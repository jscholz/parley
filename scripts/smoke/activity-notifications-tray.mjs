// Activity tray v1: all OS-push-worthy Parley events get a recoverable row.
//
// Covers the two non-approval cases that users actually see as push
// notifications:
//   - off-screen reply_final (agent reply / weather-tool-style result)
//   - cron notification envelope
// Also pins the dismiss control: x removes the row immediately.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-notifications-tray';
export const DESCRIPTION = 'off-screen agent replies and cron notifications persist in Activity and can be dismissed';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-chat-activity-notif-viewed';
const REPLY_CHAT = 'mock-chat-activity-agent-reply';
const CRON_CHAT = 'mock-chat-activity-cron';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  for (const [id, title] of [
    [VIEWED_CHAT, 'Activity Notification Viewed'],
    [REPLY_CHAT, 'Weather Tool Check'],
    [CRON_CHAT, 'Cron Timer Check'],
  ]) {
    mock.addChat(id, {
      title,
      messages: [
        { role: 'user', content: `${title} seed`, parley_id: `umsg_${id}_seed`, timestamp: t0 },
      ],
      lastActiveAt: Date.now() - 1000,
    });
  }
}

// One-number rule (2026-07-10): mere unread tray items show a DOT on
// the bell, not a number — numbers on the bell are reserved for
// pending approvals. This helper asserts the dot state.
async function waitForActivityDot(page, visible) {
  await page.waitForFunction(
    (v) => {
      const badge = document.getElementById('activity-drawer-count-rail');
      const shown = !!badge && !badge.hidden && badge.classList.contains('dot-only');
      return v ? shown : !shown;
    },
    visible,
    { timeout: 3_000, polling: 50 },
  );
}

async function activityText(page) {
  return page.evaluate(() => document.getElementById('activity-drawer-panel')?.textContent || '');
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, VIEWED_CHAT);
  await page.waitForFunction(
    () => /Activity Notification Viewed seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );

  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: REPLY_CHAT,
    message_id: 'msg_activity_agent_reply_1',
    text: 'Weather check complete: London is overcast and mild.',
  });
  await waitForActivityDot(page, true);
  log('off-screen reply_final lit the Activity dot ✓');

  mock.pushEnvelope({
    type: 'notification',
    chat_id: CRON_CHAT,
    kind: 'cron',
    content:
      'Cronjob Response: Tea timer\n' +
      '(job_id: smoke-tea-timer)\n' +
      '--------------------------\n' +
      'Your tea timer fired.\n\n' +
      'To stop or manage this job, open Parley.',
    parley_id: 'notif_activity_cron_1',
  });
  await waitForActivityDot(page, true);
  log('cron notification keeps the Activity dot lit ✓');

  await clickRow(page, REPLY_CHAT);
  await page.waitForFunction(
    () => /Weather Tool Check seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  await waitForActivityDot(page, true);   // cron item still unread → dot stays
  const readState = mock.activityItems().find((item) => item.id === 'msg_activity_agent_reply_1');
  assert(readState?.read === true, 'opening reply chat did not mark its Activity item read on the server');
  log('opening a chat clears matching Activity unread across the server store ✓');

  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector('#activity-drawer-panel:not([hidden]) .activity-drawer-item', { timeout: 3_000 });
  const text = await activityText(page);
  assert(text.includes('Read'), 'read Activity row state missing');
  assert(text.includes('New'), 'unread Activity row state missing');
  assert(text.includes('Reply · Weather Tool Check'), 'agent reply Activity title missing');
  assert(text.includes('Weather check complete'), 'agent reply Activity body missing');
  assert(text.includes('Cron · Cron Timer Check'), 'cron Activity title missing');
  assert(text.includes('Your tea timer fired'), 'cron Activity body missing');
  log('Activity tray rendered reply + cron rows ✓');

  const beforeCount = await page.locator('#activity-drawer-panel .activity-drawer-item').count();
  await page.locator('#activity-drawer-panel .activity-drawer-item', { hasText: 'Weather check complete' })
    .locator('.pin-item-unpin-btn')
    .click();
  await page.waitForFunction(
    () => !(document.getElementById('activity-drawer-panel')?.textContent || '').includes('Weather check complete'),
    null,
    { timeout: 3_000, polling: 50 },
  );
  const afterCount = await page.locator('#activity-drawer-panel .activity-drawer-item').count();
  assert(afterCount === beforeCount - 1, `expected dismiss to remove one row (${beforeCount} -> ${afterCount})`);
  log('dismiss x removed Activity row ✓');

  await page.click('#pin-drawer-clear');
  await page.waitForFunction(
    () => document.querySelectorAll('#activity-drawer-panel .activity-drawer-item').length === 0,
    null,
    { timeout: 3_000, polling: 50 },
  );
  const clearHidden = await page.evaluate(() => document.getElementById('pin-drawer-clear')?.hidden ?? false);
  assert(clearHidden, 'Activity clear button should hide after clearing all activity');
  log('Activity clear button removed remaining rows ✓');
}
