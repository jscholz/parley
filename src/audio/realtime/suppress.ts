/**
 * @fileoverview Minimal user-transcript suppression during agent reply.
 *
 * Background: while the agent is speaking, the iOS speakerphone (and to
 * a lesser degree desktop speakers) re-captures the agent's TTS output
 * as mic input, which Deepgram transcribes. Without suppression, those
 * fake transcripts pollute the chat log. We can't tell from the
 * transcript text alone whether a "user" line came from the user or the
 * speakerphone echo — so while a reply is in progress, we drop user
 * transcripts entirely.
 *
 * Barge-in is server-side now (audio-bridge runs an RMS VAD on raw
 * pre-AEC PCM). When the bridge detects user voice during TTS, it
 * sends a `{type:'barge'}` envelope and the PWA both cancels remote
 * playback and clears suppression — see main.ts. Suppression also
 * clears on assistant `is_final: true` plus a small grace period
 * (TTS playback continues briefly after text-final).
 *
 * This module replaces the client-side analyser/HUD-driven
 * `pipelines/webrtc/duplex.ts` that lived here previously. The
 * analyser path was structurally broken on browsers that apply AEC
 * inside the WebRTC capture pipeline (every modern Chrome/Safari);
 * the bridge-side VAD is the canonical detector now.
 */

import { log } from '../../util/log.ts';

/** Tail extension after `is_final` — TTS audio playback continues a
 *  bit after text-final on most TTS providers (sentence-end pause,
 *  buffered audio). Re-enabling user transcripts immediately would let
 *  the tail leak back as fake user transcripts. 1.2 s covers Aura's
 *  typical buffer plus a small margin. */
const SUPPRESS_GRACE_MS = 1200;

// Speaker-buffer drain time after a barge halt. The bridge stops
// sending TTS frames when it receives the upstream barge envelope,
// but the client's audio output queue (Web Audio + OS speaker buffer)
// has ~300-500ms of TTS already in flight. During that drain window,
// the mic captures the residual TTS audio — without this grace, the
// drained tail gets STT-transcribed into a fake user turn (the
// "1 2 3 ... zero" feedback loop).
// Bumped 600 → 1500ms: post-barge user speech (e.g. "okay okay") was
// bleeding past the 600ms window before the user could stop talking.
// The longer grace gives both the speaker tail AND the user's reflex
// talking-stop time to settle before transcripts re-enable.
// Trade-off: legitimate post-barge follow-up speech takes 1.5s before
// it counts as the next turn.
const TTS_DRAIN_GRACE_MS = 1500;

let suppressing = false;
let suppressEndTimer: ReturnType<typeof setTimeout> | null = null;
let ttsPlayingClearTimer: ReturnType<typeof setTimeout> | null = null;
// While a talk-mode call is CONNECTED, the peer's ordered data channel
// is the only trusted arming source for suppression. Field bug
// 2026-08-26 (docs/bugs/2026-08-26-realtime-talk-post-reply-audio-
// failures.md): the SSE stream channel and the WebRTC data channel are
// independent transports with no cross-ordering guarantee. A reply's
// SSE deltas can arrive AFTER the bridge's {type:'listening'} envelope
// already cleared ttsPlaying — e.g. an SSE stall while the phone is
// pocketed that flushes on wake, or a visibilitychange forceReconnect
// ring-replay of the just-spoken reply. Each such late delta re-armed
// ttsPlaying with no TTS round behind it, so no `listening` ever
// followed and EVERY subsequent user transcript was dropped at
// main.ts's isTtsPlaying() gate until the call was cycled ("every time
// you reply, some state gets flipped; it doesn't stream from me
// anymore"). The bridge forwards the same assistant deltas over the
// data channel (rendering parity), and there the ordering IS
// guaranteed: every DC assistant delta feeds the bridge's TTS queue,
// and `listening` is only emitted after that audio finishes — so a
// DC-armed ttsPlaying always has a DC clear coming. Controls flips
// this on at 'connected' (talk mode) and off on teardown states.
let dcOwnsArming = false;
// TTS audio playback flag — distinct from `suppressing` because the
// transcript-suppression window is short (final + 1.2s grace, just long
// enough to drop the AEC-leaked speakerphone tail) but the TTS audio
// keeps playing through the speaker for SECONDS after `final`. The
// realtime barge detector needs the audio-playback window, not the
// transcript-suppression window — gating barge on `suppressing` makes
// it impossible to interrupt anything past the first ~1.2s of a reply.
// Set on first
// assistant delta; cleared on `listening` envelope from the bridge
// (the authoritative "TTS audio is done, your turn now" signal).
let ttsPlaying = false;

export function isSuppressing(): boolean {
  return suppressing;
}

export function isTtsPlaying(): boolean {
  return ttsPlaying;
}

/** Flip the arming-source policy. `true` while a talk-mode call is
 *  connected: only `viaDataChannel` deltas/finals may arm or extend
 *  suppression (see dcOwnsArming rationale above). Managed exclusively
 *  by controls.ts's state listener. Idempotent. */
export function setDataChannelOwnsArming(on: boolean): void {
  dcOwnsArming = !!on;
}

/** Test-only introspection. */
export function __dcOwnsArmingForTests(): boolean {
  return dcOwnsArming;
}

/** Called on every assistant transcript delta — from main.ts's SSE
 *  reply handler (default) or, during a talk call, from the data-
 *  channel assistant envelopes (`viaDataChannel: true`). First call
 *  of a reply turn flips suppression on; subsequent calls within the
 *  same reply cancel any pending end-timer (each delta extends the
 *  tail). While a talk call owns arming, non-DC (SSE) deltas are
 *  IGNORED — they can be late replays with no TTS behind them (the
 *  2026-08-26 post-reply wedge). */
export function onAssistantDelta(opts?: { viaDataChannel?: boolean }): void {
  if (dcOwnsArming && !opts?.viaDataChannel) return;
  if (suppressEndTimer) {
    clearTimeout(suppressEndTimer);
    suppressEndTimer = null;
  }
  if (!suppressing) {
    suppressing = true;
    log('[suppress] agent speaking — dropping user transcripts');
  }
  // Audio playback starts when the bridge starts pushing TTS frames,
  // which lags the first delta by a few hundred ms. Treating delta as
  // the start is a slight over-approximation — barge in this small
  // pre-audio window is a no-op (BargeWindow has its own warmup mute).
  ttsPlaying = true;
}

/** Called on assistant `is_final: true` (same two sources as
 *  onAssistantDelta). Schedules suppression-clear after the grace
 *  period, unless a delta arrives in the meantime (which would extend
 *  the tail). Non-DC finals are ignored while a talk call owns arming
 *  — symmetric with onAssistantDelta. */
export function onAssistantFinal(opts?: { viaDataChannel?: boolean }): void {
  if (dcOwnsArming && !opts?.viaDataChannel) return;
  if (!suppressing) return;
  if (suppressEndTimer) clearTimeout(suppressEndTimer);
  suppressEndTimer = setTimeout(() => {
    suppressEndTimer = null;
    stopSuppressing('final+grace');
  }, SUPPRESS_GRACE_MS);
}

/** Called by main.ts when the bridge sends `{type:'barge'}` — the
 *  user interrupted, so cancel any pending tail-grace and let user
 *  transcripts flow again immediately for the user's intentional
 *  speech. BUT: keep `ttsPlaying` true for TTS_DRAIN_GRACE_MS so the
 *  speaker-buffer tail draining over the next ~500ms doesn't get
 *  STT-transcribed as a fake user turn. */
export function onBarge(): void {
  if (suppressEndTimer) {
    clearTimeout(suppressEndTimer);
    suppressEndTimer = null;
  }
  if (suppressing) stopSuppressing('barge');
  // Schedule ttsPlaying clear AFTER the speaker tail drains — was
  // immediate, but the drained tail leaked to STT and created fake
  // user turns ("1 2 3 ... zero" feedback loop).
  if (ttsPlayingClearTimer) clearTimeout(ttsPlayingClearTimer);
  ttsPlayingClearTimer = setTimeout(() => {
    ttsPlayingClearTimer = null;
    ttsPlaying = false;
  }, TTS_DRAIN_GRACE_MS);
}

/** Called by main.ts when the bridge sends `{type:'listening'}` —
 *  TTS audio playback is finished and the bridge is ready for the next
 *  user turn. Authoritative "audio done" signal: the bridge knows when
 *  its own TTS sender stopped pushing frames.
 *
 *  v0.398 race fix: when a barge JUST fired (drain-grace timer still
 *  pending), the bridge's listening envelope arrives within ~200ms.
 *  Pre-fix, this preempted the drain grace and re-enabled transcripts
 *  before the user's reflex post-barge speech ("okay okay") settled.
 *  Now: if a drain-grace timer is active, let it run — the timer is
 *  the user-reaction-time signal, not the speaker-frame-end signal. */
export function onListening(): void {
  if (ttsPlayingClearTimer) {
    // Barge in flight; drain grace owns the ttsPlaying clear. Don't
    // override the timer — the user is still in the "okay okay reflex
    // wind-down" window.
    return;
  }
  ttsPlaying = false;
}

/** Called by controls.ts on call open/close so a stale state from a
 *  previous call doesn't leak in. Idempotent. */
export function reset(): void {
  if (suppressEndTimer) {
    clearTimeout(suppressEndTimer);
    suppressEndTimer = null;
  }
  if (suppressing) {
    suppressing = false;
    log('[suppress] reset (call lifecycle)');
  }
  if (ttsPlayingClearTimer) {
    clearTimeout(ttsPlayingClearTimer);
    ttsPlayingClearTimer = null;
  }
  ttsPlaying = false;
  // Arming policy resets with the call lifecycle too — controls re-arms
  // it on the next 'connected' (talk) transition.
  dcOwnsArming = false;
}

function stopSuppressing(reason: string): void {
  log('[suppress] resume user transcripts (', reason, ')');
  suppressing = false;
}
