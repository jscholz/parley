// Contract: when an approval is actioned —
// whether by clicking Approve/Session/Deny in the Activity tray, or by
// typing /approve, /approve session, /deny in the chat — the approval
// row STAYS in the tray with a clear-at-a-glance outcome pill
// ("✓ Approved", "✓ Approved (session)", "✗ Denied"). It does NOT
// disappear from the tray. The unresolved-approval badge drops because
// it is now resolved; the row sorts to its chronological position (no
// longer floating at top under the unresolved-approval clause).
//
// This reverses the a3177a3 (2026-05-22) "delete on action" tightening:
// post-redesign the model owns resolution outcomes (`ActivityResolution
// = 'approved' | 'approved_session' | 'denied' | 'dismissed'`), and the
// user-visible history of "what did I approve / when" stays in the
// Activity buffer with the same eviction policy as other items.
//
// Sub-cases in one smoke:
//   1. Tray Approve button → resolved='approved', pill "✓ Approved".
//   2. Composer /deny           → resolved='denied',   pill "✗ Denied".

import { waitForReady, openSidebar, clickRow, send, assert } from './lib.mjs';

export const NAME = 'activity-approval-resolves-with-outcome';
export const DESCRIPTION = 'actioning an approval (tray button or composer command) marks it resolved with an outcome pill and keeps the row visible';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-approval-resolves';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Approval resolution chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_ar_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

function approvalEnvelope(parleyId, reason) {
  return {
    type: 'notification',
    chat_id: CHAT_ID,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      `printf ${parleyId}\n\n` +
      `Reason: ${reason}\n` +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    parley_id: parleyId,
    urgent: true,
  };
}

async function inspectApproval(page, approvalId) {
  return page.evaluate((id) => {
    const li = document.querySelector(
      `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
    );
    if (!li) return { present: false };
    const stateEl = li.querySelector('.activity-item-state');
    return {
      present: true,
      isApproval: li.classList.contains('activity-approval'),
      resolved: li.classList.contains('activity-resolved'),
      // Resolution outcome surfaced via the dedicated state element.
      // The exact display text is the "clear-at-a-glance" assertion.
      stateText: (stateEl?.textContent || '').trim(),
      stateResolution: stateEl?.getAttribute('data-resolution') || '',
      // Action buttons must be HIDDEN once resolved (they're meaningless
      // post-decision and would let the user re-fire /approve in a
      // resolved chat).
      buttonCount: li.querySelectorAll('.activity-item-actions button').length,
    };
  }, approvalId);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000, polling: 50 },
  );

  // Open the Activity tray once; it stays open for both sub-cases.
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector('#activity-drawer-panel:not([hidden])', { timeout: 3_000 });

  // ─── Sub-case 1: tray Approve button → resolved='approved' ───────────
  const id1 = 'notif_ar_approve_btn';
  mock.pushEnvelope(approvalEnvelope(id1, 'tray button case'));
  await page.waitForSelector(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id1}"] .activity-item-actions button`,
    { timeout: 3_000 },
  );

  // Click "Approve" in the tray row. Pre-fix the handler also locally
  // dismissed the row (a3177a3); post-fix it only sends /approve, and
  // the backendEvents user_message echo path marks the row resolved.
  await page.locator(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id1}"] .activity-item-actions button`,
    { hasText: 'Approve' },
  ).first().click();

  // Wait for /approve to land in the transcript (the action handler
  // sends it via the composer) AND the activity row to flip to resolved.
  await page.waitForFunction(
    (id) => {
      const li = document.querySelector(
        `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
      );
      return !!li && li.classList.contains('activity-resolved');
    },
    id1, { timeout: 5_000, polling: 100 },
  );

  const after1 = await inspectApproval(page, id1);
  assert(after1.present, `approval ${id1} must NOT be deleted on Approve — must stay in tray as resolved (a3177a3 reversed)`);
  assert(after1.resolved, `approval ${id1} must carry .activity-resolved after Approve`);
  assert(after1.buttonCount === 0, `resolved approval ${id1} must have NO action buttons (got ${after1.buttonCount})`);
  assert(after1.stateResolution === 'approved',
    `approval ${id1} stateResolution attr must be "approved", got "${after1.stateResolution}"`);
  assert(/^\s*✓\s*Approved\s*$/i.test(after1.stateText),
    `approval ${id1} state pill must read "✓ Approved" (clear-at-a-glance), got "${after1.stateText}"`);
  log(`tray Approve → resolved='approved' with pill "${after1.stateText}" ✓`);

  // ─── Sub-case 2: composer /deny → resolved='denied' ───────────────────
  const id2 = 'notif_ar_deny_composer';
  mock.pushEnvelope(approvalEnvelope(id2, 'composer command case'));
  await page.waitForSelector(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id2}"] .activity-item-actions button`,
    { timeout: 3_000 },
  );

  // Send /deny via the composer — the in-chat user-typed command path
  // (backendEvents.handleUserMessage matches the /^\s*\/(approve…|deny)/
  // regex). This must resolve ALL pending approvals for this chat.
  await send(page, '/deny');
  await page.waitForFunction(
    (id) => {
      const li = document.querySelector(
        `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
      );
      return !!li && li.classList.contains('activity-resolved');
    },
    id2, { timeout: 5_000, polling: 100 },
  );

  const after2 = await inspectApproval(page, id2);
  assert(after2.present && after2.resolved,
    `approval ${id2} must stay in tray + be resolved after composer /deny`);
  assert(after2.buttonCount === 0, `resolved approval ${id2} must have NO action buttons`);
  assert(after2.stateResolution === 'denied',
    `approval ${id2} stateResolution attr must be "denied", got "${after2.stateResolution}"`);
  assert(/^\s*✗\s*Denied\s*$/i.test(after2.stateText),
    `approval ${id2} state pill must read "✗ Denied", got "${after2.stateText}"`);
  log(`composer /deny → resolved='denied' with pill "${after2.stateText}" ✓`);

  // ─── Final: unresolved-approval badge has dropped to 0 (both resolved).
  const badgeHidden = await page.evaluate(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !b || b.hidden || (b.textContent || '').trim() === '' || (b.textContent || '').trim() === '0';
  });
  assert(badgeHidden,
    'unresolved-approval count badge must be cleared once every approval in the tray is resolved');
  log('unresolved-approval badge cleared after both resolutions ✓');
}
