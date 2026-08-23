// Stale Activity entries should not create local "New chat" ghosts.
//
// Reproduces the real-smoke cleanup shape: Activity persists locally, but
// the underlying temporary chat was deleted server-side. Clicking the item
// must validate with a read-only fetch, dismiss the stale row, and avoid
// hydrating a 0-message sidebar placeholder.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-stale-link-no-ghost';
export const DESCRIPTION = 'clicking stale Activity item dismisses it without creating a New chat ghost';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-chat-activity-stale-viewed';
const STALE_CHAT = 'parley:mock-chat-activity-stale-missing';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Activity Stale Viewed',
    messages: [
      { role: 'user', content: 'viewed seed', parley_id: 'umsg_activity_stale_viewed', timestamp: t0 },
    ],
    lastActiveAt: Date.now() - 1000,
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
    chat_id: STALE_CHAT,
    kind: 'cron',
    content: 'Cronjob Response: Deleted smoke\n(job_id: stale)\n---\nSTALE_ACTIVITY_MARKER',
    parley_id: 'notif_activity_stale_missing_1',
  });

  await page.waitForFunction(
    () => !(document.getElementById('activity-drawer-count-rail')?.hidden ?? true),
    null,
    { timeout: 3_000, polling: 50 },
  );
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector('#activity-drawer-panel:not([hidden]) .activity-drawer-item', { timeout: 3_000 });

  await page.locator('#activity-drawer-panel .activity-drawer-item', { hasText: 'STALE_ACTIVITY_MARKER' }).click();
  await page.waitForFunction(
    () => !(document.getElementById('activity-drawer-panel')?.textContent || '').includes('STALE_ACTIVITY_MARKER'),
    null,
    { timeout: 3_000, polling: 50 },
  );
  const state = await page.evaluate((staleId) => ({
    staleRow: !!document.querySelector(`#sessions-list li[data-chat-id="${CSS.escape(staleId)}"]`),
    transcript: document.getElementById('transcript')?.textContent || '',
    activity: document.getElementById('activity-drawer-panel')?.textContent || '',
  }), STALE_CHAT);
  assert(!state.staleRow, 'stale Activity click created a sidebar ghost row');
  assert(!state.transcript.includes('STALE_ACTIVITY_MARKER'), 'stale Activity click rendered missing transcript content');
  assert(!state.activity.includes('STALE_ACTIVITY_MARKER'), 'stale Activity row was not dismissed');
  log('stale Activity item dismissed without creating sidebar ghost ✓');
}
