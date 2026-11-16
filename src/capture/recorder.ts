// Meeting capture ORCHESTRATOR — the platform-neutral half of capture
// (plan §3.2; split from the engine 2026-11-16, see engine.ts).
//
// Owns: the capture's identity and durable ledger, the server
// conversation (register / activate / marks / stop, via the shared
// uploader), the UI state the pill renders, health pings, and the one
// verdict the server IS allowed to hand down — that a capture has been
// finalized/discarded elsewhere, so a recorder describing it must stand
// down. Everything about the microphone, segmentation, durability of
// audio and its delivery belongs to the engine (engines/web.ts or
// engines/native.ts) and is reached only through the engine contract.
//
// App-global by design: nothing here is chat-scoped, so recording
// survives session switches (§3.6 multisession property; pinned by the
// capture-pill-survives-session-switch smoke).

import {
  putSegment, putPartialSegment, removeSegment, segmentKey, finalizePartials, clearExpired,
  putLedger, getLedger, updateLedger, removeLedger,
} from './segmentStore.ts';
import { mintChatId } from '../conversations.ts';
import { createUploader, type Uploader } from './uploader.ts';
import * as syncStatus from './syncStatus.ts';
import { apiUrl } from '../apiBase.ts';
import { log } from '../util/log.ts';
import * as settings from '../settings.ts';
import { selectEngineKind, type CaptureEngine, type EngineState, type EngineStateDetail } from './engine.ts';
import { createWebEngine, type WebSegmentSink } from './engines/web.ts';
import { createNativeEngine, resolveNativePlugin } from './engines/native.ts';

export interface CaptureUiState {
  active: boolean;
  captureId: string | null;
  title: string;
  chatId: string | null;
  /** epoch ms of capture start (timer renders from this). */
  startedAt: number;
  /** Pill copy + button states. 'starting' is the HONEST startup phase
   *  (postmortem 2026-08-18): mic acquisition + recorder start are in
   *  flight — "Starting microphone…", active stays false, nothing has
   *  announced success anywhere. 'paused' is USER-deliberate (pause
   *  button — mic fully released, OS indicator goes dark);
   *  'interrupted' is INVOLUNTARY (call/Siri stole the mic — amber,
   *  the engine is re-acquiring). Distinct on purpose: auto-resume after
   *  a deliberate pause would be a privacy bug. */
  /** 'failed' (2026-08-27) is the HONEST terminal state for a recording
   *  the server has written off while the client still believed in it. */
  phase: 'idle' | 'starting' | 'recording' | 'paused' | 'interrupted' | 'finishing' | 'failed';
  /** User-facing explanation for 'failed'. Shown, not swallowed. */
  failedReason?: string;
  uploaderPending: number;
  sealedSegments: number;
  marks: number;
  /** Wall-clock ms spent paused/interrupted so far (completed spans). */
  stalledTotalMs: number;
  /** Chunk feedback (field 2026-11-02, capture/chunkProgress.ts): when the
   *  running chunk started (0 = none running), how many sealed chunks the
   *  server has acked, and how many transcript pushes have landed for
   *  this capture. The pill's pie and ring render from these. */
  segmentStartedAt: number;
  segmentMs: number;
  uploadedSegments: number;
  landedSegments: number;
  /** The server has acknowledged this capture (create acked). False
   *  from an offline start until the uploader registers it — the
   *  recording is real either way; this only gates server-side extras
   *  (health pings, live transcript, the start announcement). */
  registered: boolean;
  /** Last upload attempt could not reach the server. Audio keeps
   *  buffering locally; the pill says so ("Offline — saving locally"). */
  offline: boolean;
  /** Start of the CURRENT paused/interrupted span (null while
   *  recording). The pill timer shows RECORDED time — it freezes
   *  during pause (field nit 2026-07-09) — while segment t0/marks stay
   *  wall-relative so transcript offsets line up with real gaps. */
  stalledSince: number | null;
  /** Which engine is recording ('web' | 'native'); null when idle. */
  engine: 'web' | 'native' | null;
}

export const SEGMENT_MS = 45_000;

/** Local IDB retention for parked/orphaned segments — mirrors the
 *  server's Recently Deleted window, so a discarded capture's
 *  un-uploaded tail stays recoverable exactly as long as the server
 *  copy does. */
const LOCAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How long the 'nothing was saved' pill stays up. */
const FAILED_PILL_MS = 90_000;

const HEALTH_PING_MS = 30_000;

/** Lifecycle calls self-identify for the server's capture audit log
 *  (postmortem P0 #3 — "who called this?" must never be unknowable
 *  again). */
function lifecycleHeaders(json = false): Record<string, string> {
  return {
    'x-parley-client': 'pwa-recorder',
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

const IDLE_STATE: CaptureUiState = {
  active: false, captureId: null, title: '', chatId: null,
  startedAt: 0, phase: 'idle', uploaderPending: 0, sealedSegments: 0, marks: 0,
  stalledTotalMs: 0, stalledSince: null, segmentStartedAt: 0, segmentMs: SEGMENT_MS, uploadedSegments: 0, landedSegments: 0, registered: false, offline: false,
  engine: null,
};

let state: CaptureUiState = { ...IDLE_STATE };
let uploader: Uploader | null = null;
let engine: CaptureEngine | null = null;
/** Monotonic id of the current start attempt — see startMeetingCapture. */
let startEpoch = 0;
let healthTimer: number | null = null;
let failedDismissTimer: number | null = null;
/** Ack listeners the web sink registers (uploader → engine → counters). */
const ackListeners: Array<(captureId: string, seq: number) => void> = [];
/** Build stamp for health pings — set by main.ts once version.json is
 *  read, so the server's audit can tell an old bundle from a bug. */
let buildStamp: string | null = null;

// A transcript push for THIS capture (backendEventHandlers doc.show →
// 'parley:capture-doc') means a chunk's words reached the shelf.
if (typeof window !== 'undefined') {
  window.addEventListener('parley:capture-doc', (ev) => {
    const id = (ev as CustomEvent<{ captureId?: string }>).detail?.captureId;
    if (!id || !state.active || id !== state.captureId) return;
    state.landedSegments = Math.min(state.sealedSegments, state.landedSegments + 1);
    emit();
  });
}

function emit(): void {
  try {
    window.dispatchEvent(new CustomEvent('parley:capture-state', { detail: { ...state } }));
  } catch { /* non-browser */ }
}

export function getCaptureState(): CaptureUiState { return { ...state }; }

/** The engine's own diagnostic snapshot (what the health ping carries).
 *  Smokes read it to prove the recorder is still recording after a
 *  server verdict that must NOT stop it. */
export function getEngineHealth(): Record<string, unknown> | null { return engine ? engine.health() : null; }

export function setBuildStamp(stamp: string | null): void { buildStamp = stamp; }

/** Read the bundle's own stamp once (relative URL: the CAP shell reads
 *  ITS bundled copy, not the server's). Best-effort; null is honest. */
function loadBuildStamp(): void {
  if (buildStamp != null || typeof fetch !== 'function') return;
  buildStamp = '';
  fetch('build/version.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((v) => { buildStamp = typeof v?.sha === 'string' ? v.sha : null; })
    .catch(() => { buildStamp = null; });
}

// ── engine selection ──────────────────────────────────────────────────

function webSink(): WebSegmentSink {
  return {
    persist: (seg) => putSegment(seg),
    persistPartial: (seg) => putPartialSegment(seg),
    remove: (captureId, seq) => removeSegment(segmentKey(captureId, seq)),
    kick: () => { ensureUploader().kick(); },
    pendingUploads: () => uploader?.pendingCount() ?? 0,
    drained: () => ensureUploader().drained(),
    onUploaded: (cb) => { ackListeners.push(cb); },
  };
}

function ensureEngine(): CaptureEngine {
  if (engine) return engine;
  if (selectEngineKind() === 'native') {
    const plugin = resolveNativePlugin();
    if (plugin) {
      engine = createNativeEngine(plugin);
      log('[capture] engine: native (ParleyRecorder plugin)');
      return engine;
    }
  }
  engine = createWebEngine(webSink());
  log('[capture] engine: web (MediaRecorder)');
  return engine;
}

/** Test seam: swap the engine (node:test drives a fake). Never product code. */
export function _setEngineForTests(e: CaptureEngine | null): void { engine = e; }

function ensureUploader(): Uploader {
  if (uploader) return uploader;
  uploader = createUploader({
    onDrained: () => { state.uploaderPending = 0; state.uploadedSegments = state.sealedSegments; emit(); },
    onDropped: () => { syncPending(); },
    onAcked: (seg) => { for (const cb of ackListeners) cb(seg.captureId, seg.seq); },
    externalPending: (captureId) => (engine?.kind === 'native' ? engine.pendingUploads(captureId) : 0),
    onNetwork: (online) => {
      syncStatus.reportNetwork(online);
      if (state.offline === !online) return;
      state.offline = !online;
      emit();
    },
    onProgress: (info) => { syncStatus.reportUploader(info); },
    onRegistered: (entry, capture) => {
      log(`[capture] ${entry.id}: registered with the server${capture?.linked_chat ? ` chat=${capture.linked_chat}` : ''}`);
      if (entry.id !== state.captureId) return;
      state.registered = true;
      if (capture?.title && !state.title) state.title = capture.title;
      if (capture?.linked_chat) state.chatId = capture.linked_chat;
      emit();
      if (state.active) {
        startHealthPings();
        startResumeReconcile();
        engine?.kick();     // a native engine may have segments waiting on registration
      }
    },
    onRegisterFailed: (entry, reason) => {
      log(`[capture] ${entry.id}: server refused the capture — ${reason}`);
      if (entry.id !== state.captureId || !state.active) return;
      void forceLocalStop('refused', `The server refused this recording (${reason}). Audio is kept on this device.`);
    },
    onStopped: (captureId, title) => {
      log(`[capture] ${captureId}: deferred stop landed`);
      syncStatus.reportStopped(captureId, title);
    },
  });
  syncStatus.initSyncStatus();
  try {
    window.addEventListener('online', () => { uploader?.kick(); engine?.kick(); });
  } catch { /* non-browser */ }
  return uploader;
}

/** Queue depth across the engine's durable store and the ledger uploader. */
function syncPending(): void {
  state.uploaderPending = engine?.pendingUploads(state.captureId ?? undefined) ?? uploader?.pendingCount() ?? 0;
  state.uploadedSegments = Math.max(state.uploadedSegments, state.sealedSegments - state.uploaderPending);
  emit();
}

/** Boot-time: expire retention-window-old segments, then drain any a
 *  previous session left behind. Cheap no-op when nothing is buffered. */
export function resumePendingUploads(): void {
  void clearExpired(LOCAL_RETENTION_MS)
    .catch(() => 0)
    .then(async (n) => {
      if (n) log(`[capture] dropped ${n} buffered segment(s) past the ${Math.round(LOCAL_RETENTION_MS / 86400000)}d retention window`);
      const promoted = await finalizePartials().catch(() => 0);
      if (promoted) log(`[capture] promoted ${promoted} partial segment(s) a previous session left unsealed`);
      ensureUploader().kick();
      ensureEngine().kick();   // the native engine resumes its own background uploads
    });
}

function nowMs(): number { return Date.now() - state.startedAt; }

/** Same shape the server mints (`cap_<epoch ms>_<6 hex>`, CAPTURE_ID_RE in
 *  proxy/parley/capture.ts) so an offline-minted id is adopted verbatim. */
function mintCaptureId(): string {
  const bytes = new Uint8Array(3);
  try { crypto.getRandomValues(bytes); } catch { for (let i = 0; i < 3; i++) bytes[i] = Math.floor(Math.random() * 256); }
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `cap_${Date.now()}_${hex}`;
}

// ── engine → UI state ─────────────────────────────────────────────────

/** The engine's state is the pill's state. 'interrupted' and 'paused'
 *  open a stalled span (the timer shows recorded time); 'recording'
 *  closes it. An unsolicited 'stopped' is the engine giving up, which is
 *  a failed recording and says so. */
function onEngineState(captureId: string, next: EngineState, detail?: EngineStateDetail): void {
  if (!state.active || state.captureId !== captureId) return;
  if (next === 'recording') {
    if (state.stalledSince != null) {
      state.stalledTotalMs += Date.now() - state.stalledSince;
      state.stalledSince = null;
    }
    state.phase = 'recording';
    state.segmentStartedAt = Date.now();
    if (detail?.reason) log(`[capture] recording (${detail.reason})`);
  } else if (next === 'interrupted' || next === 'paused') {
    if (state.stalledSince == null) state.stalledSince = Date.now();
    state.phase = next;
    state.segmentStartedAt = 0;
    if (next === 'interrupted') log(`[capture] interrupted (${detail?.reason ?? 'unknown'})`);
  } else if (next === 'stopped') {
    // Only an UNSOLICITED stop reaches here with active still true — the
    // stop/cancel flows flip active first. The engine gave up.
    void forceLocalStop('failed', `Recording stopped: ${detail?.reason ?? 'the recorder ended unexpectedly'}.`);
    return;
  }
  emit();
}

function engineHandlers(captureId: string) {
  return {
    onState: (s: EngineState, d?: EngineStateDetail) => onEngineState(captureId, s, d),
    onSegmentSealed: () => {
      if (state.captureId !== captureId) return;
      state.sealedSegments += 1;
      state.segmentStartedAt = state.phase === 'recording' ? Date.now() : 0;
      syncPending();
    },
    onSegmentUploaded: () => {
      if (state.captureId !== captureId) return;
      syncPending();
    },
    onAudioProgress: () => { /* reserved: a future "audio flowing" dot */ },
    onNetwork: (online: boolean) => {
      syncStatus.reportNetwork(online);
      if (state.offline === !online) return;
      state.offline = !online;
      emit();
    },
  };
}

// ── health pings + the server's terminal verdict ──────────────────────

function healthSnapshot(): Record<string, unknown> {
  return {
    phase: state.phase,
    ...(engine?.health() ?? { engine: null, recorder_state: 'none', chunks: 0 }),
    pending_uploads: state.uploaderPending,
    sealed_segments: state.sealedSegments,
    build: buildStamp,
  };
}

/** Diagnostic POST, total-failure-tolerant: a recording must never break
 *  because a diagnostic POST failed. */
async function pingHealth(): Promise<void> {
  const id = state.captureId;
  if (!id || !state.registered) return;
  try {
    await fetch(apiUrl(`/api/parley/captures/${id}/health`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(healthSnapshot()),
      keepalive: true,
    });
  } catch { /* diagnostics must never disturb a recording */ }
}

function startHealthPings(): void {
  if (healthTimer != null) return;
  void pingHealth();
  healthTimer = window.setInterval(() => { void pingHealth(); }, HEALTH_PING_MS);
}

function stopHealthPings(): void {
  if (healthTimer != null) { window.clearInterval(healthTimer); healthTimer = null; }
}

/** Ask the server what it thinks of OUR capture. The ONLY verdicts obeyed
 *  are terminal ones — failed / discarded / complete-and-not-healed —
 *  because then the recorder is describing a recording that no longer
 *  exists. A stall flag is information for the user, never an order to
 *  the engine (2026-11-16: obeying it killed the recorder while the
 *  mic light stayed on). */
async function reconcileWithServer(reason: string): Promise<void> {
  const id = state.captureId;
  if (!id || !state.active) return;
  try {
    const res = await fetch(apiUrl(`/api/parley/captures/${id}`));
    if (!res.ok) return;
    const remote = await res.json();
    const status = String(remote?.status ?? remote?.capture?.status ?? '');
    const healed = !!(remote?.healed_by_sweep ?? remote?.capture?.healed_by_sweep);
    if (status === 'complete' && healed) {
      // The server gave up waiting (nothing arrived for 10 min — we were
      // offline or asleep), not a verdict on the meeting: the next segment
      // reopens it. Keep recording.
      log(`[capture] server stale-healed ${id} while we were away (${reason}) — the backlog will reopen it`);
      engine?.kick();
      return;
    }
    if (status === 'failed' || status === 'discarded' || status === 'complete') {
      log(`[capture] server says ${id} is ${status} (${reason}) — standing down a recording that no longer exists`);
      await forceLocalStop(status);
    }
  } catch { /* offline — the engine's durable store still owns the audio */ }
}

let reconcileWired = false;
function startResumeReconcile(): void {
  if (reconcileWired) return;
  reconcileWired = true;
  try {
    document.addEventListener('visibilitychange', () => {
      void pingHealth();
      if (document.visibilityState !== 'visible') return;
      void reconcileWithServer('resume');
      engine?.kick();
    });
    window.addEventListener('parley:capture-changed-remote', (ev) => {
      const detail = (ev as CustomEvent).detail || {};
      const id = detail?.capture?.id;
      if (!id || id !== state.captureId) return;
      void reconcileWithServer(`envelope:${detail?.kind ?? 'changed'}`);
    });
  } catch { /* non-browser */ }
}

/** Tear down local recording when the server has written the capture
 *  off or the engine gave up. Whatever audio exists stays in the engine's
 *  durable store (the uploader parks rather than deletes). */
async function forceLocalStop(remoteStatus: string, reasonText?: string): Promise<void> {
  stopHealthPings();
  state.active = false;
  state.phase = 'failed';
  try { await engine?.stop(); } catch { /* best effort */ }
  engine?.disarm();
  if (failedDismissTimer != null) window.clearTimeout(failedDismissTimer);
  failedDismissTimer = window.setTimeout(() => {
    failedDismissTimer = null;
    if (state.phase !== 'failed') return;
    state = { ...IDLE_STATE };
    emit();
  }, FAILED_PILL_MS);
  state.failedReason = reasonText ?? (remoteStatus === 'failed'
    ? 'No audio reached the server — nothing was saved.'
    : `This recording was ${remoteStatus} elsewhere.`);
  emit();
}

// ── lifecycle ─────────────────────────────────────────────────────────

export async function startMeetingCapture(
  opts: { title?: string; linkedChat?: string } = {},
): Promise<CaptureUiState> {
  if (state.active || state.phase === 'starting') return getCaptureState();
  const eng = ensureEngine();
  loadBuildStamp();
  // HONEST startup phase (postmortem 2026-08-18 P1): the pill shows
  // "Starting microphone…" — active stays false, nothing red, and NO
  // success signal exists anywhere until the engine has proven live.
  state = { ...IDLE_STATE, phase: 'starting', engine: eng.kind };
  const myEpoch = ++startEpoch;
  emit();
  // Inside the user's tap, before any await: the web engine unlocks
  // background play on iOS here. Released on every exit below.
  eng.arm();
  const failToIdle = () => {
    if (startEpoch !== myEpoch) return;
    eng.disarm();
    state = { ...IDLE_STATE };
    emit();
  };

  // OFFLINE-FIRST (2026-10-05): the capture is named and recorded HERE,
  // with no network at all. The id has the server's own shape so the
  // server adopts it verbatim; the uploader registers the capture
  // upstream when it can, then the audio follows.
  const capture = {
    id: mintCaptureId(),
    title: opts.title?.trim() || `Meeting ${new Date().toISOString().slice(0, 10)}`,
    linked_chat: opts.linkedChat || mintChatId(),
    minted_session: !opts.linkedChat,
  };
  try {
    await putLedger({
      id: capture.id, title: capture.title, linkedChat: capture.linked_chat,
      mintedSession: capture.minted_session,
      diarize: settings.get().captureDiarize !== false,
      autoIngest: settings.get().captureAutoIngest,
      createdAt: Date.now(), registered: false, activated: false,
      stopRequested: false, marks: [],
    });
  } catch (e) {
    failToIdle();
    throw e;
  }
  const abortStart = (reason: string) => {
    log(`[capture] ${capture.id}: start aborted — ${reason}`);
    void getLedger(capture.id).then(async (entry) => {
      if (entry?.registered) {
        await fetch(apiUrl(`/api/parley/captures/${capture.id}/abort-start`), {
          method: 'POST', headers: lifecycleHeaders(true), body: JSON.stringify({ reason }),
        }).catch(() => { /* pending TTL fails it in place */ });
      }
      await removeLedger(capture.id).catch(() => { /* retention janitor */ });
    });
  };

  if (startEpoch !== myEpoch || state.phase !== 'starting') {
    abortStart('startup superseded on the client');
    return getCaptureState();
  }
  state.captureId = capture.id;
  state.title = capture.title;
  state.chatId = capture.linked_chat;
  emit();

  const startedAt = Date.now();
  try {
    await eng.start({
      captureId: capture.id, segmentMs: SEGMENT_MS, startedAt,
      handlers: engineHandlers(capture.id),
    });
  } catch (e) {
    abortStart(`engine start failed: ${String((e as Error)?.message || e)}`);
    failToIdle();
    throw e;
  }
  if (state.phase !== 'starting' || state.captureId !== capture.id) {
    // Stood down while the engine was starting: release what it holds.
    void eng.cancel();
    abortStart('startup superseded on the client');
    return getCaptureState();
  }

  state = {
    ...IDLE_STATE,
    active: true, captureId: capture.id, title: capture.title,
    chatId: capture.linked_chat, startedAt, phase: 'recording',
    segmentStartedAt: Date.now(), offline: state.offline, engine: eng.kind,
  };
  // The server learns about it from the uploader (create → activate),
  // on whatever connection the room has; nothing here waits on the
  // network — that was the whole bug.
  ensureUploader().kick();
  startResumeReconcile();
  emit();   // NOW the pill flips to the real red recording state
  log(`[capture] started ${capture.id} ("${capture.title}") chat=${capture.linked_chat} engine=${eng.kind}`);
  return getCaptureState();
}

/** Stand down a start that is still in its honest 'starting' phase
 *  (the stop affordances must work while "Starting microphone…" shows). */
function standDownPendingStart(): boolean {
  if (state.active || state.phase !== 'starting') return false;
  log(`[capture] stood down pending start ${state.captureId || '(not yet created)'}`);
  engine?.disarm();
  state = { ...IDLE_STATE };
  emit();
  return true;
}

export async function stopMeetingCapture(): Promise<void> {
  if (standDownPendingStart()) return;
  if (!state.active) return;
  const captureId = state.captureId!;
  const eng = engine!;
  state.active = false;
  state.phase = 'finishing';
  state.segmentStartedAt = 0;
  emit();
  // One FINAL ping: the record of what the recorder looked like at the
  // moment of stop (the snapshot that was missing on 2026-08-27).
  void pingHealth();
  stopHealthPings();
  await eng.stop();            // final segment durable
  // The /stop itself is the uploader's job: it fires once every segment
  // is acked (the engine's own pending count included, for a native
  // capture), survives a reload via the ledger row, and runs the
  // transcription pipeline. The pill's 'finishing' state is capped at
  // 15 s; the sync continues in the background — or next launch.
  const ledgerOk = await updateLedger(captureId, { stopRequested: true }).catch(() => null);
  if (!ledgerOk) {
    void eng.drained(captureId).then(() => fetch(apiUrl(`/api/parley/captures/${captureId}/stop`), {
      method: 'POST', headers: lifecycleHeaders(),
    }).catch(() => { /* stale heal completes it server-side */ }));
  }
  ensureUploader().kick();
  eng.kick();
  const drainedInTime = await Promise.race([
    eng.drained(captureId).then(() => ensureUploader().drained()).then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
  ]);
  if (!drainedInTime) {
    log(`[capture] ${captureId}: uploads still draining — stop deferred until they land`);
  }
  eng.disarm();
  state = { ...IDLE_STATE };
  emit();
  log(`[capture] stopped ${captureId}`);
}

/** Cancel = discard WITHOUT ingesting (field ask 2026-07-09), with
 *  Recently-Deleted semantics (postmortem P0 #2): the server capture is
 *  soft-discarded (restorable ~7 days) — never hard-DELETEd — and the
 *  engine's durable audio is NOT cleared. Returns the tombstoned id so
 *  the caller can offer Undo, or null when nothing was tombstoned. */
export async function cancelMeetingCapture(): Promise<string | null> {
  if (standDownPendingStart()) return null;
  if (!state.active || !state.captureId) return null;
  const captureId = state.captureId;
  const eng = engine!;
  state = { ...IDLE_STATE };
  emit();
  stopHealthPings();
  await eng.cancel();
  eng.disarm();
  const entry = await getLedger(captureId).catch(() => null);
  if (entry && !entry.registered) {
    await updateLedger(captureId, { registerFailed: 'discarded before it synced' }).catch(() => null);
    log(`[capture] canceled ${captureId} before it synced — audio kept on device for the retention window`);
    return null;
  }
  try {
    const res = await fetch(apiUrl(`/api/parley/captures/${captureId}/discard`), {
      method: 'POST',
      headers: lifecycleHeaders(true),
      body: JSON.stringify({ reason: 'user_discard_pill' }),
    });
    if (!res.ok) {
      log(`[capture] discard of ${captureId} answered ${res.status} — server reconciles via sweep`);
    }
  } catch { /* server unreachable — stale-recording auto-heal resolves it in place */ }
  log(`[capture] canceled ${captureId} → Recently Deleted (recoverable)`);
  return captureId;
}

/** Undo of a sheet discard: POST /restore flips the Recently-Deleted
 *  tombstone back — to 'complete'/'failed', never to a live recording. */
export async function restoreDiscardedCapture(captureId: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/parley/captures/${captureId}/restore`), {
    method: 'POST', headers: lifecycleHeaders(),
  });
  if (!res.ok) throw new Error(`restore failed (${res.status})`);
}

/** Pause = the engine seals and RELEASES the mic (the OS indicator must
 *  go dark — the pause button is a privacy promise). The t0 gap in the
 *  manifest IS the pause marker. No auto-resume. */
export function pauseMeetingCapture(): void {
  if (!state.active || state.phase !== 'recording') return;
  void engine?.pause();
  log('[capture] paused');
}

export async function resumeMeetingCapture(): Promise<void> {
  if (!state.active || state.phase !== 'paused') return;
  await engine?.resume();
  log('[capture] resumed');
}

/** Flag button — timestamped [MARK] the ingest skill treats as a
 *  user-flagged moment (§3.6). Fire-and-forget. */
export function markMoment(): void {
  if (!state.active || !state.captureId) return;
  state.marks += 1;
  emit();
  const tMs = nowMs();
  const captureId = state.captureId;
  if (!state.registered || state.offline) {
    void updateLedger(captureId, (e) => { e.marks.push(tMs); }).then(() => ensureUploader().kick());
    return;
  }
  void fetch(apiUrl(`/api/parley/captures/${captureId}/marks`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ t_ms: tMs }),
  }).catch(() => {
    void updateLedger(captureId, (e) => { e.marks.push(tMs); });
  });
}

/** Rename / re-link from the pill sheet — thin PATCH passthrough. */
export async function renameCapture(title: string): Promise<void> {
  if (!state.captureId) return;
  state.title = title;
  emit();
  const captureId = state.captureId;
  const entry = await updateLedger(captureId, (e) => { e.title = title; if (e.registered) e.titleDirty = true; }).catch(() => null);
  if (entry && !entry.registered) return;
  await fetch(apiUrl(`/api/parley/captures/${captureId}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((res) => { if (res.ok) void updateLedger(captureId, { titleDirty: false }); })
    .catch(() => { /* titleDirty → the uploader retries */ });
}
