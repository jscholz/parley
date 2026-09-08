/**
 * @fileoverview Per-reply navigation pointer for BT skip-fwd / skip-back.
 *
 * Wired in `src/main.ts` onNextTrack / onPrevTrack via session.ts.
 *
 * The DOM-class flips, loading bar, played-ratio bar, scrub, and
 * play/pause/replay button all live in `replyPlayer.ts` (delegated
 * handlers driven by `tts.ts` events). This module is intentionally
 * thin: it owns ONLY the "what bubble does BT skip-fwd/back act on"
 * pointer + the navigation algorithm.
 *
 * Pointer model: `currentBubble` defaults to the most-recent agent
 * bubble. Updated whenever a fresh playback starts on a specific bubble
 * (via `tts.ts:play-start` event). Reset on chat switch via `reset()`,
 * and also invalidated to `null` once RECENT_TTS_GRACE_MS has elapsed
 * since the last playback ended (see `skipAllowed()` below) — otherwise
 * a stale pointer from long ago could silently "resurrect" the moment
 * skip becomes allowed again for an unrelated reason (e.g. a later call
 * opens) and speak a superseded reply.
 *
 * Skip gate (field bug, ~daily for weeks): `session.ts` registers
 * `nexttrack`/`previoustrack` Media Session handlers unconditionally at
 * app init, so the page advertises itself as a media target even while
 * playing nothing. ANY external media event — a BT headset double-tap,
 * a car head unit sending next-track on connect, a keyboard media key,
 * a Control Center skip — used to reach `playNext`/`playPrev` and make
 * an idle, backgrounded Parley speak a chat reply out loud with nobody
 * having chosen to hear it. `skipAllowed()` gates every entry point
 * (Media Session handlers, the `fakeLock` prev/next callbacks, and the
 * `window.__audioSessionTest.fireAction` test bridge — all of them
 * funnel through `playNext`/`playPrev`) on Parley actually being in an
 * audio-active state, mirroring the precedent `remoteControl.ts`'s
 * `dispatch()` already set for `togglePlayPause` ("tapping it from a
 * quiet state shouldn't surprise-auto-start audio").
 */

import { log } from '../../util/log.ts';
import * as tts from './tts.ts';
import * as webrtcControls from '../realtime/controls.ts';
import * as fakeLock from '../../ios/fakeLock.ts';

let currentBubble: HTMLElement | null = null;
let subscribed = false;

/** How long after a TTS playback session ends a skip is still honored.
 *  Lets someone who just finished listening keep walking between
 *  replies for a while after the audio itself stopped, without leaving
 *  skip "live" forever once they've put the phone down. */
export const RECENT_TTS_GRACE_MS = 5 * 60 * 1000;

/** Wall-clock ms timestamp of the last TTS playback session ending, or
 *  null if none has ended yet (or the window was explicitly cleared —
 *  see `reset()`). Stamped from the SAME tts.ts subscription
 *  `ensureSubscribed()` already holds (see below) — deliberately not a
 *  second listener. */
let lastTtsEndAt: number | null = null;

async function resolveVoice(): Promise<string> {
  try {
    const settingsMod = await import('../../settings.ts');
    // BT skip-fwd/back navigates the viewed session's bubbles, so prefer
    // that session's assigned voice (sessionIdentity) over the default.
    const identMod = await import('../../sessionIdentity.ts');
    const switchMod = await import('../../switchController.ts');
    const sid = switchMod.viewedId?.() || '';
    const v = identMod.voiceFor?.(sid) || settingsMod.get?.()?.voice;
    return typeof v === 'string' && v ? v : 'aura-2-thalia-en';
  } catch {
    return 'aura-2-thalia-en';
  }
}

function listAgentBubbles(): HTMLElement[] {
  const transcript = document.getElementById('transcript');
  if (!transcript) return [];
  return Array.from(transcript.querySelectorAll<HTMLElement>('.line.agent'));
}

function findBubbleByReplyId(replyId: string | null): HTMLElement | null {
  if (!replyId) return null;
  const transcript = document.getElementById('transcript');
  if (!transcript) return null;
  return transcript.querySelector<HTMLElement>(
    `.line.agent[data-reply-id="${CSS.escape(replyId)}"]`,
  );
}

/** Subscribe once to tts events so the pointer follows playback and the
 *  grace-window timestamp tracks playback end. Without the play-start
 *  half, BT skip-fwd would always start from the most-recent bubble
 *  even after the user drove playback to a middle reply. The end-of-
 *  session half feeds `skipAllowed()`'s recent-tts-grace condition.
 *
 *  Called eagerly at module load (see bottom of file) rather than
 *  lazily from playNext/playPrev: replies can auto-play (see
 *  backendEventHandlers.ts) and finish WITHOUT the user ever touching
 *  skip. If the subscription only started on first skip attempt, a
 *  user's very first BT skip of the session — arriving shortly after
 *  an auto-played reply that already finished — would find
 *  `lastTtsEndAt` still null (the 'ended' event fired before anyone was
 *  listening for it) and be wrongly denied. Idempotent either way. */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  tts.on('play-start', ({ replyId }: { replyId: string }) => {
    const b = findBubbleByReplyId(replyId);
    if (b) currentBubble = b;
    // Playback STARTING arms the grace window too, not just its end.
    // The end-only version made the gate depend on a terminal event that
    // is not guaranteed to arrive: if 'ended'/'stopped' never fires for a
    // playback (a path that tears the element down, an engine that omits
    // it), lastTtsEndAt stays null and a legitimate skip moments later is
    // refused with "sinceLastTts=n/a" — seen as an intermittent failure of
    // the mediasession-skip smoke under full-suite load, 2026-09-08. A
    // reply that started playing is itself proof the user is in a
    // listening session, which is exactly what the window is for.
    lastTtsEndAt = Date.now();
  });
  // Natural end-of-reply re-arms the grace window (it moves the clock
  // forward from play-start to the actual end).
  tts.on('ended', () => { lastTtsEndAt = Date.now(); });
  // Explicit stop/cancel arms it too — EXCEPT 'reset', which is
  // reset() tearing playback down on purpose for a chat switch, not
  // "the user just finished listening". reset() clears the grace
  // timestamp directly (see below) so excluding it here just avoids
  // this handler racing that clear and re-arming it a tick later.
  tts.on('stopped', (payload: { reason?: string }) => {
    if (payload?.reason === 'reset') return;
    lastTtsEndAt = Date.now();
  });
}
// Eager: see the doc comment above for why this can't wait for the
// first playNext/playPrev call.
ensureSubscribed();

/** Dependencies `skipAllowed()` reads, overridable for tests. Default to
 *  the real modules — production callers (`playNext`/`playPrev`) invoke
 *  `skipAllowed()` with no arguments. */
export type SkipAllowedDeps = {
  isCallOpen?: () => boolean;
  getTtsState?: () => tts.TtsState;
  isPocketLockOpen?: () => boolean;
  now?: () => number;
};

/** Skip-gate predicate: may a BT-headset / lock-screen / car-infotainment
 *  track-skip (nexttrack/previoustrack) act right now? Honored when ANY
 *  of these hold — otherwise inert (see module doc for why):
 *
 *    1. a realtime/call session is open (`webrtcControls.isOpen()`);
 *    2. reply TTS is playing or paused (`tts.getState()`);
 *    3. the pocket-lock overlay is open (`fakeLock.isActive()`) — the
 *       explicit hands-free case: phone pocketed, listening to replies;
 *    4. reply TTS finished less than RECENT_TTS_GRACE_MS ago — lets a
 *       user who just listened keep skipping right after playback ends.
 *
 *  Returns the reason either way so callers can log a single line
 *  naming which state was checked (mirrors remoteControl.ts's
 *  dispatch() log style). */
export function skipAllowed(deps: SkipAllowedDeps = {}): { allowed: boolean; reason: string } {
  const isCallOpen = deps.isCallOpen ?? webrtcControls.isOpen;
  const getTtsState = deps.getTtsState ?? tts.getState;
  const isPocketLockOpen = deps.isPocketLockOpen ?? fakeLock.isActive;
  const now = deps.now ?? Date.now;

  if (isCallOpen()) return { allowed: true, reason: 'call-open' };

  const ttsState = getTtsState();
  if (ttsState === 'playing' || ttsState === 'paused') {
    return { allowed: true, reason: `tts-${ttsState}` };
  }

  if (isPocketLockOpen()) return { allowed: true, reason: 'pocket-lock-open' };

  if (lastTtsEndAt !== null) {
    const sinceEndMs = now() - lastTtsEndAt;
    if (sinceEndMs < RECENT_TTS_GRACE_MS) {
      return { allowed: true, reason: `recent-tts-grace (${sinceEndMs}ms ago)` };
    }
  }

  const graceMs = lastTtsEndAt === null ? 'n/a' : `${now() - lastTtsEndAt}ms`;
  return {
    allowed: false,
    reason: `idle — callOpen=false ttsState=${ttsState} pocketLock=false sinceLastTts=${graceMs}`,
  };
}

/** Once the grace window has lapsed, drop the stale pointer so it can't
 *  silently resurrect and let a much-later skip (allowed for some other
 *  reason — a fresh call opens, pocket-lock reopens) speak a reply the
 *  user never asked to resume from. No-op while still within grace or
 *  before any playback has ever ended. */
function invalidateStalePointerIfLapsed(): void {
  if (lastTtsEndAt !== null && Date.now() - lastTtsEndAt >= RECENT_TTS_GRACE_MS) {
    currentBubble = null;
  }
}

/** Public: play the agent bubble BEFORE the current pointer. */
export async function playPrev(): Promise<void> {
  ensureSubscribed();
  invalidateStalePointerIfLapsed();
  const gate = skipAllowed();
  if (!gate.allowed) {
    log(`[reply-nav] playPrev ignored — ${gate.reason}`);
    return;
  }
  const all = listAgentBubbles();
  if (!all.length) return;
  const cur = currentBubble && document.body.contains(currentBubble)
    ? currentBubble : all[all.length - 1];
  const idx = all.indexOf(cur);
  const target = idx > 0 ? all[idx - 1] : null;
  if (!target) {
    log('[reply-nav] already at first reply');
    return;
  }
  await playBubble(target);
}

/** Public: play the agent bubble AFTER the current pointer. */
export async function playNext(): Promise<void> {
  ensureSubscribed();
  invalidateStalePointerIfLapsed();
  const gate = skipAllowed();
  if (!gate.allowed) {
    log(`[reply-nav] playNext ignored — ${gate.reason}`);
    return;
  }
  const all = listAgentBubbles();
  if (!all.length) return;
  const cur = currentBubble && document.body.contains(currentBubble)
    ? currentBubble : all[all.length - 1];
  const idx = all.indexOf(cur);
  const target = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;
  if (!target) {
    log('[reply-nav] already at most-recent reply');
    return;
  }
  await playBubble(target);
}

async function playBubble(bubble: HTMLElement): Promise<void> {
  const replyId = bubble.dataset.replyId || '';
  const text = (bubble.dataset.text || bubble.textContent || '').trim();
  if (!text) return;
  currentBubble = bubble;
  const voice = await resolveVoice();
  // playReplyTts internally cancels any prior session before starting.
  // The 'play-start' event will land in replyPlayer, which paints the
  // bubble's tts-active / tts-playing classes.
  await tts.playReplyTts(text, voice, replyId || undefined);
}

/** Public: stop playback + reset the pointer. Called on chat switch.
 *  Also clears the grace-window timestamp — a chat switch means the
 *  "just listened, keep skipping" intent doesn't carry over to whatever
 *  chat is viewed next. */
export function reset(): void {
  tts.cancelReplyTts('reset');
  currentBubble = null;
  lastTtsEndAt = null;
}
