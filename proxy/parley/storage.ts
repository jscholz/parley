// Storage governance (2026-10-24). Field: "something that keeps it from
// just growing open-endedly without me realizing it until it overloads
// my hard drive … build the feedback mechanism into the UX so that it's
// easy to see how big ParleyDB is and what needs to be purged … settings
// in the config file that control automated TTLs."
//
// Three parts, all here:
//   1. inventory()  — what lives under the data home, by category, with
//      sizes, counts and the oldest item (served to Settings › Storage
//      and to the daily health digest).
//   2. policy       — `<dataHome>/storage-policy.json`: TTLs per category
//      plus a total ceiling; editable from the UI; generous defaults.
//   3. sweep()      — applies the policy: capture AUDIO older than its TTL
//      is purged through capture.ts's own purgeCaptureAudio (manifest
//      marked audio_purged, transcript kept); uploads older than their
//      TTL are deleted leaving a `.purged` marker so the bubble's chip can
//      say the file is no longer stored; if the total still exceeds the
//      ceiling, the oldest of those two categories go next. Runs on a
//      timer (hourly check, acts at most once a day) and on demand.
//
// Transcripts, manifests, docs and the small JSON stores are NEVER
// swept: they are the record. Only bulk media is.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { dataHome } from '../dataHome.mjs';
import { purgeCaptureAudio } from './capture.ts';
import { uploadsRoot } from './uploads.ts';

export type Category = 'capture_audio' | 'capture_text' | 'uploads' | 'logs' | 'other';

export interface CategoryStat {
  bytes: number;
  files: number;
  /** epoch ms of the oldest file (mtime) — null when empty. */
  oldest: number | null;
  /** Items (captures / upload message dirs) — the unit a TTL acts on. */
  items: number;
}

export interface StoragePolicy {
  /** Days a finished meeting keeps its raw audio. 0 = keep forever. */
  captureAudioTtlDays: number;
  /** Days an attachment file is kept. 0 = keep forever. */
  uploadsTtlDays: number;
  /** Hard ceiling for the swept categories combined (MB). 0 = none. When
   *  exceeded after TTLs, the oldest audio/uploads go until under it. */
  maxTotalMb: number;
  /** Master switch for the automatic sweep. */
  autoSweep: boolean;
}

export const DEFAULT_POLICY: StoragePolicy = {
  captureAudioTtlDays: 365,
  uploadsTtlDays: 365,
  maxTotalMb: 20_000,
  autoSweep: true,
};

export interface SweepResult {
  ranAt: number;
  dryRun: boolean;
  capturesPurged: string[];
  uploadsPurged: string[];
  bytesFreed: number;
  ceilingHit: boolean;
  errors: string[];
}

export interface StorageReport {
  dataHome: string;
  categories: Record<Category, CategoryStat>;
  totalBytes: number;
  /** Bytes the sweep is allowed to act on (audio + uploads). */
  sweepableBytes: number;
  disk: { free: number; size: number } | null;
  policy: StoragePolicy;
  lastSweep: SweepResult | null;
  /** What a sweep would do right now, without doing it. */
  due: { captures: number; uploads: number; bytes: number };
}

const MS_PER_DAY = 86_400_000;
const AUDIO_RE = /\.(m4a|webm|wav|bin|mp3|ogg|opus)$/i;

let homeResolver: () => string = () => dataHome();
/** Test seam: point the whole module at a scratch data home. */
export function setStorageHomeForTests(fn: (() => string) | null): void {
  homeResolver = fn ?? (() => dataHome());
}
function home(): string { return homeResolver(); }
function policyPath(): string { return path.join(home(), 'storage-policy.json'); }
function lastSweepPath(): string { return path.join(home(), 'storage-last-sweep.json'); }
function capturesDir(): string { return path.join(home(), 'captures'); }
function uploadsDir(): string {
  // uploads.ts resolves its own root (tests redirect it); when the home is
  // redirected for tests, derive from it instead so both agree.
  return homeResolver === defaultHome ? uploadsRoot() : path.join(home(), 'uploads');
}
const defaultHome = homeResolver;

// ── policy ──────────────────────────────────────────────────────────

function clampPolicy(p: Partial<StoragePolicy> | null | undefined): StoragePolicy {
  const num = (v: unknown, d: number, max: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : d;
    return Math.max(0, Math.min(max, n));
  };
  return {
    captureAudioTtlDays: num(p?.captureAudioTtlDays, DEFAULT_POLICY.captureAudioTtlDays, 36_500),
    uploadsTtlDays: num(p?.uploadsTtlDays, DEFAULT_POLICY.uploadsTtlDays, 36_500),
    maxTotalMb: num(p?.maxTotalMb, DEFAULT_POLICY.maxTotalMb, 10_000_000),
    autoSweep: typeof p?.autoSweep === 'boolean' ? p.autoSweep : DEFAULT_POLICY.autoSweep,
  };
}

export async function readPolicy(): Promise<StoragePolicy> {
  try {
    const raw = JSON.parse(await fs.readFile(policyPath(), 'utf8'));
    return clampPolicy(raw);
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export async function writePolicy(patch: Partial<StoragePolicy>): Promise<StoragePolicy> {
  const next = clampPolicy({ ...(await readPolicy()), ...patch });
  await fs.mkdir(home(), { recursive: true });
  const tmp = policyPath() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(next, null, 2));
  await fs.rename(tmp, policyPath());
  return next;
}

// ── inventory ───────────────────────────────────────────────────────

async function walk(dir: string, visit: (file: string, st: { size: number; mtimeMs: number }) => void): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { await walk(p, visit); continue; }
    if (!e.isFile()) continue;
    try {
      const st = await fs.stat(p);
      visit(p, { size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* vanished mid-walk */ }
  }
}

function emptyStat(): CategoryStat { return { bytes: 0, files: 0, oldest: null, items: 0 }; }
function add(stat: CategoryStat, size: number, mtimeMs: number): void {
  stat.bytes += size; stat.files += 1;
  if (stat.oldest == null || mtimeMs < stat.oldest) stat.oldest = mtimeMs;
}

interface CaptureAudioItem { id: string; bytes: number; endedAt: number; }
interface UploadItem { umsg: string; bytes: number; mtimeMs: number; }

async function listCaptureAudio(): Promise<CaptureAudioItem[]> {
  const out: CaptureAudioItem[] = [];
  let ids: string[];
  try { ids = (await fs.readdir(capturesDir())).filter((n) => n.startsWith('cap_')); } catch { return out; }
  for (const id of ids) {
    const dir = path.join(capturesDir(), id);
    let m: any = null;
    try { m = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')); } catch { continue; }
    if (m.status !== 'complete' && m.status !== 'failed') continue;   // live meetings are untouchable
    if (m.audio_purged) continue;
    let bytes = 0;
    await walk(dir, (f, st) => { if (AUDIO_RE.test(f) || /\/audio\./.test(f)) bytes += st.size; });
    if (!bytes) continue;
    out.push({ id, bytes, endedAt: Number(m.ended_at || m.started_at || 0) });
  }
  return out;
}

async function listUploads(): Promise<UploadItem[]> {
  const out: UploadItem[] = [];
  let dirs: string[];
  try { dirs = await fs.readdir(uploadsDir()); } catch { return out; }
  for (const umsg of dirs) {
    const dir = path.join(uploadsDir(), umsg);
    let bytes = 0; let newest = 0; let any = false;
    await walk(dir, (f, st) => {
      if (f.endsWith('.purged')) return;
      any = true; bytes += st.size; newest = Math.max(newest, st.mtimeMs);
    });
    if (!any) continue;
    out.push({ umsg, bytes, mtimeMs: newest });
  }
  return out;
}

export async function inventory(): Promise<StorageReport> {
  const categories: Record<Category, CategoryStat> = {
    capture_audio: emptyStat(), capture_text: emptyStat(), uploads: emptyStat(), logs: emptyStat(), other: emptyStat(),
  };
  const root = home();
  let entries: import('node:fs').Dirent[] = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { /* fresh install */ }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.name === 'captures') {
      await walk(p, (f, st) => add(AUDIO_RE.test(f) || /\/audio\./.test(f) ? categories.capture_audio : categories.capture_text, st.size, st.mtimeMs));
    } else if (e.name === 'uploads') {
      await walk(p, (f, st) => { if (!f.endsWith('.purged')) add(categories.uploads, st.size, st.mtimeMs); });
    } else if (e.name === 'logs') {
      await walk(p, (_f, st) => add(categories.logs, st.size, st.mtimeMs));
    } else if (e.isDirectory()) {
      await walk(p, (_f, st) => add(categories.other, st.size, st.mtimeMs));
    } else if (e.isFile()) {
      try { const st = await fs.stat(p); add(categories.other, st.size, st.mtimeMs); } catch { /* gone */ }
    }
  }
  const audioItems = await listCaptureAudio();
  const uploadItems = await listUploads();
  categories.capture_audio.items = audioItems.length;
  categories.uploads.items = uploadItems.length;
  try { categories.capture_text.items = (await fs.readdir(capturesDir())).filter((n) => n.startsWith('cap_')).length; } catch { /* none */ }
  const totalBytes = Object.values(categories).reduce((s, c) => s + c.bytes, 0);
  const policy = await readPolicy();
  const plan = planSweep(policy, audioItems, uploadItems, Date.now());
  let disk: StorageReport['disk'] = null;
  try {
    const sf = await (fs as any).statfs(root);
    disk = { free: Number(sf.bavail) * Number(sf.bsize), size: Number(sf.blocks) * Number(sf.bsize) };
  } catch { /* statfs unavailable */ }
  let lastSweep: SweepResult | null = null;
  try { lastSweep = JSON.parse(await fs.readFile(lastSweepPath(), 'utf8')); } catch { /* never */ }
  return {
    dataHome: root,
    categories,
    totalBytes,
    sweepableBytes: categories.capture_audio.bytes + categories.uploads.bytes,
    disk,
    policy,
    lastSweep,
    due: { captures: plan.captures.length, uploads: plan.uploads.length, bytes: plan.bytes },
  };
}

// ── sweep ───────────────────────────────────────────────────────────

/** Pure planner: which captures' audio and which upload dirs go, under
 *  this policy, at this moment. TTLs first; then the ceiling takes the
 *  oldest remaining until the swept categories fit. */
export function planSweep(
  policy: StoragePolicy, audio: CaptureAudioItem[], uploads: UploadItem[], now: number,
): { captures: string[]; uploads: string[]; bytes: number; ceilingHit: boolean } {
  const captures = new Set<string>();
  const umsgs = new Set<string>();
  let bytes = 0;
  if (policy.captureAudioTtlDays > 0) {
    const cutoff = now - policy.captureAudioTtlDays * MS_PER_DAY;
    for (const a of audio) if (a.endedAt && a.endedAt < cutoff) { captures.add(a.id); bytes += a.bytes; }
  }
  if (policy.uploadsTtlDays > 0) {
    const cutoff = now - policy.uploadsTtlDays * MS_PER_DAY;
    for (const u of uploads) if (u.mtimeMs < cutoff) { umsgs.add(u.umsg); bytes += u.bytes; }
  }
  let ceilingHit = false;
  if (policy.maxTotalMb > 0) {
    const ceiling = policy.maxTotalMb * 1024 * 1024;
    let remaining = audio.filter((a) => !captures.has(a.id)).reduce((s, a) => s + a.bytes, 0)
      + uploads.filter((u) => !umsgs.has(u.umsg)).reduce((s, u) => s + u.bytes, 0);
    if (remaining > ceiling) {
      ceilingHit = true;
      const pool: Array<{ kind: 'c' | 'u'; key: string; bytes: number; at: number }> = [
        ...audio.filter((a) => !captures.has(a.id)).map((a) => ({ kind: 'c' as const, key: a.id, bytes: a.bytes, at: a.endedAt })),
        ...uploads.filter((u) => !umsgs.has(u.umsg)).map((u) => ({ kind: 'u' as const, key: u.umsg, bytes: u.bytes, at: u.mtimeMs })),
      ].sort((x, y) => x.at - y.at);
      for (const it of pool) {
        if (remaining <= ceiling) break;
        if (it.kind === 'c') captures.add(it.key); else umsgs.add(it.key);
        remaining -= it.bytes; bytes += it.bytes;
      }
    }
  }
  return { captures: Array.from(captures), uploads: Array.from(umsgs), bytes, ceilingHit };
}

async function purgeUploadDir(umsg: string): Promise<number> {
  const dir = path.join(uploadsDir(), umsg);
  let freed = 0;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name.endsWith('.purged')) continue;
    const p = path.join(dir, name);
    try {
      const st = await fs.stat(p);
      if (!st.isFile()) continue;
      await fs.unlink(p);
      freed += st.size;
      // The marker keeps the chip honest: "<name> — no longer stored".
      await fs.writeFile(`${p}.purged`, JSON.stringify({ purgedAt: Date.now(), size: st.size }));
    } catch { /* best-effort */ }
  }
  return freed;
}

let sweeping: Promise<SweepResult> | null = null;

export function sweep(opts: { dryRun?: boolean; reason?: string } = {}): Promise<SweepResult> {
  if (sweeping) return sweeping;
  sweeping = (async () => {
    const policy = await readPolicy();
    const now = Date.now();
    const audio = await listCaptureAudio();
    const uploads = await listUploads();
    const plan = planSweep(policy, audio, uploads, now);
    const result: SweepResult = {
      ranAt: now, dryRun: !!opts.dryRun, capturesPurged: [], uploadsPurged: [], bytesFreed: 0,
      ceilingHit: plan.ceilingHit, errors: [],
    };
    if (opts.dryRun) {
      result.capturesPurged = plan.captures; result.uploadsPurged = plan.uploads; result.bytesFreed = plan.bytes;
      return result;
    }
    const audioBytes = new Map(audio.map((a) => [a.id, a.bytes]));
    for (const id of plan.captures) {
      try { await purgeCaptureAudio(id); result.capturesPurged.push(id); result.bytesFreed += audioBytes.get(id) ?? 0; }
      catch (e) { result.errors.push(`${id}: ${String((e as Error)?.message || e)}`); }
    }
    for (const umsg of plan.uploads) {
      try { result.bytesFreed += await purgeUploadDir(umsg); result.uploadsPurged.push(umsg); }
      catch (e) { result.errors.push(`${umsg}: ${String((e as Error)?.message || e)}`); }
    }
    if (result.capturesPurged.length || result.uploadsPurged.length || result.errors.length) {
      console.log(`[storage] sweep (${opts.reason || 'manual'}): ${result.capturesPurged.length} capture audio, ${result.uploadsPurged.length} upload dirs, ${(result.bytesFreed / 1e6).toFixed(1)} MB freed${result.ceilingHit ? ' (ceiling)' : ''}${result.errors.length ? `, ${result.errors.length} error(s)` : ''}`);
    }
    try { await fs.writeFile(lastSweepPath(), JSON.stringify(result)); } catch { /* diagnostics only */ }
    return result;
  })().finally(() => { sweeping = null; });
  return sweeping;
}

// ── scheduler ───────────────────────────────────────────────────────

const SWEEP_CHECK_MS = 60 * 60_000;
const SWEEP_EVERY_MS = 24 * 60 * 60_000;
let timer: NodeJS.Timeout | null = null;

/** Hourly tick; a real sweep at most once a day, and only when the
 *  policy's master switch is on. Called once from server boot. */
export function startStorageScheduler(): void {
  if (timer) return;
  const tick = async () => {
    try {
      const policy = await readPolicy();
      if (!policy.autoSweep) return;
      let last = 0;
      try { last = JSON.parse(await fs.readFile(lastSweepPath(), 'utf8')).ranAt || 0; } catch { /* never */ }
      if (Date.now() - last < SWEEP_EVERY_MS) return;
      await sweep({ reason: 'scheduled' });
    } catch (e) {
      console.warn(`[storage] scheduled sweep failed: ${String((e as Error)?.message || e)}`);
    }
  };
  timer = setInterval(() => { void tick(); }, SWEEP_CHECK_MS);
  timer.unref?.();
  setTimeout(() => { void tick(); }, 5 * 60_000).unref?.();
}

// ── HTTP ────────────────────────────────────────────────────────────

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

/** GET /api/parley/storage */
export async function handleStorageGet(_req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  try { sendJson(res, 200, await inventory()); }
  catch (e) { sendJson(res, 500, { error: String((e as Error)?.message || e) }); }
}

/** PUT /api/parley/storage/policy  { captureAudioTtlDays?, uploadsTtlDays?, maxTotalMb?, autoSweep? } */
export async function handleStoragePolicyPut(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'invalid_body' });
  try { sendJson(res, 200, { ok: true, policy: await writePolicy(body) }); }
  catch (e) { sendJson(res, 500, { error: String((e as Error)?.message || e) }); }
}

/** POST /api/parley/storage/sweep  { dryRun?: boolean } */
export async function handleStorageSweep(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  const body = (await readBody(req)) || {};
  try { sendJson(res, 200, { ok: true, result: await sweep({ dryRun: !!body.dryRun, reason: 'ui' }) }); }
  catch (e) { sendJson(res, 500, { error: String((e as Error)?.message || e) }); }
}

/** POST /api/parley/storage/purge  { category: 'capture_audio'|'uploads', olderThanDays: number }
 *  A one-off purge at a different age than the policy — the "purge now"
 *  verb in Settings. Confirmed in the UI; here it just does it. */
export async function handleStoragePurge(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  const body = await readBody(req);
  const category = body?.category;
  const days = Number(body?.olderThanDays);
  if ((category !== 'capture_audio' && category !== 'uploads') || !Number.isFinite(days) || days < 0) {
    return sendJson(res, 400, { error: 'invalid_body', detail: 'category ∈ {capture_audio, uploads}, olderThanDays ≥ 0' });
  }
  const now = Date.now();
  const cutoff = now - days * MS_PER_DAY;
  const result: SweepResult = { ranAt: now, dryRun: false, capturesPurged: [], uploadsPurged: [], bytesFreed: 0, ceilingHit: false, errors: [] };
  try {
    if (category === 'capture_audio') {
      for (const a of await listCaptureAudio()) {
        if (!a.endedAt || a.endedAt >= cutoff) continue;
        try { await purgeCaptureAudio(a.id); result.capturesPurged.push(a.id); result.bytesFreed += a.bytes; }
        catch (e) { result.errors.push(`${a.id}: ${String((e as Error)?.message || e)}`); }
      }
    } else {
      for (const u of await listUploads()) {
        if (u.mtimeMs >= cutoff) continue;
        try { result.bytesFreed += await purgeUploadDir(u.umsg); result.uploadsPurged.push(u.umsg); }
        catch (e) { result.errors.push(`${u.umsg}: ${String((e as Error)?.message || e)}`); }
      }
    }
    console.log(`[storage] purge ${category} older than ${days}d: ${result.capturesPurged.length + result.uploadsPurged.length} item(s), ${(result.bytesFreed / 1e6).toFixed(1)} MB`);
    try { await fs.writeFile(lastSweepPath(), JSON.stringify(result)); } catch { /* diagnostics only */ }
    sendJson(res, 200, { ok: true, result });
  } catch (e) {
    sendJson(res, 500, { error: String((e as Error)?.message || e) });
  }
}
