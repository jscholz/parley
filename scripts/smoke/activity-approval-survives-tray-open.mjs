// Field bug (2026-07-07): "approval notifications show up, but when I
// click on the pin bar to action it, they disappear" — opening the
// Activity tray to ACT on a pending approval resolved it to 'dismissed'
// while the agent was still blocked waiting on the decision.
//
// Root cause: during a long autonomous turn the hermes plugin persists
// the per-iteration "⏳ Still working…" progress heartbeats as
// agent_reply Activity rows server-side (_persist_activity_for_push —
// they were push-delivered, so they get a durable tray row). The
// PER-EVENT client path already knows heartbeats don't mean "agent
// moved on" (isProgressHeartbeatText gate in handleReplyFinal, pinned
// by activity-approval-survives-heartbeat) — but the SNAPSHOT-time
// pruneSupersededApprovals had no such gate. Opening the tray fires
// render → refreshFromServer → reconcile → prune, the snapshot contains
// a heartbeat row newer than the approval, and the prune dismissed the
// still-pending approval the moment the user came to action it.
//
// This smoke reproduces that exact sequence deterministically:
//   1. a pending approval lands (SSE notification) → urgent rail badge
//   2. a NEWER heartbeat agent_reply row is seeded into the SERVER
//      activity store (simulating the plugin's push writethrough)
//   3. the user clicks the Activity rail button (the field action)
//   4. the approval row must STILL be pending + actionable after the
//      snapshot applies — and again after closing + reopening the tray.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-survives-tray-open';
export const DESCRIPTION = 'opening the Activity tray during heartbeat traffic must not dismiss a pending approval';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-trayopen-viewed';
const APPROVAL_CHAT = 'mock-trayopen-approval';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed',
    messages: [{ role: 'user', content: 'viewed seed', sidekick_id: 'umsg_to_view_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(APPROVAL_CHAT, {
    title: 'Approval source',
    messages: [{ role: 'user', content: 'approval seed', sidekick_id: 'umsg_to_app_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 5000,
  });
}

/** The pending approval must be present, unresolved, and carry all three
 *  inline action buttons. Returns a diagnostic snapshot for assert msgs. */
async function approvalState(page, approvalId) {
  return page.evaluate((id) => {
    const li = document.querySelector(
      `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
    );
    if (!li) return { present: false };
    return {
      present: true,
      resolved: li.classList.contains('activity-resolved'),
      buttons: Array.from(li.querySelectorAll('.activity-item-actions button'))
        .map((b) => b.textContent),
      state: li.querySelector('.activity-item-read-state')?.textContent || '',
      pill: li.querySelector('.activity-item-state')?.textContent || '',
    };
  }, approvalId);
}

function assertPending(st, phase) {
  assert(st.present, `${phase}: approval row vanished from the Activity tray`);
  assert(!st.resolved,
    `${phase}: approval was resolved by merely viewing the tray (pill: "${st.pill}") — agent is still blocked`);
  assert(st.buttons.length === 3,
    `${phase}: approval lost its action buttons (got: ${JSON.stringify(st.buttons)})`);
  assert(st.state === 'Action needed', `${phase}: expected "Action needed", got "${st.state}"`);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, VIEWED_CHAT);
  await page.waitForFunction(
    () => /viewed seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000, polling: 50 },
  );

  // 1. Pending approval lands for the off-screen chat.
  const approvalId = 'notif_trayopen_1';
  mock.pushEnvelope({
    type: 'notification',
    chat_id: APPROVAL_CHAT,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf sidekick-trayopen\n\n' +
      'Reason: tray open must not dismiss\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    sidekick_id: approvalId,
    urgent: true,
  });
  await page.waitForFunction(
    () => {
      const badge = document.getElementById('activity-drawer-count-rail');
      return !!badge && !badge.hidden && badge.classList.contains('urgent');
    },
    null, { timeout: 3_000, polling: 50 },
  );
  // The tray row's fire-and-forget POST must land server-side before we
  // seed the heartbeat, so the snapshot the tray-open fetches contains
  // BOTH rows (the field shape).
  const deadline = Date.now() + 3_000;
  while (!mock.activityItems().some((it) => it.id === approvalId)) {
    assert(Date.now() < deadline, 'approval POST never reached the mock activity store');
    await new Promise((r) => setTimeout(r, 50));
  }
  log('pending approval landed (badge urgent + server row) ✓');

  // 2. Plugin-persisted heartbeat row, NEWER than the approval. This is
  //    verbatim the field shape (sidekick.db activity_items, 2026-07-07):
  //    push-delivered "⏳ Still working…" beats written as agent_reply
  //    rows while the approval sat pending in the same chat.
  mock.seedActivity({
    id: 'msg_trayopen_heartbeat_1',
    chat_id: APPROVAL_CHAT,
    kind: 'agent_reply',
    title: 'Agent reply',
    body: '⏳ Still working... (15 min elapsed — iteration 38/60, running: terminal)',
    created_at: Date.now() / 1000 + 1,
    urgent: false,
    read: true,
  });

  // 3. The field action: click the Activity rail button to go action the
  //    approval. This fires render → refreshFromServer → reconcile/prune.
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector('#activity-drawer-panel:not([hidden])', { timeout: 3_000 });
  // Wait for the snapshot (which contains the heartbeat row) to apply —
  // the heartbeat's tray row appearing proves the refresh round-tripped,
  // so the prune has definitely run by the time we assert.
  await page.waitForFunction(
    () => /Still working/.test(document.getElementById('activity-drawer-panel')?.textContent || ''),
    null, { timeout: 5_000, polling: 50 },
  );
  assertPending(await approvalState(page, approvalId), 'after tray open');
  log('approval still pending + actionable after opening the tray ✓');

  // 4. Close + reopen (rail button toggles when the module is active) —
  //    a second snapshot apply must not dismiss it either.
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector('#pin-drawer.collapsed', { timeout: 3_000 });
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector('#activity-drawer-panel:not([hidden])', { timeout: 3_000 });
  await page.waitForFunction(
    () => /Still working/.test(document.getElementById('activity-drawer-panel')?.textContent || ''),
    null, { timeout: 5_000, polling: 50 },
  );
  assertPending(await approvalState(page, approvalId), 'after close + reopen');

  // The server row must still be unresolved too — the prune's dismissal
  // POSTs /resolve, which would permanently decide the approval for every
  // device (that's what made the field bug sticky).
  const serverRow = mock.activityItems().find((it) => it.id === approvalId);
  assert(serverRow && !serverRow.resolved,
    `server activity row was resolved by tray-open (resolved=${serverRow?.resolved})`);
  log('approval survives close + reopen, server row still pending ✓');
}
