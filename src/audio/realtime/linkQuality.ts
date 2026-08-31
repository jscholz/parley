/**
 * @fileoverview In-call "your audio link is weak / it's back" signal.
 *
 * Jonathan, 2026-08-27, after losing minutes of speech on a bike ride:
 *
 *   "If it was a real phone call, number one, I would have gotten
 *    feedback after a minute from WhatsApp or whatever service that the
 *    audio was weak. And second, it will eventually come back, and I get
 *    a chime to that effect. We engineered the system to be like that,
 *    and it definitely didn't behave that way today."
 *
 * He was right, and the gap was not detection — the bridge had already
 * spotted every stall and written it to the journal. The gap was that
 * nothing ever reached him. This module is the client half of closing
 * that loop: it consumes the bridge's `{type:'link-quality'}` envelope
 * (audio-bridge/stt_bridge.py `_LinkQualityMonitor`) and turns it into
 * one glanceable indicator plus one chime at each end of an episode.
 *
 * ── Level in, edges out ──────────────────────────────────────────────
 * The envelope is a LEVEL: the bridge republishes `degraded` about once
 * a second for as long as the stall lasts, so the client can bound
 * itself (see the deadline below). The CUE is an EDGE — once when the
 * link goes bad, once when it comes back, never in between. A chirp
 * every second through a ten-second dead zone would be the fastest
 * possible way to teach him to ignore the sound.
 *
 * ── The indicator can never be left stuck on ─────────────────────────
 * That is the safety property, and — following the duck in realtime.ts,
 * which had the same shape of problem — it has three independent
 * guarantors:
 *
 *   1. the bridge's `{state:'ok'}` envelope, the normal path;
 *   2. LINK_EVIDENCE_DEADLINE_MS, for when that envelope never arrives
 *      at all (older bridge, dropped data channel, bridge crash) — the
 *      indicator self-clears once the degraded republishes stop;
 *   3. reset() on every terminal call state and on a fresh call open,
 *      so no call can inherit its predecessor's amber.
 *
 * Only (1) is audible. (2) and (3) clear the indicator SILENTLY: we do
 * not know the link recovered, we only know the bridge stopped talking,
 * and chiming "you're back" at a man whose call just died would be a
 * lie in the one direction that costs him a dictation.
 *
 * ── Cues are always paired, or absent ────────────────────────────────
 * The recovery cue only fires if the degradation cue actually sounded.
 * A lone "all clear" for a problem he was never told about is noise.
 */

import { diag } from '../../util/log.ts';

/** How long to keep the indicator up after the last `degraded` envelope.
 *  The bridge republishes at LINK_QUALITY_PING_S (1 s), so this is three
 *  missed republishes on an ordered, reliable SCTP channel — by which
 *  point the channel itself is gone and the call state machine owns the
 *  story. Same number and same reasoning as suppress.ts's
 *  TTS_EVIDENCE_DEADLINE_MS, which solves the identical "a level signal
 *  needs a deadline or it wedges" problem. */
export const LINK_EVIDENCE_DEADLINE_MS = 3000;

/** Longest we will hold the degraded cue back waiting for the agent to
 *  stop speaking. Firing an alert chime into the middle of a TTS reply
 *  sounds like a playback glitch rather than a warning, and while the
 *  agent is talking a stalled uplink is costing him nothing anyway (he
 *  is listening, not dictating). But the wait has to be bounded: if the
 *  reply runs long, he still needs to know before he answers it. */
export const CUE_DEFER_MAX_MS = 4000;

export interface LinkQualityHooks {
  /** Paint (or clear) the degraded indicator. Called only on changes. */
  setIndicator: (degraded: boolean) => void;
  /** Fire a chime. Injected rather than imported so the state machine
   *  can be unit-tested without an AudioContext. */
  playCue: (name: 'link-degraded' | 'link-restored') => void;
  /** Is the agent's TTS audible right now? Gates the degraded cue. */
  isTtsPlaying: () => boolean;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Test seam: shrink the evidence deadline so a suite doesn't have to
   *  sleep through 3 real seconds. Mirrors the duck's watchdogMs
   *  override in realtime.setRemotePlaybackTargetsForTests. */
  deadlineMs?: number;
}

let hooks: LinkQualityHooks | null = null;
let degraded = false;
/** Has the degraded cue for THIS episode actually sounded? Gates the
 *  recovery cue, so the two are always heard as a pair. */
let cueSounded = false;
/** When the current episode started — the budget for CUE_DEFER_MAX_MS. */
let episodeStartedAt = 0;
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

function nowMs(): number {
  return hooks?.now ? hooks.now() : Date.now();
}

/**
 * Bind the hooks. Deliberately does NOT paint: `setIndicator` reaches
 * main.ts's `isMicOwnedCall`, a lazy closure over a `let` declared far
 * below the `controls.init()` call site — invoking it at boot is a
 * temporal-dead-zone ReferenceError, which the paint's catch would
 * swallow into a silent no-op. There is nothing to clear at boot
 * anyway; every real clear goes through reset(), which runs on call
 * teardown and on every fresh open.
 */
export function init(h: LinkQualityHooks): void {
  hooks = h;
  clearDeadline();
  degraded = false;
  cueSounded = false;
  episodeStartedAt = 0;
}

/** True while the bridge says his uplink is stalled. Diagnostic. */
export function isDegraded(): boolean {
  return degraded;
}

function clearDeadline(): void {
  if (deadlineTimer != null) { clearTimeout(deadlineTimer); deadlineTimer = null; }
}

function armDeadline(): void {
  clearDeadline();
  deadlineTimer = setTimeout(() => {
    deadlineTimer = null;
    if (!degraded) return;
    // Guarantor 2. Silent by construction — see the header.
    diag('[link-quality] evidence deadline expired — clearing indicator silently');
    degraded = false;
    cueSounded = false;
    try { hooks?.setIndicator(false); } catch { /* paint is best-effort */ }
  }, hooks?.deadlineMs ?? LINK_EVIDENCE_DEADLINE_MS);
}

/** Play the degraded cue if it is owed and the moment is right.
 *
 *  Called on every degraded republish (the bridge's ~1 Hz level IS the
 *  retry clock — no extra timer needed) and immediately on a TTS-end
 *  envelope, so the cue lands the instant the agent stops rather than
 *  waiting out the next republish. */
function maybePlayDegradedCue(): void {
  if (!degraded || cueSounded || !hooks) return;
  let speaking = false;
  try { speaking = hooks.isTtsPlaying(); } catch { /* treat as quiet */ }
  if (speaking && nowMs() - episodeStartedAt < CUE_DEFER_MAX_MS) return;
  cueSounded = true;
  try { hooks.playCue('link-degraded'); } catch { /* best-effort */ }
}

/**
 * Feed one data-channel envelope in. Safe to hand the whole stream —
 * anything that isn't `link-quality` or `tts-playing` is ignored.
 *
 * A bridge that predates this protocol simply never sends
 * `link-quality`, and the client then behaves exactly as it does today:
 * no indicator, no cue, nothing stuck.
 */
export function onEnvelope(ev: any): void {
  if (!ev || !hooks) return;
  if (ev.type === 'tts-playing') {
    // The agent stopped speaking — flush any cue we were holding back.
    if (ev.active === false) maybePlayDegradedCue();
    return;
  }
  if (ev.type !== 'link-quality') return;

  if (ev.state === 'degraded') {
    if (!degraded) {
      degraded = true;
      cueSounded = false;
      episodeStartedAt = nowMs();
      diag(`[link-quality] degraded (uplink stalled ${ev.stalled_s ?? '?'}s)`);
      try { hooks.setIndicator(true); } catch { /* best-effort */ }
    }
    armDeadline();        // renew on every republish
    maybePlayDegradedCue();
    return;
  }

  if (ev.state === 'ok') {
    clearDeadline();      // guarantor 1
    if (!degraded) return;
    degraded = false;
    diag('[link-quality] recovered');
    try { hooks.setIndicator(false); } catch { /* best-effort */ }
    // Paired-or-absent: no "all clear" for a problem he never heard.
    if (cueSounded) {
      try { hooks.playCue('link-restored'); } catch { /* best-effort */ }
    }
    cueSounded = false;
  }
}

/**
 * Guarantor 3. Hard, silent reset — no conditions. Runs on every
 * terminal call state and on a fresh open, so a call that ends while
 * degraded cannot strand the amber indicator on a button the user is
 * now looking at with no call behind it.
 */
export function reset(why: string): void {
  clearDeadline();
  const wasDegraded = degraded;
  degraded = false;
  cueSounded = false;
  episodeStartedAt = 0;
  try { hooks?.setIndicator(false); } catch { /* best-effort */ }
  if (wasDegraded) diag(`[link-quality] reset while degraded (${why})`);
}

/** Test seam — drop the hooks and all state between cases. */
export function __resetForTests(): void {
  clearDeadline();
  hooks = null;
  degraded = false;
  cueSounded = false;
  episodeStartedAt = 0;
}
