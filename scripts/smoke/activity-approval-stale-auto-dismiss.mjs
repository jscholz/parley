// Contract: a pending approval that's been
// untouched for the stale window (30 minutes in production) and has had
// no other chat activity should auto-resolve to 'dismissed' with status
// pill "Stale", so the tray doesn't accumulate stuck-pending approvals
// from sessions the user abandoned.
//
// The stale-check module exposes a small test seam:
//   - `window.__parleySetApprovalStaleMsForTest(N)` — override the
//     30-min threshold to N ms (debug-mode only; throws otherwise).
//   - `window.__parleyRunApprovalStaleCheckForTest()` — run the check
//     synchronously (the production path runs it on a slow interval).
// This lets the smoke complete in seconds instead of waiting 30 minutes.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-stale-auto-dismiss';
export const DESCRIPTION = 'an approval older than the stale window with no chat activity auto-resolves to dismissed (status pill "Stale")';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-stale-viewed';
const APPROVAL_CHAT = 'mock-stale-approval';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_st_view_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(APPROVAL_CHAT, {
    title: 'Stale approval source',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_st_app_seed', timestamp: t0 }],
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

  // Shrink the stale window to 300ms so the test takes ~1s, not 30 min.
  // Throws if the test seam isn't wired (debug-mode requirement
  // enforced by the impl).
  await page.evaluate(() => {
    const fn = window.__parleySetApprovalStaleMsForTest;
    if (typeof fn !== 'function') throw new Error('__parleySetApprovalStaleMsForTest not exposed');
    fn(300);
  });

  const approvalId = 'notif_stale_1';
  mock.pushEnvelope({
    type: 'notification',
    chat_id: APPROVAL_CHAT,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf parley-stale\n\n' +
      'Reason: stale auto-dismiss\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    parley_id: approvalId,
    urgent: true,
  });

  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${approvalId}"] .activity-item-actions button`,
    { timeout: 3_000 },
  );
  log('approval landed pending ✓');

  // No further activity in the approval chat. Wait past the stale window,
  // then trigger the check (production runs this on a slow interval; we
  // trigger it manually so the smoke is deterministic).
  await page.waitForTimeout(450);
  await page.evaluate(() => {
    const fn = window.__parleyRunApprovalStaleCheckForTest;
    if (typeof fn !== 'function') throw new Error('__parleyRunApprovalStaleCheckForTest not exposed');
    fn();
  });

  await page.waitForFunction(
    (id) => {
      const li = document.querySelector(
        `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
      );
      return !!li && li.classList.contains('activity-resolved');
    },
    approvalId, { timeout: 3_000, polling: 80 },
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
      // Aging happens in place — the buttons must be gone.
      buttonCount: li.querySelectorAll('.activity-item-actions button').length,
    };
  }, approvalId);
  assert(state.present && state.resolved,
    'stale approval must stay in tray and become resolved (kept-with-pill, not deleted)');
  assert(state.stateResolution === 'stale',
    `expected resolution='stale' (the dedicated enum value, distinct from agent-moved-on 'dismissed'), got "${state.stateResolution}"`);
  assert(/^\s*Stale\s*$/i.test(state.stateText),
    `expected stale pill text "Stale" (distinct from user "Dismissed" / agent-moved-on "Dismissed"), got "${state.stateText}"`);
  assert(state.buttonCount === 0, 'stale-resolved approval must have no action buttons');
  log('stale approval auto-resolved with pill "Stale" ✓');

  // Activity in the chat AFTER stale-resolution should NOT re-promote
  // it to pending (sanity: resolution is sticky, the row only ages
  // OUT of pending, never back in).
  mock.pushEnvelope({
    type: 'reply_delta', chat_id: APPROVAL_CHAT, message_id: 'msg_post_stale',
    text: 'late activity',
  });
  mock.pushEnvelope({ type: 'reply_final', chat_id: APPROVAL_CHAT, message_id: 'msg_post_stale' });
  await page.waitForTimeout(200);
  const stillResolved = await page.evaluate((id) => {
    const li = document.querySelector(
      `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
    );
    return !!li && li.classList.contains('activity-resolved');
  }, approvalId);
  assert(stillResolved, 'stale-resolved approval must NOT flip back to pending on subsequent chat activity');
  log('resolution sticky across post-resolve activity ✓');
}
