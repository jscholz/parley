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
import * as turnGuard from './turnGuard.ts';
import * as linkQuality from './linkQuality.ts';
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
  /** Called on EVERY terminal call state, immediately before the
   *  dictation machine is reset, so the host can drain any speech the
   *  user has spoken but not yet sent and park it in the composer.
   *
   *  Jonathan field bug 2026-08-30 (in the car, lost signal): the chime
   *  came through, reconnect eventually gave up, and the give-up path
   *  transitions 'reconnecting' → 'closing' → 'idle' — straight into the
   *  reset branch below, which deletes the dictation buffer. Several
   *  minutes of dictation gone, silently, with no undo. The rescue runs
   *  BEFORE reset() and is purely local text, so it works fine with a
   *  dead data channel — which is precisely the case that needs it.
   *
   *  There is deliberately NO button for this (Jonathan, 2026-08-30:
   *  "there's no reason for a button if the rule is always that if you
   *  end a call before saying over, it dumps the text in the composer").
   *  The rule is unconditional, so the affordance is the absence of one.
   *
   *  Must be idempotent: several terminal states can fire for one
   *  teardown ('closing' then 'idle'). Draining is what makes it
   *  idempotent — the second call finds an empty buffer. */
  onRescueBufferedSpeech?: (reason: string) => void;
}

let opts: ControlsOpts | null = null;

function btnEl(id: string): HTMLButtonElement | null {
  return document.getElementById(id) as HTMLButtonElement | null;
}

/** Paint the "your uplink has stalled" indicator.
 *
 *  Routed onto whichever button the user actually tapped, exactly like
 *  the `reconnecting` amber above it — and cleared off the other one
 *  unconditionally, so a mid-call ownership change can't strand it.
 *
 *  It is a SEPARATE class from `reconnecting` (which renders identically
 *  — see app.css) rather than a reuse of it, because the state listener
 *  owns that class and toggles it off on every transition: a degraded
 *  link sharing the class would be wiped by the next unrelated state
 *  event. Two orthogonal conditions, two independent classes, one
 *  deliberately identical visual — from the handlebar, both mean the
 *  same thing ("your voice isn't getting through, wait"), and inventing
 *  a second amber vocabulary for that would be worse than useless. */
function paintLinkDegraded(on: boolean): void {
  const micOwned = !!opts?.isMicOwnedCall?.();
  const mic = btnEl('btn-mic');
  if (mic) mic.classList.toggle('link-degraded', on && micOwned);
  const call = btnEl('btn-call');
  if (call) call.classList.toggle('link-degraded', on && !micOwned);
}

export function init(o: ControlsOpts) {
  opts = o;

  // Uplink health → amber indicator + the edge chimes. Registered as a
  // tap for the same reason the playback heartbeat below is: the
  // single-slot setDataChannelListener is swapped save-and-restore by
  // dictate/STTProvider, and "he only gets told his connection died in
  // some modes" is precisely the bug class this signal exists to fix.
  // Dictation is in fact the mode where it matters most — that is the
  // one where he monologues.
  linkQuality.init({
    setIndicator: paintLinkDegraded,
    playCue: (name) => { try { playFeedback(name); } catch { /* best-effort */ } },
    isTtsPlaying: () => suppress.isTtsPlaying(),
  });
  conn.tapEnvelopes((ev: any) => linkQuality.onEnvelope(ev));

  // Playback heartbeat → the bound on suppression's ttsPlaying gate.
  // Deliberately a tapEnvelopes subscriber, NOT the single-slot
  // setDataChannelListener: that slot is swapped save-and-restore by
  // dictate/STTProvider, and a gate that only unbounds itself in some
  // modes is the class of bug this whole mechanism exists to kill.
  // Taps fan out and are registered once for the process.
  conn.tapEnvelopes((ev: any) => {
    if (!ev || ev.type !== 'tts-playing') return;
    suppress.onPlaybackState(!!ev.active, 'bridge');
  });

  // Network-drop signal (connected call torn down by the network, not the
  // user). Distinct from the state listener below because the drop reason
  // doesn't survive the transient failed→idle state transitions.
  conn.setDroppedListener((reason) => {
    diag('[webrtc-controls] call dropped, reason=', reason);
    try { opts?.onCallDropped?.(reason); } catch { /* noop */ }
  });

  conn.setStateListener((state, mode) => {
    log('[webrtc-controls] state=', state, 'mode=', mode);
    // Suppression arming source: while a talk call is CONNECTED, only
    // the peer's ordered data channel may arm/extend suppression — the
    // SSE stream channel can deliver a reply's deltas AFTER the
    // bridge's `listening` envelope (stall-flush on wake, ring replay
    // on forceReconnect), which re-armed ttsPlaying with no TTS behind
    // it and wedged the user-transcript path for the rest of the call
    // (field bug 2026-08-26). Every other state falls back to SSE
    // arming (harmless: suppress.reset() runs on the next call open,
    // and the gate is only read while a call is up).
    //
    // Stream mode gets 'playback-only': there is no bridge TTS track
    // (signaling.py attaches one for mode=='talk' only), so the
    // bridge's `listening` fires exactly ONCE per call and can never
    // re-open a gate a later delta shut — and there is nothing to
    // suppress anyway, since reply auto-play is skipped while a call
    // is open. Text must not arm; only real playback evidence may.
    suppress.setArmingPolicy(
      state !== 'connected' ? 'sse'
        : mode === 'talk' ? 'data-channel'
        : 'playback-only',
    );
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
      // RESCUE BEFORE RESET (Jonathan field bug 2026-08-30). reset()
      // clears `buffer` outright; every path that ends a call — user
      // hangup, reconnect give-up/'call-dropped', failure, timeout —
      // funnels through here, which is why the loss was total and
      // silent. Draining first turns "ending a call" from a destructive
      // act into a save. 'requesting-mic' is a fresh OPEN, not a
      // terminal state: its buffer is already empty, and calling the
      // rescue there would only risk re-parking text on call start.
      if (state !== 'requesting-mic') {
        try { opts?.onRescueBufferedSpeech?.(state); }
        catch (e: any) { diag('[webrtc-controls] rescue handler err', e?.message); }
      }
      dictation.reset();
      suppress.reset();
      realtimeBarge.stop();
      turnGuard.stop();
      // Guarantor 3 for the never-stuck indicator (linkQuality.ts). A
      // call that ends mid-stall must not leave amber burning on a
      // button with no call behind it — and 'requesting-mic' is in this
      // branch too, so a fresh open can never inherit it either.
      // Deliberately silent: the link did not recover, the call ended.
      linkQuality.reset(state);
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
      // Same reason as realtimeBarge: the mic stream is dead through
      // the gap, so the analyser would read zeros and manufacture a
      // "he stopped talking" verdict for the whole yellow window.
      turnGuard.stop();
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
    // Turn guard: the end-of-turn countdown's VOICE source, plus
    // "newest input wins" for a reply the user has already talked over.
    // Runs in BOTH modes and independently of the bargeIn kill switch —
    // it is not a barge detector, it never reads the mic while TTS is
    // audible, and dictation's commit trigger must not silently depend
    // on a barge setting. See turnGuard.ts.
    if (state === 'connected') {
      const micForGuard = conn.getMicStream();
      if (micForGuard) {
        turnGuard.start({
          micStream: micForGuard,
          isTtsPlayingCb: () => suppress.isTtsPlaying(),
          onVoice: () => dictation.noteVoice(),
          onStaleReply: (why) => {
            // Deliberately the EXACT barge halt sequence — one halt
            // path, not two. There is no upstream generation-cancel
            // API (see turnGuard.ts / the report): this stops the
            // agent SPEAKING and reopens the mic gate, which is what
            // makes his next words the next turn instead of being
            // eaten by the half-duplex window.
            log('[webrtc-controls] turn-guard halting stale reply —', why);
            conn.sendBarge();
            conn.cancelRemotePlayback();
            suppress.onBarge();
          },
          subscribeEnvelopes: conn.tapEnvelopes,
        });
      }
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
    await conn.close('user-hangup', { source: 'toggle-call' });
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
    await conn.close('user-hangup', { source: 'open-call-mode-switch' });
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

/** Close the call if one is open (or recovering). *source* names the
 *  caller in the [webrtc-close] log line — field bug 2026-08-26 saw
 *  clean client-side closes the user swears he didn't request, and
 *  every close path funnels through here with the same 'user-hangup'
 *  reason, so the reason alone can't attribute them. Pass a stable
 *  short tag (e.g. 'mediasession-pause'). */
export async function closeIfOpen(source = 'close-if-open'): Promise<void> {
  if (conn.isOpen() || conn.isReconnecting()) {
    await conn.close('user-hangup', { source });
  }
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
