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
import { putSegment, clearExpired } from './segmentStore.ts';
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
  phase: 'idle' | 'starting' | 'recording' | 'paused' | 'interrupted' | 'finishing';
  uploaderPending: number;
  sealedSegments: number;
  marks: number;
  /** Wall-clock ms spent paused/interrupted so far (completed spans). */
  stalledTotalMs: number;
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
    'x-sidekick-client': 'pwa-recorder',
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
  stalledTotalMs: 0, stalledSince: null,
};

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let segTimer: number | null = null;
let seq = 0;
let segStartMs = 0;          // capture-relative t0 of the running segment
let mimeType = '';
let uploader: Uploader | null = null;
let reacquireTimer: number | null = null;
let watchdogTimer: number | null = null;
let lastChunkAt = 0;         // epoch ms of the last dataavailable

function emit(): void {
  try {
    window.dispatchEvent(new CustomEvent('sidekick:capture-state', { detail: { ...state } }));
  } catch { /* non-browser */ }
}

export function getCaptureState(): CaptureUiState { return { ...state }; }

function ensureUploader(): Uploader {
  uploader ??= createUploader({
    onDrained: () => { state.uploaderPending = 0; emit(); },
    onDropped: () => { syncPending(); },
  });
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
    if (ev.data && ev.data.size) chunks.push(ev.data);
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

const IDLE_STATE: CaptureUiState = {
  active: false, captureId: null, title: '', chatId: null,
  startedAt: 0, phase: 'idle', uploaderPending: 0, sealedSegments: 0, marks: 0,
  stalledTotalMs: 0, stalledSince: null,
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
  emit();
  const failToIdle = () => { state = { ...IDLE_STATE }; emit(); };

  // Create server-side FIRST (instant-start: no prompts — title
  // defaults, annotate later via PATCH; §3.4). Cheap now: the entity
  // is a PENDING placeholder — no chat message, no session title, no
  // recording claim until /activate. linkedChat carries the
  // PLACEMENT-SCOPED semantics (field UX 2026-07-09): app-level entry
  // points omit it → 'new' mints a dedicated meeting session (§3.6);
  // the composer mic-menu passes the viewed chat → the meeting lands
  // in the session the user is standing in.
  let capture: { id: string; title: string; linked_chat: string | null };
  try {
    const res = await fetch(apiUrl('/api/sidekick/captures'), {
      method: 'POST',
      headers: lifecycleHeaders(true),
      body: JSON.stringify({
        title: opts.title || undefined,
        linked_chat: opts.linkedChat || 'new',
        // Settings → Meetings defaults (field 2026-07-09 #9); the pill
        // sheet's PATCH can still flip diarize mid-recording.
        diarize: settings.get().captureDiarize,
        auto_ingest: settings.get().captureAutoIngest,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error || `capture create failed (${res.status})`);
    }
    ({ capture } = await res.json());
  } catch (e) {
    failToIdle();
    throw e;
  }
  state.captureId = capture.id;
  state.title = capture.title;
  state.chatId = capture.linked_chat;
  emit();

  // Startup failure → abort-start: fails the pending capture IN PLACE
  // with the reason. NEVER the delete endpoint (postmortem root cause:
  // the old rollback here shared the irreversible DELETE with explicit
  // discard, and erased a real meeting). If this call can't get
  // through, the server's pending TTL reaches the same 'failed' state.
  const abortStart = (reason: string) => fetch(
    apiUrl(`/api/sidekick/captures/${capture.id}/abort-start`),
    { method: 'POST', headers: lifecycleHeaders(true), body: JSON.stringify({ reason }) },
  ).catch(() => { /* unreachable — pending TTL fails it in place */ });

  try {
    stream = await acquireMicBounded();
  } catch (e) {
    void abortStart(`mic acquisition failed: ${String((e as Error)?.message || e)}`);
    failToIdle();
    throw e;
  }
  // Re-check after the await: a reload/cancel that landed while
  // getUserMedia was pending must not resurrect the capture.
  if (state.phase !== 'starting' || state.captureId !== capture.id) {
    try { mic.release('meeting'); } catch { /* fine */ }
    stream = null;
    void abortStart('startup superseded on the client');
    return getCaptureState();
  }

  mimeType = pickMime();
  seq = 0;
  state = {
    active: true, captureId: capture.id, title: capture.title,
    chatId: capture.linked_chat, startedAt: Date.now(), phase: 'recording',
    uploaderPending: 0, sealedSegments: 0, marks: 0,
    stalledTotalMs: 0, stalledSince: null,
  };
  // No emit yet — the pill stays on "Starting microphone…" until the
  // recorder start is VERIFIED below.
  if (!startSegment()) {
    try { mic.release('meeting'); } catch { /* fine */ }
    stream = null;
    void abortStart('MediaRecorder.start() threw');
    failToIdle();
    throw new Error('recorder failed to start');
  }

  // Mic owned + recorder running → tell the server (this transition
  // fires the "Recording started" message and session title). A
  // network failure here is non-fatal: the first uploaded segment
  // implies activation server-side. A 409 means the pending capture
  // was superseded/expired while we started — stand down cleanly, no
  // destructive calls (the server already resolved its fate).
  let refused = false;
  try {
    const res = await fetch(apiUrl(`/api/sidekick/captures/${capture.id}/activate`), {
      method: 'POST', headers: lifecycleHeaders(),
    });
    refused = res.status === 409;
  } catch {
    log(`[capture] ${capture.id}: activate unreachable — first segment will imply activation`);
  }
  if (refused) {
    state.captureId = null;   // seal below skips persistence
    sealCurrent();
    try { mic.release('meeting'); } catch { /* fine */ }
    stream = null;
    failToIdle();
    throw new Error('recording was superseded before it could start — try again');
  }

  watchTracks();
  startWatchdog();
  emit();   // NOW the pill flips to the real red recording state
  log(`[capture] started ${capture.id} ("${capture.title}") chat=${capture.linked_chat}`);
  return getCaptureState();
}

export async function stopMeetingCapture(): Promise<void> {
  if (!state.active) return;
  const captureId = state.captureId!;
  state.active = false;
  state.phase = 'finishing';
  emit();
  stopWatchdog();
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
  const postStop = async () => {
    try {
      await fetch(apiUrl(`/api/sidekick/captures/${captureId}/stop`), { method: 'POST' });
    } catch { /* server unreachable — stale heal completes it server-side */ }
  };
  const drainP = ensureUploader().drained();
  const drainedInTime = await Promise.race([
    drainP.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
  ]);
  if (drainedInTime) {
    await postStop();
  } else {
    log(`[capture] ${captureId}: uploads still draining — stop deferred until they land`);
    void drainP.then(postStop);
  }
  state = {
    active: false, captureId: null, title: '', chatId: null,
    startedAt: 0, phase: 'idle', uploaderPending: 0, sealedSegments: 0, marks: 0,
    stalledTotalMs: 0, stalledSince: null,
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
 *  until the retention janitor or a deliberate purge. */
export async function cancelMeetingCapture(): Promise<void> {
  if (!state.active || !state.captureId) return;
  const captureId = state.captureId;
  state = { ...IDLE_STATE };
  emit();
  stopWatchdog();
  if (reacquireTimer != null) { window.clearTimeout(reacquireTimer); reacquireTimer = null; }
  sealCurrent();                       // stops the recorder; persist skipped (captureId cleared)
  try { mic.release('meeting'); } catch { /* fine */ }
  stream = null;
  try {
    const res = await fetch(apiUrl(`/api/sidekick/captures/${captureId}/discard`), {
      method: 'POST',
      headers: lifecycleHeaders(true),
      body: JSON.stringify({ reason: 'user cancel (pill discard)' }),
    });
    if (!res.ok) {
      log(`[capture] discard of ${captureId} answered ${res.status} — server reconciles via sweep`);
    }
  } catch { /* server unreachable — stale-recording auto-heal resolves it in place */ }
  log(`[capture] canceled ${captureId} → Recently Deleted (recoverable)`);
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
  void fetch(apiUrl(`/api/sidekick/captures/${state.captureId}/marks`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ t_ms: nowMs() }),
  }).catch(() => { /* mark is decorative; never disturb the recording */ });
}

/** Rename / re-link from the pill sheet — thin PATCH passthrough. */
export async function renameCapture(title: string): Promise<void> {
  if (!state.captureId) return;
  state.title = title;
  emit();
  await fetch(apiUrl(`/api/sidekick/captures/${state.captureId}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).catch(() => { /* retryable via sheet */ });
}
