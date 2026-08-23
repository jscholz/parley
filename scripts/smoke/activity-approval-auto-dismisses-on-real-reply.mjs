// Contract: when a non-heartbeat reply_final
// lands for a chat that has a pending approval, the agent has
// effectively moved on — auto-resolve the approval to 'dismissed' so
// the tray reflects reality. Pairs with the heartbeat-survives smoke:
// HEARTBEAT reply_final → approval stays pending; REAL reply_final →
// approval resolves as 'dismissed' (status pill "Dismissed").
//
// The existing pruneSupersededApprovals (activityStore.ts:162) does the
// same thing but only at applyServerSnapshot time. This smoke pins the
// PER-EVENT path: as soon as a real reply lands, the approval auto-
// resolves, no snapshot wait required.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-auto-dismisses-on-real-reply';
export const DESCRIPTION = 'a pending approval auto-resolves to dismissed when a real (non-heartbeat) reply_final arrives for the same chat';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-autodismiss-viewed';
const APPROVAL_CHAT = 'mock-autodismiss-approval';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_ad_view_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(APPROVAL_CHAT, {
    title: 'Approval source',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_ad_app_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 5000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, VIEWED_CHAT);
  await page.waitForFunction(
    () => /seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000, polling: 50 },
  );

  // 1. Approval lands.
  const approvalId = 'notif_autodismiss_1';
  mock.pushEnvelope({
    type: 'notification',
    chat_id: APPROVAL_CHAT,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf parley-autodismiss\n\n' +
      'Reason: auto-dismiss on real reply\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    parley_id: approvalId,
    urgent: true,
  });
  await page.waitForFunction(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !!b && !b.hidden && (b.textContent || '').trim() === '1';
  }, null, { timeout: 3_000, polling: 50 });

  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${approvalId}"] .activity-item-actions button`,
    { timeout: 3_000 },
  );
  log('approval landed pending ✓');

  // 2. Push a REAL (non-heartbeat) reply_final for the approval chat.
  // This is the canonical "Command approved. The agent is resuming…"
  // shape OR any normal turn output — anything that does NOT match
  // isProgressHeartbeat. The agent has moved past the approval point.
  mock.pushEnvelope({
    type: 'reply_delta',
    chat_id: APPROVAL_CHAT,
    message_id: 'msg_real_reply',
    text: '✅ Command approved. The agent is resuming…',
  });
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: APPROVAL_CHAT,
    message_id: 'msg_real_reply',
  });

  // 3. Approval row must transition to resolved='dismissed' with the
  //    Dismissed pill, NO action buttons, and the unresolved-count badge
  //    must clear (this is the only approval).
  await page.waitForFunction(
    (id) => {
      const li = document.querySelector(
        `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
      );
      return !!li && li.classList.contains('activity-resolved');
    },
    approvalId, { timeout: 4_000, polling: 100 },
  );

  const state = await page.evaluate((id) => {
    const li = document.querySelector(
      `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
    );
    if (!li) return { present: false };
    const stateEl = li.querySelector('.activity-item-state');
    return {
      present: true,
      resolved: li.classList.contains('activity-resolved'),
      stateText: (stateEl?.textContent || '').trim(),
      stateResolution: stateEl?.getAttribute('data-resolution') || '',
      buttonCount: li.querySelectorAll('.activity-item-actions button').length,
    };
  }, approvalId);
  assert(state.present, 'approval row must STAY in the tray (resolved, not deleted) after a real reply');
  assert(state.resolved, 'approval must have .activity-resolved after a real reply');
  assert(state.stateResolution === 'dismissed',
    `expected resolution=dismissed (agent moved on), got "${state.stateResolution}"`);
  assert(/^\s*Dismissed\s*$/i.test(state.stateText),
    `expected state pill "Dismissed", got "${state.stateText}"`);
  assert(state.buttonCount === 0,
    'resolved approval must have no action buttons');

  // The total badge count may still be > 0 because the same reply_final
  // ALSO creates an agent_reply Activity item (unread). What MUST clear
  // is the URGENT state — the badge stops being "you have a pending
  // approval" red. Verified via the `.urgent` class that
  // refreshActivityCountBanner toggles based on unresolvedApprovalCount.
  await page.waitForFunction(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !!b && !b.classList.contains('urgent');
  }, null, { timeout: 2_000, polling: 60 }).catch(() => { /* surface via assert below */ });
  const urgentCleared = await page.evaluate(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !!b && !b.classList.contains('urgent');
  });
  assert(urgentCleared, 'badge must lose the .urgent class once the only approval auto-resolves (total count can stay if the same reply added an agent_reply)');
  log('real reply → approval auto-resolved to dismissed ✓');
}
