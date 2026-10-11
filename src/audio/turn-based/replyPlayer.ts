/**
 * @fileoverview Per-bubble TTS playback UX — loading bar, played-ratio
 * bar, play/pause/replay button, scrub-by-tap-or-drag.
 *
 * Subscribes to events from `tts.ts`. Every event carries `replyId` in
 * its payload; this module looks up the matching bubble by
 * `data-reply-id` and updates the DOM. ALL state lives in the DOM so
 * replies keep their rendered progress across re-renders + session
 * restores.
 *
 * Bar layering (see `styles/app.css`):
 *   .play-bar-loaded  — light primary, width = synthesis/buffer ratio
 *                       (animated shimmer while .tts-streaming)
 *   .play-bar-played  — bright primary, width = position / duration
 *
 * CSS class state machine (per bubble):
 *   .tts-active   — this bubble is the player's current focus
 *   .tts-streaming — fetch in flight; loaded bar shimmers
 *   .tts-playing  — audio playing through speakers (CSS swaps glyph)
 *   .tts-paused   — audio paused mid-stream
 *   .tts-played   — audio finished naturally (icon back to play)
 *   .tts-cached   — replyCache.has(text, voice); chip uses primary color
 *
 * Click handling is DELEGATED at the transcript element level, so new
 * bubbles work without per-bubble listener attachment. Single click
 * handler for play-btn taps, single pointerdown for scrub-bar drags.
 *
 * Ported from classic (08f50ac:src/pipelines/classic/replyPlayer.ts).
 * Mechanics preserved one-to-one; only the underlying tts module API
 * differs (turn-based/tts.ts uses HTMLAudioElement under the hood
 * instead of classic's chunk-decoded WebAudio queue).
 */

import { log, diag } from '../../util/log.ts';
import { lastStart, isUserTrigger, notePlaybackStart } from '../../playbackAudit.ts';
import * as tts from './tts.ts';
import * as replyCache from './replyCache.ts';

let transcriptEl: HTMLElement | null = null;
let initialized = false;

/** Per-replyId playback state. Under virtualization the bubble's DOM is
 *  destroyed when the spec leaves the visible window — without an
 *  out-of-DOM mirror, the loaded/played bar widths + state classes
 *  reset to zero when the bubble remounts. Each tts event updates this
 *  map; `applyBubbleState` reads it when the reconciler creates a new
 *  agent bubble. Default-path (full DOM) is unaffected — the map is
 *  written either way but only matters on remount. */
interface BubbleState {
  active: boolean;
  streaming: boolean;
  playing: boolean;
  paused: boolean;
  played: boolean;
  loadedRatio: number;
  playedRatio: number;
}
const bubbleStates = new Map<string, BubbleState>();
function getOrCreateState(replyId: string): BubbleState {
  let s = bubbleStates.get(replyId);
  if (!s) {
    s = { active: false, streaming: false, playing: false, paused: false, played: false, loadedRatio: 0, playedRatio: 0 };
    bubbleStates.set(replyId, s);
  }
  return s;
}
function clearActiveExcept(except: string): void {
  for (const [key, state] of bubbleStates) {
    if (key === except) continue;
    if (state.active || state.streaming || state.playing || state.paused) {
      state.active = state.streaming = state.playing = state.paused = false;
    }
  }
}

/** Test hook: directly set the persisted playback state without going
 *  through the tts event path. Smokes use this to assert that virt
 *  unmount/remount preserves the per-replyId state. Not part of the
 *  production API. */
export function __testSetBubbleState(replyId: string, partial: Partial<BubbleState>): void {
  const s = getOrCreateState(replyId);
  Object.assign(s, partial);
  const bubble = findBubble(replyId);
  if (bubble) applyBubbleState(bubble, replyId);
}

/** Reapply persisted playback state to a newly-mounted agent bubble.
 *  Called by the reconciler (createAssistant) after addLine returns so
 *  bubbles scrolled back into the virtualizer's window paint their
 *  prior tts state instead of resetting to "fresh" zeroed bars. */
export function applyBubbleState(bubble: HTMLElement, replyId: string): void {
  const s = bubbleStates.get(replyId);
  if (!s) return;
  bubble.classList.toggle('tts-active', s.active);
  bubble.classList.toggle('tts-streaming', s.streaming);
  bubble.classList.toggle('tts-playing', s.playing);
  bubble.classList.toggle('tts-paused', s.paused);
  bubble.classList.toggle('tts-played', s.played);
  setLoadedRatio(bubble, s.loadedRatio);
  setPlayedRatio(bubble, s.playedRatio);
}

export type ReplyPlayerOpts = {
  transcriptEl: HTMLElement;
  /** Resolve the voice setting (sync or async). Used for cache-hit
   *  badge rendering + scrub-from-cold-start playback. */
  resolveVoice: () => string | Promise<string>;
};

/** Wire the module to the live DOM. Idempotent — calling again replaces
 *  the transcript element + re-subscribes (used by tests; production
 *  calls once at boot). */
export function init(opts: ReplyPlayerOpts): void {
  if (initialized) {
    // Tear down + rewire — covers test reset.
    teardown();
  }
  transcriptEl = opts.transcriptEl;
  voiceResolver = opts.resolveVoice;
  initialized = true;

  tts.on('synth-start',    onSynthStart);
  tts.on('load-progress',  onLoadProgress);
  tts.on('duration-known', onDurationKnown);
  tts.on('play-start',     onPlayStart);
  tts.on('progress',       onProgress);
  tts.on('seek',           onSeek);
  tts.on('paused',         onPaused);
  tts.on('resumed',        onResumed);
  tts.on('ended',          onEnded);
  tts.on('stopped',        onStopped);

  // Delegated click + pointerdown — bubbles come and go (streaming,
  // session restore, chat.clear), so we don't want per-line listeners.
  transcriptEl.addEventListener('click', onTranscriptClick);
  transcriptEl.addEventListener('pointerdown', onTranscriptPointerDown);
}

function teardown(): void {
  if (transcriptEl) {
    transcriptEl.removeEventListener('click', onTranscriptClick);
    transcriptEl.removeEventListener('pointerdown', onTranscriptPointerDown);
  }
  tts.off('synth-start',    onSynthStart);
  tts.off('load-progress',  onLoadProgress);
  tts.off('duration-known', onDurationKnown);
  tts.off('play-start',     onPlayStart);
  tts.off('progress',       onProgress);
  tts.off('seek',           onSeek);
  tts.off('paused',         onPaused);
  tts.off('resumed',        onResumed);
  tts.off('ended',          onEnded);
  tts.off('stopped',        onStopped);
  initialized = false;
}

/** Re-flag every visible agent bubble's `.tts-cached` state against
 *  the LRU cache. Called by chat.ts after rendering history (or after
 *  cache mutations from elsewhere). */
export function syncCachedBadges(): void {
  if (!transcriptEl) return;
  const voice = resolveVoiceSync();
  if (!voice) {
    // Voice not synchronously resolvable yet — caller can re-call
    // after settings.load resolves.
    return;
  }
  transcriptEl.querySelectorAll<HTMLElement>('.line.agent[data-reply-id]').forEach((b) => {
    const text = (b.dataset.text || b.textContent || '').trim();
    if (text && replyCache.has(text, voice)) b.classList.add('tts-cached');
    else b.classList.remove('tts-cached');
  });
}

let voiceResolver: () => string | Promise<string> = () => 'aura-2-thalia-en';
function resolveVoiceSync(): string | null {
  // Best-effort sync resolve: if the resolver returns a string,
  // use it; if a promise, return null and let async paths handle it.
  const v = voiceResolver();
  return typeof v === 'string' ? v : null;
}
async function resolveVoiceAsync(): Promise<string> {
  return await Promise.resolve(voiceResolver());
}

// ── DOM helpers ──────────────────────────────────────────────────────

function findBubble(replyId: string | null): HTMLElement | null {
  if (!transcriptEl || !replyId) return null;
  return transcriptEl.querySelector<HTMLElement>(
    `.line.agent[data-reply-id="${CSS.escape(replyId)}"]`,
  );
}

function setLoadedRatio(bubble: HTMLElement, ratio: number): void {
  const el = bubble.querySelector<HTMLElement>('.play-bar-loaded');
  if (el) el.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

function setPlayedRatio(bubble: HTMLElement, ratio: number): void {
  const el = bubble.querySelector<HTMLElement>('.play-bar-played');
  if (el) el.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

/** Clear ALL playback-state classes from every other bubble — only one
 *  bubble can be the active focus at a time. Called when a new bubble
 *  takes over (play-start fires for a fresh replyId). */
function clearAllStateClassesExcept(except: HTMLElement): void {
  if (!transcriptEl) return;
  transcriptEl.querySelectorAll('.line.agent').forEach((el) => {
    if (el === except) return;
    el.classList.remove('tts-active', 'tts-playing', 'tts-paused', 'tts-streaming');
  });
}

// ── tts event handlers ───────────────────────────────────────────────

function onSynthStart({ replyId }: { replyId: string }) {
  clearActiveExcept(replyId);
  const s = getOrCreateState(replyId);
  s.active = true; s.streaming = true; s.played = false; s.paused = false;
  s.loadedRatio = 0; s.playedRatio = 0;
  const bubble = findBubble(replyId);
  if (!bubble) return;
  clearAllStateClassesExcept(bubble);
  bubble.classList.add('tts-active', 'tts-streaming');
  bubble.classList.remove('tts-played', 'tts-paused');
  setLoadedRatio(bubble, 0);
  setPlayedRatio(bubble, 0);
}

function onLoadProgress({ replyId, ratio }: { replyId: string; ratio: number }) {
  const s = getOrCreateState(replyId);
  s.loadedRatio = ratio;
  // Reaching full synthesis is what ends the streaming/shimmer state — for
  // the multi-chunk path this only happens once the LAST chunk has settled
  // (load-progress climbs chunk-by-chunk), not when chunk 0's metadata
  // lands. Single-blob/cache replies emit ratio:1 immediately, so they
  // still clear streaming the instant the blob loads.
  if (ratio >= 1) s.streaming = false;
  const bubble = findBubble(replyId);
  if (!bubble) return;
  setLoadedRatio(bubble, ratio);
  if (ratio >= 1) bubble.classList.remove('tts-streaming');
}

// `duration-known` is now only a scrub-timeline scale hint (whole-reply
// duration; the played/loaded bars work in ratios and don't need it). It
// must NOT clear the streaming state — for multi-chunk replies the first
// chunk's metadata arrives long before synthesis finishes, and clearing
// streaming here would stop the shimmer + freeze the grey bar early.
// onLoadProgress owns the streaming→done transition (ratio >= 1).
function onDurationKnown(_payload: { replyId: string; duration: number }) {
  /* intentionally inert — see comment above */
}

function onPlayStart({ replyId }: { replyId: string }) {
  clearActiveExcept(replyId);
  const s = getOrCreateState(replyId);
  s.active = true; s.playing = true; s.streaming = false; s.paused = false; s.played = false;
  const bubble = findBubble(replyId);
  if (!bubble) return;
  clearAllStateClassesExcept(bubble);
  bubble.classList.remove('tts-streaming', 'tts-paused', 'tts-played');
  bubble.classList.add('tts-active', 'tts-playing');
  // Name the trigger on the bar when the user did NOT tap this bubble —
  // "auto · media-skip" tells the user (and the next bug report) why it
  // is talking. A user tap clears any earlier badge.
  const bar = bubble.querySelector<HTMLElement>('.play-bar');
  const st = lastStart();
  if (bar) {
    if (st && st.replyId === replyId && !isUserTrigger(st.trigger) && Date.now() - st.at < 10_000) {
      bar.dataset.ttsTrigger = st.trigger;
    } else {
      delete bar.dataset.ttsTrigger;
    }
  }
}

function onProgress({ replyId, position, duration }: { replyId: string; position: number; duration: number }) {
  const ref = duration || 1;
  getOrCreateState(replyId).playedRatio = position / ref;
  const bubble = findBubble(replyId);
  if (!bubble) return;
  setPlayedRatio(bubble, position / ref);
}

function onSeek({ replyId, position, duration }: { replyId: string; position: number; duration: number }) {
  const ref = duration || 1;
  getOrCreateState(replyId).playedRatio = position / ref;
  const bubble = findBubble(replyId);
  if (!bubble) return;
  setPlayedRatio(bubble, position / ref);
}

function onPaused({ replyId }: { replyId: string }) {
  const s = getOrCreateState(replyId);
  s.playing = false; s.played = false; s.paused = true; s.active = true;
  const bubble = findBubble(replyId);
  if (!bubble) return;
  bubble.classList.remove('tts-playing', 'tts-played');
  bubble.classList.add('tts-active', 'tts-paused');
}

function onResumed({ replyId }: { replyId: string }) {
  const s = getOrCreateState(replyId);
  s.paused = false; s.playing = true; s.active = true;
  const bubble = findBubble(replyId);
  if (!bubble) return;
  bubble.classList.remove('tts-paused');
  bubble.classList.add('tts-active', 'tts-playing');
}

function onEnded({ replyId }: { replyId: string }) {
  const s = getOrCreateState(replyId);
  s.active = false; s.streaming = false; s.playing = false; s.paused = false;
  s.played = true; s.loadedRatio = 1; s.playedRatio = 1;
  const bubble = findBubble(replyId);
  if (!bubble) return;
  bubble.classList.remove('tts-active', 'tts-streaming', 'tts-playing', 'tts-paused');
  bubble.classList.add('tts-played');
  setLoadedRatio(bubble, 1);
  setPlayedRatio(bubble, 1);
}

function onStopped({ replyId, reason }: { replyId: string; reason: string }) {
  const s = getOrCreateState(replyId);
  s.active = false; s.streaming = false; s.playing = false; s.paused = false;
  if (reason === 'play-error' || reason === 'tts-http-error') s.playedRatio = 0;
  const bubble = findBubble(replyId);
  if (!bubble) return;
  bubble.classList.remove('tts-active', 'tts-streaming', 'tts-playing', 'tts-paused');
  // 'superseded' = a fresh playReplyTts cancelled this one (e.g. user
  // tapped a different bubble); leave the played bar where it was so
  // the user can scrub back later. 'cancel' / explicit stop = also
  // leave bar state alone. 'play-error' / 'tts-http-error' = visually
  // fall back to "not played" by clearing the bar.
  if (reason === 'play-error' || reason === 'tts-http-error') {
    setPlayedRatio(bubble, 0);
  }
  log(`[reply-player] stopped (${reason}): ${replyId}`);
}

// ── Click + drag handlers (delegated) ────────────────────────────────

function onTranscriptClick(e: Event) {
  const target = e.target as HTMLElement;
  const playBtn = target.closest('.play-btn') as HTMLElement | null;
  if (playBtn) { void onPlayClick(e, playBtn); return; }
  // Bar taps are handled via pointerdown (below) so drag-to-scrub works.
}

function onTranscriptPointerDown(e: Event) {
  const target = e.target as HTMLElement;
  const bar = target.closest('.play-bar') as HTMLElement | null;
  if (!bar) return;
  void onBarPointerDown(e as PointerEvent, bar);
}

async function onBarPointerDown(e: PointerEvent, bar: HTMLElement): Promise<void> {
  e.stopPropagation();
  e.preventDefault();
  const bubble = bar.closest('.line.agent') as HTMLElement | null;
  if (!bubble) return;
  const replyId = bubble.dataset.replyId || '';
  if (!replyId) return;
  const text = (bubble.dataset.text || bubble.textContent || '').trim();
  if (!text) return;

  const rect = bar.getBoundingClientRect();
  const ratioAt = (clientX: number) =>
    Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const ratio = ratioAt(e.clientX);

  // Drive seek-or-start: if this bubble is already the active one, just
  // seek. Otherwise start a fresh playback (cache-first via playReplyTts)
  // and seek once duration-known fires.
  if (tts.getActiveReplyId() === replyId) {
    tts.seekTo(ratio);
  } else {
    const voice = await resolveVoiceAsync();
    notePlaybackStart('user-tap', { reason: 'scrub', replyId, ttsState: tts.getState() });
    // playReplyTts internally cancels any prior session before starting.
    await tts.playReplyTts(text, voice, replyId);
    // Wait a tick for duration to be known, then seek. Subscribe once.
    const onceDur = (p: any) => {
      if (p.replyId !== replyId) return;
      tts.off('duration-known', onceDur);
      tts.seekTo(ratio);
    };
    tts.on('duration-known', onceDur);
  }

  try { bar.setPointerCapture(e.pointerId); } catch { /* noop */ }

  const onMove = (ev: PointerEvent) => {
    if (tts.getActiveReplyId() === replyId) {
      tts.seekTo(ratioAt(ev.clientX));
    }
  };
  const onUp = () => {
    bar.removeEventListener('pointermove', onMove);
    bar.removeEventListener('pointerup', onUp);
    bar.removeEventListener('pointercancel', onUp);
    try { bar.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };
  bar.addEventListener('pointermove', onMove);
  bar.addEventListener('pointerup', onUp);
  bar.addEventListener('pointercancel', onUp);
}

// Phantom-click guard. iPhone PWA reload can take seconds to settle;
// during that window an iOS-queued synthetic click from the user's
// pre-reload tap (e.g. on Refresh) can land on a play-btn that just
// rendered in the same screen position. Ignoring play-btn clicks for
// the first PHANTOM_CLICK_MUTE_MS after page load prevents auto-TTS
// on reload that the user didn't actually intend — a phantom tap can
// land on a play-btn that appears in the same screen position.
const PHANTOM_CLICK_MUTE_MS = 1500;
const PAGE_LOAD_T0 = typeof performance !== 'undefined' ? performance.now() : 0;

async function onPlayClick(e: Event, btn: HTMLElement): Promise<void> {
  e.stopPropagation();
  const sincePageLoad = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - PAGE_LOAD_T0;
  if (sincePageLoad < PHANTOM_CLICK_MUTE_MS) {
    log(`[reply-player] click ignored (boot-window phantom guard, +${sincePageLoad.toFixed(0)}ms)`);
    return;
  }
  const bubble = btn.closest('.line.agent') as HTMLElement | null;
  if (!bubble) return;
  const replyId = bubble.dataset.replyId || '';
  if (!replyId) {
    diag('[reply-player] click on bubble without data-reply-id');
    return;
  }
  const text = (bubble.dataset.text || bubble.textContent || '').trim();
  if (!text) return;

  const activeId = tts.getActiveReplyId();
  // Guard against tap-while-loading: each subsequent tap supersedes
  // the in-flight /tts fetch and restarts it, leaving the user waiting
  // with no feedback (multiple taps on a loading bubble just restart
  // the synth). If THIS bubble is currently loading, drop the click —
  // the CSS spinner already signals "working on it." Other bubbles can
  // still steal focus; that's the supersede-and-cancel design.
  if (activeId === replyId && tts.getState() === 'loading') {
    log(`[reply-player] click ignored (loading) bubble=${replyId}`);
    return;
  }
  log(`[reply-player] click bubble=${replyId} active=${activeId} state=${tts.getState()}`);

  // If THIS bubble is active, toggle on the live state machine.
  if (activeId === replyId) {
    const state = tts.getState();
    if (state === 'playing') { tts.pauseReplyTts(); return; }
    if (state === 'paused')  { void tts.resumeReplyTts(); return; }
    if (state === 'ended')   { notePlaybackStart('user-replay', { replyId, ttsState: state }); if (await tts.replay()) return; }
    // Fall through to fresh playback if state unexpectedly idle.
  }

  // Different bubble or nothing active: cancel + start fresh. Cache hits
  // get instant replay; misses re-`/tts`. Same code path either way.
  const voice = await resolveVoiceAsync();
  notePlaybackStart('user-tap', { reason: 'play-btn', replyId, ttsState: tts.getState() });
  await tts.playReplyTts(text, voice, replyId);
}
