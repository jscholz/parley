/**
 * @fileoverview Per-call dictation state machine — owns the utterance
 * buffer, silence timer, and commit-phrase regex that used to live in
 * the audio bridge. The bridge is now a thin transcript pass-through;
 * the PWA decides when an utterance is "done" and tells the bridge to
 * dispatch it via the data channel.
 *
 * Inputs:
 *   handleUserFinal(text)  — every is_final user transcript from the bridge
 *   noteVoice()            — the local mic is carrying voice right now
 *
 * Triggers that fire a dispatch:
 *   1. End-of-turn silence — `settings.silenceSec` seconds during which
 *      THE MICROPHONE was quiet. silenceSec=0 disables (waits forever
 *      for a commit phrase). Pre-2026-08-30 this counted from the last
 *      is_final instead, which made an STT hole look exactly like a
 *      pause and committed half-utterances under him — see noteVoice().
 *   2. Commit-phrase match — utterance ends in the configured phrase
 *      (e.g. "over"); the phrase is stripped and the rest is sent.
 *      IMMEDIATE by default (commitDelaySec=0) and deliberately does
 *      not consult the voice window at all: "I like the immediate
 *      reactivity of the send as soon as I say over" (Jonathan,
 *      2026-08-30). Nothing in this module may add latency there.
 *
 * On dispatch:
 *   - Clear the buffer.
 *   - connection.dispatch(text) — bridge POSTs to /api/hermes/responses.
 *   - onUserBubble(text) — caller renders the user bubble locally
 *     (one utterance = one bubble = one dispatch).
 *
 * On call close, callers must invoke reset() so a stale buffer doesn't
 * survive into the next call — but they must call takeBufferedText()
 * FIRST and park the result somewhere the user can still see it.
 * reset() is destructive by design; ending a call is not allowed to
 * destroy speech (Jonathan field bug 2026-08-30).
 */

import * as conn from './realtime.ts';
import { playFeedback } from '../shared/feedback.ts';
import { matchSendword, getHandsfreeConfig, SilenceWindow } from '../shared/handsfree.ts';
import * as turnGuard from './turnGuard.ts';
import { log, diag } from '../../util/log.ts';

let buffer: string[] = [];
let silenceTimer: ReturnType<typeof setTimeout> | null = null;
/** End-of-turn evidence. A pause is only a pause if the MICROPHONE is
 *  quiet — see armSilenceTimer(). Non-null only while a countdown is
 *  live; noteVoice() before any countdown is a cheap no-op. */
let voiceWindow: SilenceWindow | null = null;
// Sendword grace window (commitDelaySec): armed when the commit phrase
// is heard, dispatches when it elapses. Finals landing inside the
// window append to the buffer and ride the same dispatch. Distinct
// from silenceTimer so pause/resume can treat them differently: a
// paused pending COMMIT re-fires immediately on resume (the user
// already said the sendword; the grace was served during the gap).
let commitTimer: ReturnType<typeof setTimeout> | null = null;
let commitPendingThroughPause = false;
let onUserBubble: ((text: string) => void) | null = null;
let onReset: (() => void) | null = null;
let onDispatchFailed: ((text: string) => void) | null = null;
let userMessageIdProvider: (() => string) | null = null;
// When true, the silence countdown is held — armSilenceTimer becomes a
// no-op and any in-flight timer is cleared. Set during a 'reconnecting'
// gap so the silenceSec window doesn't elapse while the bridge is dead
// and prematurely dispatch a half-utterance. See Jonathan field bug
// 2026-06-23: mid-utterance buffer must survive the reconnect window
// so the recovered call resumes the same logical sentence.
let silencePaused = false;

/** Caller registers a handler that renders the user bubble (and any
 *  other "utterance committed" UI) at dispatch time. */
export function setUserBubbleHandler(cb: (text: string) => void): void {
  onUserBubble = cb;
}

/** Caller registers a handler that fires from inside reset() so any
 *  out-of-tree state mirroring the dictation buffer (e.g. main.ts's
 *  streaming user bubble id) can clear in lockstep. */
export function setOnResetHandler(cb: () => void): void {
  onReset = cb;
}

/** Caller registers a handler invoked when a dispatch was ATTEMPTED but
 *  the data channel refused it (`conn.dispatch` returned false — bridge
 *  gone). Pre-2026-08-30 that utterance was simply gone: dispatchNow
 *  had already emptied the buffer and rendered a pending user bubble,
 *  so the text existed nowhere and the bubble hung forever. The host
 *  routes it to the composer instead (see main.ts rescueSpokenText).
 *  Deliberately NOT re-buffered here: onUserBubble has already run, so
 *  the host has bubble state to clean up and only it can do that. */
export function setDispatchFailedHandler(cb: ((text: string) => void) | null): void {
  onDispatchFailed = cb;
}

/** Drain the un-dispatched utterance buffer and return it as one
 *  string, leaving the machine empty (timers cleared, pause flag
 *  untouched — reset() owns that).
 *
 *  This is the rescue seam for Jonathan's 2026-08-30 field bug: a call
 *  in the car lost signal, reconnect gave up, and controls.ts's
 *  terminal-state branch called reset() — which drops `buffer` on the
 *  floor. Several minutes of transcribed speech vanished with no trace
 *  and no undo. Callers now drain FIRST and park the text in the
 *  composer, then reset. Returning the text (rather than dispatching
 *  it) keeps this module free of any composer/chat knowledge.
 *
 *  Safe against double-send by construction: dispatchNow() empties
 *  `buffer` before it hands the utterance to the bridge, so anything
 *  still in here is by definition text that never left the client. */
export function takeBufferedText(): string {
  const text = buffer.join(' ').trim();
  buffer = [];
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (commitTimer !== null) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
  commitPendingThroughPause = false;
  voiceWindow = null;
  return text;
}

/** Caller registers a provider that returns the current utterance's
 *  pre-minted user_message_id. Called inside dispatchNow so the same
 *  id ships to the bridge → upstream → user_message echo. The
 *  provider is responsible for minting on first call within an
 *  utterance and returning the same value through finalize. */
export function setUserMessageIdProvider(fn: (() => string) | null): void {
  userMessageIdProvider = fn;
}

/** Clear all per-call dictation state. Call on call open AND close. */
export function reset(): void {
  buffer = [];
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (commitTimer !== null) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
  commitPendingThroughPause = false;
  voiceWindow = null;
  // Drop any pause flag too — a 'reconnecting'-paused buffer that's
  // being torn down (call ended, fresh open) should not start the next
  // call already-paused. Pause is strictly a within-call hold.
  silencePaused = false;
  if (onReset) {
    try { onReset(); } catch { /* swallow — out-of-tree listener */ }
  }
}

/** Pause the silence countdown without touching the buffer. Called by
 *  controls.ts when the WebRTC peer transitions into 'reconnecting' —
 *  the mic is dead during the gap so no new is_final events arrive,
 *  but the silenceSec timer (armed on the last segment) would still
 *  fire mid-gap and dispatch the half-utterance the user is actively
 *  building. Idempotent. */
export function pauseSilenceTimer(): void {
  silencePaused = true;
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  // A pending sendword commit must not dispatch into a dead channel
  // (conn.dispatch would fail and the emptied buffer would lose the
  // utterance). Hold it; resumeSilenceTimer re-fires it immediately.
  if (commitTimer !== null) {
    clearTimeout(commitTimer);
    commitTimer = null;
    commitPendingThroughPause = true;
  }
}

/** Resume the silence countdown. Called by controls.ts when the peer
 *  is back to 'connected'. Re-arms the timer ONLY if the buffer has
 *  content — an empty buffer doesn't need a silence window. Idempotent. */
export function resumeSilenceTimer(): void {
  silencePaused = false;
  if (commitPendingThroughPause) {
    // The sendword landed before the gap; its grace window is long
    // since served. Dispatch now that the channel is back.
    commitPendingThroughPause = false;
    dispatchNow();
    return;
  }
  if (buffer.length > 0) armSilenceTimer();
}

function dispatchNow(): void {
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (commitTimer !== null) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
  commitPendingThroughPause = false;
  voiceWindow = null;
  const utterance = buffer.join(' ').trim();
  buffer = [];
  if (!utterance) return;
  log('[dictation] dispatch:', utterance.slice(0, 120));
  // Snag the userMessageId BEFORE invoking onUserBubble — the bubble
  // handler may consume + clear the provider's state when it
  // finalizes (next utterance mints fresh). Same id rides the wire
  // so the server's user_message echo collapses idempotently.
  const userMessageId = userMessageIdProvider ? userMessageIdProvider() : undefined;
  if (onUserBubble) {
    try { onUserBubble(utterance); } catch (e: any) { diag('[dictation] bubble handler err', e?.message); }
  }
  const ok = conn.dispatch(utterance, userMessageId);
  if (!ok) {
    // The channel is gone and the buffer is already empty — without the
    // rescue hook this utterance is destroyed here (2026-08-30 field
    // bug's sibling path: give-up can land between the silence timer
    // firing and the write). Hand it to the host for the composer.
    diag('[dictation] dispatch send failed (channel not open?) — rescuing to composer');
    if (onDispatchFailed) {
      try { onDispatchFailed(utterance); } catch (e: any) { diag('[dictation] rescue handler err', e?.message); }
    }
    return;
  }
  // A reply is now in flight. The turn guard watches for the user
  // starting a NEW utterance before it lands — see turnGuard.ts.
  turnGuard.onDispatch();
  // No 'send' chime here: in WebRTC voice mode the dispatch is a
  // synchronous data-channel write (no network round-trip from the
  // PWA's POV — the bridge is the one talking to the agent). Firing
  // 'send' here means commit and send chimes overlap by microseconds
  // and merge audibly into one merged tone. Instead, main.ts fires
  // 'send' on the first assistant delta arriving over the data
  // channel — i.e. when the AGENT has actually received the
  // utterance and started replying. Real time gap, real meaning:
  // commit = "I heard the over"; send = "agent is replying."
}

/**
 * Report detected VOICE on the local microphone.
 *
 * THE 2026-08-30 FIX. Pre-fix the end-of-turn countdown was armed on
 * TRANSCRIPTS — `handleUserFinal` was the only caller of
 * armSilenceTimer, and it returns early on empty text, so an empty
 * final does not re-arm. That made "the user fell silent" and "the STT
 * hop stopped producing text" the SAME EVENT to this module. They are
 * not remotely the same thing, and the difference is a whole dictation:
 *
 *   "I was in the middle of a dictation, and I paused to think. And for
 *    some reason, it sent the message, and the agent fired a reply. I
 *    hadn't realized this, so I continued to talk… we started having
 *    this staggered turn dynamic where it was replying to an old chunk
 *    of my previous text."   — Jonathan, 2026-08-30
 *
 * A run of empty finals (Phase 1's bug — ~30% of utterances that
 * session) or a transcript hole (2026-08-27, 11-30 s three times) is
 * indistinguishable from silence when you only listen to text. So the
 * countdown now elapses on MIC SILENCE, with transcripts as a secondary
 * arming input. Voice is authoritative.
 *
 * Cost on the happy path: zero. This does not delay anything — it only
 * refuses to fire the timer EARLY. The sendword path never touches it.
 */
export function noteVoice(now: number = Date.now()): void {
  if (voiceWindow) voiceWindow.noteVoice(now);
}

/** Arm (or re-arm) the end-of-turn countdown.
 *
 *  Two-stage by design: the setTimeout is a DEADLINE, and when it
 *  fires we re-check the voice window. If the mic has been active more
 *  recently than the deadline assumed, we re-arm for exactly the
 *  remaining time instead of committing. Deadline-chasing rather than
 *  polling — no per-frame timer work, and the commit still lands the
 *  instant silenceSec of genuine silence has elapsed (no added
 *  latency, which is the hard constraint here). */
function armSilenceTimer(): void {
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  // Held during 'reconnecting' — see pauseSilenceTimer(). A late
  // is_final landing during the gap (shouldn't normally happen, bridge
  // is dead — but be defensive) still appends to the buffer; the timer
  // just doesn't re-arm until resumeSilenceTimer() runs.
  if (silencePaused) return;
  const { silenceSec } = getHandsfreeConfig();
  if (silenceSec <= 0) return;  // 0 = disabled (sendword-only mode).
  const now = Date.now();
  // A final transcript IS evidence the user was speaking, so arming
  // from handleUserFinal counts as voice. Callers that arm for other
  // reasons (resumeSilenceTimer) get the same treatment — the mic loop
  // will correct it within a frame if he is in fact still talking.
  if (voiceWindow === null) voiceWindow = new SilenceWindow(silenceSec, now);
  else {
    voiceWindow.setThreshold(silenceSec);
    voiceWindow.noteVoice(now);
  }
  scheduleSilenceCheck(silenceSec * 1000);
}

function scheduleSilenceCheck(delayMs: number): void {
  silenceTimer = setTimeout(() => {
    silenceTimer = null;
    const w = voiceWindow;
    if (!w) { dispatchNow(); return; }
    const { silenceSec } = getHandsfreeConfig();
    w.setThreshold(silenceSec);
    if (silenceSec <= 0) return;   // slider moved to "sendword only" mid-turn
    const now = Date.now();
    if (w.expired(now)) {
      dispatchNow();
      return;
    }
    // Still talking — the transcripts just went quiet. Chase the real
    // deadline. This is the branch that saves the dictation.
    const remaining = Math.max(20, silenceSec * 1000 - w.msSinceVoice(now));
    diag('[dictation] end-of-turn deferred — mic still active,',
      `${Math.round(w.msSinceVoice(now))}ms since voice`);
    scheduleSilenceCheck(remaining);
  }, Math.max(0, delayMs));
}

/**
 * Feed an is_final user transcript into the dictation state machine.
 *
 * Behavior:
 *   - If the joined buffer + this segment matches the commit phrase,
 *     strip it and dispatch immediately.
 *   - Otherwise append to buffer and arm the silence timer.
 *
 * Interim transcripts should NOT be passed here — they're for live
 * caption rendering and don't move the state machine.
 */
/** Test-only introspection — returns a shallow copy of the current
 *  utterance buffer. Production code never reads the buffer directly;
 *  this exists so unit tests can assert the pause/resume preserves
 *  content across a 'reconnecting' window (Jonathan field bug
 *  2026-06-23). */
export function __getBufferForTests(): string[] {
  return buffer.slice();
}

/** Test-only introspection — true iff a silence timer is currently
 *  armed. Used by the pause/resume tests so they can verify a
 *  reconnecting-paused buffer is NOT counting down. */
export function __hasSilenceTimerForTests(): boolean {
  return silenceTimer !== null;
}

/** Test-only introspection — true iff a sendword commit-grace timer
 *  (commitDelaySec) is currently pending. */
export function __hasCommitTimerForTests(): boolean {
  return commitTimer !== null;
}

/** Test-only introspection — ms since the last noteVoice() on the live
 *  end-of-turn window, or null when no countdown is armed. */
export function __msSinceVoiceForTests(now: number = Date.now()): number | null {
  return voiceWindow ? voiceWindow.msSinceVoice(now) : null;
}

export function handleUserFinal(text: string): void {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  const joined = (buffer.join(' ') + ' ' + trimmed).trim();
  const { sendwordPhrase } = getHandsfreeConfig();
  const m = matchSendword(joined, sendwordPhrase);
  if (m.matched) {
    // Match: replace whatever's buffered with the cleaned prefix and
    // dispatch. The 'commit' chime fires the moment the send-word
    // lands so the user gets feedback BEFORE the dispatch round-trips
    // — pairs with the 'send' chime in dispatchNow(). With a non-zero
    // commitDelaySec the dispatch waits out the grace window (finals
    // arriving inside it append and ride along; a repeated sendword
    // re-arms the window).
    try { playFeedback('commit'); } catch { /* feedback is best-effort */ }
    buffer = m.cleaned ? [m.cleaned] : [];
    const { commitDelaySec } = getHandsfreeConfig();
    if (commitDelaySec > 0) {
      if (commitTimer !== null) clearTimeout(commitTimer);
      commitTimer = setTimeout(() => {
        commitTimer = null;
        dispatchNow();
      }, commitDelaySec * 1000);
      return;
    }
    dispatchNow();
    return;
  }
  buffer.push(trimmed);
  armSilenceTimer();
}
