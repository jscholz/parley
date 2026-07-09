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
import { putSegment, clearCapture } from './segmentStore.ts';
import { createUploader, type Uploader } from './uploader.ts';
import { apiUrl } from '../apiBase.ts';
import { log } from '../util/log.ts';

export interface CaptureUiState {
  active: boolean;
  captureId: string | null;
  title: string;
  chatId: string | null;
  /** epoch ms of capture start (timer renders from this). */
  startedAt: number;
  /** Pill copy + button states. 'paused' is USER-deliberate (pause
   *  button — mic fully released, OS indicator goes dark);
   *  'interrupted' is INVOLUNTARY (call/Siri stole the mic — amber,
   *  auto-resume polling). Distinct on purpose: auto-resume after a
   *  deliberate pause would be a privacy bug. */
  phase: 'idle' | 'recording' | 'paused' | 'interrupted' | 'finishing';
  uploaderPending: number;
  sealedSegments: number;
  marks: number;
}

const SEGMENT_MS = 45_000;

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
};

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let segTimer: number | null = null;
let seq = 0;
let segStartMs = 0;          // capture-relative t0 of the running segment
let mimeType = '';
let uploader: Uploader | null = null;
let reacquireTimer: number | null = null;

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

/** Boot-time: drain any segments a previous session left in IDB.
 *  Cheap no-op when the buffer is empty. */
export function resumePendingUploads(): void {
  ensureUploader().kick();
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
 *  the blob and (while still active) starts the next segment. */
function startSegment(): void {
  if (!stream || !state.active) return;
  const chunks: Blob[] = [];
  segStartMs = nowMs();
  const rec = new MediaRecorder(
    stream,
    mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 },
  );
  recorder = rec;
  rec.ondataavailable = (ev: BlobEvent) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
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
    // requested by stopMeetingCapture flips state.active first).
    if (state.active && state.phase === 'recording') startSegment();
  };
  // 1s timeslice (memo.ts prior art): steady dataavailable cadence and
  // size-agnostic chunk handling (Safari can flush oversized chunks
  // after OS-level interruptions — plan finding #2).
  rec.start(1000);
  if (segTimer != null) window.clearTimeout(segTimer);
  segTimer = window.setTimeout(() => {
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* sealed */ }
  }, SEGMENT_MS);
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
      state.phase = 'recording';
      emit();
      startSegment();
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
      emit();
      sealCurrent();
    }
  });
  track.addEventListener('unmute', () => {
    if (state.active && state.phase === 'interrupted' && stream) {
      state.phase = 'recording';
      emit();
      startSegment();
    }
  });
}

export async function startMeetingCapture(
  opts: { title?: string; linkedChat?: string } = {},
): Promise<CaptureUiState> {
  if (state.active) return getCaptureState();
  // Create server-side FIRST (instant-start: no prompts — title
  // defaults, annotate later via PATCH; §3.4). linkedChat carries the
  // PLACEMENT-SCOPED semantics (field UX 2026-07-09): app-level entry
  // points omit it → 'new' mints a dedicated meeting session (§3.6);
  // the composer mic-menu passes the viewed chat → the meeting lands
  // in the session the user is standing in.
  const res = await fetch(apiUrl('/api/sidekick/captures'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: opts.title || undefined,
      linked_chat: opts.linkedChat || 'new',
      diarize: true,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || `capture create failed (${res.status})`);
  }
  const { capture } = await res.json();

  try {
    stream = await mic.acquire('meeting', MIC_CONSTRAINTS);
  } catch (e) {
    // Roll back with DELETE, not stop (audit 2026-07-09): stopping a
    // zero-segment capture ran the whole pipeline — a minted session,
    // a start message, then an ingest turn asking the agent to
    // summarize an empty transcript — on the COMMON first-use
    // mic-permission-denied path. Cancel semantics erase it entirely.
    void fetch(apiUrl(`/api/sidekick/captures/${capture.id}`), { method: 'DELETE' });
    throw e;
  }

  mimeType = pickMime();
  seq = 0;
  state = {
    active: true, captureId: capture.id, title: capture.title,
    chatId: capture.linked_chat, startedAt: Date.now(), phase: 'recording',
    uploaderPending: 0, sealedSegments: 0, marks: 0,
  };
  watchTracks();
  startSegment();
  emit();
  log(`[capture] started ${capture.id} ("${capture.title}") chat=${capture.linked_chat}`);
  return getCaptureState();
}

export async function stopMeetingCapture(): Promise<void> {
  if (!state.active) return;
  const captureId = state.captureId!;
  state.active = false;
  state.phase = 'finishing';
  emit();
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
  };
  emit();
  log(`[capture] stopped ${captureId}`);
}

/** Cancel = discard WITHOUT ingesting (field ask 2026-07-09). The
 *  inverse promise of stop: nothing is saved, no agent turn fires.
 *  Clearing state.captureId BEFORE stopping the recorder makes the
 *  onstop seal a no-op (its persist path checks captureId), then the
 *  IDB buffer for this capture is dropped and the server capture is
 *  hard-deleted (segments already uploaded included). */
export async function cancelMeetingCapture(): Promise<void> {
  if (!state.active || !state.captureId) return;
  const captureId = state.captureId;
  state = {
    active: false, captureId: null, title: '', chatId: null,
    startedAt: 0, phase: 'idle', uploaderPending: 0, sealedSegments: 0, marks: 0,
  };
  emit();
  if (reacquireTimer != null) { window.clearTimeout(reacquireTimer); reacquireTimer = null; }
  sealCurrent();                       // stops the recorder; persist skipped (captureId cleared)
  try { mic.release('meeting'); } catch { /* fine */ }
  stream = null;
  await clearCapture(captureId);       // un-uploaded audio must not drain later
  try {
    await fetch(apiUrl(`/api/sidekick/captures/${captureId}`), { method: 'DELETE' });
  } catch { /* server unreachable — stale-recording auto-heal covers the manifest */ }
  log(`[capture] canceled + discarded ${captureId}`);
}

/** Pause = seal the running segment and RELEASE the mic (the OS mic
 *  indicator must go dark — the pause button is a privacy promise).
 *  The capture entity stays open server-side; the t0 gap between the
 *  sealed segment and the next one IS the pause marker in the
 *  manifest. Same seal machinery as interruptions, but no auto-resume. */
export function pauseMeetingCapture(): void {
  if (!state.active || state.phase !== 'recording') return;
  state.phase = 'paused';
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
  state.phase = 'recording';
  emit();
  startSegment();
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
