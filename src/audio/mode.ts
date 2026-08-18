/**
 * @fileoverview AudioMode interface — the dispatch contract that both
 * voice modes (turn-based and realtime) implement. Lets `src/main.ts`
 * pick a mode based on `settings.realtime` and call into it without
 * mode-specific branching.
 *
 * See `src/audio/README.md` for the full picture (where each mode
 * lives, what's shared, what's mode-specific). This file is just the
 * contract.
 *
 * The interface is richer than a bare lifecycle (start/stop/isActive)
 * because today both modes drive the same agent-contract endpoints
 * (`/api/parley/messages` + `/api/parley/stream`), so "user
 * committed an utterance" and "agent reply playing" are meaningful in
 * both. A future duplex-native backend (OpenAI Realtime, Gemini Live)
 * would break that: realtime mode would stream audio in both
 * directions without discrete commit boundaries, so `onCommit` would
 * stop being meaningful for that mode. When that lands we'll either
 * widen `AudioModeState` (add `speaking` / `listening` / `interrupted`)
 * or split this interface into `AudioMode` + `DuplexMode`. Don't
 * pre-build the abstraction — the duplex shape isn't pinned down.
 */

/** Sub-state machine common to both modes. Names are a superset; modes
 *  that don't visit a state simply skip it (e.g. realtime doesn't
 *  visit `cooldown`). Maps onto UI affordances (mic icon, status pill)
 *  via the `onState` callback. */
export type AudioModeState =
  | 'idle'        // Mode not running.
  | 'armed'       // Mic open, waiting for user speech.
  | 'recording'   // User actively speaking, audio being captured.
  | 'sending'     // Utterance committed, request in flight to backend.
  | 'playing'     // Agent reply audio playing through speakers.
  | 'cooldown';   // Brief grace window after playback before re-arming.

/** Fired when the user commits an utterance via one of the handsfree
 *  triggers. `text` is the cleaned transcript (sendword stripped if
 *  applicable). `reason` lets the caller decide whether to apply
 *  per-trigger UI (e.g. silence vs. sendword commit). */
export type CommitReason = 'silence' | 'sendword' | 'barge';

export type AudioModeStartOpts = {
  /** UI status hook — called on every state transition. Caller
   *  mirrors the state to the mic icon + status pill text. */
  onState?: (s: AudioModeState) => void;

  /** User committed an utterance. The transcript has already been
   *  cleaned (sendword stripped, etc.). The caller's job is to
   *  dispatch it through the chat send path; this module is
   *  agnostic to how that happens.
   *
   *  NOTE: meaningful only for turn-based-shaped backends today.
   *  A duplex-native backend would not fire this — see file header. */
  onCommit?: (text: string, reason: CommitReason) => void;

  /** Sustained user speech detected during agent TTS playback. The
   *  caller decides what to do (typically: cancel TTS playback,
   *  notify mode to re-arm). The mode itself does NOT cancel
   *  playback — TTS lifecycle is owned by the caller. */
  onBarge?: () => void;

  /** Mode was stopped externally (user hit cancel, navigation, etc.)
   *  and the mode wants to confirm teardown for UI cleanup. */
  onCancel?: () => void;
};

export interface AudioMode {
  /** Acquire mic + run mode-specific setup. Returns false if the mic
   *  was unavailable (no device, permission denied). Multiple calls
   *  while active are no-ops. */
  start(opts?: AudioModeStartOpts): Promise<boolean>;

  /** Release mic + tear down. Idempotent. */
  stop(): Promise<void>;

  /** Is this mode currently running? Used by main.ts as a guard
   *  before flipping the other mode on (mutual exclusion). */
  isActive(): boolean;

  /** Lifecycle/status sub-state. Same union as the `onState` callback. */
  getState(): AudioModeState;

  /** Caller signals an external TTS playback (turn-based: PWA `/tts`
   *  blob; realtime: peer-track audio) is starting / ending. Drives
   *  barge detection windows + cooldown timers inside the mode. */
  notifyReplyPlayback(playing: boolean): void;
}
