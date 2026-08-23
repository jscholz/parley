// Activity tray v1: approvals are recoverable after the transient banner.
//
// Verifies the right drawer is now a two-module host:
//   - off-screen approval notification lands in Activity
//   - collapsed Activity rail shows its own badge
//   - Activity item keeps action buttons
//   - action sends the exact slash command into the source chat

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-tray';
export const DESCRIPTION = 'off-screen approval persists in Activity tray and actions send slash commands';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-chat-activity-viewed';
const APPROVAL_CHAT = 'mock-chat-activity-approval';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Activity Viewed',
    messages: [
      { role: 'user', content: 'viewed seed', parley_id: 'umsg_activity_viewed_seed', timestamp: t0 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(APPROVAL_CHAT, {
    title: 'Approval Source',
    messages: [
      { role: 'user', content: 'approval seed', parley_id: 'umsg_activity_approval_seed', timestamp: t0 },
    ],
    lastActiveAt: Date.now() - 5000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, VIEWED_CHAT);
  await page.waitForFunction(
    () => /viewed seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );

  mock.pushEnvelope({
    type: 'notification',
    chat_id: APPROVAL_CHAT,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf parley-activity-approval\n\n' +
      'Reason: activity tray smoke\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    parley_id: 'notif_activity_approval_1',
    urgent: true,
  });

  await page.waitForFunction(
    () => {
      const badge = document.getElementById('activity-drawer-count-rail');
      return !!badge && !badge.hidden && (badge.textContent || '').trim() === '1';
    },
    null,
    { timeout: 3_000, polling: 50 },
  );
  log('activity rail badge showed approval count ✓');

  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector('#activity-drawer-panel:not([hidden]) .activity-drawer-item', { timeout: 3_000 });
  const tray = await page.evaluate(() => ({
    title: document.getElementById('right-drawer-title')?.textContent || '',
    text: document.getElementById('activity-drawer-panel')?.textContent || '',
    pinsHidden: document.getElementById('pin-drawer-panel')?.hasAttribute('hidden') || false,
  }));
  assert(tray.title === 'Activity', `expected Activity title, got ${tray.title}`);
  assert(tray.pinsHidden, 'expected Pins panel hidden when Activity is selected');
  assert(tray.text.includes('Approval required'), 'approval title missing from Activity tray');
  assert(tray.text.includes('activity tray smoke'), 'approval preview missing from Activity tray');
  assert(tray.text.includes('Approve') && tray.text.includes('Session') && tray.text.includes('Deny'),
    'approval actions missing from Activity tray');
  log('activity tray rendered approval item + actions ✓');

  await page.locator('#activity-drawer-panel .activity-item-actions button', { hasText: 'Deny' }).click();
  // Wait for /deny in the transcript AND for the user_message echo's
  // round-trip to fire resolveApprovalsForChat (the row carries .activity-
  // resolved). The bare /deny appears instantly from the optimistic
  // addPendingSend; the resolution only lands after the mock's
  // user_message echo round-trips back through handleUserMessage.
  await page.waitForFunction(
    () => /\/deny/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 5_000, polling: 100 },
  );
  await page.waitForFunction(
    () => !!document.querySelector(
      '#activity-drawer-panel .activity-drawer-item.activity-approval.activity-resolved',
    ),
    null,
    { timeout: 5_000, polling: 80 },
  );
  const after = await page.evaluate(() => ({
    transcript: document.getElementById('transcript')?.textContent || '',
    activity: document.getElementById('activity-drawer-panel')?.textContent || '',
    badgeHidden: document.getElementById('activity-drawer-count-rail')?.hidden ?? true,
  }));
  assert(after.transcript.includes('/deny'), 'Deny action did not send /deny into the approval chat');
  // 2026-05-28: reversed a3177a3's "delete on action" tightening. The
  // approval row now STAYS in the tray after Approve/Session/Deny with
  // a clear-at-a-glance outcome pill (✓ Approved / ✗ Denied / etc.) so
  // the user has an audit trail of "what I decided, and when."
  assert(after.activity.includes('activity tray smoke'),
    'Deny must KEEP the approval row in the tray (resolved, with outcome pill) — not delete it');
  assert(/✗\s*Denied/.test(after.activity),
    'Deny must surface the "✗ Denied" outcome pill on the resolved row');
  const noPendingButtons = await page.evaluate(() => {
    const li = document.querySelector('#activity-drawer-panel .activity-drawer-item.activity-approval.activity-resolved');
    return li ? li.querySelectorAll('.activity-item-actions button').length === 0 : false;
  });
  assert(noPendingButtons, 'resolved approval must have no Approve/Session/Deny buttons (decision is final)');
  // The unresolved-approval count clears (urgent gone). Total badge
  // visibility may depend on unread agent_reply etc., so check the
  // `urgent` class which directly reflects unresolvedApprovalCount.
  const noUrgent = await page.evaluate(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !!b && !b.classList.contains('urgent');
  });
  assert(noUrgent, 'unresolved-approval urgent state must clear after Deny');
  log('Deny sent /deny and the row stays resolved with "✗ Denied" pill ✓');
}
