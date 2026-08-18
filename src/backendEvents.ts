// Adapter-envelope handlers — the inbound side of the BackendAdapter
// contract.
//
// Scope intentionally narrow: only `handleNotification` and
// `handleUserMessage` live here today. The streaming-bubble cluster —
// `handleReplyDelta`, `handleReplyFinal`, `handleActivity`,
// `handleToolEvent`, plus the streaming-state helpers
// (`showStreamingIndicator`, `finalizeOldestPending`,
// `clearStreamingIndicator`, `pendingStreamingKey`, the idle timer)
// — remains in main.ts. Those handlers all share mutable streaming
// state that would need to move with them; pulling them piecemeal
// would scatter the state machine across two modules.
//
// `handleNotification` is the Web Push integration point — the
// off-screen branch will expand into "post an OS notification + set
// badge + wake the SW push handler." Keeping it here means that
// expansion lands as a focused diff rather than a ~200-line touch
// in main.ts.

import { log } from './util/log.ts';
import * as transcriptStore from './transcript/store.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as switchCtl from './switchController.ts';
import * as badge from './notifications/badge.ts';
import * as inAppBanner from './notifications/inAppBanner.ts';
import * as activityStore from './notifications/activityStore.ts';
import * as chat from './chat.ts';

/** Push notification handler — cron output, /background results,
 *  scheduled reminders. Backends that support out-of-band push (today:
 *  hermes-gateway via /api/parley/notifications) call this; others
 *  never fire it. For the currently-viewed chat: append a styled
 *  notification row matching the persisted transcript shape (so
 *  reload finds the same data-message-id and dedups). For off-screen
 *  chats: bump the badge counter. */
export function handleNotification({ chatId, kind, content, sidekickId, isReplay }: any): void {
  const replay = isReplay === true;
  // Normalize the incoming chat_id shape. Post-v0.383 chat_ids are
  // `sidekick:<uuid>`, but a producer can emit the bare uuid and the
  // focused/viewed id may be either form. Compare on the bare id, and when
  // this notification is for the chat that's currently on screen, adopt the
  // app's canonical id (focusedId) so EVERY downstream site keys
  // consistently — the tray upsert, the off-screen banner/badge gate, and
  // the in-chat transcript appendInflight. Without this, a notification for
  // the viewed chat with a mismatched prefix took the off-screen path
  // (spurious banner, #234) AND failed to render its in-chat row.
  const focusedAtEntry = switchCtl.focusedId();
  const bareId = (id: any) => (id == null ? '' : String(id).replace(/^parley:/, ''));
  if (chatId && focusedAtEntry && bareId(chatId) === bareId(focusedAtEntry)) {
    chatId = focusedAtEntry;
  }
  if (!replay && chatId && kind !== 'approval') {
    // Agent moved past the approval point with a different kind of
    // notification — mark resolved with outcome 'dismissed' (kept in
    // tray with a pill, not deleted).
    activityStore.resolveApprovalsForChat(chatId, 'dismissed');
  }
  // Project into the Activity store on BOTH live and replay envelopes.
  // Replay was previously skipped entirely, which silently dropped an
  // approval that arrived as a push while the app was closed: on the
  // next reconnect the approval only ever comes back as a replayed
  // envelope, so it never landed in the tray and the user couldn't find
  // it to act on later. The upsert is idempotent on sidekick_id and
  // preserves prior read/resolved state, so re-projecting a replayed row
  // is safe. The banner + badge bump below STAY replay-gated so a
  // reconnect doesn't re-alert; only the recoverable tray row is added.
  activityStore.upsertNotification({
    chatId: chatId || null,
    kind: kind || '',
    content: content || '',
    sidekickId: typeof sidekickId === 'string' ? sidekickId : null,
    urgent: kind === 'approval',
    chatLabel: sessionDrawer.getTitleForChat?.(chatId) || null,
  });
  // Off-screen chat — bump the app-icon badge so the user notices
  // there's a new event waiting in another chat. clearUnread fires
  // from sessionDrawer.setViewed when they switch in. The system
  // notification (OS-level) is dispatched separately by the proxy
  // (proxy/parley/notifications/dispatch.ts); this is the in-app
  // counterpart for badge state.
  if (chatId && chatId !== switchCtl.focusedId()) {
    if (replay) {
      log(`notification (off-screen replay) chat=${chatId} kind=${kind} — no badge/banner`);
      return;
    }
    badge.incrementUnread(chatId);
    // In-app banner — surface the notification at the top of the
    // viewport so the user actually notices it (the badge alone is
    // a "next time you scan the drawer" signal, not "look at me NOW").
    // Tap → drills into the chat + scrolls to the notification row.
    inAppBanner.show({
      chatId,
      kind: kind || '',
      content: content || '',
      sidekickId: typeof sidekickId === 'string' ? sidekickId : null,
      chatLabel: sessionDrawer.getTitleForChat?.(chatId) || undefined,
    });
    log(`notification (off-screen) chat=${chatId} kind=${kind} — badge++ + banner`);
    return;
  }
  // On-screen approvals: the focused chat doesn't get a badge bump (the
  // user is already looking at the chat) but DOES need the banner — an
  // approval blocks the agent until the user decides, so it's urgent
  // regardless of which chat is on screen. The transcript bubble + tray
  // row are not enough; the banner is the affordance with action buttons
  // that doesn't require opening the right drawer.
  if (!replay && chatId && kind === 'approval') {
    inAppBanner.show({
      chatId,
      kind: kind || '',
      content: content || '',
      sidekickId: typeof sidekickId === 'string' ? sidekickId : null,
      chatLabel: sessionDrawer.getTitleForChat?.(chatId) || undefined,
    });
  }
  // On-screen notification — push into the store. Projection renders
  // it via the reconciler's notification path; same shape as durable
  // rows that come back through /messages later (deduped via sidekick_id).
  let displayText = content || '';
  if (kind === 'cron') {
    // Strip the scheduler boilerplate so the in-chat row reads cleanly.
    const headerRe = /^Cronjob Response:\s*(.+?)\s*\n\(job_id:\s*([^)]+)\)\s*\n-+\s*\n+([\s\S]*?)(?:\n+To stop or manage this job[^\n]*\.?\s*)?$/;
    const match = headerRe.exec(displayText);
    if (match) {
      const taskName = match[1].trim();
      const agentBody = match[3].trim();
      displayText = `**${taskName}**\n\n${agentBody}`;
    }
  }
  if (chatId) {
    transcriptStore.appendInflight(chatId, {
      type: 'notification',
      chat_id: chatId,
      kind: kind || 'notification',
      content: displayText,
      sidekick_id: typeof sidekickId === 'string' ? sidekickId : undefined,
    });
    // Live notification landing in a scrolled-up viewport = one unread.
    // No sidekickId → no stable dedup key → skip (noteLiveMessage no-ops).
    if (!replay) chat.noteLiveMessage(chatId, typeof sidekickId === 'string' ? sidekickId : null);
    void badge.clearUnread(chatId);
  }
}

/** Cross-device user-message broadcast handler. The upstream emits a
 *  `user_message` envelope as soon as a /v1/responses POST lands —
 *  every connected device receives it, including the originator.
 *
 *  Dedup: the originating device pre-minted `messageId` for its
 *  optimistic bubble (see sendTypedMessage) and registered it in
 *  renderedMessages. The upsert below is idempotent on that key, so
 *  for the originator this is a no-op (entry exists; status doesn't
 *  change; text doesn't change). For every OTHER device the entry
 *  doesn't exist yet — upsert creates a fresh user bubble.
 *
 *  Off-screen filtering: like reply_delta, drop only when the
 *  conversation is explicitly different from the viewed one. When
 *  getViewed() is null (boot races), render — there's no on-screen
 *  session to protect. */
export function handleUserMessage({ conversation, text, messageId, isReplay }: any): void {
  if (!messageId || !conversation) return;
  // Defensive: empty text must not wipe an existing bubble. Production
  // envelopes always carry text; future metadata-only pings shouldn't
  // clobber the user's words.
  if (!text) {
    log(`user_message (empty text) chat=${conversation} msgId=${messageId} — skip to preserve existing bubble`);
    return;
  }
  // Push into the store unconditionally — background chats need to
  // know about the echo too so a switch-back finds the right state.
  transcriptStore.appendInflight(conversation, {
    type: 'user_message',
    chat_id: conversation,
    message_id: messageId,
    text,
  });
  // Unread badge: a CROSS-DEVICE user message is an unread; the
  // originator's own echo (matched by its pendingSend, cleared just
  // below) is not — they typed it. Replays (SSE reconnect re-emits
  // user_message envelopes) never count.
  const isOwnEcho = transcriptStore.getState(conversation).pendingSends
    .some(p => p.messageId === messageId);
  if (isReplay !== true && !isOwnEcho) chat.noteLiveMessage(conversation, String(messageId));
  // Clear the matching pendingSend on the originator — projection
  // dedups against inflight regardless, but cleaning up keeps the
  // store hygienic.
  transcriptStore.clearPendingSend(conversation, messageId);
  // User-typed approval decision in the chat — mirror the tray button
  // outcomes so the activity row resolves with the right pill regardless
  // of which surface the user actioned through.
  const cmd = /^\s*\/(deny|approve\s+session|approve\s+always|approve)\b/i.exec(text);
  if (cmd) {
    const verb = cmd[1].toLowerCase().replace(/\s+/g, ' ');
    const resolution =
      verb === 'deny' ? 'denied'
      : verb === 'approve session' ? 'approved_session'
      // /approve always carries a scope handled by hermes; for the
      // activity tray it's still a user "approved" decision.
      : 'approved';
    activityStore.resolveApprovalsForChat(conversation, resolution);
  }
}
