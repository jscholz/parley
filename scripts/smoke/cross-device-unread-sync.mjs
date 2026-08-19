// Regression gate for the 2026-05-16 cross-device unread/badge sync bug.
//
// What broke (two coupled gaps):
//   1. Plugin only emitted `unread_changed` on explicit /seen and
//      /mark POSTs, never when a reply_final or notification landed.
//      Other devices stayed at stale badge counts until manual
//      foreground refresh. (commit 5b9c713)
//   2. EventSource subscription list didn't include `unread_changed`,
//      so even when the envelope was fanned by the proxy, the PWA
//      never delivered it to handleEnvelope. (caught by cross-device-
//      pin-sync.mjs sibling smoke)
//
// What this test does:
//   1. PWA boots viewing chat A. Mock seeds chat B with no unread.
//   2. Server-side: bump chat B's unread count + push
//      `unread_changed` envelope (mirrors plugin's behavior on a new
//      reply for chat B while user is on chat A).
//   3. PWA's badge.ts debounces 1500ms, fetches /api/parley/
//      notifications/unread, sees chat B has unread=1, fires
//      setAppBadge(1).

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'cross-device-unread-sync';
export const DESCRIPTION = 'unread_changed envelope from "another device" → badge.ts re-fetches and updates the app icon';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-cross-unread-viewed';
const REMOTE_CHAT = 'mock-cross-unread-remote';

export function MOCK_SETUP(mock) {
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed',
    messages: [
      { role: 'user', content: 'viewed-chat-seed',
        sidekick_id: 'umsg_unread_viewed', timestamp: Date.now() / 1000 - 60 },
    ],
  });
  mock.addChat(REMOTE_CHAT, {
    title: 'Remote',
    messages: [
      { role: 'user', content: 'remote-chat-seed',
        sidekick_id: 'umsg_unread_remote', timestamp: Date.now() / 1000 - 120 },
    ],
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
    const calls = window.__badgeCalls;
    if (!calls?.length) return null;
    const last = calls[calls.length - 1];
    return last.kind === 'clear' ? 0 : last.n;
  });
}

export default async function run({ page, log, mock }) {
  await installBadgeSpy(page);
  await waitForReady(page);
  await openSidebar(page);

  // Open the VIEWED chat so we're "off-screen" w.r.t. the remote.
  await clickRow(page, VIEWED_CHAT);
  await page.waitForFunction(
    () => /viewed-chat-seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000 },
  );

  // Simulate another device's plugin: bump unread for REMOTE_CHAT
  // server-side, then emit the envelope.
  mock.setUnread(REMOTE_CHAT, 1);
  mock.pushEnvelope({
    type: 'unread_changed',
    chat_id: REMOTE_CHAT,
    cause: 'reply_final',
  });
  log('pushed unread_changed envelope simulating remote reply');

  // badge.ts debounce is 1500ms; allow 1700ms for the fetch + state
  // update + setAppBadge call.
  await page.waitForTimeout(1700);
  const afterEnvelope = await lastBadgeState(page);
  assert(afterEnvelope === 1,
    `expected badge=1 after remote unread_changed, got ${afterEnvelope}. calls=${JSON.stringify(await page.evaluate(() => window.__badgeCalls))}`);
  log(`badge=1 after remote unread_changed ✓`);

  // Switching INTO the remote chat fires badge.clearUnread → POST /seen
  // → server clears its state → refreshFromServer → badge=0 → clearAppBadge.
  await clickRow(page, REMOTE_CHAT);
  await page.waitForFunction(
    () => /remote-chat-seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000 },
  );
  await page.waitForTimeout(1700);
  const afterSwitch = await lastBadgeState(page);
  assert(afterSwitch === 0,
    `expected badge=0 after switching INTO remote chat, got ${afterSwitch}`);
  log(`badge=0 after switch-into-remote (clearAppBadge fired) ✓`);
}
