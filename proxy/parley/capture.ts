/**
 * Capture store + HTTP surface — the server half of meeting capture
 * (design: workspace/documents/agent-development/
 * the 2026-07-07 capture design doc §3.1/§3.3 (hermes-agent-private)).
 *
 * PROXY-owned by design (not the hermes plugin): capture must work on
 * every backend — hermes, Claude Code, even the npx stub with only a
 * Deepgram key. Storage is plain files under the parley data home;
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
import { readEnv } from '../env.mjs';
import { dataHome } from '../dataHome.mjs';

import { pushEnvelope } from './stream.ts';
import { setAuditFileResolver, recordCaptureEvent } from './captureAudit.ts';

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
  /** True when linked_chat was MINTED for this capture (create body
   *  said "new") rather than pointing at an existing chat. The titling
   *  pipeline start-titles only minted sessions — an existing chat's
   *  title is someone else's to keep (meeting-polish #25). */
  minted_session?: boolean;
  diarize: boolean;
  /** Per-capture override of the pipeline's auto-ingest (Settings →
   *  Meetings). Absent = pipeline default. */
  auto_ingest?: boolean;
  /** Raw audio was purged (storage hygiene — transcript retained).
   *  Playback + retro-diarize become unavailable. */
  audio_purged?: boolean;
  /** Two-phase lifecycle (2026-08-18 postmortem P0 #1):
   *  'pending'    — server entity exists, but NO device has confirmed a
   *                 running recorder. No announce, no title, invisible
   *                 to the user. Expires to 'failed' in place.
   *  'recording'  — a client confirmed mic + MediaRecorder via
   *                 /activate (or, legacy-client compat, uploaded a
   *                 first segment). THIS transition is the only one
   *                 allowed to announce "Recording started".
   *  'discarded'  — soft-deleted tombstone (Recently Deleted): the
   *                 directory and audio stay on disk, restorable, until
   *                 an explicit /purge or the retention sweep. */
  status: 'pending' | 'recording' | 'transcribing' | 'complete' | 'failed' | 'discarded';
  /** Why the capture ended 'failed' (abort-start reason, pending TTL
   *  expiry, supersede, stale heal). Kept in place — never deleted. */
  failed_reason?: string;
  /** Epoch ms of the pending→recording transition. */
  activated_at?: number;
  /** Arrival clock for AUDIO specifically, set on every accepted
   *  segment. Distinct from the manifest mtime that lastActivityMs()
   *  reads: marks, patches and (from 2026-08-27) health pings also move
   *  that, and a stall detector keyed on it would be fooled by a client
   *  that is chattering happily while producing no sound — which is
   *  exactly the incident this was added for. */
  last_segment_at?: number;
  /** Set when the stall detector first notices audio has stopped
   *  arriving on a live recording; cleared the moment a segment lands.
   *  Presence is what makes the warning edge-triggered (one push per
   *  stall, not one per sweep). */
  stalled_since?: number;
  /** Tombstone stamp — when the capture entered Recently Deleted. */
  discarded_at?: number;
  /** Status held at discard time (restore-target hint). */
  pre_discard_status?: 'pending' | 'recording' | 'transcribing' | 'complete' | 'failed';
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
  /** The capture ENTITY exists (status 'pending'). NOT a success
   *  signal: no device has confirmed a recorder yet — do not announce,
   *  title, or otherwise tell a human that recording started here
   *  (postmortem 2026-08-18: that announce-at-create was the harm). */
  onCreated?(m: CaptureManifest): void;
  /** pending → recording: a client confirmed mic ownership and a
   *  running MediaRecorder. Fires EXACTLY once per capture — this is
   *  where "Recording started" side-effects belong. */
  onActivated?(m: CaptureManifest): void;
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
  /** Soft-discard (Recently Deleted tombstone) — pipelines drop queued
   *  work; the data stays on disk, restorable. */
  onDiscarded?(id: string): void;
  /** The capture directory is GONE (explicit purge, or hard delete of
   *  an empty terminal husk) — pipelines drop queued work. */
  onDeleted?(id: string): void;
}

/** Who/why for lifecycle mutations — threaded from the HTTP layer into
 *  the audit log (postmortem P0 #3: the DELETE handler ignored `_req`,
 *  so the incident's caller is unknowable forever). */
export interface CaptureActor {
  /** 'pwa-recorder', 'api', 'sweep', … (x-parley-client header). */
  source?: string;
  userAgent?: string;
  remote?: string;
  /** Explicit reason for the action ("user cancel", "getUserMedia
   *  rejected", …). */
  reason?: string;
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
 *  order: PARLEY_CAPTURES_DIR (Jonathan points this at his agent
 *  workspace so hermes reads transcripts as plain files) → the
 *  parley data home (dataHome(): PARLEY_HOME, else ~/.parley)
 *  /captures. */
export function initCapture(opts?: { dir?: string }): void {
  capturesDirOverride = opts?.dir ?? null;
}

function capturesDir(): string {
  if (capturesDirOverride) return capturesDirOverride;
  const dirOverride = readEnv('PARLEY_CAPTURES_DIR');
  if (dirOverride) return dirOverride;
  return path.join(dataHome(), 'captures');
}

// capture ids are path components — validate hard so a crafted id can
// never traverse out of the captures dir.
const CAPTURE_ID_RE = /^cap_[0-9]+_[0-9a-f]{6}$/;

function assertValidId(id: string): void {
  if (!CAPTURE_ID_RE.test(id)) throw new CaptureError(400, `invalid capture id: ${id}`);
}

function captureDir(id: string): string { return path.join(capturesDir(), id); }

// Lifecycle audit lives BESIDE the capture dirs (sibling of index.json),
// never inside one — discard/purge/delete of any capture can't touch it.
setAuditFileResolver(() => path.join(capturesDir(), 'audit.log'));

/** Audit-event shorthand: pre-action counts + actor fields. Fire-and-
 *  forget by default (audit never gates storage); await the returned
 *  promise where durability must precede destruction (purge). */
function audit(
  m: CaptureManifest,
  action: string,
  fields: { actor?: CaptureActor; priorStatus?: string; newStatus?: string;
    reason?: string; error?: string; detail?: Record<string, unknown> },
): Promise<void> {
  return recordCaptureEvent({
    capture_id: m.id,
    action,
    reason: fields.reason ?? fields.actor?.reason,
    source: fields.actor?.source ?? 'api',
    user_agent: fields.actor?.userAgent,
    remote: fields.actor?.remote,
    prior_status: fields.priorStatus,
    new_status: fields.newStatus,
    segment_count: m.segments.length,
    total_bytes: m.segments.reduce((s, x) => s + x.bytes, 0),
    result: fields.error ? 'error' : 'ok',
    ...(fields.error ? { error: fields.error } : {}),
    ...(fields.detail ? { detail: fields.detail } : {}),
  });
}

/** Public: a capture's on-disk directory (transcripts, seg/, …).
 *  Pipeline modules and the ingest message build paths from this. */
export function captureDirPath(id: string): string {
  assertValidId(id);
  return captureDir(id);
}

/** Canonical transcript file — ONE definition of the layout fact
 *  "captures store transcript.md" (captureTranscribe's transcriptPath
 *  delegates here). The storage module owns it so the transcript GET
 *  endpoint below never has to reach into the pipeline (audit 2.2). */
export function transcriptFilePath(id: string): string {
  return path.join(captureDirPath(id), 'transcript.md');
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
  // The cache mirrors ALL manifests, tombstones included — it must
  // never disagree with disk; view-level filtering happens in list
  // consumers.
  const rows = await listCaptures({ includeDiscarded: true });
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
  /** Why the capture ended 'failed' (abort/expiry/heal reason). */
  failed_reason?: string;
  /** Tombstone stamp — present only for Recently Deleted rows. */
  discarded_at?: number;
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
    ...(m.failed_reason ? { failed_reason: m.failed_reason } : {}),
    ...(m.discarded_at ? { discarded_at: m.discarded_at } : {}),
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

/** Stall warning: audio should arrive every SEGMENT_MS (45s on the
 *  client), so two missed segments means something is wrong NOW —
 *  long before the 10-minute heal quietly buries the recording.
 *
 *  Incident 2026-08-27: an hour-long meeting produced ZERO segments.
 *  The server knew at 14:10 that no audio had ever arrived; it said
 *  nothing until the 14:18 sweep, and said nothing to the USER at all.
 *  The phone kept showing a running timer until 15:30 and the meeting
 *  was gone. A recording that is silently not recording is the worst
 *  failure this feature has, so the server now says so out loud —
 *  in-band (capture_changed) and out-of-band (push, which reaches a
 *  pocketed phone even if its page is frozen).
 *
 *  Warn, do NOT fail: a stall is often recoverable (route change, a
 *  backgrounded tab catching up), and the existing 10-minute heal
 *  already owns the terminal decision. */
const STALL_WARN_MS = 2 * 60 * 1000;

/** The AUDIO arrival clock — segments only. Deliberately NOT
 *  lastActivityMs(), which reads the manifest mtime and therefore also
 *  moves on marks, patches and health pings; keying the stall detector
 *  on that would let a chatty-but-silent client look healthy, which is
 *  precisely the failure being detected. Falls back to activation (a
 *  capture that never produced its FIRST segment is the incident case
 *  and must warn too). */
function lastAudioMs(m: CaptureManifest): number {
  return m.last_segment_at ?? m.activated_at ?? m.started_at;
}

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

/** A 'pending' capture that never activated is a startup that never
 *  finished (mic prompt hanging, page reloaded, phone frozen). Past
 *  this TTL it is FAILED IN PLACE — never recursively deleted
 *  (postmortem P0 #1 step 6). Generous vs the client's ~20s startup
 *  timeout so slow-but-honest activations still land. */
const PENDING_TTL_MS = 2 * 60 * 1000;

/** Recently Deleted retention: a discarded capture stays on disk,
 *  restorable, for this long before the sweep purges it (audited). */
const DISCARD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Out-of-band stall warning. A push is the only channel that reaches
 *  a phone whose page is frozen or pocketed — the exact situation in
 *  which a silent recording is most costly, because the user is in a
 *  meeting believing it is being captured.
 *
 *  Best-effort by construction: push may be unconfigured (no VAPID) or
 *  have no subscriptions, and a recording must never fail because a
 *  notification could not be sent. Import is lazy so capture.ts stays
 *  usable in unit tests that never touch the notification stack.
 *
 *  The copy names the ACTION, not the diagnosis: the user cannot fix a
 *  stalled uploader, but they can look at their phone — which is all
 *  that was needed on 2026-08-27 to save the meeting. */
async function warnStalledCapture(m: CaptureManifest, silentForMs: number): Promise<void> {
  try {
    const { dispatchPush } = await import('./notifications/dispatch.ts');
    const mins = Math.max(1, Math.round(silentForMs / 60000));
    const body = m.segments.length === 0
      ? `No audio has reached the server since it started ${mins}m ago. Open Parley to check.`
      : `Audio stopped arriving ${mins}m ago (${m.segments.length} segments saved). Open Parley to check.`;
    await dispatchPush({
      title: `\u26a0\ufe0f "${m.title}" may not be recording`,
      body,
      chat_id: m.linked_chat || undefined,
      // Stable tag: a stall that persists across sweeps must not stack
      // duplicate banners. (Re-warning is already edge-triggered by
      // stalled_since; this is belt-and-braces for multi-device.)
      tag: `capture-stall-${m.id}`,
    });
  } catch (e) {
    console.warn(`[capture] stall push failed for ${m.id}: ${String((e as Error)?.message || e)}`);
  }
}

/** Janitor pass over every capture — the stale-recording heal it always
 *  had, plus pending-TTL expiry and Recently-Deleted retention. Runs
 *  under the create lock (createCapture calls it inline; server boot
 *  schedules it periodically). Every transition is failed/completed IN
 *  PLACE and audited; the ONLY destructive branch is the
 *  retention-expired purge of a capture the user already discarded. */
export function sweepCaptures(): Promise<void> {
  return withCaptureLock('__create__', () => sweepLocked());
}

async function sweepLocked(opts?: { supersedePending?: boolean }): Promise<void> {
  for (const row of await listCaptures({ includeDiscarded: true })) {
    try {
      if (row.status === 'recording') {
        // Stale-recording auto-heal (unchanged direction — audit
        // 2026-07-09): a crashed capture WITH sealed audio is a real
        // meeting — complete it; only a segment-less husk fails.
        await withCaptureLock(row.id, async () => {
          const m = await readManifest(row.id);
          if (m.status !== 'recording') return;
          // Stall WARNING first — it must be able to fire on a capture
          // that the heal below will not touch yet (the whole point is
          // to speak up minutes earlier than the terminal verdict).
          const audioSilentFor = Date.now() - lastAudioMs(m);
          if (audioSilentFor > STALL_WARN_MS && m.stalled_since == null) {
            m.stalled_since = Date.now();
            await saveManifest(m);
            const mins = Math.round(audioSilentFor / 60000);
            void audit(m, 'stall-warn', {
              actor: { source: 'sweep' },
              reason: `no audio for ${mins}m (${m.segments.length} segments so far)`,
            });
            notifyChanged(m, 'stalled');
            void warnStalledCapture(m, audioSilentFor);
          }
          if (Date.now() - await lastActivityMs(m) <= STALE_RECORDING_MS) return;
          const next = m.segments.length ? 'complete' : 'failed';
          void audit(m, 'stale-heal', {
            actor: { source: 'sweep' }, priorStatus: m.status, newStatus: next,
            reason: `no activity for ${Math.round(STALE_RECORDING_MS / 60000)}m — healed in place`,
          });
          m.status = next;
          if (next === 'failed') m.failed_reason = 'stale recording — no activity, no audio';
          m.ended_at = Date.now();
          await saveManifest(m);
          notifyChanged(m, 'completed');
        });
      } else if (row.status === 'pending') {
        await withCaptureLock(row.id, async () => {
          const m = await readManifest(row.id);
          if (m.status !== 'pending') return;
          const expired = Date.now() - await lastActivityMs(m) > PENDING_TTL_MS;
          // A zero-segment pending is an inert placeholder; a NEW create
          // supersedes it immediately so a hung phone can't wedge the
          // one-active rule for the healthy device retrying.
          const superseded = !!opts?.supersedePending && !m.segments.length;
          if (!expired && !superseded) return;
          void audit(m, 'expire-pending', {
            actor: { source: 'sweep' }, priorStatus: 'pending', newStatus: 'failed',
            reason: superseded
              ? 'superseded by a new capture before activation'
              : 'never activated — pending TTL expired',
          });
          m.status = 'failed';
          m.failed_reason = superseded
            ? 'superseded by a new capture before activation'
            : 'start never completed (pending expired without activation)';
          m.ended_at = Date.now();
          await saveManifest(m);
          notifyChanged(m, 'completed');
        });
      } else if (row.status === 'discarded') {
        const m = await readManifest(row.id);
        const age = Date.now() - (m.discarded_at ?? Date.now());
        if (m.discarded_at && age > DISCARD_RETENTION_MS) {
          await withCaptureLock(row.id, () => purgeCaptureLocked(row.id, {
            source: 'sweep',
            reason: `Recently Deleted retention (${Math.round(DISCARD_RETENTION_MS / 86400000)}d) elapsed`,
          })).catch(() => { /* raced a restore — fine */ });
        }
      }
    } catch { /* torn row — skip, never wedge the sweep */ }
  }
}

export function createCapture(opts: {
  title?: string;
  linkedChat?: string | null;
  diarize?: boolean;
  autoIngest?: boolean;
  mintedSession?: boolean;
  actor?: CaptureActor;
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
  mintedSession?: boolean;
  actor?: CaptureActor;
}): Promise<CaptureManifest> {
  await fs.mkdir(capturesDir(), { recursive: true });
  // Heal/expire first, then enforce one ACTIVE capture at a time
  // (plan §3.1, v1). Pending placeholders never block — they are
  // superseded (failed in place) by the sweep above.
  await sweepLocked({ supersedePending: true });
  for (const row of await listCaptures()) {
    if (row.status === 'recording') {
      throw new CaptureError(409, `capture ${row.id} is already recording`);
    }
  }
  const id = `cap_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const manifest: CaptureManifest = {
    id,
    title: opts.title?.trim() || `Meeting ${new Date().toISOString().slice(0, 10)}`,
    linked_chat: opts.linkedChat ?? null,
    ...(opts.mintedSession ? { minted_session: true } : {}),
    diarize: opts.diarize !== false,   // default ON for meetings (plan §1.5)
    ...(typeof opts.autoIngest === 'boolean' ? { auto_ingest: opts.autoIngest } : {}),
    // PENDING, not recording (postmortem P0 #1): nothing may claim
    // "recording started" until a device proves a running recorder
    // via /activate (or a legacy client's first segment).
    status: 'pending',
    started_at: Date.now(),
    ended_at: null,
    marks: [],
    speakers: {},
    segments: [],
  };
  await fs.mkdir(path.join(captureDir(id), 'seg'), { recursive: true });
  await saveManifest(manifest);
  void audit(manifest, 'create', { actor: opts.actor, newStatus: 'pending' });
  notifyChanged(manifest, 'created');
  try { hooks?.onCreated?.(manifest); } catch { /* hook errors never break storage */ }
  return manifest;
}

/** pending → recording, atomically, once. The client calls this AFTER
 *  mic acquisition and a verified MediaRecorder.start() — this
 *  transition (and only this) fires onActivated ("Recording started").
 *  Idempotent for retries: an already-recording capture returns as-is
 *  without re-firing the hook. */
export function activateCapture(id: string, actor?: CaptureActor): Promise<CaptureManifest> {
  return withCaptureLock(id, () => activateCaptureLocked(id, actor));
}

async function activateCaptureLocked(id: string, actor?: CaptureActor): Promise<CaptureManifest> {
  const m = await readManifest(id);
  if (m.status === 'recording') return m;   // retry after a lost ack
  if (m.status !== 'pending') {
    throw new CaptureError(409, `capture ${id} is ${m.status}; cannot activate`);
  }
  m.status = 'recording';
  m.activated_at = Date.now();
  await saveManifest(m);
  void audit(m, 'activate', { actor, priorStatus: 'pending', newStatus: 'recording' });
  notifyChanged(m, 'activated');
  try { hooks?.onActivated?.(m); } catch { /* hook errors never break storage */ }
  return m;
}

/** Startup failure: mark a pending capture failed IN PLACE with the
 *  reason (mic denied, recorder threw, timeout). Never deletes
 *  anything, never touches a capture that has segments or already
 *  activated — those are real recordings; use /discard deliberately. */
export function abortStartCapture(id: string, actor?: CaptureActor): Promise<CaptureManifest> {
  return withCaptureLock(id, () => abortStartCaptureLocked(id, actor));
}

async function abortStartCaptureLocked(id: string, actor?: CaptureActor): Promise<CaptureManifest> {
  const m = await readManifest(id);
  if (m.status === 'failed') return m;      // expired/superseded meanwhile — same outcome
  if (m.status !== 'pending') {
    throw new CaptureError(409, `capture ${id} is ${m.status}; abort-start only applies to a pending capture`);
  }
  if (m.segments.length) {
    throw new CaptureError(409, `capture ${id} has ${m.segments.length} segments; use /discard`);
  }
  const reason = actor?.reason?.trim() || 'startup aborted (no reason given)';
  m.status = 'failed';
  m.failed_reason = reason;
  m.ended_at = Date.now();
  await saveManifest(m);
  void audit(m, 'abort-start', { actor, reason, priorStatus: 'pending', newStatus: 'failed' });
  notifyChanged(m, 'completed');
  return m;
}

export function putSegment(
  id: string,
  seq: number,
  body: Buffer,
  meta: { t0Ms: number; mime: string; sha256?: string },
  actor?: CaptureActor,
): Promise<{ manifest: CaptureManifest; duplicate: boolean }> {
  return withCaptureLock(id, () => putSegmentLocked(id, seq, body, meta, actor));
}

async function putSegmentLocked(
  id: string,
  seq: number,
  body: Buffer,
  meta: { t0Ms: number; mime: string; sha256?: string },
  actor?: CaptureActor,
): Promise<{ manifest: CaptureManifest; duplicate: boolean }> {
  const m = await readManifest(id);
  // Segments are accepted while recording AND after stop (the client
  // uploader is resumable by design — an outage during the meeting
  // means the tail segments arrive after /stop). Only terminal states
  // refuse. 'frozen' in the message is load-bearing: the client
  // uploader parks (keeps its durable IDB copy) on /frozen/i.
  if (m.status === 'complete' || m.status === 'failed' || m.status === 'discarded') {
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
  // Compat gate (postmortem §compat): a legacy client never calls
  // /activate — real audio arriving IS the proof a recorder runs, so
  // the first segment implies activation (announce fires here, once).
  const impliedActivation = m.status === 'pending';
  if (impliedActivation) {
    m.status = 'recording';
    m.activated_at = Date.now();
  }
  void audit(m, 'segment', { actor, detail: { seq, bytes: body.length } });
  await fs.mkdir(path.dirname(segmentPath(id, seg)), { recursive: true });
  await fs.writeFile(segmentPath(id, seg), body);
  m.segments.push(seg);
  m.segments.sort((a, b) => a.seq - b.seq);
  m.last_segment_at = Date.now();
  // Audio is flowing again — clear any stall flag so a later stall
  // re-warns instead of staying silent because the field is still set.
  const wasStalled = m.stalled_since != null;
  delete m.stalled_since;
  await saveManifest(m);
  if (wasStalled) {
    void audit(m, 'stall-cleared', {
      actor, reason: 'segment arrived after a stall warning',
    });
    notifyChanged(m, 'recovered');
  }
  if (impliedActivation) {
    void audit(m, 'activate', {
      actor, priorStatus: 'pending', newStatus: 'recording',
      reason: 'implied by first segment (legacy client compat)',
    });
    notifyChanged(m, 'activated');
    try { hooks?.onActivated?.(m); } catch { /* hook errors never break storage */ }
  }
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

export function stopCapture(id: string, actor?: CaptureActor): Promise<CaptureManifest> {
  return withCaptureLock(id, () => stopCaptureLocked(id, actor));
}

async function stopCaptureLocked(id: string, actor?: CaptureActor): Promise<CaptureManifest> {
  const m = await readManifest(id);
  // Idempotent stop; a still-PENDING capture stays pending (a stop
  // before any recorder ever ran is not a meeting — the TTL sweep
  // fails it in place, and no ingest/announce debris is created).
  if (m.status !== 'recording') return m;
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
  void audit(m, 'stop', { actor, priorStatus: 'recording', newStatus: m.status });
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

/** POST /api/parley/captures/{id}/purge-audio */
export async function handleCapturePurgeAudio(
  _req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try { sendJson(res, 200, { ok: true, capture: await purgeCaptureAudio(id) }); }
  catch (err) { sendError(res, err); }
}

/** Soft-discard — the SAFE deletion verb (postmortem P0 #2). Tombstones
 *  the capture ('discarded', Recently Deleted): the directory, audio,
 *  and transcripts stay on disk, restorable via /restore, until an
 *  explicit /purge or the retention sweep. This is what cancel and
 *  every UI "delete" map to; nothing automatic ever removes bytes. */
export function discardCapture(id: string, actor?: CaptureActor): Promise<CaptureManifest> {
  return withCaptureLock(id, () => discardCaptureLocked(id, actor));
}

async function discardCaptureLocked(id: string, actor?: CaptureActor): Promise<CaptureManifest> {
  const m = await readManifest(id);
  if (m.status === 'discarded') return m;   // idempotent (double-tap, retry)
  const prior = m.status;
  void audit(m, 'discard', { actor, priorStatus: prior, newStatus: 'discarded' });
  m.pre_discard_status = prior;
  m.status = 'discarded';
  m.discarded_at = Date.now();
  if (!m.ended_at) m.ended_at = Date.now();
  await saveManifest(m);
  try { hooks?.onDiscarded?.(id); } catch { /* hook errors never break discard */ }
  notifyChanged(m, 'discarded');
  return m;
}

/** Bring a capture back from Recently Deleted. A capture that was live
 *  when discarded has no recorder anymore — it restores to 'complete'
 *  (it has audio: a real meeting) or 'failed' (empty husk), never to a
 *  phantom 'recording'. */
export function restoreCapture(id: string, actor?: CaptureActor): Promise<CaptureManifest> {
  return withCaptureLock(id, () => restoreCaptureLocked(id, actor));
}

async function restoreCaptureLocked(id: string, actor?: CaptureActor): Promise<CaptureManifest> {
  const m = await readManifest(id);
  if (m.status !== 'discarded') {
    throw new CaptureError(409, `capture ${id} is ${m.status}; only discarded captures can be restored`);
  }
  const prior = m.pre_discard_status;
  const target = (prior === 'complete' || prior === 'failed')
    ? prior
    : (m.segments.length ? 'complete' : 'failed');
  m.status = target;
  if (target === 'failed' && !m.failed_reason) m.failed_reason = 'restored from Recently Deleted with no audio';
  delete m.discarded_at;
  delete m.pre_discard_status;
  await saveManifest(m);
  void audit(m, 'restore', { actor, priorStatus: 'discarded', newStatus: target });
  notifyChanged(m, 'restored');
  return m;
}

/** Irreversible purge — the ONLY verb that removes a capture's bytes
 *  while it still has data, and it requires the capture to already be
 *  in Recently Deleted (two deliberate steps). Unreachable from
 *  automatic/error paths by construction: nothing in this repo calls
 *  it except the HTTP handler (management UI) and the retention sweep
 *  over already-discarded captures. */
export function purgeCapture(id: string, actor?: CaptureActor): Promise<void> {
  return withCaptureLock(id, () => purgeCaptureLocked(id, actor));
}

async function purgeCaptureLocked(id: string, actor?: CaptureActor): Promise<void> {
  const m = await readManifest(id);
  if (m.status !== 'discarded') {
    throw new CaptureError(409, `capture ${id} is ${m.status}; purge requires Recently Deleted — discard it first`);
  }
  // Audit BEFORE destruction, awaited: the record of what was destroyed
  // must be durable even if the process dies mid-rm.
  await audit(m, 'purge', { actor, priorStatus: 'discarded', newStatus: 'purged' });
  await fs.rm(captureDir(m.id), { recursive: true, force: true });
  await rebuildIndex();
  try { hooks?.onDeleted?.(id); } catch { /* hook errors never break purge */ }
  notifyChanged(m, 'deleted');
}

/** Legacy DELETE — SAFETY-MAPPED, never destructive while data exists.
 *
 *  THE incident verb (corrected forensics 2026-08-18): the old client
 *  bundle's pill ✕ fired this raw DELETE against a healthy recording
 *  with ~28 uploaded segments, and the old fs.rm body erased 20
 *  minutes of meeting. Old bundles keep calling this until the next
 *  CAP rebuild, so the SERVER maps the call to safe semantics:
 *
 *    live or segment-bearing  → soft discard (tombstone, restorable)
 *    empty pending            → failed in place (startup rollback)
 *    discarded                → 409 (that's /purge's deliberate job)
 *    terminal empty husk      → actual removal (nothing at stake)
 *
 *  Every call is audited with caller identity — "who deleted this?"
 *  must never be unanswerable again. */
export function deleteCapture(id: string, actor?: CaptureActor): Promise<void> {
  return withCaptureLock(id, () => deleteCaptureLocked(id, actor));
}

async function deleteCaptureLocked(id: string, actor?: CaptureActor): Promise<void> {
  const m = await readManifest(id);   // 404s unknown ids; validates shape
  if (m.status === 'discarded') {
    throw new CaptureError(409, `capture ${id} is in Recently Deleted; use /purge for permanent removal`);
  }
  if (m.segments.length || m.status === 'recording' || m.status === 'transcribing') {
    void audit(m, 'delete', {
      actor, priorStatus: m.status, newStatus: 'discarded',
      reason: actor?.reason || 'legacy DELETE on a live/segment-bearing capture',
      detail: { mapped_to: 'discard' },
    });
    await discardCaptureLocked(id, {
      ...actor,
      reason: actor?.reason || 'legacy DELETE mapped to soft-discard (live/segment-bearing capture)',
    });
    return;
  }
  if (m.status === 'pending') {
    void audit(m, 'delete', {
      actor, priorStatus: 'pending', newStatus: 'failed',
      reason: actor?.reason || 'legacy DELETE on an empty pending capture',
      detail: { mapped_to: 'abort-start' },
    });
    await abortStartCaptureLocked(id, {
      ...actor,
      reason: actor?.reason || 'legacy DELETE on a pending capture (startup rollback) — failed in place',
    });
    return;
  }
  // Terminal (complete/failed) with ZERO segments — an empty husk;
  // removing it destroys no audio.
  await audit(m, 'delete', { actor, priorStatus: m.status, newStatus: 'purged' });
  await fs.rm(captureDir(m.id), { recursive: true, force: true });
  await rebuildIndex();
  try { hooks?.onDeleted?.(id); } catch { /* hook errors never break delete */ }
  notifyChanged(m, 'deleted');
}

/** Default view HIDES Recently Deleted (discarded) captures — lists,
 *  badges, and the one-active check must not see tombstones. Pass
 *  includeDiscarded for the management/Recently-Deleted surfaces and
 *  the index cache. */
export async function listCaptures(opts?: { includeDiscarded?: boolean }): Promise<CaptureSummary[]> {
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(capturesDir())).filter((e) => CAPTURE_ID_RE.test(e));
  } catch {
    return [];   // captures dir not created yet = empty list
  }
  const out: CaptureSummary[] = [];
  for (const id of entries) {
    try {
      const row = summarize(await readManifest(id));
      if (row.status === 'discarded' && !opts?.includeDiscarded) continue;
      out.push(row);
    } catch { /* torn/missing manifest → skip the row, don't 500 the list */ }
  }
  out.sort((a, b) => b.started_at - a.started_at);
  return out;
}

/** Cross-device capture state (pill on the laptop while the phone
 *  records, list refreshes) rides the same fanout as everything else.
 *  `kind` distinguishes lifecycle steps so clients can badge/update
 *  without refetching on every segment. */
function notifyChanged(
  m: CaptureManifest,
  kind: 'created' | 'activated' | 'patched' | 'stopped' | 'completed' | 'discarded' | 'restored' | 'deleted' | 'stalled' | 'recovered',
): void {
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

/** Caller identity for the audit log (postmortem P0 #3: handlers must
 *  stop ignoring `_req`). `x-parley-client` is the cooperative
 *  self-identification header the PWA recorder sends; UA + remote are
 *  what the transport knows regardless.
 * */
function actorFromReq(req: IncomingMessage, reason?: string): CaptureActor {
  const src = req.headers['x-parley-client'];
  const fwd = req.headers['x-forwarded-for'];
  return {
    source: typeof src === 'string' && src ? src : 'api',
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    remote: typeof fwd === 'string' && fwd ? fwd : (req.socket?.remoteAddress ?? undefined),
    ...(reason ? { reason } : {}),
  };
}

// A single 45s segment at 32kbps is ~180KB; iOS can ignore the bitrate
// hint and emit much fatter AAC (chunkedTranscribe's SIZE_THRESHOLD
// lesson), and interruption-sealed segments can be long. 32MB is a
// generous ceiling that still stops a runaway client.
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;

/** POST /api/parley/captures — start. Body {title?, linked_chat?, diarize?}.
 *  linked_chat: "new" mints a fresh session id (the PWA's chats are
 *  lazily created server-side on first message, so minting = issuing
 *  an id in the same `parley:<uuid>` shape the composer's new-chat
 *  path uses — see src/main.ts new-chat). */
export async function handleCaptureCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson(req);
    let linkedChat: string | null = null;
    let mintedSession = false;
    if (body.linked_chat === 'new') {
      linkedChat = `parley:${crypto.randomUUID()}`;
      mintedSession = true;
    } else if (typeof body.linked_chat === 'string' && body.linked_chat) linkedChat = body.linked_chat;
    const manifest = await createCapture({
      title: typeof body.title === 'string' ? body.title : undefined,
      linkedChat,
      mintedSession,
      diarize: typeof body.diarize === 'boolean' ? body.diarize : undefined,
      autoIngest: typeof body.auto_ingest === 'boolean' ? body.auto_ingest : undefined,
      actor: actorFromReq(req),
    });
    sendJson(res, 201, { capture: manifest });
  } catch (err) { sendError(res, err); }
}

/** POST /api/parley/captures/{id}/activate — the client proved a
 *  running recorder (mic acquired, MediaRecorder.start() succeeded).
 *  pending→recording, once; fires the "Recording started" hook. */
export async function handleCaptureActivate(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    sendJson(res, 200, { capture: await activateCapture(id, actorFromReq(req)) });
  } catch (err) { sendError(res, err); }
}

/** POST /api/parley/captures/{id}/abort-start — body {reason}.
 *  Startup failed before a recorder ran: fail the pending capture IN
 *  PLACE. Never deletes; never touches an activated capture. */
export async function handleCaptureAbortStart(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    const body = await readJson(req);
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    sendJson(res, 200, { capture: await abortStartCapture(id, actorFromReq(req, reason)) });
  } catch (err) { sendError(res, err); }
}

/** POST /api/parley/captures/{id}/discard — body {reason?}. Soft
 *  delete to Recently Deleted; recoverable via /restore. */
export async function handleCaptureDiscard(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    const body = await readJson(req);
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    sendJson(res, 200, { capture: await discardCapture(id, actorFromReq(req, reason)) });
  } catch (err) { sendError(res, err); }
}

/** POST /api/parley/captures/{id}/restore — undo a discard. */
export async function handleCaptureRestore(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    sendJson(res, 200, { capture: await restoreCapture(id, actorFromReq(req)) });
  } catch (err) { sendError(res, err); }
}

/** POST /api/parley/captures/{id}/purge — deliberate irreversible
 *  deletion of a capture already in Recently Deleted. Management-UI
 *  verb; 409 for anything not discarded. */
export async function handleCapturePurge(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    const body = await readJson(req);
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    await purgeCapture(id, actorFromReq(req, reason));
    sendJson(res, 200, { ok: true, purged: id });
  } catch (err) { sendError(res, err); }
}

/** POST /api/parley/captures/{id}/segments/{seq} — raw bytes.
 *  Headers: content-type (segment mime), x-parley-t0-ms,
 *  x-parley-sha256 (optional integrity check). */
export async function handleCaptureSegment(
  req: IncomingMessage, res: ServerResponse, id: string, seqRaw: string,
): Promise<void> {
  try {
    const seq = Number(seqRaw);
    const body = await readBody(req, MAX_SEGMENT_BYTES);
    const { duplicate } = await putSegment(id, seq, body, {
      t0Ms: Number(req.headers['x-parley-t0-ms'] ?? 0),
      mime: String(req.headers['content-type'] || 'application/octet-stream'),
      sha256: typeof req.headers['x-parley-sha256'] === 'string'
        ? req.headers['x-parley-sha256'] : undefined,
    }, actorFromReq(req));
    sendJson(res, 200, { ok: true, seq, duplicate });
  } catch (err) { sendError(res, err); }
}

/** POST /api/parley/captures/{id}/stop */
export async function handleCaptureStop(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try { sendJson(res, 200, { capture: await stopCapture(id, actorFromReq(req)) }); }
  catch (err) { sendError(res, err); }
}

/** PATCH /api/parley/captures/{id} — rename / re-link / diarize
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

/** DELETE /api/parley/captures/{id} — legacy hard delete, now guarded
 *  (postmortem P0 #2): 409 for live/discarded/segment-bearing captures;
 *  only a terminal zero-segment husk is removable here. Real deletion
 *  is the two-step /discard → /purge lane. */
export async function handleCaptureDelete(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    await deleteCapture(id, actorFromReq(req));
    sendJson(res, 200, { ok: true, deleted: id });
  } catch (err) { sendError(res, err); }
}

/** POST /api/parley/captures/{id}/marks — {t_ms} */
export async function handleCaptureMark(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    const body = await readJson(req);
    const manifest = await addMark(id, Number(body.t_ms));
    sendJson(res, 200, { ok: true, marks: manifest.marks });
  } catch (err) { sendError(res, err); }
}

/** GET /api/parley/captures[?include=discarded] — default view hides
 *  Recently Deleted; the management surface opts in. */
export async function handleCaptureList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const includeDiscarded = /[?&]include=discarded\b/.test(req.url || '');
    sendJson(res, 200, { captures: await listCaptures({ includeDiscarded }) });
  } catch (err) { sendError(res, err); }
}

/** GET /api/parley/captures/{id} */
export async function handleCaptureGet(
  _req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try { sendJson(res, 200, { capture: await getCapture(id) }); }
  catch (err) { sendError(res, err); }
}

/** GET /api/parley/captures/{id}/transcript — the transcript as data,
 *  not fanout. The finished doc_show push is a ONE-SHOT SSE envelope:
 *  a client that wasn't connected when the meeting ended misses it
 *  (the 128-entry replay ring churns fast — every reply_delta rides
 *  it) and its localStorage-persisted shelf doc stays titled "(live)"
 *  forever ("Meeting 2026-08-24 (live)" field report 2026-08-26; same
 *  missed-envelope class as the answered-question replay bug fixed
 *  2026-08-25). This endpoint lets any client reconcile a persisted
 *  capture doc against reality on demand.
 *
 *  200 {capture_id, status, title, format:'markdown', content};
 *  discarded → status + title WITHOUT content (Recently Deleted — the
 *  client should drop its shelf entry, not resurrect the words);
 *  404 when the capture or its transcript file doesn't exist. */
export async function handleCaptureTranscript(
  _req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    const m = await readManifest(id);   // CaptureError(404) on unknown ids
    if (m.status === 'discarded') {
      sendJson(res, 200, { capture_id: m.id, status: m.status, title: m.title });
      return;
    }
    let content: string;
    try {
      content = await fs.readFile(transcriptFilePath(id), 'utf8');
    } catch {
      throw new CaptureError(404, `capture ${id} has no transcript`);
    }
    sendJson(res, 200, {
      capture_id: m.id,
      status: m.status,
      title: m.title,
      format: 'markdown',
      content,
    });
  } catch (err) { sendError(res, err); }
}

/** POST /api/parley/captures/control — {action: 'start'|'stop', ...}.
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
