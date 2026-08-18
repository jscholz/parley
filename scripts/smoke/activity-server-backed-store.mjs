// Activity tray persistence is server-backed, not browser-profile-local.
//
// The mocked /api/parley/activity endpoint starts with one server row.
// A fresh browser context with empty localStorage must render it, a reload
// after clearing localStorage must still render it, and dismiss must DELETE
// it from the server so it stays gone after reload.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'activity-server-backed-store';
export const DESCRIPTION = 'Activity tray hydrates from /api/parley/activity and deletes through the server API';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const ITEM_ID = 'activity_server_backed_cron_1';

export function MOCK_SETUP(mock) {
  mock.addChat('mock-activity-server-chat', {
    title: 'Server Activity Chat',
    messages: [
      { role: 'user', content: 'server activity seed', sidekick_id: 'umsg_activity_server_seed', timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

async function openActivity(page) {
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector('#activity-drawer-panel:not([hidden])', { timeout: 3_000 });
}

async function panelText(page) {
  return page.evaluate(() => document.getElementById('activity-drawer-panel')?.textContent || '');
}

export default async function run({ page, log, mock }) {
  mock.seedActivity({
    id: ITEM_ID,
    chatId: 'mock-activity-server-chat',
    kind: 'cron',
    title: 'Cron · Server Activity Chat',
    body: 'Server-backed activity survived a fresh profile.',
    createdAt: Date.now() / 1000,
    urgent: false,
    read: false,
    messageId: ITEM_ID,
    resolved: null,
  });


  await waitForReady(page);
  await openSidebar(page);
  await openActivity(page);
  await page.waitForFunction(
    () => (document.getElementById('activity-drawer-panel')?.textContent || '').includes('Server-backed activity survived'),
    null,
    { timeout: 3_000, polling: 50 },
  );
  log('fresh profile hydrated Activity from server ✓');

  await page.evaluate(() => localStorage.removeItem('sidekick.activity.items.v1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 5_000 });
  await openActivity(page);
  await page.waitForFunction(
    () => (document.getElementById('activity-drawer-panel')?.textContent || '').includes('Server-backed activity survived'),
    null,
    { timeout: 3_000, polling: 50 },
  );
  log('localStorage clear + reload still hydrates Activity from server ✓');

  await page.locator('#activity-drawer-panel .activity-drawer-item', { hasText: 'Server-backed activity survived' })
    .locator('.pin-item-unpin-btn')
    .click();
  await page.waitForFunction(
    () => !(document.getElementById('activity-drawer-panel')?.textContent || '').includes('Server-backed activity survived'),
    null,
    { timeout: 3_000, polling: 50 },
  );
  assert(mock.activityItems().length === 0, `expected server item deleted, got ${mock.activityItems().length}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 5_000 });
  await openActivity(page);
  const after = await panelText(page);
  assert(!after.includes('Server-backed activity survived'), 'deleted server Activity item reappeared after reload');
  log('dismiss deletes through server and stays gone after reload ✓');
}
