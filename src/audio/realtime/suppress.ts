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
// but the client's audio output queue (WebRTC jitter buffer + OS
// speaker buffer) has ~100-300ms of TTS already in flight, and the mic
// captures it.
//
// 2026-08-28 — WHAT THIS WINDOW IS FOR NOW. It used to be the echo
// defence: main.ts dropped every user transcript while `ttsPlaying`,
// so holding the flag here for 1.5s blanket-suppressed the drained
// tail (the "1 2 3 ... zero" feedback loop). That also ate the user's
// genuine interrupting words — the whole point of a barge — and on
// 2026-08-27 23:04 it ate the first interim AND final of his
// post-barge sentence.
//
// Echo suppression now lives where the AUDIO is: the bridge holds its
// own mic→Deepgram gate shut across the speaker tail
// (audio-bridge/tts_bridge.py HALT_TAIL_GRACE_S), so the tail is never
// transcribed at all and main.ts DELIVERS user transcripts during this
// window. What remains here is the `ttsPlaying` LEVEL: it keeps the
// barge detector's playback gate and the bridge's own late
// `tts-playing`/`listening` envelopes coherent across the halt (the
// v0.398 contract in onListening/onPlaybackState) rather than
// censoring anything. Length is uncritical for that job; left at 1500
// so the surrounding race behaviour is unchanged.
const TTS_DRAIN_GRACE_MS = 1500;

// ── The bounded-playback invariant ───────────────────────────────────
//
// `ttsPlaying` is a LEVEL signal, not a latch: it may only stay set
// while there is recent POSITIVE evidence that audio is actually
// playing. Text events (assistant deltas) may only PREDICT playback,
// for a bounded look-ahead.
//
// History, because this property was load-bearing and got deleted by
// accident. aad065d (2026-05-03 02:52) introduced `ttsPlaying`, but
// main.ts still gated user transcripts on `isSuppressing()` — which is
// timer-backed (onAssistantFinal → 1.2 s → stopSuppressing) and
// therefore SELF-HEALING: a bogus arming decayed on its own. d9a4905
// (same night, 04:32) swapped that gate to `isTtsPlaying()` to close a
// TTS-bleed feedback loop, and in doing so replaced the self-healing
// gate with one whose only clear was the bridge's EDGE-triggered
// `listening` envelope. Nothing bounded it any more. Every wedge since
// has the same shape: something arms `ttsPlaying` via an event that
// does not guarantee a corresponding clear.
//
// Four confirmed instances: late/replayed SSE deltas (fixed by
// cc57300's dcOwnsArming); stream mode, where `tts_track is None` so
// the bridge emits `listening` exactly once per CALL; a barge, which
// consumes the turn's only `listening` and then lets the aborted
// reply's remaining deltas re-arm; and a reply that sanitizes to empty
// for TTS, arming with no round behind it.
//
// The fix is not four special cases, it is restoring the bound — but a
// naive deadline reopens exactly the loop d9a4905 closed (an 80 s
// reply's deltas end in the first few seconds; unsuppressing there
// puts the mic back on the speaker). So the deadline is renewed only
// by evidence that playback is genuinely still happening:
//
//   • the bridge's {type:'tts-playing'} heartbeat, which publishes
//     `PCMTrack.is_active()` — the same boolean the bridge uses to
//     decide whether mic audio reaches Deepgram. Ticks ~1/s while
//     audio is on the wire. See audio-bridge/stt_bridge.py.
//   • local (turn-based) TTS playback, where the client owns the
//     player and start/end are authoritative.
//
// Degradation is deliberate: a bridge that never sends the heartbeat
// (older deploy) leaves `playbackSignalSeen` false and the deadline is
// NOT enforced — behavior is byte-for-byte what it is today. We only
// tighten the gate once we know something will keep telling us the
// truth about playback.

/** Look-ahead granted to a text delta. The bridge's first PCM frame
 *  lags the first delta by the sanitize → text_queue → provider-synth
 *  latency (a few hundred ms in practice), so the gate has to shut
 *  before we have any playback evidence. If evidence never shows up —
 *  the empty-sanitize case, or an aborted round's trailing deltas —
 *  this is the whole cost of the mistake instead of the rest of the
 *  call. */
const TTS_PREDICT_MS = 3000;

/** How long a heartbeat keeps the gate shut on its own. Must exceed
 *  the bridge's TTS_PLAYBACK_PING_S (1 s) by enough to ride out a
 *  couple of missed pings. A gap longer than this means the pings
 *  stopped, which means either the data channel died or inbound mic
 *  frames stopped — in both cases nothing is being transcribed and
 *  opening the gate is the safe direction. */
const TTS_EVIDENCE_DEADLINE_MS = 3000;

/** Ceiling on a client-owned (local speechSynthesis / <audio>) round.
 *  Local playback reports authoritative start and end events, so this
 *  never fires in practice — it exists so a dropped `ended` can't
 *  resurrect the unbounded latch this module is built to prevent. */
const LOCAL_PLAYBACK_CEILING_MS = 90_000;

/** After a barge, the halted reply's remaining deltas keep arriving
 *  over the data channel — the bridge stops the TTS track but not the
 *  parley stream subscriber. Those deltas have NO TTS round behind
 *  them (the round was halted) and the turn's single `listening`
 *  already fired, so pre-fix they re-wedged the call. Ignore text
 *  arming for this window; it is scoped to the residual-delta burst,
 *  not the turn, so a genuine next round still arms normally. */
const BARGE_STALE_DELTA_MS = 2500;

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
//
// 'playback-only' is the stream-mode policy. Stream mode has no bridge
// TTS track at all (signaling.py only calls tts_bridge.attach for
// mode=='talk'), so `tts_track is None`, `tts_active` is permanently
// False, and the bridge's once-per-turn `listening` re-arm never
// happens — it fires EXACTLY ONCE, on the first mic frame of the call.
// Any text delta after that latched the gate for the rest of the call.
// And it latched it for nothing: reply auto-play is explicitly skipped
// while a WebRTC call is open (backendEventHandlers "CALL-ONLY" route),
// so during a stream call nothing is coming out of the speaker for the
// mic to re-capture. Text must not arm here; only a real client-owned
// playback round (a manual per-bubble play tap) may.
export type ArmingPolicy = 'sse' | 'data-channel' | 'playback-only';
let armingPolicy: ArmingPolicy = 'sse';
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
// Deadline enforcing the bounded-playback invariant above. Null when
// no bound is armed (either nothing is playing, or we have never seen
// playback evidence on this call and so must not enforce one).
let playbackDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
// Capability latch: has ANY playback-evidence event arrived since the
// last reset()? Until it has, the deadline is advisory-only. This is
// what makes an old bridge / an unknown surface degrade to exactly the
// pre-existing behavior rather than to a mid-playback unsuppress.
let playbackSignalSeen = false;
// Has the CURRENT round produced positive evidence yet? Gates the
// fast-clear on `active:false`: before playback starts, "not playing"
// is just the normal synth latency, not the end of the round.
let playbackStarted = false;
// Monotonic-ish deadline (Date.now()) until which text arming is
// treated as stale — see BARGE_STALE_DELTA_MS.
let bargeStaleUntil = 0;

export function isSuppressing(): boolean {
  return suppressing;
}

export function isTtsPlaying(): boolean {
  return ttsPlaying;
}

/** Set which source may ARM suppression from text events. Managed
 *  exclusively by controls.ts's state listener:
 *    'sse'           — no call up. Historical behavior.
 *    'data-channel'  — talk call connected; only viaDataChannel deltas
 *                      arm (cc57300 / field bug 2026-08-26).
 *    'playback-only' — stream call connected; text never arms, only
 *                      real playback evidence does.
 *  Idempotent. */
export function setArmingPolicy(policy: ArmingPolicy): void {
  armingPolicy = policy;
}

/** Back-compat shim for the cc57300 call shape. */
export function setDataChannelOwnsArming(on: boolean): void {
  armingPolicy = on ? 'data-channel' : 'sse';
}

/** Test-only introspection. */
export function __dcOwnsArmingForTests(): boolean {
  return armingPolicy === 'data-channel';
}

/** Test-only introspection. */
export function __armingPolicyForTests(): ArmingPolicy {
  return armingPolicy;
}

/** Whether a text event (assistant delta/final) from this source is
 *  allowed to arm or extend suppression right now. */
function textArmingAllowed(viaDataChannel: boolean): boolean {
  if (armingPolicy === 'playback-only') return false;
  if (armingPolicy === 'data-channel' && !viaDataChannel) return false;
  // Residual deltas from a reply the bridge already halted.
  if (bargeStaleUntil && Date.now() < bargeStaleUntil) return false;
  return true;
}

function clearPlaybackDeadline(): void {
  if (playbackDeadlineTimer) {
    clearTimeout(playbackDeadlineTimer);
    playbackDeadlineTimer = null;
  }
}

/** (Re)arm the bound on `ttsPlaying`. No-op until we have seen at
 *  least one playback-evidence event on this call — see
 *  `playbackSignalSeen`. */
function renewPlaybackDeadline(ms: number, why: string): void {
  clearPlaybackDeadline();
  if (!playbackSignalSeen) return;
  playbackDeadlineTimer = setTimeout(() => {
    playbackDeadlineTimer = null;
    if (!ttsPlaying) return;
    ttsPlaying = false;
    playbackStarted = false;
    log('[suppress] no playback evidence for', ms, 'ms after', why,
      '— reopening the user-transcript gate');
  }, ms);
}

/** Positive/negative evidence about whether agent audio is ACTUALLY
 *  playing right now.
 *
 *  `source: 'bridge'` — the bridge's {type:'tts-playing'} heartbeat,
 *  which mirrors `PCMTrack.is_active()`, i.e. the same flag the bridge
 *  uses to decide whether mic audio reaches Deepgram. Mirroring it
 *  here means the client's gate and the bridge's half-duplex gate can
 *  no longer disagree, which is what every wedge in this file has been.
 *
 *  `source: 'local'` — turn-based/local TTS, where the client owns the
 *  player and reports authoritative start/end.
 *
 *  `active: true` both ARMS and renews: "the bridge says audio is on
 *  the wire" is stronger evidence than any text event, so it must be
 *  able to shut the gate on its own (e.g. if the predict window lapsed
 *  just before a slow synth finally produced its first frame).
 *
 *  `active: false` clears immediately ONLY once this round produced a
 *  `true` — otherwise it is just pre-synth latency, and clearing there
 *  would open the mic milliseconds before playback starts. */
export function onPlaybackState(active: boolean, source: 'bridge' | 'local'): void {
  // Capability latch. The BRIDGE publishes a level, so either value
  // proves it speaks this protocol. Local TTS only emits EDGES, and a
  // lone 'stopped'/'ended' (e.g. cancelReplyTts on an idle player)
  // announces nothing — latching on it would licence the deadline on a
  // bridge that can't renew it, which is the mid-playback unsuppress
  // this whole design is built to avoid.
  const announcesCapability = source === 'bridge' || active;
  const firstSignal = announcesCapability && !playbackSignalSeen;
  if (announcesCapability) playbackSignalSeen = true;
  if (ttsPlayingClearTimer) {
    // A barge is in flight; the drain grace owns ttsPlaying for its
    // duration (v0.398 contract, see onListening). Playback evidence
    // must not preempt it in either direction.
    return;
  }
  if (active) {
    playbackStarted = true;
    if (!ttsPlaying) {
      ttsPlaying = true;
      log('[suppress] playback evidence (', source, ') — gate shut');
    }
    renewPlaybackDeadline(
      source === 'local' ? LOCAL_PLAYBACK_CEILING_MS : TTS_EVIDENCE_DEADLINE_MS,
      `${source}-playing`,
    );
    return;
  }
  if (!playbackStarted) {
    // Pre-synth silence, not end-of-round — leave the gate alone.
    // EXCEPT: if this is the first signal of the call and something
    // already armed the gate, that arming ran while the deadline was
    // still unenforceable and got no bound. Retro-arm it now, or the
    // one delta that beat the bridge's opening ping is unbounded for
    // the rest of the call — which is the exact bug shape.
    if (firstSignal && ttsPlaying && !playbackDeadlineTimer) {
      renewPlaybackDeadline(TTS_PREDICT_MS, 'late-capability');
    }
    return;
  }
  playbackStarted = false;
  clearPlaybackDeadline();
  if (ttsPlaying) {
    ttsPlaying = false;
    log('[suppress] playback ended (', source, ') — gate open');
  }
}

/** Called on every assistant transcript delta — from main.ts's SSE
 *  reply handler (default) or, during a talk call, from the data-
 *  channel assistant envelopes (`viaDataChannel: true`). First call
 *  of a reply turn flips suppression on; subsequent calls within the
 *  same reply cancel any pending end-timer (each delta extends the
 *  tail). While a talk call owns arming, non-DC (SSE) deltas are
 *  IGNORED — they can be late replays with no TTS behind them (the
 *  2026-08-26 post-reply wedge). Stream mode ('playback-only') and the
 *  post-barge stale window ignore ALL text arming — see
 *  textArmingAllowed. */
export function onAssistantDelta(opts?: { viaDataChannel?: boolean }): void {
  if (!textArmingAllowed(!!opts?.viaDataChannel)) return;
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
  //
  // But it is a PREDICTION, not evidence, so it only buys TTS_PREDICT_MS.
  // A new round starts with no evidence yet; an in-flight round keeps
  // whatever `playbackStarted` the heartbeat established.
  if (!ttsPlaying) {
    ttsPlaying = true;
    playbackStarted = false;
  }
  renewPlaybackDeadline(TTS_PREDICT_MS, 'assistant-delta');
}

/** Called on assistant `is_final: true` (same two sources as
 *  onAssistantDelta). Schedules suppression-clear after the grace
 *  period, unless a delta arrives in the meantime (which would extend
 *  the tail). Non-DC finals are ignored while a talk call owns arming
 *  — symmetric with onAssistantDelta. */
export function onAssistantFinal(opts?: { viaDataChannel?: boolean }): void {
  if (!textArmingAllowed(!!opts?.viaDataChannel)) return;
  if (!suppressing) return;
  if (suppressEndTimer) clearTimeout(suppressEndTimer);
  suppressEndTimer = setTimeout(() => {
    suppressEndTimer = null;
    stopSuppressing('final+grace');
  }, SUPPRESS_GRACE_MS);
}

/** Called by controls.ts when the client's own BargeDetector fires —
 *  barge has been client-initiated since v0.424, so this is the ONLY
 *  caller (an inbound `{type:'barge'}` envelope is legacy and no
 *  longer handled). The user interrupted, so cancel any pending
 *  tail-grace and let user
 *  transcripts flow again immediately for the user's intentional
 *  speech. `ttsPlaying` is still held for TTS_DRAIN_GRACE_MS, but as a
 *  LEVEL for the barge detector / playback-evidence races only — the
 *  speaker tail is suppressed on the bridge now, not by censoring
 *  transcripts here. See TTS_DRAIN_GRACE_MS. */
export function onBarge(): void {
  if (suppressEndTimer) {
    clearTimeout(suppressEndTimer);
    suppressEndTimer = null;
  }
  if (suppressing) stopSuppressing('barge');
  // The bridge halts the TTS track on barge but NOT the parley stream
  // subscriber, so the aborted reply keeps emitting deltas over the
  // data channel — after the turn's one and only `listening`. Pre-fix
  // those re-armed ttsPlaying with no round behind them and no clear
  // possible, re-wedging the call on the single interaction talk mode
  // exists for. Text arming stays shut for the residual burst.
  bargeStaleUntil = Date.now() + BARGE_STALE_DELTA_MS;
  clearPlaybackDeadline();
  playbackStarted = false;
  // Schedule ttsPlaying clear AFTER the speaker tail drains — was
  // immediate, but the drained tail leaked to STT and created fake
  // user turns ("1 2 3 ... zero" feedback loop).
  if (ttsPlayingClearTimer) clearTimeout(ttsPlayingClearTimer);
  ttsPlayingClearTimer = setTimeout(() => {
    ttsPlayingClearTimer = null;
    ttsPlaying = false;
    // Field 2026-08-27: this clear used to be silent — the one healthy
    // round always logs "playback ended (bridge) — gate open", so its
    // absence after a barge read as "gate never opened" and cost the
    // post-barge wedge diagnosis an hour. One line per barge.
    log('[suppress] playback ended ( barge-drain ) — gate open');
  }, TTS_DRAIN_GRACE_MS);
}

/** True while the post-barge speaker-drain grace window is running —
 *  the ~1.5 s after a barge in which `ttsPlaying` is held true.
 *
 *  main.ts's user-transcript gate uses it to tell the two windows
 *  apart, and they now have OPPOSITE outcomes: the reply window drops
 *  (the agent is really speaking), the drain window delivers (the
 *  bridge's HALT_TAIL_GRACE_S gate already guaranteed the speaker tail
 *  never reached STT, so anything here is the user). Also drives the
 *  drop/deliver tally line. */
export function isBargeDrainActive(): boolean {
  return ttsPlayingClearTimer !== null;
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
  clearPlaybackDeadline();
  playbackStarted = false;
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
  // it on the next 'connected' (talk/stream) transition.
  armingPolicy = 'sse';
  clearPlaybackDeadline();
  // Capability is per-call: the next call may land on a different
  // bridge (reconnect, host handoff), so re-learn whether playback
  // evidence is available rather than assuming it from the last one.
  playbackSignalSeen = false;
  playbackStarted = false;
  bargeStaleUntil = 0;
}

function stopSuppressing(reason: string): void {
  log('[suppress] resume user transcripts (', reason, ')');
  suppressing = false;
}
