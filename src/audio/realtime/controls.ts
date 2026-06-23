/**
 * @fileoverview WebRTC speaker bindings + call lifecycle helpers.
 *
 * The toolbar #btn-mic that used to live here is gone — the unified
 * composer mic now drives all four voice modes (memo/call × auto/manual)
 * and invokes `toggleCall` / `closeIfOpen` directly through this module's
 * exports.  The toolbar #btn-speak is also gone — the TTS-reply
 * preference (settings.tts) now lives as a "Speak replies" toggle in
 * the mic-mode menu (see main.ts flipMicSetting). Mid-call flips
 * cycle the connection into the new mode immediately.
 *
 *   toggleCall / closeIfOpen / isOpen / currentMode = exports the
 *   composer-mic dispatch in main.ts uses to open/close a stream-mode
 *   or talk-mode call. Mode (stream vs talk) derives from
 *   settings.tts AT THE TIME OF CALL OPEN.
 */

import * as conn from './realtime.ts';
import * as dictation from './dictation.ts';
import * as suppress from './suppress.ts';
import * as realtimeBarge from './realtimeBarge.ts';
import * as settings from '../../settings.ts';
import * as backend from '../../backend.ts';
import { playFeedback } from '../shared/feedback.ts';
import { log, diag } from '../../util/log.ts';

/** Cadence (ms) for the recurring 'reconnect-tick' chime while the
 *  peer is in 'reconnecting' state. ~3s feels recurring enough to read
 *  as "we're still trying" without being a nuisance during a wobbly
 *  network gap (which the give-up timer caps at ~10s). No settings
 *  knob — Jonathan can ask for one if it needs tuning. */
const RECONNECT_TICK_MS = 3000;
let reconnectTickTimer: ReturnType<typeof setInterval> | null = null;

function startReconnectTickLoop(): void {
  if (reconnectTickTimer !== null) return;  // idempotent
  // Fire one immediately so the user gets the first cue right when the
  // state flips to 'reconnecting' — otherwise they'd wait the full
  // RECONNECT_TICK_MS before hearing anything (the give-up timer might
  // even fire first). Subsequent ticks happen on the interval.
  try { playFeedback('reconnect-tick'); } catch { /* feedback best-effort */ }
  reconnectTickTimer = setInterval(() => {
    try { playFeedback('reconnect-tick'); } catch { /* best-effort */ }
  }, RECONNECT_TICK_MS);
}

function stopReconnectTickLoop(): void {
  if (reconnectTickTimer === null) return;
  clearInterval(reconnectTickTimer);
  reconnectTickTimer = null;
}

/** Resolve the (sessionId, chatId) pair to ship in the offer payload.
 *  hermes-gateway uses chat_ids; everything else uses the legacy
 *  conv_name/sessionId. The bridge picks the dispatch route based on
 *  which one is set — see audio-bridge/stt_bridge.py:_dispatch_to_agent. */
function resolveCallSession(): { sessionId: string | null; chatId: string | null } {
  const id = opts?.getSessionId() ?? null;
  if (backend.name() === 'proxy-client') {
    return { sessionId: null, chatId: id };
  }
  return { sessionId: id, chatId: null };
}

export interface ControlsOpts {
  getSessionId: () => string | null;
  onStatus?: (msg: string, kind?: 'ok' | 'err' | 'live' | null) => void;
  /** Fires after every WebRTC state transition. Same signal that drives
   *  `onStatus` internally; exposed so subscribers (e.g. wake-lock
   *  evaluator in main.ts) can react to call open/close without having
   *  to poll `isOpen()`. State strings: 'idle' | 'requesting-mic' |
   *  'connecting' | 'connected' | 'closing' | 'failed'. */
  onCallStateChange?: (state: string, mode: string | null) => void;
  /** Fires when a CONNECTED call was dropped by the network (not a user
   *  hangup). Host uses it to raise the "Call dropped — network unstable"
   *  banner with a Reconnect affordance. `reason` is the close reason from
   *  realtime.ts (e.g. 'net-failed', 'net-disconnect'). */
  onCallDropped?: (reason: string) => void;
  /** True when the OPEN WebRTC peer was mic-initiated (realtime dictation
   *  drives the composer mic, btn-mic), not call-initiated (btn-call).
   *  Routes call-lifecycle visuals — e.g. the pulsing-amber `reconnecting`
   *  state — onto the button the user actually tapped. Field nit
   *  2026-06-12: low-network recovery during dictation flashed btn-call
   *  orange while the red mic stayed untouched. */
  isMicOwnedCall?: () => boolean;
}

let opts: ControlsOpts | null = null;

function btnEl(id: string): HTMLButtonElement | null {
  return document.getElementById(id) as HTMLButtonElement | null;
}

export function init(o: ControlsOpts) {
  opts = o;

  // Network-drop signal (connected call torn down by the network, not the
  // user). Distinct from the state listener below because the drop reason
  // doesn't survive the transient failed→idle state transitions.
  conn.setDroppedListener((reason) => {
    diag('[webrtc-controls] call dropped, reason=', reason);
    try { opts?.onCallDropped?.(reason); } catch { /* noop */ }
  });

  conn.setStateListener((state, mode) => {
    log('[webrtc-controls] state=', state, 'mode=', mode);
    // Pre-button-split this code flipped btn-mic.active when a call
    // opened (back when btn-mic WAS the call button). After the split,
    // calls live on btn-call; btn-mic.active should reflect
    // mic modes only (memo / dictate). main.ts:syncCallButtonVisual
    // owns btn-call.active. The 'connecting' class still belongs to
    // the mic button visually — it's the one that animates the spin
    // during initial setup; harmless when call mode owns the actual
    // visual state through btn-call.
    // Whose button shows call-lifecycle visuals: dictation opens the
    // same WebRTC peer but from btn-mic, so recovery states belong on
    // the mic, not the (inactive) call button.
    const micOwned = !!opts?.isMicOwnedCall?.();
    const mic = btnEl('btn-mic');
    if (mic) {
      mic.classList.toggle(
        'connecting',
        state === 'requesting-mic' || state === 'connecting',
      );
      mic.classList.toggle('reconnecting', state === 'reconnecting' && micOwned);
      // Clear the "actually listening" pulse when the call closes.
      // The bridge's {type:'listening'} envelope adds it; we clear here
      // so the visual reflects state immediately on close instead of
      // lingering until next paint.
      if (!conn.isOpen()) mic.classList.remove('listening');
    }
    // Disable btn-call during transient states so rapid double-taps
    // can't race the WebRTC handshake (a second pointerdown while
    // connecting tears down the in-flight session and fails the call).
    // idle/connected/failed stay enabled — the user
    // wants those clickable (open / hang up / retry).
    const call = btnEl('btn-call');
    if (call) {
      const transient = state === 'requesting-mic'
        || state === 'connecting'
        || state === 'closing';
      call.disabled = transient;
      call.classList.toggle('disabled', transient);
      // Reconnecting stays tappable (tap = cancel/hang up) and gets a
      // distinct pulsing-yellow visual so the user knows recovery is in
      // progress — see .icon-btn-plain.reconnecting in app.css. Mic-owned
      // calls (dictation) show it on btn-mic instead — see above.
      call.classList.toggle('reconnecting', state === 'reconnecting' && !micOwned);
    }
    // Reset the dictation state machine whenever a call ends so a
    // pending utterance buffer or silence timer doesn't leak across
    // calls. requesting-mic / connecting on a fresh open is also a
    // safe place to clear (idempotent).
    if (state === 'idle' || state === 'closing' || state === 'failed'
        || state === 'requesting-mic') {
      dictation.reset();
      suppress.reset();
      realtimeBarge.stop();
    }
    // 'reconnecting' is INTENTIONALLY split out from the reset branch
    // above — Jonathan field bug 2026-06-23. Pre-fix the dictation
    // buffer was wiped every time the network wobbled green→yellow,
    // forcing the user to start the message over (twice on the same
    // bike ride). The mid-utterance buffer must survive the reconnect
    // window so the recovered call resumes the same logical sentence
    // the user was speaking; from the user's POV it's a single
    // continuous utterance.
    // realtimeBarge.stop() still fires here though: when the call
    // drops we release the dead mic stream, so the barge loop's
    // AnalyserNode would error on the freed stream. A fresh loop
    // starts when reconnect lands back on 'connected' below.
    // Silence-timer pause: see dictation.pauseSilenceTimer() — without
    // it the silenceSec countdown armed on the last segment would
    // elapse during the yellow gap and dispatch the half-utterance.
    if (state === 'reconnecting') {
      realtimeBarge.stop();
      dictation.pauseSilenceTimer();
      startReconnectTickLoop();
    } else {
      // Any other state ends the recurring tick. The give-up
      // ('call-dropped') path naturally lands here too because state
      // transitions out of 'reconnecting' into 'idle'/'failed'.
      stopReconnectTickLoop();
    }
    // Reconnect succeeded — resume the silence countdown so the
    // accumulated buffer can dispatch normally on the next silence
    // window or commit phrase.
    if (state === 'connected') {
      dictation.resumeSilenceTimer();
    }
    // Barge loop runs only while a call is connected. Started here
    // (not in realtime.ts itself) because it depends on suppress's
    // is-playing signal, and suppress lives in this controls layer.
    // talk-mode only — stream mode has no TTS to barge against, so
    // the loop would never fire and just waste a setInterval.
    if (state === 'connected' && mode === 'talk') {
      const stream = conn.getMicStream();
      if (stream) {
        realtimeBarge.start(
          stream,
          // Gate barge on TTS AUDIO playback (assistant-delta → bridge
          // 'listening' envelope), NOT transcript-suppression (which
          // ends 1.2s after `final` while audio plays for many more
          // seconds — see suppress.ts comment on ttsPlaying).
          () => suppress.isTtsPlaying(),
          () => {
            log('[webrtc-controls] client-side barge fired — sending upstream');
            conn.sendBarge();
            conn.cancelRemotePlayback();
            suppress.onBarge();
          },
        );
      }
    }
    // External subscribers (wake-lock, etc.) — fired after the internal
    // UI updates above so they observe a consistent view of state.
    try { opts?.onCallStateChange?.(state, mode); } catch { /* noop */ }
    if (!opts?.onStatus) return;
    if (state === 'requesting-mic') opts.onStatus('Requesting mic…');
    else if (state === 'connecting') opts.onStatus(`Connecting (${mode})…`);
    else if (state === 'connected') opts.onStatus(mode === 'talk' ? 'On call' : 'Streaming', 'ok');
    else if (state === 'reconnecting') opts.onStatus('Reconnecting…', 'live');
    else if (state === 'closing') opts.onStatus('Closing…');
    else if (state === 'failed') opts.onStatus('Call failed', 'err');
    else if (state === 'idle') opts.onStatus('');
  });

}

/** Open a call (or close if one is open). Mode derives from
 *  settings.tts at the time of open: tts=true → talk (TTS audio),
 *  tts=false → stream (STT only, no TTS). Surfaces errors via the
 *  onStatus callback. */
export async function toggleCall(): Promise<void> {
  // isReconnecting() so a tap during recovery hangs up (cancels reconnect)
  // rather than spuriously opening a second call — isOpen() is false while
  // a re-open attempt is mid-flight.
  if (conn.isOpen() || conn.isReconnecting()) {
    log('[webrtc-controls] toggleCall close (currentMode=', conn.currentMode(), ' reconnecting=', conn.isReconnecting(), ')');
    await conn.close();
    return;
  }
  // Talk mode requires bridge TTS over the peer track; with
  // ttsEngine='local' the bridge isn't the audio source so force
  // stream mode (matches the gating in main.ts startCallStream).
  const sx = settings.get() as any;
  const mode: conn.CallMode = (sx.tts && sx.ttsEngine !== 'local') ? 'talk' : 'stream';
  log('[webrtc-controls] toggleCall open mode=', mode);
  try {
    await conn.open(mode, resolveCallSession());
  } catch (e: any) {
    diag('[webrtc-controls] open failed', e?.message);
    if (opts?.onStatus) opts.onStatus(`Call error: ${e?.message ?? e}`, 'err');
  }
}

/** Open a call in a specific mode without consulting settings.tts.
 *  Used by the composer mic when call-mode is requested — auto-send=true
 *  needs the talk/stream choice driven by the user's settings.tts
 *  preference, but the COMPOSER mic might want to force
 *  stream regardless (e.g. for cursor-aware dictation, where TTS makes
 *  no sense). Idempotent if a matching call is already open. */
export async function openCall(mode: conn.CallMode): Promise<void> {
  if (conn.isOpen()) {
    if (conn.currentMode() === mode) return;  // already in the right mode
    await conn.close();
  }
  log('[webrtc-controls] openCall mode=', mode);
  try {
    await conn.open(mode, resolveCallSession());
  } catch (e: any) {
    diag('[webrtc-controls] openCall failed', e?.message);
    if (opts?.onStatus) opts.onStatus(`Call error: ${e?.message ?? e}`, 'err');
    throw e;
  }
}

export async function closeIfOpen(): Promise<void> {
  if (conn.isOpen() || conn.isReconnecting()) await conn.close();
}

export function isOpen(): boolean {
  return conn.isOpen();
}

/** True while a dropped call is attempting soft recovery. The call
 *  isn't `connected` but it's not gone either — used so stay-alive
 *  hints and the hang-up affordance treat recovery as a live call. */
export function isReconnecting(): boolean {
  return conn.isReconnecting();
}

export function currentMode(): conn.CallMode | null {
  return conn.currentMode();
}
