// Regression: an approval that the user never actioned (inline buttons
// never tapped) must still be RECOVERABLE in the Activity tray.
//
// Real-world trigger: the approval arrives as a Web Push while the app
// is closed. The user doesn't tap the inline approve/deny button. When
// they next open the app, the server replays the approval envelope with
// `_replay: true`. Before this fix, handleNotification's `if (!replay)`
// guard skipped `upsertNotification` for ALL replayed envelopes — so the
// replayed approval was NEVER projected into the activity store, and
// since the smoke/offline path has no server-side activity record to
// hydrate from, the approval vanished from the tray entirely. The user
// had to run /approve manually.
//
// Contract pinned here: a replayed approval (delivered ONLY as a replay,
// never live) still appears as an Activity item the user can find and
// act on later. We deliberately suppress the banner/badge-bump on replay
// (no re-alert spam on every reconnect) but the tray row must exist.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-replay-surfaces';
export const DESCRIPTION = 'an approval delivered only as a replay (never live, never tapped) still surfaces in the Activity tray';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-replay-viewed';
const APPROVAL_CHAT = 'mock-replay-approval';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed',
    messages: [{ role: 'user', content: 'seed', sidekick_id: 'umsg_rp_view_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(APPROVAL_CHAT, {
    title: 'Replay approval source',
    messages: [{ role: 'user', content: 'seed', sidekick_id: 'umsg_rp_app_seed', timestamp: t0 }],
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

  // The approval arrives ONLY as a replayed envelope — simulating the
  // reconnect-after-offline-push path. `_replay: true` is exactly what
  // the real proxy stamps on envelopes it re-streams on resume.
  const approvalId = 'notif_replay_approval_1';
  mock.pushEnvelope({
    type: 'notification',
    chat_id: APPROVAL_CHAT,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf parley-replay-approval\n\n' +
      'Reason: replayed approval must surface\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    sidekick_id: approvalId,
    urgent: true,
    _replay: true,
  });

  // Open the Activity tray and verify the replayed approval is present
  // and still actionable (the user can find + act on it later).
  await page.click('#btn-activity-drawer-rail');
  await page.waitForFunction(
    (id) => !!document.querySelector(
      `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
    ),
    approvalId, { timeout: 4_000, polling: 80 },
  );

  const state = await page.evaluate((id) => {
    const li = document.querySelector(
      `#activity-drawer-panel .activity-drawer-item[data-activity-id="${id}"]`,
    );
    if (!li) return { present: false };
    return {
      present: true,
      isApproval: li.classList.contains('activity-approval'),
      bodyText: (li.querySelector('.activity-item-body')?.textContent || '').trim(),
      buttonCount: li.querySelectorAll('.activity-item-actions button').length,
    };
  }, approvalId);

  assert(state.present,
    'a replayed (never-tapped) approval must STILL appear in the Activity tray — not silently disappear');
  assert(state.isApproval, 'the surfaced row must be marked as an approval');
  assert(/replayed approval must surface/.test(state.bodyText),
    'the approval preview text must render in the tray');
  assert(state.buttonCount === 3,
    'an unresolved replayed approval must keep Approve/Session/Deny buttons so the user can act on it later');
  log('replayed approval surfaced in Activity tray with action buttons ✓');
}
