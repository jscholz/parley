// Regression guard for cron notification race: user clicks away from a
// chat, the target session's
// /messages fetch is still in flight, and a notification lands for
// the previous chat. The clicked row must become the engagement target
// immediately; otherwise the old chat still looks "on screen", the
// notification takes the on-screen path, calls clearUnread(oldChat),
// and the unread badge flashes then disappears.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'notification-during-session-switch-unread';
export const DESCRIPTION = 'notification for previous chat during slow session switch stays unread instead of being cleared as on-screen';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const OLD_CHAT = 'mock-notif-switch-old';
const NEW_CHAT = 'mock-notif-switch-new';

export function MOCK_SETUP(mock) {
  mock.addChat(OLD_CHAT, {
    title: 'Old cron chat',
    messages: [
      { role: 'user', content: 'old chat seed', parley_id: 'umsg_notif_switch_old', timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(NEW_CHAT, {
    title: 'New target chat',
    messages: [
      { role: 'user', content: 'new chat seed', parley_id: 'umsg_notif_switch_new', timestamp: Date.now() / 1000 - 120 },
    ],
    lastActiveAt: Date.now() - 5000,
  });
}

async function installBadgeSpy(page) {
  await page.addInitScript(() => {
    /** @ts-ignore */
    window.__badgeCalls = [];
    Object.defineProperty(navigator, 'setAppBadge', {
      configurable: true,
      value: (n) => { window.__badgeCalls.push({ kind: 'set', n }); return Promise.resolve(); },
    });
    Object.defineProperty(navigator, 'clearAppBadge', {
      configurable: true,
      value: () => { window.__badgeCalls.push({ kind: 'clear' }); return Promise.resolve(); },
    });
  });
}

async function lastBadgeState(page) {
  return page.evaluate(() => {
    const calls = window.__badgeCalls || [];
    if (calls.length === 0) return null;
    const last = calls[calls.length - 1];
    return last.kind === 'clear' ? 0 : last.n;
  });
}

export default async function run({ page, log, mock }) {
  await installBadgeSpy(page);
  await waitForReady(page);
  await openSidebar(page);

  await clickRow(page, OLD_CHAT);
  await page.waitForFunction(
    () => /old chat seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('opened old chat');

  // Make the destination session slow enough that OLD_CHAT remains in
  // the DOM while NEW_CHAT is already the clicked/focused row.
  mock.setMessageDelay(NEW_CHAT, 2500);
  await clickRow(page, NEW_CHAT);

  mock.pushEnvelope({
    type: 'notification',
    chat_id: OLD_CHAT,
    kind: 'cron',
    content: 'Cronjob Response: one minute timer\n(job_id: mock-job)\n---\n\nTimer fired while switching sessions.',
  });
  log('pushed old-chat notification during slow switch');

  await page.waitForTimeout(1700);
  const duringSwitch = await lastBadgeState(page);
  assert(
    duringSwitch === 1,
    `expected badge=1 while switch is still loading, got ${duringSwitch}. calls=${JSON.stringify(await page.evaluate(() => window.__badgeCalls))}`,
  );

  await page.waitForFunction(
    () => /new chat seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 5_000, polling: 50 },
  );
  await page.waitForTimeout(1700);
  const afterSwitch = await lastBadgeState(page);
  assert(
    afterSwitch === 1,
    `expected old chat to remain unread after switch completes, got ${afterSwitch}. calls=${JSON.stringify(await page.evaluate(() => window.__badgeCalls))}`,
  );
  log('old-chat notification remains unread across slow switch ✓');
}
