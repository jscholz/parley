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
  });
  return uploader;
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
        state.uploaderPending = state.sealedSegments;   // refined by onDrained
        ensureUploader().kick();
        emit();
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
      stream = await mic.acquire('meeting', MIC_CONSTRAINTS);
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
  // iOS signals interruptions as mute/unmute on a live track.
  track.addEventListener('mute', () => {
    if (state.active && state.phase === 'recording') { sealCurrent(); }
  });
  track.addEventListener('unmute', () => {
    if (state.active && state.phase === 'recording' && !recorder) startSegment();
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
    // Roll the server capture back so the one-active rule isn't wedged
    // by a mic-permission denial.
    void fetch(apiUrl(`/api/sidekick/captures/${capture.id}/stop`), { method: 'POST' });
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
  // uploader to drain before declaring stop server-side. Segments are
  // accepted after /stop too (resumable contract), so a timeout here
  // degrades gracefully rather than losing audio.
  await new Promise((r) => setTimeout(r, 400));
  await Promise.race([
    ensureUploader().drained(),
    new Promise((r) => setTimeout(r, 15_000)),
  ]);
  try {
    await fetch(apiUrl(`/api/sidekick/captures/${captureId}/stop`), { method: 'POST' });
  } catch { /* server unreachable — uploader keeps draining; stale heal covers the manifest */ }
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
  stream = await mic.acquire('meeting', MIC_CONSTRAINTS);
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
