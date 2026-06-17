/**
 * @fileoverview Crack A — transcript pipeline bootstrap.
 *
 * Wires the store → projection → reconciler chain to the live
 * transcript element. Called once from main.ts boot. After this,
 * every mutation through the store (setDurable, appendInflight,
 * addPendingSend, …) automatically re-renders the active chat.
 *
 * Background-chat events still mutate the store but the reconciler
 * skips them — they re-render on the next session switch.
 */

import { project } from './projection.ts';
import { reconcile, resetActivityExpandState } from './reconciler.ts';
import { getState, subscribe } from './store.ts';
import { scheduleSnapshotPersist, runWithScrollSaveSuppressed, autoScroll } from '../chat.ts';

let getTranscriptEl: () => HTMLElement | null = () => document.getElementById('transcript');
let getFocusedChatId: () => string | null = () => null;

export interface BindOpts {
  transcriptEl: () => HTMLElement | null;
  getFocusedChatId: () => string | null;
}

/** Wire the store to the DOM. Returns an unsubscribe fn (mainly for
 *  tests; production never unbinds). */
export function bindTranscriptPipeline(opts: BindOpts): () => void {
  getTranscriptEl = opts.transcriptEl;
  getFocusedChatId = opts.getFocusedChatId;
  return subscribe((chatId) => {
    // Gate on the FOCUSED chat (optimistic ?? viewed) — the same pointer
    // that drives the drawer highlight — so the transcript always agrees
    // with the highlight. Skip ONLY when focus is set AND explicitly
    // differs; a null focus (boot before any switch, fresh-PWA-first-send
    // before any drawer click) renders the change — there's no other chat
    // on screen to protect.
    //
    // #255: gating on the COMMITTED `viewed` pointer instead leaked the
    // outgoing chat's live reply during a cold/slow switch — viewed lags
    // for the whole load (it only commits when the incoming transcript
    // renders) while the highlight already shows the target, so a busy
    // chat's reply_delta painted into the on-screen transcript.
    const focused = getFocusedChatId();
    if (focused && chatId !== focused) return;
    rerenderInto(chatId);
  });
}

/** Switch-then-load: blank the transcript + show the loading spinner
 *  IMMEDIATELY when the user clicks a different chat row, before the
 *  incoming transcript is ready. Pure in-DOM operation — empties the
 *  rendered content and adds the `.transcript-loading` class (the CSS
 *  spinner fades in after 200ms; a fast cache hit clears it first via
 *  rerenderInto's `specs.length > 0` removal so no flash). Decoupled
 *  from any IDB persistence: the click handler calls this synchronously,
 *  and "which session is viewed" stays on its existing async path. This
 *  is why it can't reintroduce the IDB-pagehide race that reverted the
 *  prior attempt — nothing here writes to (or awaits) IndexedDB. */
export function showTranscriptLoading(): void {
  const el = getTranscriptEl();
  if (!el) return;
  // Switching chats: forget per-row tool-list expand choices so the incoming
  // chat's (and this chat's, on switch-back) tool lists default collapsed —
  // old tool runs are long + rarely interesting.
  // Cold load starts with an empty map already.
  resetActivityExpandState();
  // Emptying the transcript collapses its scrollHeight and fires a
  // synthetic scroll-to-0 event while the LEAVING chat is still the
  // viewed one. Suppress the scroll listener's position-save across the
  // clear so that synthetic scroll doesn't clobber the leaving chat's
  // just-saved position with a garbage (empty-transcript) anchor.
  runWithScrollSaveSuppressed(() => {
    el.innerHTML = '';
  });
  el.classList.add('transcript-loading');
}

/** Force a re-render of the active chat. Call after a session-switch
 *  finishes (the store mutations may have run while a different chat
 *  was viewed, so the subscriber skipped them). */
export function rerenderActive(): void {
  const chatId = getFocusedChatId();
  if (!chatId) return;
  rerenderInto(chatId);
}

function rerenderInto(chatId: string): void {
  const el = getTranscriptEl();
  if (!el) return;
  const specs = project(getState(chatId));
  // Full-DOM render via the reconciler — no JS windowing. Off-screen
  // render cost is handled by CSS `content-visibility: auto` on `.line`,
  // and scroll stability by the browser's native scroll anchoring
  // (`overflow-anchor: auto`).
  reconcile(el, specs);
  // Switch-then-load: the row-click handler sets .transcript-loading
  // synchronously when flipping focus to a new chat. Clear it as soon
  // as the first non-empty render lands so the spinner disappears
  // when content arrives (whether from cache or server).
  if (specs.length > 0) el.classList.remove('transcript-loading');
  // Follow the tail while streaming: when a reply_delta grows the last
  // assistant bubble (an UPDATE, not a create — so per-bubble autoScroll
  // doesn't fire), keep the live edge in view. autoScroll() is a no-op
  // unless the user is pinned to the bottom, so a scrolled-up reader is
  // never yanked, and a mid-chat restore (which sets pinnedToBottom=false
  // and scrolls last) wins over this.
  autoScroll();
  scheduleSnapshotPersist();
}

// Re-export the public surface from neighboring modules so call sites
// only need to import from './transcript'.
export { project } from './projection.ts';
export { reconcile } from './reconciler.ts';
export * as store from './store.ts';
export type * from './types.ts';
