// Regression: a freshly-arrived PENDING approval must stay visible +
// ACTIONABLE in the Activity tray even if a server refresh races in
// before the server snapshot knows about it.
//
// Field bug (2026-06-06): the pending approval did not surface in the
// activity bar quickly enough for the user to tap inline Approve/Deny —
// by the time it appeared it was already resolved. Root cause is a
// clobber race in activityStore.refreshFromServer: a pending approval is
// added to the local store SYNCHRONOUSLY by upsertNotification, but its
// POST to /api/parley/activity is fire-and-forget. The server ALSO
// emits an `activity_changed` cross-device sync the moment it records the
// approval, which fires refreshFromServer. If that GET races ahead of our
// own POST (or the server's own write), the snapshot lacks the approval —
// and the wholesale `itemsById.clear()` wiped the pending/actionable row
// out from under the user. It only reappeared later, by then resolved.
//
// This smoke reproduces the race deterministically: land a pending
// approval (SSE notification), confirm the actionable row, then force a
// refreshFromServer against an EMPTY server snapshot and assert the
// pending row + inline action buttons SURVIVE.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-survives-server-refresh-race';
export const DESCRIPTION = 'a pending approval stays visible + actionable when a server refresh races in before the snapshot has it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-refreshrace-viewed';
const APPROVAL_CHAT = 'mock-refreshrace-approval';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed',
    messages: [{ role: 'user', content: 'seed', sidekick_id: 'umsg_rr_view_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(APPROVAL_CHAT, {
    title: 'Approval source',
    messages: [{ role: 'user', content: 'seed', sidekick_id: 'umsg_rr_app_seed', timestamp: t0 }],
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

  // 1. A pending approval lands via the push/notification channel.
  const approvalId = 'notif_refreshrace_1';
  mock.pushEnvelope({
    type: 'notification',
    chat_id: APPROVAL_CHAT,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf parley-refresh-race\n\n' +
      'Reason: refresh-race smoke\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    sidekick_id: approvalId,
    urgent: true,
  });
  await page.waitForFunction(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !!b && !b.hidden && (b.textContent || '').trim() === '1';
  }, null, { timeout: 3_000, polling: 50 });

  // 2. Open the tray and confirm the pending approval is ACTIONABLE
  //    (inline Approve/Session/Deny buttons present, not resolved).
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${approvalId}"] .activity-item-actions button`,
    { timeout: 3_000 },
  );
  log('approval landed pending + actionable ✓');

  // 3. Force the race: a server refresh whose snapshot does NOT yet
  //    contain the just-arrived approval (the server hasn't recorded our
  //    fire-and-forget POST yet). We override the GET to return an empty
  //    snapshot, then directly drive refreshFromServer() and AWAIT it so
  //    the assertion is deterministic (no reliance on debounce/render
  //    timing). Playwright routes are LIFO, so this override (added after
  //    the mock's route) wins.
  await page.route(/.*\/api\/parley\/activity(\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
      return;
    }
    return route.fallback();
  });
  await page.evaluate(async () => {
    const store = await import('/build/notifications/activityStore.mjs');
    // The same path the proxy's `activity_changed` cross-device sync
    // takes when the server records the approval: refreshFromServer()
    // against the (not-yet-caught-up) server snapshot.
    await store.refreshFromServer();
  });

  // 4. The pending approval row + its inline action buttons MUST survive
  //    the empty-snapshot refresh. Pre-fix: refreshFromServer's
  //    itemsById.clear() wiped the row (badge → 0, buttons gone) until a
  //    later refresh — by which point the field bug had the user staring
  //    at a vanished/already-resolved approval.
  await page.waitForFunction(
    (id) => {
      const b = document.getElementById('activity-drawer-count-rail');
      const urgentBadge = !!b && !b.hidden && b.classList.contains('urgent')
        && (b.textContent || '').trim() === '1';
      const li = document.querySelector(
        `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
      );
      const actionable = !!li
        && !li.classList.contains('activity-resolved')
        && li.querySelectorAll('.activity-item-actions button').length === 3;
      return urgentBadge && actionable;
    },
    approvalId,
    { timeout: 3_000, polling: 60 },
  ).catch(() => { /* surface via the explicit assert below for a clear message */ });

  const state = await page.evaluate((id) => {
    const b = document.getElementById('activity-drawer-count-rail');
    const li = document.querySelector(
      `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
    );
    return {
      badgeText: (b?.textContent || '').trim(),
      badgeUrgent: !!b && b.classList.contains('urgent'),
      badgeHidden: b?.hidden ?? true,
      rowPresent: !!li,
      rowResolved: !!li && li.classList.contains('activity-resolved'),
      buttonCount: li ? li.querySelectorAll('.activity-item-actions button').length : 0,
    };
  }, approvalId);

  assert(state.rowPresent,
    'pending approval row was WIPED by the racing server refresh — must survive until the server snapshot catches up');
  assert(!state.rowResolved,
    'pending approval must stay UNRESOLVED (actionable) through the refresh race — not flicker to a resolved state');
  assert(state.buttonCount === 3,
    `pending approval must keep its inline Approve/Session/Deny buttons through the refresh race (got ${state.buttonCount})`);
  assert(!state.badgeHidden && state.badgeUrgent && state.badgeText === '1',
    `urgent approval badge must stay lit at 1 through the refresh race (hidden=${state.badgeHidden} urgent=${state.badgeUrgent} text="${state.badgeText}")`);
  log('pending approval survived the racing server refresh — still visible + actionable ✓');
}
