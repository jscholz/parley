// The capture ENGINE seam (2026-11-16, after the LocalGlobe loss).
//
// A capture has two halves that used to be one 1000-line module:
//
//   * the ORCHESTRATOR (recorder.ts): capture identity + ledger, the
//     server conversation (register / activate / marks / stop), the UI
//     state the pill renders, health pings. Platform-neutral.
//   * the ENGINE (this contract): owns the microphone, cuts the audio into
//     self-contained ~45 s segments, keeps every sealed segment DURABLE on
//     the device until the server has acknowledged it, and reports what it
//     is doing. Platform-specific — and the only part that knows how.
//
// Two engines implement it:
//
//   * engines/web.ts — getUserMedia + MediaRecorder, durability through the
//     IndexedDB segment store, delivery through the shared uploader. Used
//     by the PWA and desktop, where a browser page is not frozen on lock.
//   * engines/native.ts — the Capacitor shell's Swift recorder
//     (mobile/ios/App/App/ParleyRecorderPlugin.swift): AVAudioEngine writes
//     segment files under the app sandbox, a background URLSession uploads
//     them, and iOS keeps all of it running with the screen locked. The
//     page may freeze; the recording does not.
//
// The contract is deliberately small and one-directional: the orchestrator
// calls down, the engine reports up through `EngineHandlers`. Nothing the
// SERVER says ever changes an engine's state — the 2026-11-16 recorder died
// because a false "stalled" verdict from the server flipped the client into
// a state nothing could leave. An engine leaves 'interrupted' on its own
// (OS resume signal, mic re-acquired) or not at all, and says so.

/** A sealed segment: one self-contained audio file, capture-relative t0. */
export interface SealedSegment {
  seq: number;
  t0Ms: number;
  mime: string;
  bytes: number;
}

/** What the engine is doing right now.
 *   recording    — mic held, bytes flowing.
 *   interrupted  — the OS took the mic (call, Siri, route change) or the
 *                  recorder died; the engine is trying to get it back and
 *                  will say 'recording' again when it has. Involuntary.
 *   paused       — the user paused; mic released, nothing is retried.
 *   stopped      — stop()/cancel() completed, or the engine gave up
 *                  (detail.reason says which). Terminal for this start. */
export type EngineState = 'recording' | 'interrupted' | 'paused' | 'stopped';

export interface EngineStateDetail {
  reason?: string;
}

export interface EngineHandlers {
  /** State transitions, in order. The same state may repeat with a new
   *  reason; handlers must be idempotent. */
  onState(state: EngineState, detail?: EngineStateDetail): void;
  /** A segment has been sealed and is DURABLE on this device. The engine
   *  owns its delivery from here. */
  onSegmentSealed(seg: SealedSegment): void;
  /** The server acknowledged this segment; the engine has released its
   *  durable copy. */
  onSegmentUploaded(seq: number): void;
  /** Audio progress heartbeat: at least one buffer/chunk arrived since the
   *  last call. The orchestrator's "is audio really flowing" evidence. */
  onAudioProgress?(): void;
  /** The last delivery attempt could (true) / could not (false) reach the
   *  server. Drives the pill's offline chip. */
  onNetwork?(online: boolean): void;
}

export interface EngineStartOpts {
  captureId: string;
  /** Target segment length. */
  segmentMs: number;
  /** Capture-relative clock origin (epoch ms) — segment t0 values are
   *  measured from this so a resumed engine keeps the capture's timeline. */
  startedAt: number;
  handlers: EngineHandlers;
}

/** Diagnostic snapshot for the health ping — honest, engine-specific
 *  fields plus the few every engine can answer. */
export interface EngineHealth {
  engine: 'web' | 'native';
  recorder_state: string;
  track_ready_state: string;
  track_muted: boolean | null;
  track_enabled: boolean | null;
  /** Audio progress ticks since start (dataavailable / tap buffers). */
  chunks: number;
  last_chunk_age_ms: number | null;
  /** Segments sealed and not yet acknowledged by the server. */
  pending_uploads: number;
  sealed_segments: number;
  mime: string | null;
  [extra: string]: unknown;
}

export interface CaptureEngine {
  readonly kind: 'web' | 'native';
  /** Synchronous, called INSIDE the user's start tap before any await:
   *  whatever a platform can only do from a user gesture (the web engine
   *  starts the silent keepalive that unlocks background play on iOS).
   *  Paired with disarm() on every exit from the capture lifecycle. */
  arm(): void;
  disarm(): void;
  /** Acquire the mic and prove audio is flowing. Resolves only once the
   *  first segment is running; rejects (with the mic released) otherwise.
   *  A rejected start has produced nothing durable. */
  start(opts: EngineStartOpts): Promise<void>;
  /** Seal the running segment, release the mic. Resolves once the final
   *  segment is durable (not uploaded). */
  stop(): Promise<void>;
  /** Stop and DROP the running segment; already-sealed segments stay in
   *  the engine's durable store (the recorder's discard semantics keep
   *  them for the retention window). */
  cancel(): Promise<void>;
  /** User pause: seal, release the mic (OS indicator goes dark). */
  pause(): Promise<void>;
  /** User resume after pause. Rejects if the mic cannot be re-acquired. */
  resume(): Promise<void>;
  /** Sealed-but-unacknowledged segments for this capture (or all captures
   *  the engine still holds audio for, when no id is given). */
  pendingUploads(captureId?: string): number;
  /** Resolves when nothing for this capture is left to upload. Never
   *  rejects; a permanently offline device simply waits. */
  drained(captureId: string): Promise<void>;
  /** Nudge delivery (after the network comes back, after registration). */
  kick(): void;
  health(): EngineHealth;
}

/** Which engine this runtime gets. The native engine is used only inside
 *  the Capacitor shell when its recorder plugin is actually registered —
 *  Capacitor 8 does not auto-discover local plugins, so "running in the
 *  shell" is not enough (ExternalBrowserPlugin.swift, 2026-09-06). */
export function selectEngineKind(win: any = typeof window !== 'undefined' ? window : undefined): 'web' | 'native' {
  const cap = win?.Capacitor;
  if (!cap) return 'web';
  try {
    if (typeof cap.isNativePlatform === 'function' && !cap.isNativePlatform()) return 'web';
    if (typeof cap.isPluginAvailable === 'function' && !cap.isPluginAvailable('ParleyRecorder')) return 'web';
  } catch { return 'web'; }
  return 'native';
}
