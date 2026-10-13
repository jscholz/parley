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
import { markUnread as markChatUnread } from './notifications/badge.ts';
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
