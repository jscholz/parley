// Contract: an approval row in the Activity tray must SURVIVE every
// "⏳ Still working… iteration N/60" reply_final the agent emits
// during a long autonomous turn. Regression guard: an approval landed
// correctly but disappeared from the tray seconds later because
// `handleReplyFinal` (main.ts:4419) calls
// `dismissApprovalsForChat(conversation)` on every `reply_final`,
// including heartbeats — even though the approval is still pending.
//
// Push an approval, then push several heartbeat
// reply_finals for the same chat, and assert the activity row stays put
// (still present, kind=approval, !resolved). Sibling commit 80ced31
// taught the push gate to skip heartbeats via `isProgressHeartbeat`; this
// is the matching guard on the activity-store path.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-survives-heartbeat';
export const DESCRIPTION = 'a pending approval row survives "Still working…" heartbeat reply_finals (must not be auto-dismissed)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

// Source chat = NOT the viewed chat (mirrors the field repro: the
// approval was for an off-screen autonomous turn). Bug is on the
// activity-store path and is independent of viewed/focused state, so
// either layout repros it; keeping off-screen matches the real case.
const VIEWED_CHAT = 'mock-heartbeat-viewed';
const APPROVAL_CHAT = 'mock-heartbeat-approval';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_hb_view_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(APPROVAL_CHAT, {
    title: 'Approval source',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_hb_app_seed', timestamp: t0 }],
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
  mock.pushEnvelope({
    type: 'notification',
    chat_id: APPROVAL_CHAT,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf parley-heartbeat-survives\n\n' +
      'Reason: heartbeat regression guard\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    parley_id: 'notif_hb_approval_1',
    urgent: true,
  });
  await page.waitForFunction(
    () => {
      const badge = document.getElementById('activity-drawer-count-rail');
      return !!badge && !badge.hidden && (badge.textContent || '').trim() === '1';
    },
    null, { timeout: 3_000, polling: 50 },
  );
  log('approval landed in tray (count badge = 1) ✓');

  // 2. Open the tray and capture the activity row id.
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector(
    '#activity-drawer-panel:not([hidden]) .activity-drawer-item.activity-approval',
    { timeout: 3_000 },
  );
  const initialId = await page.evaluate(() => {
    const li = document.querySelector(
      '#activity-drawer-panel .activity-drawer-item.activity-approval',
    );
    return li?.getAttribute('data-activity-id') || null;
  });
  assert(initialId, 'expected an approval activity row immediately after the notification');
  log(`approval row id = ${initialId}`);

  // 3. Push several heartbeat reply_finals for the SAME chat. These are
  //    the canonical shape the agent emits during a long autonomous turn
  //    and match `isProgressHeartbeat` in proxy/parley/notifications/
  //    dispatch.ts:271. Pre-fix, each one calls dismissApprovalsForChat
  //    → the approval row is deleted within ~50ms of the first heartbeat.
  for (let i = 1; i <= 4; i++) {
    const msgId = `msg_hb_${i}`;
    mock.pushEnvelope({
      type: 'reply_delta',
      chat_id: APPROVAL_CHAT,
      message_id: msgId,
      text: `⏳ Still working… (${i * 3} min elapsed — iteration ${i * 4}/60, running: terminal)`,
    });
    mock.pushEnvelope({
      type: 'reply_final',
      chat_id: APPROVAL_CHAT,
      message_id: msgId,
    });
    await page.waitForTimeout(150);
  }

  // 4. Approval row MUST still be present, with the SAME id, unresolved.
  const after = await page.evaluate((id) => {
    const li = document.querySelector(
      `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
    );
    if (!li) return { present: false };
    return {
      present: true,
      resolved: li.classList.contains('activity-resolved'),
      isApproval: li.classList.contains('activity-approval'),
      hasButtons: !!li.querySelector('.activity-item-actions button'),
    };
  }, initialId);
  assert(after.present,
    `approval row ${initialId} was DELETED after heartbeats — heartbeat-induced dismissApprovalsForChat regression. ` +
    `handleReplyFinal must skip heartbeats (mirror isProgressHeartbeat gate from the push path, dispatch.ts:271).`);
  assert(after.isApproval && !after.resolved && after.hasButtons,
    `approval row present but state is wrong: isApproval=${after.isApproval} resolved=${after.resolved} hasButtons=${after.hasButtons} — heartbeat must not change resolution state`);

  // 5. Count badge still 1 (unresolved-approval count holds across heartbeats).
  const badgeOk = await page.evaluate(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !!b && !b.hidden && (b.textContent || '').trim() === '1';
  });
  assert(badgeOk, 'unresolved-approval badge dropped after heartbeats — must hold at 1 until user-actioned or agent moves on with a REAL reply');

  log('approval survived 4 heartbeat reply_finals ✓');
}
