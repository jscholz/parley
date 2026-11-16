// Web capture engine — getUserMedia + MediaRecorder (engine.ts contract).
//
// The browser half of the seam: used by the PWA and desktop, and by the
// Capacitor shell only when the native recorder plugin is not registered.
//
// Records the mic as a chain of ~45 s SELF-CONTAINED segments: a fresh
// MediaRecorder per segment (stop → new recorder on the same stream) so
// every file carries its own container header — byte-slicing one long
// recording loses the header for all but the first slice, the exact
// lesson chunkedTranscribe.ts learned the hard way. Every sealed segment
// goes to the durable sink FIRST (IndexedDB, supplied by the orchestrator)
// and is uploaded by the shared uploader behind it; a crash loses at most
// the in-flight segment, and partial flushes every few seconds shrink
// even that.
//
// Recovery rules (every one a past incident):
//   * a dead chain with no event (2026-07-09 #5) — the watchdog sees no
//     chunk for 20 s and re-acquires;
//   * an interruption that never resumes (2026-11-16) — every entry into
//     'interrupted' arms the re-acquire poll, so there is ALWAYS an owner
//     for leaving that state. The server has no say here at all.

import * as mic from '../../audio/shared/capture.ts';
import * as audioSession from '../../audio/shared/session.ts';
import { log } from '../../util/log.ts';
import type {
  CaptureEngine, EngineHandlers, EngineHealth, EngineStartOpts, EngineState,
} from '../engine.ts';

/** The durable store + delivery the orchestrator lends this engine. The
 *  engine never talks to the server itself; it persists and kicks. */
export interface WebSegmentSink {
  persist(seg: { captureId: string; seq: number; t0Ms: number; mime: string; blob: Blob }): Promise<unknown>;
  persistPartial(seg: { captureId: string; seq: number; t0Ms: number; mime: string; blob: Blob }): Promise<unknown>;
  /** Drop a segment row (empty seal, cancelled segment). */
  remove(captureId: string, seq: number): Promise<void>;
  /** Nudge the uploader. */
  kick(): void;
  pendingUploads(captureId?: string): number;
  drained(captureId: string): Promise<void>;
  /** The uploader acked a segment — the engine forwards this upward. */
  onUploaded(cb: (captureId: string, seq: number) => void): void;
}

/** How often the running segment's chunks-so-far are rewritten to the
 *  durable buffer (partial row). A page the OS kills mid-segment loses
 *  at most this much audio instead of the whole segment. */
const PARTIAL_FLUSH_MS = 5_000;

/** Holder key for the background keepalive (audio/shared/ios-specific).
 *  Held `always` for the life of a capture: the 2026-10-21 meeting was
 *  lost because the native shell's page froze five seconds after the
 *  screen locked, with nothing playing to keep it alive. */
const KEEPALIVE_KEY = 'meeting';

/** Bounded startup (postmortem P1): the incident's getUserMedia hung
 *  for 21 minutes with no visible state. Past this, startup fails
 *  loudly and the pending server capture is aborted in place. */
const START_TIMEOUT_MS = 20_000;

/** No chunk for this long on a 1 s timeslice = the chain is dead in a
 *  way no event reported. */
const WATCHDOG_SILENCE_MS = 20_000;
/** 'interrupted' with no re-acquire attempt pending for this long =
 *  the signal we were waiting for (unmute) is never coming. */
const INTERRUPTED_ORPHAN_MS = 30_000;

// Far-field room capture tuning: AGC ON lifts distant speakers; AEC OFF
// (nothing plays through the speaker during capture); NS OFF (STT models
// prefer unshaped spectra; Deepgram does its own).
const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
};

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export function createWebEngine(sink: WebSegmentSink): CaptureEngine {
  let captureId: string | null = null;
  let handlers: EngineHandlers | null = null;
  let segmentMs = 45_000;
  let startedAt = 0;
  let engineState: EngineState = 'stopped';
  let active = false;                 // start() succeeded, stop/cancel not yet called

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let segTimer: number | null = null;
  let seq = 0;
  let mimeType = '';
  let reacquireTimer: number | null = null;
  let watchdogTimer: number | null = null;
  let lastChunkAt = 0;
  let chunkCount = 0;
  let sealedSegments = 0;
  let interruptedSince = 0;
  /** The persist of the most recent seal — stop() awaits it so "final
   *  segment durable" is true, not approximate. */
  let lastSeal: Promise<unknown> = Promise.resolve();

  sink.onUploaded((id, n) => { if (id === captureId) handlers?.onSegmentUploaded(n); });

  function nowMs(): number { return Date.now() - startedAt; }

  function setState(next: EngineState, reason?: string): void {
    engineState = next;
    interruptedSince = next === 'interrupted' ? (interruptedSince || Date.now()) : 0;
    handlers?.onState(next, reason ? { reason } : undefined);
  }

  function clearReacquire(): void {
    if (reacquireTimer != null) { window.clearTimeout(reacquireTimer); reacquireTimer = null; }
  }

  /** One segment = one MediaRecorder lifetime. onstop seals + persists
   *  the blob and (while still recording) starts the next segment.
   *  Returns whether MediaRecorder.start() actually succeeded. */
  function startSegment(): boolean {
    if (!stream || !active || !captureId) return false;
    const chunks: Blob[] = [];
    const myCapture = captureId;
    const mySeq = seq++;
    const t0Ms = nowMs();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 },
      );
    } catch (e) {
      log(`[capture:web] MediaRecorder construction failed (${String(e)})`);
      seq = mySeq;
      return false;
    }
    recorder = rec;
    let lastFlushAt = Date.now();
    let flushing = false;
    let dirty = false;
    const flushPartial = () => {
      if (flushing || !dirty || captureId !== myCapture) return;
      flushing = true; dirty = false; lastFlushAt = Date.now();
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      void sink.persistPartial({ captureId: myCapture, seq: mySeq, t0Ms, mime: blob.type, blob })
        .catch(() => { /* durability is best-effort; the seal still persists */ })
        .finally(() => { flushing = false; });
    };
    rec.ondataavailable = (ev: BlobEvent) => {
      lastChunkAt = Date.now();
      if (ev.data && ev.data.size) { chunkCount += 1; chunks.push(ev.data); dirty = true; }
      handlers?.onAudioProgress?.();
      if (rec.state === 'recording' && Date.now() - lastFlushAt >= PARTIAL_FLUSH_MS) flushPartial();
    };
    rec.onerror = () => {
      log('[capture:web] recorder error — treating as interruption');
      handleInterruption('recorder error');
    };
    rec.onstop = () => {
      if (recorder === rec) recorder = null;
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      const stillOurs = captureId === myCapture;
      if (blob.size > 0 && stillOurs) {
        lastSeal = sink.persist({ captureId: myCapture, seq: mySeq, t0Ms, mime: blob.type, blob }).then(() => {
          sealedSegments += 1;
          handlers?.onSegmentSealed({ seq: mySeq, t0Ms, mime: blob.type, bytes: blob.size });
          sink.kick();
        }).catch((e) => { log(`[capture:web] persist of seq ${mySeq} failed: ${String(e)}`); });
      } else {
        // Nothing to keep (empty segment) or the capture was cancelled
        // mid-segment: remove any partial copy, and hand an unused seq
        // back when no later segment has claimed one.
        void sink.remove(myCapture, mySeq).catch(() => { /* nothing there */ });
        if (blob.size === 0 && seq === mySeq + 1) seq = mySeq;
      }
      // Chain the next segment while recording. A stop()/pause()/
      // interruption flips engineState first, so this is the ONLY place a
      // healthy chain continues — and the only state it continues in.
      if (active && engineState === 'recording' && stillOurs) {
        if (!startSegment()) handleInterruption('chain restart failed');
      }
    };
    try {
      rec.start(1000);   // 1 s timeslice: steady cadence, size-agnostic
    } catch (e) {
      log(`[capture:web] recorder start failed (${String(e)})`);
      if (recorder === rec) recorder = null;
      return false;
    }
    lastChunkAt = Date.now();
    if (segTimer != null) window.clearTimeout(segTimer);
    segTimer = window.setTimeout(() => {
      try { if (rec.state !== 'inactive') rec.stop(); } catch { /* sealed */ }
    }, segmentMs);
    return true;
  }

  /** Seal the running segment immediately (interruption, pause, stop). */
  function sealCurrent(): void {
    if (segTimer != null) { window.clearTimeout(segTimer); segTimer = null; }
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* already */ }
  }

  /** Mic vanished mid-meeting (phone call, Siri, route change, dead
   *  chain). Seal what we have and poll to re-acquire. Every entry into
   *  'interrupted' comes through here, so the re-acquire poll is ALWAYS
   *  armed — nothing else can leave the state, and nothing waits on a
   *  signal that may never come. */
  function handleInterruption(reason: string): void {
    if (!active) return;
    if (engineState !== 'interrupted') setState('interrupted', reason);
    sealCurrent();
    try { mic.release('meeting'); } catch { /* released */ }
    stream = null;
    clearReacquire();
    const tryReacquire = async () => {
      reacquireTimer = null;
      if (!active || engineState !== 'interrupted') return;
      try {
        const acquired = await mic.acquire('meeting', MIC_CONSTRAINTS);
        // Re-check AFTER the await (audit 2026-07-09 #2): a stop/cancel
        // that landed while getUserMedia was pending must not strand a
        // live mic with no pill.
        if (!active || engineState !== 'interrupted') {
          try { mic.release('meeting'); } catch { /* fine */ }
          return;
        }
        stream = acquired;
        watchTracks();
        setState('recording', 'mic re-acquired');
        if (!startSegment()) { handleInterruption('restart after re-acquire failed'); return; }
        log('[capture:web] mic re-acquired after interruption');
      } catch {
        reacquireTimer = window.setTimeout(tryReacquire, 3000);
      }
    };
    reacquireTimer = window.setTimeout(tryReacquire, 1000);
  }

  function watchTracks(): void {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    track.addEventListener('ended', () => handleInterruption('track ended'));
    // iOS signals interruptions as mute/unmute on a LIVE track (vs
    // 'ended' when the mic is fully revoked). A muted track must not keep
    // chaining silent segments (audit 2026-07-09 #13); unmute resumes on
    // the same stream, and the orphan watchdog re-acquires if it never
    // comes.
    track.addEventListener('mute', () => {
      if (active && engineState === 'recording') {
        setState('interrupted', 'track muted');
        sealCurrent();
      }
    });
    track.addEventListener('unmute', () => {
      if (active && engineState === 'interrupted' && stream && reacquireTimer == null) {
        setState('recording', 'track unmuted');
        if (!startSegment()) handleInterruption('restart after unmute failed');
      }
    });
  }

  function startWatchdog(): void {
    if (watchdogTimer != null) return;
    watchdogTimer = window.setInterval(() => {
      if (!active) return;
      if (engineState === 'recording') {
        const silentFor = Date.now() - lastChunkAt;
        if (lastChunkAt > 0 && silentFor > WATCHDOG_SILENCE_MS) {
          log(`[capture:web] watchdog: no audio chunks for ${Math.round(silentFor / 1000)}s — forcing recovery`);
          handleInterruption('no chunks');
        }
      } else if (engineState === 'interrupted' && reacquireTimer == null) {
        // Waiting on an unmute that is not coming (2026-11-16 shape: the
        // phase said interrupted, the recorder was gone, nothing was
        // polling). Take ownership: re-acquire.
        if (interruptedSince && Date.now() - interruptedSince > INTERRUPTED_ORPHAN_MS) {
          log('[capture:web] watchdog: interrupted with no recovery pending — re-acquiring');
          handleInterruption('orphaned interruption');
        }
      }
    }, 5000);
  }

  function stopWatchdog(): void {
    if (watchdogTimer != null) { window.clearInterval(watchdogTimer); watchdogTimer = null; }
  }

  /** getUserMedia with a hard deadline. If the OS grants the mic after we
   *  already gave up, it is released on the spot — never a live mic with
   *  no pill. */
  async function acquireMicBounded(): Promise<MediaStream> {
    let gaveUp = false;
    const acquireP = mic.acquire('meeting', MIC_CONSTRAINTS);
    acquireP.then(
      () => { if (gaveUp) { try { mic.release('meeting'); } catch { /* fine */ } } },
      () => { /* rejection surfaces through the race below */ },
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

  function teardown(): void {
    stopWatchdog();
    clearReacquire();
    try { mic.release('meeting'); } catch { /* released */ }
    stream = null;
    active = false;
  }

  const engine: CaptureEngine = {
    kind: 'web',

    arm() {
      try { audioSession.holdKeepalive(KEEPALIVE_KEY, { always: true }); } catch { /* non-browser */ }
    },
    disarm() {
      try { audioSession.releaseKeepalive(KEEPALIVE_KEY); } catch { /* non-browser */ }
    },

    async start(opts: EngineStartOpts) {
      if (active) throw new Error('web engine already started');
      captureId = opts.captureId;
      handlers = opts.handlers;
      segmentMs = opts.segmentMs;
      startedAt = opts.startedAt;
      seq = 0; chunkCount = 0; sealedSegments = 0; lastChunkAt = 0; interruptedSince = 0;
      stream = await acquireMicBounded();
      mimeType = pickMime();
      active = true;
      engineState = 'recording';
      if (!startSegment()) {
        teardown();
        engineState = 'stopped';
        throw new Error('recorder failed to start');
      }
      watchTracks();
      startWatchdog();
      handlers.onState('recording');
    },

    async stop() {
      if (!active) return;
      active = false;
      stopWatchdog();
      clearReacquire();
      const sealed = new Promise<void>((resolve) => {
        const rec = recorder;
        if (!rec || rec.state === 'inactive') { resolve(); return; }
        const prior = rec.onstop;
        rec.onstop = (ev) => { try { (prior as any)?.call(rec, ev); } finally { resolve(); } };
      });
      sealCurrent();
      try { mic.release('meeting'); } catch { /* fine */ }
      stream = null;
      // Final segment DURABLE before stop() resolves (the contract): wait
      // for the recorder's stop event, then for that seal's persist.
      // Bounded, so a recorder that never fires onstop cannot hang the
      // stop flow — the partial row then holds the audio.
      await Promise.race([sealed, new Promise((r) => setTimeout(r, 1500))]);
      await Promise.race([lastSeal, new Promise((r) => setTimeout(r, 1500))]);
      setState('stopped', 'stopped');
    },

    async cancel() {
      if (!active) return;
      const id = captureId;
      captureId = null;          // the running segment's onstop sees !stillOurs → dropped
      teardown();
      sealCurrent();
      captureId = id;
      setState('stopped', 'cancelled');
    },

    async pause() {
      if (!active || engineState !== 'recording') return;
      setState('paused');
      clearReacquire();
      sealCurrent();
      try { mic.release('meeting'); } catch { /* released */ }
      stream = null;
    },

    async resume() {
      if (!active || engineState !== 'paused') return;
      const acquired = await mic.acquire('meeting', MIC_CONSTRAINTS);
      if (!active || engineState !== 'paused') {
        try { mic.release('meeting'); } catch { /* fine */ }
        return;
      }
      stream = acquired;
      watchTracks();
      setState('recording', 'resumed');
      if (!startSegment()) handleInterruption('restart after resume failed');
    },

    pendingUploads(id?: string) { return sink.pendingUploads(id ?? captureId ?? undefined); },
    drained(id: string) { return sink.drained(id); },
    kick() { sink.kick(); },

    health(): EngineHealth {
      const track = stream?.getAudioTracks?.()[0] || null;
      return {
        engine: 'web',
        recorder_state: recorder?.state ?? 'none',
        track_ready_state: track?.readyState ?? 'none',
        track_muted: track?.muted ?? null,
        track_enabled: track?.enabled ?? null,
        chunks: chunkCount,
        last_chunk_age_ms: lastChunkAt ? Date.now() - lastChunkAt : null,
        pending_uploads: sink.pendingUploads(captureId ?? undefined),
        sealed_segments: sealedSegments,
        mime: mimeType || null,
        engine_state: engineState,
        // Was the page visible, and was anything keeping it alive? The
        // 2026-10-21 trail could not say either.
        visibility: typeof document !== 'undefined' ? document.visibilityState : null,
        keepalive: audioSession.isKeepaliveRunning(),
      };
    },
  };
  return engine;
}
