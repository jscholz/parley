// Contract: a resolved approval — and its outcome — must survive a
// PWA reload. The row must still say "✓ Approved" with the same chat
// link, not a stale "Action needed" or a vanished row. Tests the
// persist path: activityStore writes resolution state and the next
// hydrate reads it back intact.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-resolution-survives-reload';
export const DESCRIPTION = 'a resolved approval keeps its outcome pill across a PWA reload (persistence)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-reload-survives-approval';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Reload approval chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_rs_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000, polling: 50 },
  );

  // Land approval + click Approve in the tray. (Composer path is
  // covered by activity-approval-resolves-with-outcome; here we want a
  // single resolved row to survive the reload.)
  const approvalId = 'notif_reload_survives';
  mock.pushEnvelope({
    type: 'notification',
    chat_id: CHAT_ID,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf parley-reload-survives\n\n' +
      'Reason: reload survives smoke\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    parley_id: approvalId,
    urgent: true,
  });
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${approvalId}"] .activity-item-actions button`,
    { timeout: 3_000 },
  );
  await page.locator(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${approvalId}"] .activity-item-actions button`,
    { hasText: 'Approve' },
  ).first().click();
  await page.waitForFunction(
    (id) => {
      const li = document.querySelector(
        `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
      );
      return !!li && li.classList.contains('activity-resolved');
    },
    approvalId, { timeout: 5_000, polling: 100 },
  );
  log('approval resolved=approved before reload ✓');

  // Reload. The activityStore must rehydrate the resolved approval from
  // its persistent store (IDB / server / wherever it lives) and the
  // tray row must come back resolved + pilled. NOT pending, NOT gone.
  await page.waitForTimeout(300); // give any debounced persist a beat to flush
  await page.reload();
  await waitForReady(page);
  // Open the activity tray again — it doesn't open by default after a
  // reload; the resolved item must be present once we navigate to it.
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${approvalId}"]`,
    { timeout: 5_000 },
  );

  const after = await page.evaluate((id) => {
    const li = document.querySelector(
      `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
    );
    if (!li) return { present: false };
    const stateEl = li.querySelector('.activity-item-state');
    return {
      present: true,
      resolved: li.classList.contains('activity-resolved'),
      isApproval: li.classList.contains('activity-approval'),
      stateText: (stateEl?.textContent || '').trim(),
      stateResolution: stateEl?.getAttribute('data-resolution') || '',
      buttonCount: li.querySelectorAll('.activity-item-actions button').length,
    };
  }, approvalId);
  assert(after.present,
    `approval ${approvalId} must reappear in the tray after reload — resolution must persist, not be lost`);
  assert(after.isApproval && after.resolved,
    `after reload: isApproval=${after.isApproval} resolved=${after.resolved} — both must be true`);
  assert(after.stateResolution === 'approved',
    `after reload: stateResolution must be "approved", got "${after.stateResolution}"`);
  assert(/^\s*✓\s*Approved\s*$/i.test(after.stateText),
    `after reload: state pill must read "✓ Approved", got "${after.stateText}"`);
  assert(after.buttonCount === 0,
    'after reload, the resolved row must still have NO action buttons (no second /approve)');
  log('resolved approval state + pill survived reload ✓');
}
