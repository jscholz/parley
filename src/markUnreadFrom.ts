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
 *  so the line marks where you left off until you act: a tap/click in
 *  the transcript (not on the message menu — its "Mark unread" sets the
 *  line), sending a message (store.addPendingSend), or leaving the chat.
 *  Scrolling and reading keep it. */
export function installUnreadDividerRetire(transcriptEl: HTMLElement, viewedChat: () => string | null): void {
  // Replying in a chat you'd marked unread means you've read it.
  window.addEventListener('parley:user-send', (e) => {
    const chatId = (e as CustomEvent<{ chatId?: string }>).detail?.chatId;
    if (chatId && unreadFor(chatId) > 0) void clearUnread(chatId);
  });
  transcriptEl.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('.msg-menu, .msg-caret, .play-bar')) return;
    const chatId = viewedChat();
    if (!chatId) return;
    if (transcriptStore.peekState(chatId)?.unreadFrom == null) return;
    transcriptStore.setUnreadFrom(chatId, null);
  });
}
