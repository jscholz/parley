// Meeting capture recorder — the client capture core (plan §3.2).
//
// Records the mic as a chain of ~45s SELF-CONTAINED segments: a fresh
// MediaRecorder per segment (stop → new recorder on the same stream)
// so every file carries its own container header — byte-slicing one
// long recording loses the header for all but the first slice, the
// exact lesson chunkedTranscribe.ts learned the hard way. Each sealed
// segment persists to the durable IDB buffer FIRST and uploads via the
// serial uploader; a crash loses at most the in-flight segment
// (<45s of audio).
//
// Mic ownership goes through audio/shared/capture.ts `acquire('meeting')`
// — which also buys the v1 mutual-exclusion rule (§3.4): call/listen
// modes throw "already held by meeting" and vice versa, plus the
// AVAudioSession prep, iOS BT priming, and wake-lock that module owns.
//
// App-global by design: nothing here is chat-scoped, so recording
// survives session switches (§3.6 multisession property; pinned by the
// capture-pill-survives-session-switch smoke).

import * as mic from '../audio/shared/capture.ts';
import { putSegment, clearExpired, putLedger, getLedger, updateLedger, removeLedger } from './segmentStore.ts';
import { mintChatId } from '../conversations.ts';
import { createUploader, type Uploader } from './uploader.ts';
import { apiUrl } from '../apiBase.ts';
import { log } from '../util/log.ts';
import * as settings from '../settings.ts';

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
   *  auto-resume polling). Distinct on purpose: auto-resume after a
   *  deliberate pause would be a privacy bug. */
  /** 'failed' (2026-08-27) is the HONEST terminal state for a recording
   *  the server has written off while the client still believed in it.
   *  Before this, that situation had no representation at all: the pill
   *  kept counting for 72 minutes after the capture was declared dead. */
  phase: 'idle' | 'starting' | 'recording' | 'paused' | 'interrupted' | 'finishing' | 'failed';
  /** User-facing explanation for 'failed'. Shown, not swallowed. */
  failedReason?: string;
  uploaderPending: number;
  sealedSegments: number;
  marks: number;
  /** Wall-clock ms spent paused/interrupted so far (completed spans). */
  stalledTotalMs: number;
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
}

const SEGMENT_MS = 45_000;

/** Bounded startup (postmortem P1): the incident's getUserMedia hung
 *  for 21 minutes with no visible state. Past this, startup fails
 *  loudly (toast) and the pending server capture is aborted in place. */
const START_TIMEOUT_MS = 20_000;

/** Local IDB retention for parked/orphaned segments — mirrors the
 *  server's Recently Deleted window, so a discarded capture's
 *  un-uploaded tail stays recoverable exactly as long as the server
 *  copy does. */
const LOCAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Lifecycle calls self-identify for the server's capture audit log
 *  (postmortem P0 #3 — "who called this?" must never be unknowable
 *  again). */
function lifecycleHeaders(json = false): Record<string, string> {
  return {
    'x-parley-client': 'pwa-recorder',
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

// Far-field room capture tuning: AGC ON lifts distant speakers; AEC OFF
// (nothing plays through the speaker during capture — call-mode's AEC
// policy solves a problem capture doesn't have); NS OFF (STT models
// prefer unshaped spectra; Deepgram does its own).
const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
};

let state: CaptureUiState = {
  active: false, captureId: null, title: '', chatId: null,
  startedAt: 0, phase: 'idle', uploaderPending: 0, sealedSegments: 0, marks: 0,
  stalledTotalMs: 0, stalledSince: null, registered: false, offline: false,
};

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let segTimer: number | null = null;
let seq = 0;
let segStartMs = 0;          // capture-relative t0 of the running segment
let mimeType = '';
let uploader: Uploader | null = null;
let reacquireTimer: number | null = null;
/** Monotonic id of the current start attempt — see startMeetingCapture. */
let startEpoch = 0;
let watchdogTimer: number | null = null;
let lastChunkAt = 0;         // epoch ms of the last dataavailable
/** dataavailable events seen since this capture started. ZERO on a
 *  live recorder is the incident signature (2026-08-27) — it separates
 *  "the recorder never produced anything" from "audio was produced but
 *  never uploaded", which the server cannot tell apart on its own. */
let chunkCount = 0;
let healthTimer: number | null = null;
let failedDismissTimer: number | null = null;
/** How long the 'nothing was saved' pill stays up. */
const FAILED_PILL_MS = 90_000;

function emit(): void {
  try {
    window.dispatchEvent(new CustomEvent('parley:capture-state', { detail: { ...state } }));
  } catch { /* non-browser */ }
}

export function getCaptureState(): CaptureUiState { return { ...state }; }

function ensureUploader(): Uploader {
  if (uploader) return uploader;
  uploader = createUploader({
    onDrained: () => { state.uploaderPending = 0; emit(); },
    onDropped: () => { syncPending(); },
    onNetwork: (online) => {
      if (state.offline === !online) return;
      state.offline = !online;
      emit();
    },
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
      }
    },
    onRegisterFailed: (entry, reason) => {
      log(`[capture] ${entry.id}: server refused the capture — ${reason}`);
      if (entry.id !== state.captureId || !state.active) return;
      // The audio is safe in the buffer; the recording cannot sync. Say so
      // the way a server-side write-off is said (phase 'failed' is the
      // honest terminal pill), without touching the buffered segments.
      void forceLocalStop('refused');
      state.failedReason = `The server refused this recording (${reason}). Audio is kept on this device.`;
      emit();
    },
    onStopped: (captureId) => { log(`[capture] ${captureId}: deferred stop landed`); },
  });
  // Coming back online is the moment the backlog can move; don't wait
  // for the backoff timer to expire.
  try {
    window.addEventListener('online', () => { uploader?.kick(); });
  } catch { /* non-browser */ }
  return uploader;
}

/** Real queue depth from the uploader (audit 2.5: the old value was
 *  cumulative-sealed masquerading as pending). */
function syncPending(): void {
  state.uploaderPending = uploader?.pendingCount() ?? 0;
  emit();
}

/** Boot-time: expire retention-window-old segments, then drain any a
 *  previous session left in IDB. Cheap no-op when the buffer is empty. */
export function resumePendingUploads(): void {
  void clearExpired(LOCAL_RETENTION_MS)
    .catch(() => 0)
    .then((n) => {
      if (n) log(`[capture] dropped ${n} buffered segment(s) past the ${Math.round(LOCAL_RETENTION_MS / 86400000)}d retention window`);
      ensureUploader().kick();
    });
}

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
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

/** One segment = one MediaRecorder lifetime. onstop seals + persists
 *  the blob and (while still active) starts the next segment.
 *  Returns whether MediaRecorder.start() actually succeeded — the
 *  STARTUP call must verify this before activating server-side
 *  (postmortem P0 #1); mid-meeting callers route false into the
 *  interruption/recovery path instead. */
function startSegment(): boolean {
  if (!stream || !state.active) return false;
  const chunks: Blob[] = [];
  segStartMs = nowMs();
  const rec = new MediaRecorder(
    stream,
    mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 },
  );
  recorder = rec;
  rec.ondataavailable = (ev: BlobEvent) => {
    lastChunkAt = Date.now();
    if (ev.data && ev.data.size) { chunkCount += 1; chunks.push(ev.data); }
  };
  // A recorder error is a dead segment chain unless handled — route it
  // through the interruption path (seal what we have, re-acquire).
  rec.onerror = () => {
    log('[capture] recorder error — treating as interruption');
    handleInterruption();
  };
  rec.onstop = () => {
    if (recorder === rec) recorder = null;
    const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
    if (blob.size > 0 && state.captureId) {
      const mySeq = seq++;
      void putSegment({
        captureId: state.captureId, seq: mySeq, t0Ms: segStartMs,
        mime: blob.type, blob,
      }).then(() => {
        state.sealedSegments += 1;
        ensureUploader().kick();
        syncPending();
      });
    }
    // Chain the next segment while the meeting is live (a stop()
    // requested by stopMeetingCapture flips state.active first). A
    // failed chain start is a dead stream — recover via interruption.
    if (state.active && state.phase === 'recording') {
      if (!startSegment()) handleInterruption();
    }
  };
  // 1s timeslice (memo.ts prior art): steady dataavailable cadence and
  // size-agnostic chunk handling (Safari can flush oversized chunks
  // after OS-level interruptions — plan finding #2).
  try {
    rec.start(1000);
  } catch (e) {
    // start() throws when the stream died without an 'ended' event
    // (route change, device unplug). The old code let the chain die
    // silently — a live pill over a stopped recording (field wedge
    // 2026-07-09 #5). Callers decide the recovery: interruption
    // mid-meeting, abort-start during startup.
    log(`[capture] recorder start failed (${String(e)})`);
    if (recorder === rec) recorder = null;
    return false;
  }
  lastChunkAt = Date.now();
  if (segTimer != null) window.clearTimeout(segTimer);
  segTimer = window.setTimeout(() => {
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* sealed */ }
  }, SEGMENT_MS);
  return true;
}

/** Seal the running segment immediately (interruption, stop). */
function sealCurrent(): void {
  if (segTimer != null) { window.clearTimeout(segTimer); segTimer = null; }
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* already */ }
}

/** Mic vanished mid-meeting (phone call, Siri, route change). Seal
 *  what we have and poll to re-acquire; the t0 jump in the manifest is
 *  the gap marker. */
function handleInterruption(): void {
  if (!state.active) return;
  state.phase = 'interrupted';
  if (state.stalledSince == null) state.stalledSince = Date.now();
  emit();
  sealCurrent();
  try { mic.release('meeting'); } catch { /* released */ }
  stream = null;
  const tryReacquire = async () => {
    if (!state.active || state.phase !== 'interrupted') return;
    try {
      const acquired = await mic.acquire('meeting', MIC_CONSTRAINTS);
      // Re-check AFTER the await (audit 2026-07-09 #2): a stop/cancel
      // that landed while getUserMedia was pending already released
      // nothing (stream was null) — holding this acquisition would
      // leave the OS mic indicator on forever with no pill.
      if (!state.active || state.phase !== 'interrupted') {
        try { mic.release('meeting'); } catch { /* fine */ }
        return;
      }
      stream = acquired;
      watchTracks();
      if (state.stalledSince != null) {
        state.stalledTotalMs += Date.now() - state.stalledSince;
        state.stalledSince = null;
      }
      state.phase = 'recording';
      emit();
      if (!startSegment()) { handleInterruption(); return; }
      log('[capture] mic re-acquired after interruption');
    } catch {
      reacquireTimer = window.setTimeout(tryReacquire, 3000);
    }
  };
  reacquireTimer = window.setTimeout(tryReacquire, 1000);
}

function watchTracks(): void {
  const track = stream?.getAudioTracks()[0];
  if (!track) return;
  track.addEventListener('ended', handleInterruption);
  // iOS signals interruptions as mute/unmute on a LIVE track (vs
  // 'ended' when the mic is fully revoked). Flip to 'interrupted' so
  // the seal's onstop doesn't auto-chain a new (silent) segment and
  // the pill honestly shows the stall — the old same-phase seal
  // restarted immediately, making the unmute guard dead code and
  // recording silence as if all were well (audit 2026-07-09 #13).
  track.addEventListener('mute', () => {
    if (state.active && state.phase === 'recording') {
      state.phase = 'interrupted';
      if (state.stalledSince == null) state.stalledSince = Date.now();
      emit();
      sealCurrent();
    }
  });
  track.addEventListener('unmute', () => {
    if (state.active && state.phase === 'interrupted' && stream) {
      if (state.stalledSince != null) {
        state.stalledTotalMs += Date.now() - state.stalledSince;
        state.stalledSince = null;
      }
      state.phase = 'recording';
      emit();
      if (!startSegment()) handleInterruption();
    }
  });
}

/** Heartbeat + resume reconciliation (incident 2026-08-27).
 *
 *  Two things went wrong that day and this closes both from the client
 *  side. First, the server had no way to tell a sleeping phone from a
 *  mute recorder — identical silence — so the cause was never found.
 *  Second, the server FAILED the capture at 14:18 and the client never
 *  learned: the pill counted happily to 1:22:15. `capture_changed`
 *  envelopes were already being broadcast, but their only consumer was
 *  the sidebar's meetings index.
 *
 *  The ping is deliberately cheap and total-failure-tolerant: a
 *  recording must never break because a diagnostic POST failed. */
const HEALTH_PING_MS = 30_000;

function healthSnapshot(): Record<string, unknown> {
  const track = stream?.getAudioTracks?.()[0] || null;
  return {
    phase: state.phase,
    recorder_state: recorder?.state ?? 'none',
    track_ready_state: track?.readyState ?? 'none',
    track_muted: track?.muted ?? null,
    track_enabled: track?.enabled ?? null,
    chunks: chunkCount,
    last_chunk_age_ms: lastChunkAt ? Date.now() - lastChunkAt : null,
    pending_uploads: state.uploaderPending,
    sealed_segments: state.sealedSegments,
    mime: mimeType || null,
  };
}

async function pingHealth(): Promise<void> {
  const id = state.captureId;
  if (!id || !state.registered) return;   // nothing upstream to report to yet
  try {
    await fetch(apiUrl(`/api/parley/captures/${id}/health`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(healthSnapshot()),
      keepalive: true,   // survives a page being backgrounded mid-flight
    });
  } catch { /* diagnostics must never disturb a recording */ }
}

/** Ask the server what it thinks of OUR capture and believe it.
 *
 *  Runs on resume, because that is when a client is most likely to be
 *  holding a stale belief (it may have been frozen for an hour), and on
 *  any capture_changed envelope naming our id. If the server has moved
 *  the capture to a terminal state, the local recorder is describing a
 *  recording that no longer exists — stop claiming otherwise. */
async function reconcileWithServer(reason: string): Promise<void> {
  const id = state.captureId;
  if (!id || !state.active) return;
  try {
    const res = await fetch(apiUrl(`/api/parley/captures/${id}`));
    if (!res.ok) return;                       // transient — keep recording
    const remote = await res.json();
    const status = String(remote?.status ?? remote?.capture?.status ?? '');
    const healed = !!(remote?.healed_by_sweep ?? remote?.capture?.healed_by_sweep);
    if (status === 'complete' && healed) {
      // The server gave up waiting (10 min with nothing arriving — we were
      // offline), not a verdict on the meeting: our next segment reopens
      // it. Keep recording.
      log(`[capture] server stale-healed ${id} while we were away (${reason}) — the backlog will reopen it`);
      return;
    }
    if (status === 'failed' || status === 'discarded' || status === 'complete') {
      log(`[capture] server says ${id} is ${status} (${reason}) — standing down a recording that no longer exists`);
      await forceLocalStop(status);
      return;
    }
    if (remote?.stalled_since || remote?.capture?.stalled_since) {
      // Server is not receiving audio. Say so where the user is looking;
      // the recorder keeps trying, because stalls do recover.
      if (state.phase === 'recording') {
        state.phase = 'interrupted';
        emit();
      }
    }
  } catch { /* offline — the uploader's durable queue still owns the audio */ }
}

/** Tear down local recording machinery when the server has already
 *  written the capture off. Keeps whatever audio exists in the durable
 *  IDB queue (the uploader parks rather than deletes), so a later
 *  unfreeze can still drain it. */
async function forceLocalStop(remoteStatus: string): Promise<void> {
  stopWatchdog();
  stopHealthPings();
  if (reacquireTimer != null) { window.clearTimeout(reacquireTimer); reacquireTimer = null; }
  try { sealCurrent(); } catch { /* best effort */ }
  try { mic.release('meeting'); } catch { /* released */ }
  stream = null;
  state.active = false;
  state.phase = 'failed';
  // Bounded, so a data-loss notice can never become permanent chrome.
  // Long enough to be read and acted on, short enough that a pill the
  // user has already absorbed stops occupying the composer forever.
  // (Starting another capture resets state and clears it sooner.)
  if (failedDismissTimer != null) window.clearTimeout(failedDismissTimer);
  failedDismissTimer = window.setTimeout(() => {
    failedDismissTimer = null;
    if (state.phase !== 'failed') return;
    state = { ...IDLE_STATE };
    emit();
  }, FAILED_PILL_MS);
  state.failedReason = remoteStatus === 'failed'
    ? 'No audio reached the server — nothing was saved.'
    : `This recording was ${remoteStatus} elsewhere.`;
  emit();
}

function startHealthPings(): void {
  if (healthTimer != null) return;
  void pingHealth();                    // one immediately: the FIRST ping
  healthTimer = window.setInterval(() => { void pingHealth(); }, HEALTH_PING_MS);
}

function stopHealthPings(): void {
  if (healthTimer != null) { window.clearInterval(healthTimer); healthTimer = null; }
}

function startWatchdog(): void {
  if (watchdogTimer != null) return;
  watchdogTimer = window.setInterval(() => {
    if (!state.active) return;
    if (state.phase !== 'recording') return;   // paused/interrupted have their own flows
    const silentFor = Date.now() - lastChunkAt;
    // Timeslice is 1s — 20s of silence means the chain is dead in a
    // way NO event reported (the exact field wedge 2026-07-09 #5:
    // pill alive, seg/6 never arrived). Recover via the interruption
    // path: seal whatever exists, release, re-acquire, resume.
    if (lastChunkAt > 0 && silentFor > 20_000) {
      log(`[capture] watchdog: no audio chunks for ${Math.round(silentFor / 1000)}s — forcing recovery`);
      handleInterruption();
    }
  }, 5000);
}

function stopWatchdog(): void {
  if (watchdogTimer != null) { window.clearInterval(watchdogTimer); watchdogTimer = null; }
}

/** Resume reconciliation + the server's own verdict.
 *
 *  visibilitychange is the moment a client is most likely to be holding
 *  a stale belief — proxyClient already uses the same hook to
 *  forceReconnect its stream, which is how we know it fires reliably in
 *  the CAP shell (his console, 2026-08-27). Wired ONCE per module; the
 *  handlers no-op unless a capture of ours is live. */
let reconcileWired = false;
function startResumeReconcile(): void {
  if (reconcileWired) return;
  reconcileWired = true;
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      void reconcileWithServer('resume');
      void pingHealth();     // ...and re-report immediately on wake
    });
    // A capture_changed envelope naming OUR capture is the fastest
    // possible notice. Previously this event had exactly one consumer
    // (the sidebar meetings index) and the recorder never heard it.
    window.addEventListener('parley:capture-changed-remote', (ev) => {
      const detail = (ev as CustomEvent).detail || {};
      const id = detail?.capture?.id;
      if (!id || id !== state.captureId) return;
      void reconcileWithServer(`envelope:${detail?.kind ?? 'changed'}`);
    });
  } catch { /* non-browser */ }
}

const IDLE_STATE: CaptureUiState = {
  active: false, captureId: null, title: '', chatId: null,
  startedAt: 0, phase: 'idle', uploaderPending: 0, sealedSegments: 0, marks: 0,
  stalledTotalMs: 0, stalledSince: null, registered: false, offline: false,
};

/** getUserMedia with a hard deadline. The incident's acquire hung 21
 *  MINUTES; anything past START_TIMEOUT_MS is a failure. If the OS
 *  grants the mic after we already gave up, it is released on the spot
 *  — never a live mic with no pill. */
async function acquireMicBounded(): Promise<MediaStream> {
  let gaveUp = false;
  const acquireP = mic.acquire('meeting', MIC_CONSTRAINTS);
  acquireP.then(
    () => { if (gaveUp) { try { mic.release('meeting'); } catch { /* fine */ } } },
    () => { /* rejection surfaces through the race below (or after it — swallowed) */ },
  );
  try {
    return await Promise.race([
      acquireP,
      new Promise<never>((_, reject) => window.setTimeout(
        () => reject(new Error(`microphone did not start within ${START_TIMEOUT_MS / 1000}s`)),
        START_TIMEOUT_MS,
      )),
    ]);
  } finally {
    gaveUp = true;
  }
}

export async function startMeetingCapture(
  opts: { title?: string; linkedChat?: string } = {},
): Promise<CaptureUiState> {
  if (state.active || state.phase === 'starting') return getCaptureState();
  // HONEST startup phase (postmortem 2026-08-18 P1): the pill shows
  // "Starting microphone…" — active stays false, nothing red, and NO
  // success signal exists anywhere (server included) until the
  // recorder is proven live.
  state = { ...IDLE_STATE, phase: 'starting' };
  // Identity for THIS start attempt, needed before there is a
  // captureId to compare against: stand-down → immediate restart can
  // put a second attempt in 'starting' while the first is still inside
  // its create POST, and phase alone can't tell the two apart.
  const myEpoch = ++startEpoch;
  emit();
  // Scoped to THIS attempt: a stand-down followed by an immediate
  // restart means this closure can still fire (late create rejection,
  // late 409) while attempt N+1 already owns the state — idling it
  // would kill a start the user is currently watching come up.
  const failToIdle = () => {
    if (startEpoch !== myEpoch) return;
    state = { ...IDLE_STATE };
    emit();
  };

  // Create server-side FIRST (instant-start: no prompts — title
  // defaults, annotate later via PATCH; §3.4). Cheap now: the entity
  // is a PENDING placeholder — no chat message, no session title, no
  // recording claim until /activate. linkedChat carries the
  // PLACEMENT-SCOPED semantics (field UX 2026-07-09): app-level entry
  // points omit it → 'new' mints a dedicated meeting session (§3.6);
  // the composer mic-menu passes the viewed chat → the meeting lands
  // in the session the user is standing in.
  // OFFLINE-FIRST (2026-10-05): the capture is named and recorded HERE,
  // with no network at all — same promise memo mode makes. The id has the
  // server's own shape (CAPTURE_ID_RE) so the server adopts it verbatim;
  // the uploader registers the capture upstream when it can
  // (uploader.ts ensureRegistered), then drains the audio behind it.
  // Until then nothing is announced in the chat — the server does that
  // on activation, as before; it just happens later.
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
    // No durable ledger → no way to sync later; but the recording itself
    // would still work for the session. Prefer honesty: fail the start.
    failToIdle();
    throw e;
  }
  // A start that dies before any audio exists leaves nothing worth
  // syncing: drop the ledger row (and tell the server, if it already
  // knows — which, this early, it never does).
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

  try {
    stream = await acquireMicBounded();
  } catch (e) {
    abortStart(`mic acquisition failed: ${String((e as Error)?.message || e)}`);
    failToIdle();
    throw e;
  }
  if (state.phase !== 'starting' || state.captureId !== capture.id) {
    try { mic.release('meeting'); } catch { /* fine */ }
    stream = null;
    abortStart('startup superseded on the client');
    return getCaptureState();
  }

  mimeType = pickMime();
  seq = 0;
  state = {
    active: true, captureId: capture.id, title: capture.title,
    chatId: capture.linked_chat, startedAt: Date.now(), phase: 'recording',
    uploaderPending: 0, sealedSegments: 0, marks: 0,
    stalledTotalMs: 0, stalledSince: null, registered: false, offline: state.offline,
  };
  // No emit yet — the pill stays on "Starting microphone…" until the
  // recorder start is VERIFIED below.
  if (!startSegment()) {
    try { mic.release('meeting'); } catch { /* fine */ }
    stream = null;
    abortStart('MediaRecorder.start() threw');
    failToIdle();
    throw new Error('recorder failed to start');
  }

  // Mic owned + recorder running. The server learns about it from the
  // uploader (create → activate → segments), on whatever connection the
  // room has; the activation there is what fires "Recording started".
  // Nothing here waits on the network — that was the whole bug.
  ensureUploader().kick();

  watchTracks();
  startWatchdog();
  chunkCount = 0;
  startResumeReconcile();     // health pings begin once the server knows us
  emit();   // NOW the pill flips to the real red recording state
  log(`[capture] started ${capture.id} ("${capture.title}") chat=${capture.linked_chat}`);
  return getCaptureState();
}

/** Stand down a start that is still in its honest 'starting' phase.
 *  Every stop-shaped affordance used to test `state.active`, which is
 *  false for the whole of mic acquisition by design (postmortem
 *  2026-08-18 P1) — so the pill's live stop button, the header toggle
 *  and Cmd+Shift+M all did NOTHING if pressed inside that window, and
 *  the user watched "Starting microphone…" flip to a red recording they
 *  had already cancelled, mic hot. Resetting local state is the whole
 *  fix: startMeetingCapture re-checks the phase after every await and
 *  abort-starts the pending capture server-side (never DELETE — that
 *  shared-rollback path is what erased a real meeting) the moment it
 *  finds its start superseded. */
function standDownPendingStart(): boolean {
  if (state.active || state.phase !== 'starting') return false;
  log(`[capture] stood down pending start ${state.captureId || '(not yet created)'}`);
  state = { ...IDLE_STATE };
  emit();
  return true;
}

export async function stopMeetingCapture(): Promise<void> {
  if (standDownPendingStart()) return;
  if (!state.active) return;
  const captureId = state.captureId!;
  state.active = false;
  state.phase = 'finishing';
  emit();
  stopWatchdog();
  // One FINAL ping before the pings stop — it is the record of what the
  // recorder looked like at the moment of stop, which is exactly the
  // snapshot that was missing on 2026-08-27.
  void pingHealth();
  stopHealthPings();
  if (reacquireTimer != null) { window.clearTimeout(reacquireTimer); reacquireTimer = null; }
  sealCurrent();
  try { mic.release('meeting'); } catch { /* fine */ }
  stream = null;
  // Give the final onstop → putSegment a beat, then wait for the
  // uploader to drain BEFORE declaring stop server-side. /stop lets
  // the pipeline finalize, and a finalized capture freezes late
  // segments — so stopping with un-uploaded audio risked exactly the
  // data loss the durable buffer exists to prevent (audit 2026-07-09
  // P0#1). The pill's "finishing" state is capped at 15s for the UI,
  // but the ACTUAL /stop defers until the drain completes in the
  // background; the server's stale-heal completes (not fails) a
  // segment-bearing capture if we die first.
  await new Promise((r) => setTimeout(r, 400));
  // The /stop itself is the uploader's job: it fires once every segment
  // is acked (and, for an offline start, once the capture is registered
  // at all), survives a reload via the ledger row, and is what runs the
  // transcription pipeline. The pill's 'finishing' state is capped at
  // 15s; the sync continues in the background — or next launch.
  const ledgerOk = await updateLedger(captureId, { stopRequested: true }).catch(() => null);
  if (!ledgerOk) {
    // Pre-ledger capture (started before this build): stop it the old way.
    void ensureUploader().drained().then(() => fetch(apiUrl(`/api/parley/captures/${captureId}/stop`), {
      method: 'POST', headers: lifecycleHeaders(),
    }).catch(() => { /* server unreachable — stale heal completes it server-side */ }));
  }
  const drainP = ensureUploader().drained();
  const drainedInTime = await Promise.race([
    drainP.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
  ]);
  if (!drainedInTime) {
    log(`[capture] ${captureId}: uploads still draining — stop deferred until they land`);
  }
  state = {
    active: false, captureId: null, title: '', chatId: null,
    startedAt: 0, phase: 'idle', uploaderPending: 0, sealedSegments: 0, marks: 0,
    stalledTotalMs: 0, stalledSince: null, registered: false, offline: false,
  };
  emit();
  log(`[capture] stopped ${captureId}`);
}

/** Cancel = discard WITHOUT ingesting (field ask 2026-07-09), now with
 *  Recently-Deleted semantics (postmortem P0 #2): the server capture
 *  is soft-discarded (tombstone, restorable ~7 days) — never
 *  hard-DELETEd — and the local IDB buffer is NOT cleared: un-uploaded
 *  tail segments are the only copy of that audio, so they stay
 *  buffered (the uploader parks them on the server's "frozen" answer)
 *  until the retention janitor or a deliberate purge.
 *
 *  Returns the tombstoned capture's id so the caller can offer Undo
 *  (B1 pass: the pill sheet's post-discard toast), or null when
 *  nothing was tombstoned (stand-down of a pending start / no capture). */
export async function cancelMeetingCapture(): Promise<string | null> {
  // The sheet's discard is reachable during 'starting' too, and there
  // is nothing to tombstone yet — no audio, no recording claim, just a
  // pending placeholder. Stand down and let the superseded start abort
  // it; a Recently-Deleted entry for a meeting that never recorded
  // would be noise the user has to clean up.
  if (standDownPendingStart()) return null;
  if (!state.active || !state.captureId) return null;
  const captureId = state.captureId;
  state = { ...IDLE_STATE };
  emit();
  stopWatchdog();
  stopHealthPings();
  if (reacquireTimer != null) { window.clearTimeout(reacquireTimer); reacquireTimer = null; }
  sealCurrent();                       // stops the recorder; persist skipped (captureId cleared)
  try { mic.release('meeting'); } catch { /* fine */ }
  stream = null;
  const entry = await getLedger(captureId).catch(() => null);
  if (entry && !entry.registered) {
    // The server never heard of this capture, so there is nothing to
    // tombstone there. Mark the row refused so the uploader PARKS the
    // buffered audio (kept for the retention window) instead of trying
    // to register a meeting the user just threw away.
    await updateLedger(captureId, { registerFailed: 'discarded before it synced' }).catch(() => null);
    log(`[capture] canceled ${captureId} before it synced — audio kept on device for the retention window`);
    return null;
  }
  try {
    const res = await fetch(apiUrl(`/api/parley/captures/${captureId}/discard`), {
      method: 'POST',
      headers: lifecycleHeaders(true),
      // Machine-readable reason + x-parley-client identity: the
      // audit log must answer "who discarded this, and why" (the
      // incident's DELETE was unattributable).
      body: JSON.stringify({ reason: 'user_discard_pill' }),
    });
    if (!res.ok) {
      log(`[capture] discard of ${captureId} answered ${res.status} — server reconciles via sweep`);
    }
  } catch { /* server unreachable — stale-recording auto-heal resolves it in place */ }
  log(`[capture] canceled ${captureId} → Recently Deleted (recoverable)`);
  // Returned even if the POST itself failed: the server's sweeps
  // reconcile the discard, so the id is still the undo target.
  return captureId;
}

/** Undo of a sheet discard (B1 pass): POST /restore flips the
 *  Recently-Deleted tombstone back — to 'complete'/'failed', never to a
 *  live recording (the mic and segment chain are long gone; this is
 *  data recovery, not resume). Throws on a non-2xx answer so the undo
 *  toast can say honestly that the restore did NOT land. */
export async function restoreDiscardedCapture(captureId: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/parley/captures/${captureId}/restore`), {
    method: 'POST', headers: lifecycleHeaders(),
  });
  if (!res.ok) throw new Error(`restore failed (${res.status})`);
}

/** Pause = seal the running segment and RELEASE the mic (the OS mic
 *  indicator must go dark — the pause button is a privacy promise).
 *  The capture entity stays open server-side; the t0 gap between the
 *  sealed segment and the next one IS the pause marker in the
 *  manifest. Same seal machinery as interruptions, but no auto-resume. */
export function pauseMeetingCapture(): void {
  if (!state.active || state.phase !== 'recording') return;
  state.phase = 'paused';
  state.stalledSince = Date.now();
  emit();
  sealCurrent();
  try { mic.release('meeting'); } catch { /* released */ }
  stream = null;
  log('[capture] paused');
}

export async function resumeMeetingCapture(): Promise<void> {
  if (!state.active || state.phase !== 'paused') return;
  const acquired = await mic.acquire('meeting', MIC_CONSTRAINTS);
  // Same post-await guard as tryReacquire (audit #2): stop/cancel
  // during the pending acquire must not strand a live mic.
  if (!state.active || state.phase !== 'paused') {
    try { mic.release('meeting'); } catch { /* fine */ }
    return;
  }
  stream = acquired;
  watchTracks();
  if (state.stalledSince != null) {
    state.stalledTotalMs += Date.now() - state.stalledSince;
    state.stalledSince = null;
  }
  state.phase = 'recording';
  emit();
  if (!startSegment()) handleInterruption();
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
    // Queue it; the uploader delivers marks right after registration.
    void updateLedger(captureId, (e) => { e.marks.push(tMs); }).then(() => ensureUploader().kick());
    return;
  }
  void fetch(apiUrl(`/api/parley/captures/${captureId}/marks`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ t_ms: tMs }),
  }).catch(() => {
    void updateLedger(captureId, (e) => { e.marks.push(tMs); });   // mark is decorative; retried later
  });
}

/** Rename / re-link from the pill sheet — thin PATCH passthrough. */
export async function renameCapture(title: string): Promise<void> {
  if (!state.captureId) return;
  state.title = title;
  emit();
  const captureId = state.captureId;
  // Unregistered: the title rides the create. Registered: PATCH now, and
  // leave a titleDirty flag the uploader clears if this PATCH fails.
  const entry = await updateLedger(captureId, (e) => { e.title = title; if (e.registered) e.titleDirty = true; }).catch(() => null);
  if (entry && !entry.registered) return;
  await fetch(apiUrl(`/api/parley/captures/${captureId}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((res) => { if (res.ok) void updateLedger(captureId, { titleDirty: false }); })
    .catch(() => { /* titleDirty → the uploader retries */ });
}
