/**
 * @fileoverview "Mark unread from here" (2026-10-13, Slack-style). One
 * action shared by the message menu's "Mark unread" and the U key in
 * keyboard highlight mode:
 *   - the chat goes unread with its read pointer just before this
 *     message (badge.markUnread fromMs → plugin /v1/unread/mark from_ts),
 *     so the session list shows it unread and its count starts here;
 *   - the transcript draws the "New" divider above this message right
 *     away (transcriptStore.setUnreadFrom), and again whenever the chat
 *     is next opened while still unread;
 *   - agent replies and notifications also get their Activity-tray
 *     entry, as the menu action always did.
 */
import { markUnread as markChatUnread, clearUnread, unreadFor } from './notifications/badge.ts';
import { markUnreadForMessage } from './notifications/activityStore.ts';
import * as transcriptStore from './transcript/store.ts';

export function markUnreadFromLine(line: HTMLElement, chatId: string | null): boolean {
  const msgId = line.dataset.messageId || '';
  if (!chatId || !msgId) return false;
  const ts = Number(line.dataset.ts) || Date.now();
  const isNotification = line.classList.contains('notification');
  const isAgent = line.classList.contains('agent');
  if (isAgent || isNotification) {
    const liveText = line.dataset.text
      || (line.querySelector('.text') as HTMLElement | null)?.textContent || '';
    const kind = line.classList.contains('notification-cron') ? 'cron'
      : isNotification ? 'notification' : 'agent_reply';
    markUnreadForMessage({ chatId, messageId: msgId, text: liveText.slice(0, 500), createdAt: ts, kind });
  }
  void markChatUnread(chatId, { fromMs: ts });
  transcriptStore.setUnreadFrom(chatId, ts - 1);
  return true;
}

/** Retire the "New" divider on the first deliberate interaction with the
 *  transcript (2026-10-13, field: "I'm reading the message and clicking
 *  on it, and neither makes it go away"). Slack keeps its line for the
 *  whole visit because people hop channels; here you stay in one chat,
 *  so the line marks where you left off until you act: a completed tap/click in
 *  the transcript (not on the message menu — its "Mark unread" sets the
 *  line), sending a message (store.addPendingSend), or leaving the chat.
 *  Scrolling and reading keep it. */
export function installUnreadDividerRetire(transcriptEl: HTMLElement, viewedChat: () => string | null): void {
  // Replying in a chat you'd marked unread means you've read it.
  window.addEventListener('parley:user-send', (e) => {
    const chatId = (e as CustomEvent<{ chatId?: string }>).detail?.chatId;
    if (chatId && unreadFor(chatId) > 0) void clearUnread(chatId);
  });
  // NOT pointerdown, and never synchronously (field 2026-10-14, laptop
  // "Aw, Snap!" twice): removing the divider row inside a REAL mouse-down
  // on message text — while Chrome is anchoring a text selection — shifts
  // the content under the press and kills the renderer (reproduced on the
  // live chat with a real click; synthetic events, a blocked handler, or a
  // divider already gone all survive). Retire after the click completes,
  // on the next task, so no layout change ever lands mid-gesture.
  transcriptEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('.msg-menu, .msg-caret, .play-bar')) return;
    const chatId = viewedChat();
    if (!chatId) return;
    if (transcriptStore.peekState(chatId)?.unreadFrom == null) return;
    setTimeout(() => transcriptStore.setUnreadFrom(chatId, null), 0);
  });
  installSeenRetire(transcriptEl, viewedChat);
}

/** How long the "New" line must be on screen, with the window focused,
 *  before it counts as seen and retires on its own. */
export const DIVIDER_SEEN_MS = 4000;

/** Retire the "New" line once it has actually been seen (field
 *  2026-10-16: "the 'new' marker here is stale — the thread was already
 *  read, and the badge is gone"). Seen = the line on screen, the page
 *  visible and focused, for DIVIDER_SEEN_MS. Never removes it while a
 *  pointer is pressed — removing it mid-press crashed Chrome (2026-10-14);
 *  a retirement that comes due during a press waits for the release. */
function installSeenRetire(transcriptEl: HTMLElement, viewedChat: () => string | null): void {
  if (typeof IntersectionObserver === 'undefined') return;
  let pressed = false;
  let pendingRetire = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onScreen = false;
  const retire = () => {
    const chatId = viewedChat();
    if (!chatId || transcriptStore.peekState(chatId)?.unreadFrom == null) return;
    if (pressed) { pendingRetire = true; return; }
    transcriptStore.setUnreadFrom(chatId, null);
  };
  const focused = () => (typeof document === 'undefined')
    || (document.visibilityState === 'visible' && (typeof document.hasFocus !== 'function' || document.hasFocus()));
  const arm = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (onScreen && focused()) timer = setTimeout(() => { timer = null; if (onScreen && focused()) retire(); else arm(); }, DIVIDER_SEEN_MS);
  };
  const io = new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    arm();
  }, { root: transcriptEl, threshold: 0.5 });
  let watched: Element | null = null;
  const rewatch = () => {
    const d = transcriptEl.querySelector('.unread-divider');
    if (d === watched) return;
    if (watched) io.unobserve(watched);
    watched = d;
    onScreen = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (d) io.observe(d);
  };
  new MutationObserver(rewatch).observe(transcriptEl, { childList: true });
  document.addEventListener('pointerdown', () => { pressed = true; }, true);
  const release = () => {
    pressed = false;
    if (pendingRetire) { pendingRetire = false; setTimeout(retire, 0); }
  };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  window.addEventListener('focus', arm);
  window.addEventListener('blur', arm);
  document.addEventListener('visibilitychange', arm);
}
