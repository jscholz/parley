/**
 * Capture store + HTTP surface — the server half of meeting capture
 * (design: workspace/documents/agent-development/
 * sidekick-capture-design-and-plan-2026-07-07.md §3.1/§3.3).
 *
 * PROXY-owned by design (not the hermes plugin): capture must work on
 * every backend — hermes, Claude Code, even the npx stub with only a
 * Deepgram key. Storage is plain files under the sidekick data home;
 * everything agent-facing is filesystem + chat-message based, so any
 * backend with file tools can read transcripts.
 *
 * This is a PUBLIC API, not PWA plumbing: the PWA recorder is merely
 * its first client. A Shortcut, a desk-mic daemon, or a meeting bot
 * can drive the same endpoints (create → PUT segments → stop) and get
 * the same pipeline. Keep the shapes boring and versionable.
 *
 * Layout on disk (source of truth — index.json is a rebuildable cache):
 *   <capturesDir>/<capture_id>/manifest.json
 *   <capturesDir>/<capture_id>/seg/<seq>.<ext>     raw self-contained segments
 *   <capturesDir>/index.json                       list cache, atomic rewrite
 *
 * Durable raw audio is deliberate (plan finding #7): segments are never
 * deleted by the pipeline — they enable re-transcription, lazy/retro
 * diarization, and the tap-to-seek player.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { pushEnvelope } from './stream.ts';

export interface SegmentMeta {
  seq: number;
  t0_ms: number;       // capture-relative start of this segment
  bytes: number;
  mime: string;
  sha256: string;
}

export interface CaptureManifest {
  id: string;
  title: string;
  /** Chat that owns the start-message + ingest turn. Null = none
   *  (bare API captures). See §3.6 — the PWA sends "new" at create
   *  time and gets a freshly minted session id back. */
  linked_chat: string | null;
  diarize: boolean;
  /** Per-capture override of the pipeline's auto-ingest (Settings →
   *  Meetings). Absent = pipeline default. */
  auto_ingest?: boolean;
  /** Raw audio was purged (storage hygiene — transcript retained).
   *  Playback + retro-diarize become unavailable. */
  audio_purged?: boolean;
  status: 'recording' | 'transcribing' | 'complete' | 'failed';
  started_at: number;          // epoch ms, server clock
  ended_at: number | null;
  /** User-flagged moments (pill flag button / POST marks). The
   *  stitcher renders them as [MARK +MM:SS] lines in position. */
  marks: { t_ms: number }[];
  /** Reserved for speaker naming (deferred; plan §deferred). */
  speakers: Record<string, string>;
  segments: SegmentMeta[];
}

/** HTTP-mappable failure. `status` is the response code the handlers
 *  emit; module-level callers (tests, later pipeline stages) get a
 *  typed error instead of a raw res write. */
export class CaptureError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ── Pipeline hooks ─────────────────────────────────────────────────────
//
// capture.ts is deliberately PURE STORAGE + API; everything that
// happens *because* of a capture event (start-message into the linked
// chat, rolling transcription, the diarize pass) hangs off this hooks
// registry, wired at server boot (server.ts → captureTranscribe.ts).
// This is also the extension seam: a fork can hook captures into
// anything without touching the storage contract. No hooks registered
// (unit tests, transcription-less deployments) → stop goes straight to
// 'complete' and everything still works.

export interface CaptureHooks {
  onCreated?(m: CaptureManifest): void;
  onSegmentStored?(m: CaptureManifest, seg: SegmentMeta): void;
  /** Claim query — called while stop is being processed, BEFORE any
   *  state is persisted. Return true to CLAIM finalization (capture
   *  parks in 'transcribing' until the claimant calls
   *  finalizeCapture()); false/undefined → immediate 'complete'.
   *  MUST NOT mutate capture state or start finalization here — that
   *  is what onStopCommitted is for (audit 2026-07-09: a claimant that
   *  finalized synchronously raced stopCapture's own save and could
   *  wedge the capture in 'transcribing'). */
  onStopRequested?(m: CaptureManifest): boolean | undefined;
  /** The stop state is durably saved — a claimant starts (or
   *  schedules) finalization HERE. */
  onStopCommitted?(m: CaptureManifest): void;
  /** Called after a capture is deleted (cancel mid-recording, or
   *  delete of a finished recording) — pipelines drop queued work. */
  onDeleted?(id: string): void;
}

// ── Per-capture mutation serialization ─────────────────────────────────
//
// Every mutator is read-manifest → mutate → save; without ordering,
// last-writer-wins loses data (audit 2026-07-09: a mark flagged during
// an in-flight segment POST vanished; concurrent third-party uploads
// could drop segment entries; stop raced finalize). A per-id promise
// chain is the proportionate fix — no locks file, no API change.
// createCapture serializes on a global key so the one-active rule is
// check-then-act-safe.
const mutexTails = new Map<string, Promise<unknown>>();

function withCaptureLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = mutexTails.get(key) ?? Promise.resolve();
  const next = tail.then(fn, fn);
  // The stored tail swallows rejections (it exists only for ordering);
  // the caller still gets them from `next`. Entry is dropped once this
  // link settles as the current tail, so the map stays bounded.
  const stored = next.then(() => undefined, () => undefined).then(() => {
    if (mutexTails.get(key) === stored) mutexTails.delete(key);
  });
  mutexTails.set(key, stored);
  return next;
}

let hooks: CaptureHooks | null = null;

export function setCaptureHooks(h: CaptureHooks | null): void {
  hooks = h;
}

// ── Storage root ───────────────────────────────────────────────────────

let capturesDirOverride: string | null = null;

/** Test seam + explicit boot configuration. Production resolution
 *  order: SIDEKICK_CAPTURES_DIR (Jonathan points this at his agent
 *  workspace so hermes reads transcripts as plain files) → the
 *  sidekick data home (`SIDEKICK_HOME`, else ~/.sidekick) /captures. */
export function initCapture(opts?: { dir?: string }): void {
  capturesDirOverride = opts?.dir ?? null;
}

function capturesDir(): string {
  if (capturesDirOverride) return capturesDirOverride;
  if (process.env.SIDEKICK_CAPTURES_DIR) return process.env.SIDEKICK_CAPTURES_DIR;
  const home = process.env.SIDEKICK_HOME || path.join(os.homedir(), '.sidekick');
  return path.join(home, 'captures');
}

// capture ids are path components — validate hard so a crafted id can
// never traverse out of the captures dir.
const CAPTURE_ID_RE = /^cap_[0-9]+_[0-9a-f]{6}$/;

function assertValidId(id: string): void {
  if (!CAPTURE_ID_RE.test(id)) throw new CaptureError(400, `invalid capture id: ${id}`);
}

function captureDir(id: string): string { return path.join(capturesDir(), id); }

/** Public: a capture's on-disk directory (transcripts, seg/, …).
 *  Pipeline modules and the ingest message build paths from this. */
export function captureDirPath(id: string): string {
  assertValidId(id);
  return captureDir(id);
}
function manifestPath(id: string): string { return path.join(captureDir(id), 'manifest.json'); }

function extForMime(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('wav')) return 'wav';
  return 'bin';
}

export function segmentPath(id: string, seg: SegmentMeta): string {
  return path.join(captureDir(id), 'seg', `${seg.seq}.${extForMime(seg.mime)}`);
}

// ── Atomic JSON persistence ────────────────────────────────────────────
//
// tmp-write + rename in the same directory: a crash mid-write leaves
// the old file intact, never a torn one. Same idiom for manifests and
// the index.

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 1));
  await fs.rename(tmp, file);
}

async function readManifest(id: string): Promise<CaptureManifest> {
  assertValidId(id);
  try {
    const raw = await fs.readFile(manifestPath(id), 'utf8');
    return JSON.parse(raw) as CaptureManifest;
  } catch {
    throw new CaptureError(404, `unknown capture: ${id}`);
  }
}

async function saveManifest(m: CaptureManifest): Promise<void> {
  await writeJsonAtomic(manifestPath(m.id), m);
  await rebuildIndex();
}

/** index.json is a CACHE of the manifests (one summary row each),
 *  rebuilt on every mutation. O(captures) reads per write is fine at
 *  the dozens-of-meetings scale; being derivable means it can never
 *  disagree with the manifests it summarizes. */
async function rebuildIndex(): Promise<void> {
  const rows = await listCaptures();
  await writeJsonAtomic(path.join(capturesDir(), 'index.json'), { captures: rows });
}

export interface CaptureSummary {
  id: string;
  title: string;
  linked_chat: string | null;
  diarize: boolean;
  /** Per-capture override of the pipeline's auto-ingest (Settings →
   *  Meetings). Absent = pipeline default. */
  auto_ingest?: boolean;
  /** Raw audio was purged (storage hygiene — transcript retained).
   *  Playback + retro-diarize become unavailable. */
  audio_purged?: boolean;
  status: CaptureManifest['status'];
  started_at: number;
  ended_at: number | null;
  segment_count: number;
  total_bytes: number;
  duration_ms: number;
}

function summarize(m: CaptureManifest): CaptureSummary {
  const last = m.segments[m.segments.length - 1];
  return {
    id: m.id,
    title: m.title,
    linked_chat: m.linked_chat,
    diarize: m.diarize,
    status: m.status,
    started_at: m.started_at,
    ended_at: m.ended_at,
    segment_count: m.segments.length,
    total_bytes: m.segments.reduce((s, x) => s + x.bytes, 0),
    duration_ms: m.ended_at
      ? m.ended_at - m.started_at
      : (last ? last.t0_ms : 0),
  };
}

// ── Core operations (module-level, unit-testable) ─────────────────────

/** Stale-recording auto-heal: a crash (battery death mid-meeting)
 *  leaves status 'recording' forever, which would wedge the
 *  one-active-capture rule. Anything "recording" with no activity for
 *  this long is failed in place when the next capture starts. */
const STALE_RECORDING_MS = 10 * 60 * 1000;

async function lastActivityMs(m: CaptureManifest): Promise<number> {
  // ARRIVAL clock, not meeting-relative time: manifest mtime moves on
  // every accepted segment/mark/patch. The previous started_at+t0
  // arithmetic made a paused meeting or an offline upload backlog look
  // "stale" after 10 wall-clock minutes (audit 2026-07-09 #11).
  try {
    const st = await fs.stat(manifestPath(m.id));
    return Math.max(st.mtimeMs, m.started_at);
  } catch {
    return m.started_at;
  }
}

export function createCapture(opts: {
  title?: string;
  linkedChat?: string | null;
  diarize?: boolean;
  autoIngest?: boolean;
}): Promise<CaptureManifest> {
  // Global-key lock: the one-active rule is check-then-act, so two
  // concurrent creates must serialize (audit 2026-07-09).
  return withCaptureLock('__create__', () => createCaptureLocked(opts));
}

async function createCaptureLocked(opts: {
  title?: string;
  linkedChat?: string | null;
  diarize?: boolean;
  autoIngest?: boolean;
}): Promise<CaptureManifest> {
  await fs.mkdir(capturesDir(), { recursive: true });
  // One active capture at a time (plan §3.1, v1) — with the stale
  // auto-heal above so a crashed capture can't wedge the rule.
  for (const row of await listCaptures()) {
    if (row.status !== 'recording') continue;
    const m = await readManifest(row.id);
    if (Date.now() - await lastActivityMs(m) > STALE_RECORDING_MS) {
      // Heal direction matters (audit): a crashed capture WITH sealed
      // audio is a real meeting — complete it (segments + transcripts
      // stay usable, retro-transcribable); only a segment-less husk is
      // a failure.
      m.status = m.segments.length ? 'complete' : 'failed';
      m.ended_at = Date.now();
      await saveManifest(m);
      continue;
    }
    throw new CaptureError(409, `capture ${row.id} is already recording`);
  }
  const id = `cap_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const manifest: CaptureManifest = {
    id,
    title: opts.title?.trim() || `Meeting ${new Date().toISOString().slice(0, 10)}`,
    linked_chat: opts.linkedChat ?? null,
    diarize: opts.diarize !== false,   // default ON for meetings (plan §1.5)
    ...(typeof opts.autoIngest === 'boolean' ? { auto_ingest: opts.autoIngest } : {}),
    status: 'recording',
    started_at: Date.now(),
    ended_at: null,
    marks: [],
    speakers: {},
    segments: [],
  };
  await fs.mkdir(path.join(captureDir(id), 'seg'), { recursive: true });
  await saveManifest(manifest);
  notifyChanged(manifest, 'created');
  try { hooks?.onCreated?.(manifest); } catch { /* hook errors never break storage */ }
  return manifest;
}

export function putSegment(
  id: string,
  seq: number,
  body: Buffer,
  meta: { t0Ms: number; mime: string; sha256?: string },
): Promise<{ manifest: CaptureManifest; duplicate: boolean }> {
  return withCaptureLock(id, () => putSegmentLocked(id, seq, body, meta));
}

async function putSegmentLocked(
  id: string,
  seq: number,
  body: Buffer,
  meta: { t0Ms: number; mime: string; sha256?: string },
): Promise<{ manifest: CaptureManifest; duplicate: boolean }> {
  const m = await readManifest(id);
  // Segments are accepted while recording AND after stop (the client
  // uploader is resumable by design — an outage during the meeting
  // means the tail segments arrive after /stop). Only terminal states
  // refuse.
  if (m.status === 'complete' || m.status === 'failed') {
    throw new CaptureError(409, `capture ${id} is ${m.status}; segments are frozen`);
  }
  if (!Number.isInteger(seq) || seq < 0) throw new CaptureError(400, `invalid seq: ${seq}`);
  if (!body.length) throw new CaptureError(400, 'empty segment body');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  if (meta.sha256 && meta.sha256.toLowerCase() !== sha) {
    throw new CaptureError(409, `sha256 mismatch on segment ${seq} (corrupt upload — retry)`);
  }
  const existing = m.segments.find((s) => s.seq === seq);
  if (existing) {
    // Idempotent re-upload: the client deletes its IDB copy only on
    // ack, so a lost ack means the same bytes come again. Same sha →
    // ack again silently; different sha → the client has diverged.
    if (existing.sha256 === sha) return { manifest: m, duplicate: true };
    throw new CaptureError(409, `segment ${seq} already stored with different content`);
  }
  const seg: SegmentMeta = {
    seq,
    t0_ms: Math.max(0, Math.floor(meta.t0Ms || 0)),
    bytes: body.length,
    mime: meta.mime || 'application/octet-stream',
    sha256: sha,
  };
  await fs.mkdir(path.dirname(segmentPath(id, seg)), { recursive: true });
  await fs.writeFile(segmentPath(id, seg), body);
  m.segments.push(seg);
  m.segments.sort((a, b) => a.seq - b.seq);
  await saveManifest(m);
  try { hooks?.onSegmentStored?.(m, seg); } catch { /* hook errors never break storage */ }
  return { manifest: m, duplicate: false };
}

export function addMark(id: string, tMs: number): Promise<CaptureManifest> {
  return withCaptureLock(id, () => addMarkLocked(id, tMs));
}

async function addMarkLocked(id: string, tMs: number): Promise<CaptureManifest> {
  const m = await readManifest(id);
  if (m.status !== 'recording') throw new CaptureError(409, `capture ${id} is not recording`);
  m.marks.push({ t_ms: Math.max(0, Math.floor(tMs || 0)) });
  await saveManifest(m);
  return m;
}

export function patchCapture(id: string, patch: {
  title?: string;
  linkedChat?: string | null;
  diarize?: boolean;
}): Promise<CaptureManifest> {
  return withCaptureLock(id, () => patchCaptureLocked(id, patch));
}

async function patchCaptureLocked(id: string, patch: {
  title?: string;
  linkedChat?: string | null;
  diarize?: boolean;
}): Promise<CaptureManifest> {
  const m = await readManifest(id);
  if (typeof patch.title === 'string' && patch.title.trim()) m.title = patch.title.trim();
  if (patch.linkedChat !== undefined) m.linked_chat = patch.linkedChat;
  if (typeof patch.diarize === 'boolean') {
    // Diarize can only be toggled before the pipeline consumed it.
    if (m.status === 'complete' || m.status === 'failed') {
      throw new CaptureError(409, 'capture already finished; use retro-diarize (Phase 4g)');
    }
    m.diarize = patch.diarize;
  }
  await saveManifest(m);
  notifyChanged(m, 'patched');
  return m;
}

export function stopCapture(id: string): Promise<CaptureManifest> {
  return withCaptureLock(id, () => stopCaptureLocked(id));
}

async function stopCaptureLocked(id: string): Promise<CaptureManifest> {
  const m = await readManifest(id);
  if (m.status !== 'recording') return m;   // idempotent stop
  m.ended_at = Date.now();
  // A registered pipeline (captureTranscribe) may CLAIM finalization —
  // the capture parks in 'transcribing' until finalizeCapture(). No
  // claimant (unit tests, transcription-less installs) → complete now.
  // Claim is a pure QUERY; the claimant starts work only on
  // onStopCommitted below, AFTER the state is durably saved —
  // otherwise finalize raced this save (audit 2026-07-09).
  let claimed = false;
  try { claimed = hooks?.onStopRequested?.(m) === true; } catch { /* hook errors never break stop */ }
  m.status = claimed ? 'transcribing' : 'complete';
  await saveManifest(m);
  notifyChanged(m, 'stopped');
  if (claimed) {
    try { hooks?.onStopCommitted?.(m); } catch { /* hook errors never break stop */ }
  }
  return m;
}

/** Pipeline hand-back: the onStopRequested claimant calls this when
 *  transcription (and, when enabled, the diarize pass) is done. */
export function finalizeCapture(id: string, opts?: { failed?: boolean }): Promise<CaptureManifest> {
  return withCaptureLock(id, () => finalizeCaptureLocked(id, opts));
}

async function finalizeCaptureLocked(id: string, opts?: { failed?: boolean }): Promise<CaptureManifest> {
  const m = await readManifest(id);
  if (m.status === 'complete' || m.status === 'failed') return m;
  m.status = opts?.failed ? 'failed' : 'complete';
  if (!m.ended_at) m.ended_at = Date.now();
  await saveManifest(m);
  notifyChanged(m, 'completed');
  return m;
}

export async function getCapture(id: string): Promise<CaptureManifest> {
  return readManifest(id);
}

/** Hard delete — the whole capture directory, audio included. Serves
 *  BOTH cancel-without-ingest (discard an in-flight recording; the
 *  pill's ✕) and deleting a finished recording later. This is the one
 *  deliberately destructive verb in the API, so it validates the id,
 *  confirms the manifest exists (404 otherwise), and never touches
 *  anything outside the capture dir. */
/** Storage hygiene (field 2026-07-09 #7): delete the AUDIO, keep the
 *  transcript(s) + per-segment text. Audio is the only thing that
 *  meaningfully eats disk (~22MB/h stitched + raw segments); the words
 *  keep their value forever. Irreversible: playback and retro-diarize
 *  are gone for this capture afterwards. */
export function purgeCaptureAudio(id: string): Promise<CaptureManifest> {
  return withCaptureLock(id, () => purgeCaptureAudioLocked(id));
}

async function purgeCaptureAudioLocked(id: string): Promise<CaptureManifest> {
  const m = await readManifest(id);
  if (m.status !== 'complete' && m.status !== 'failed') {
    throw new CaptureError(409, `capture is ${m.status}; purge audio after it finishes`);
  }
  const dir = captureDir(id);
  const segDir = path.join(dir, 'seg');
  for (const f of await fs.readdir(segDir).catch(() => [] as string[])) {
    if (/\.(m4a|webm|wav|bin)$/.test(f)) await fs.unlink(path.join(segDir, f)).catch(() => { /* best-effort */ });
  }
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    if (/^audio\./.test(f)) await fs.unlink(path.join(dir, f)).catch(() => { /* best-effort */ });
  }
  m.audio_purged = true;
  await saveManifest(m);
  notifyChanged(m, 'patched');
  return m;
}

/** POST /api/sidekick/captures/{id}/purge-audio */
export async function handleCapturePurgeAudio(
  _req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try { sendJson(res, 200, { ok: true, capture: await purgeCaptureAudio(id) }); }
  catch (err) { sendError(res, err); }
}

export function deleteCapture(id: string): Promise<void> {
  return withCaptureLock(id, () => deleteCaptureLocked(id));
}

async function deleteCaptureLocked(id: string): Promise<void> {
  const m = await readManifest(id);   // 404s unknown ids; validates shape
  await fs.rm(captureDir(m.id), { recursive: true, force: true });
  await rebuildIndex();
  try { hooks?.onDeleted?.(id); } catch { /* hook errors never break delete */ }
  notifyChanged(m, 'deleted');
}

export async function listCaptures(): Promise<CaptureSummary[]> {
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(capturesDir())).filter((e) => CAPTURE_ID_RE.test(e));
  } catch {
    return [];   // captures dir not created yet = empty list
  }
  const out: CaptureSummary[] = [];
  for (const id of entries) {
    try {
      out.push(summarize(await readManifest(id)));
    } catch { /* torn/missing manifest → skip the row, don't 500 the list */ }
  }
  out.sort((a, b) => b.started_at - a.started_at);
  return out;
}

/** Cross-device capture state (pill on the laptop while the phone
 *  records, list refreshes) rides the same fanout as everything else.
 *  `kind` distinguishes lifecycle steps so clients can badge/update
 *  without refetching on every segment. */
function notifyChanged(m: CaptureManifest, kind: 'created' | 'patched' | 'stopped' | 'completed' | 'deleted'): void {
  try {
    pushEnvelope({
      type: 'capture_changed',
      kind,
      chat_id: m.linked_chat || '',
      capture: summarize(m),
    } as any);
  } catch { /* fanout unavailable (unit tests) — state on disk is still truth */ }
}

// ── HTTP handlers (server.ts dispatch) ─────────────────────────────────

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof CaptureError) return sendJson(res, err.status, { error: err.message });
  sendJson(res, 500, { error: String((err as Error)?.message || err) });
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > maxBytes) {
        // Reject WITHOUT destroying the socket: a destroyed request
        // never carries the 413 back, so the client uploader read it
        // as a network error and retried the same oversized segment
        // forever, damming its serial queue (audit 2026-07-09 #14).
        // The handler's 413 makes it a permanent 4xx drop instead.
        req.removeAllListeners('data');
        req.resume();
        reject(new CaptureError(413, 'body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<any> {
  const buf = await readBody(req, 1_000_000);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new CaptureError(400, 'invalid json body'); }
}

// A single 45s segment at 32kbps is ~180KB; iOS can ignore the bitrate
// hint and emit much fatter AAC (chunkedTranscribe's SIZE_THRESHOLD
// lesson), and interruption-sealed segments can be long. 32MB is a
// generous ceiling that still stops a runaway client.
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;

/** POST /api/sidekick/captures — start. Body {title?, linked_chat?, diarize?}.
 *  linked_chat: "new" mints a fresh session id (the PWA's chats are
 *  lazily created server-side on first message, so minting = issuing
 *  an id in the same `sidekick:<uuid>` shape the composer's new-chat
 *  path uses — see src/main.ts new-chat). */
export async function handleCaptureCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson(req);
    let linkedChat: string | null = null;
    if (body.linked_chat === 'new') linkedChat = `sidekick:${crypto.randomUUID()}`;
    else if (typeof body.linked_chat === 'string' && body.linked_chat) linkedChat = body.linked_chat;
    const manifest = await createCapture({
      title: typeof body.title === 'string' ? body.title : undefined,
      linkedChat,
      diarize: typeof body.diarize === 'boolean' ? body.diarize : undefined,
      autoIngest: typeof body.auto_ingest === 'boolean' ? body.auto_ingest : undefined,
    });
    sendJson(res, 201, { capture: manifest });
  } catch (err) { sendError(res, err); }
}

/** POST /api/sidekick/captures/{id}/segments/{seq} — raw bytes.
 *  Headers: content-type (segment mime), x-sidekick-t0-ms,
 *  x-sidekick-sha256 (optional integrity check). */
export async function handleCaptureSegment(
  req: IncomingMessage, res: ServerResponse, id: string, seqRaw: string,
): Promise<void> {
  try {
    const seq = Number(seqRaw);
    const body = await readBody(req, MAX_SEGMENT_BYTES);
    const { duplicate } = await putSegment(id, seq, body, {
      t0Ms: Number(req.headers['x-sidekick-t0-ms'] || 0),
      mime: String(req.headers['content-type'] || 'application/octet-stream'),
      sha256: typeof req.headers['x-sidekick-sha256'] === 'string'
        ? req.headers['x-sidekick-sha256'] : undefined,
    });
    sendJson(res, 200, { ok: true, seq, duplicate });
  } catch (err) { sendError(res, err); }
}

/** POST /api/sidekick/captures/{id}/stop */
export async function handleCaptureStop(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try { sendJson(res, 200, { capture: await stopCapture(id) }); }
  catch (err) { sendError(res, err); }
}

/** PATCH /api/sidekick/captures/{id} — rename / re-link / diarize
 *  toggle (the annotate-later sheet, §3.4). */
export async function handleCapturePatch(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    const body = await readJson(req);
    const manifest = await patchCapture(id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      linkedChat: body.linked_chat === undefined ? undefined
        : (typeof body.linked_chat === 'string' && body.linked_chat ? body.linked_chat : null),
      diarize: typeof body.diarize === 'boolean' ? body.diarize : undefined,
    });
    sendJson(res, 200, { capture: manifest });
  } catch (err) { sendError(res, err); }
}

/** DELETE /api/sidekick/captures/{id} — discard (cancel or delete). */
export async function handleCaptureDelete(
  _req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    await deleteCapture(id);
    sendJson(res, 200, { ok: true, deleted: id });
  } catch (err) { sendError(res, err); }
}

/** POST /api/sidekick/captures/{id}/marks — {t_ms} */
export async function handleCaptureMark(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    const body = await readJson(req);
    const manifest = await addMark(id, Number(body.t_ms));
    sendJson(res, 200, { ok: true, marks: manifest.marks });
  } catch (err) { sendError(res, err); }
}

/** GET /api/sidekick/captures */
export async function handleCaptureList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try { sendJson(res, 200, { captures: await listCaptures() }); }
  catch (err) { sendError(res, err); }
}

/** GET /api/sidekick/captures/{id} */
export async function handleCaptureGet(
  _req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try { sendJson(res, 200, { capture: await getCapture(id) }); }
  catch (err) { sendError(res, err); }
}

/** POST /api/sidekick/captures/control — {action: 'start'|'stop', ...}.
 *  External-trigger control plane (§3.3): broadcasts over the fanout;
 *  whichever device's PWA is foregrounded picks it up and drives its
 *  recorder. API clients that own their own mic don't need this —
 *  they call create/segments/stop directly. */
export async function handleCaptureControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson(req);
    // STRICT validation (audit 2026-07-09): defaulting unknown actions
    // to 'start' made any malformed body a start-the-microphone
    // broadcast — a privacy footgun on a public endpoint.
    const action = body.action;
    if (action !== 'start' && action !== 'stop') {
      throw new CaptureError(400, `action must be 'start' or 'stop', got: ${JSON.stringify(action ?? null)}`);
    }
    pushEnvelope({
      type: 'capture_control',
      action,
      chat_id: '',
      title: typeof body.title === 'string' ? body.title : undefined,
      capture_id: typeof body.capture_id === 'string' ? body.capture_id : undefined,
    } as any);
    sendJson(res, 202, { ok: true, action });
  } catch (err) { sendError(res, err); }
}
