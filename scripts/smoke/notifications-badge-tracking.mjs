// Pins the badge wiring (src/notifications/badge.ts) end-to-end.
//
// Flow (post-2026-05 refactor — server-driven SSOT):
//
//   1. Off-screen `notification` or `reply_final` envelope lands.
//   2. PWA's handler calls `incrementUnread(chatId)` →
//      `requestRefresh()` (debounced 1500ms).
//   3. Debounced fetch hits /api/parley/notifications/unread.
//   4. Server (mocked here) returns per-chat counts; PWA's
//      `syncBadge()` calls navigator.setAppBadge(total).
//
//   Switching INTO a chat:
//   5. PWA fires `/api/parley/notifications/seen` (POST).
//   6. Server clears that chat's unread; subsequent refresh sees
//      lower total → setAppBadge or clearAppBadge accordingly.
//
// The mock backend (scripts/smoke/mock-backend.mjs) auto-bumps the
// per-chat unread counter on every `notification` / `reply_final`
// envelope pushEnvelope sees — same shape as the real plugin's
// responses-handler. We stub navigator.setAppBadge + clearAppBadge so
// the smoke can observe the call sequence without requiring an
// installed PWA.
//
// Timing: PWA's requestRefresh debounce is 1500ms. Each
// "observable" badge state requires waiting at least 1700ms after the
// triggering envelope for the fetch to land.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'notifications-badge-tracking';
export const DESCRIPTION = 'off-screen notification / reply_final bumps app-icon badge; switching into chat clears it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-chat-badge-viewed';
const BG_CHAT_A = 'mock-chat-badge-bg-a';
const BG_CHAT_B = 'mock-chat-badge-bg-b';

export function MOCK_SETUP(mock) {
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed chat',
    messages: [
      { role: 'user', content: 'viewed seed',
        sidekick_id: 'umsg_badge_viewed', timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(BG_CHAT_A, {
    title: 'Background A',
    messages: [
      { role: 'user', content: 'bg A seed',
        sidekick_id: 'umsg_badge_bg_a', timestamp: Date.now() / 1000 - 90 },
    ],
    lastActiveAt: Date.now() - 5000,
  });
  mock.addChat(BG_CHAT_B, {
    title: 'Background B',
    messages: [
      { role: 'user', content: 'bg B seed',
        sidekick_id: 'umsg_badge_bg_b', timestamp: Date.now() / 1000 - 120 },
    ],
    lastActiveAt: Date.now() - 8000,
  });
}

/** Install instrumentation BEFORE the PWA boots so badge.ts sees the
 *  stubbed navigator methods on first load. */
async function installBadgeSpy(page) {
  await page.addInitScript(() => {
    const calls = [];
    /** @ts-ignore */
    Object.defineProperty(navigator, 'setAppBadge', {
      configurable: true,
      value: (n) => { calls.push({ kind: 'set', n }); return Promise.resolve(); },
    });
    /** @ts-ignore */
    Object.defineProperty(navigator, 'clearAppBadge', {
      configurable: true,
      value: () => { calls.push({ kind: 'clear' }); return Promise.resolve(); },
    });
    /** @ts-ignore */
    window.__badgeCalls = calls;
  });
}

async function badgeCalls(page) {
  return page.evaluate(() => window.__badgeCalls.slice());
}

async function lastBadgeState(page) {
  // Reduce the call sequence to the final intended badge value.
  // setAppBadge(n) sets, clearAppBadge() means 0.
  return page.evaluate(() => {
    const calls = window.__badgeCalls;
    if (calls.length === 0) return null;
    const last = calls[calls.length - 1];
    return last.kind === 'clear' ? 0 : last.n;
  });
}

export default async function run({ page, log, mock }) {
  await installBadgeSpy(page);
  await waitForReady(page);
  await openSidebar(page);

  await clickRow(page, VIEWED_CHAT);
  await page.waitForFunction(
    () => /viewed seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );

  // Switching INTO VIEWED_CHAT may have fired clearUnread(VIEWED_CHAT)
  // (which is a no-op for an empty map but still calls syncBadge →
  // navigator.clearAppBadge). Either 0 or null is fine as a baseline.
  const baseline = await lastBadgeState(page);
  log(`baseline badge state after switch into VIEWED: ${baseline ?? '(no calls yet)'}`);

  // ── Off-screen notification envelope → incrementUnread(BG_CHAT_A).
  mock.pushEnvelope({
    type: 'notification',
    chat_id: BG_CHAT_A,
    kind: 'cron',
    content: 'badge-pin-notification — should bump unread for BG_A',
  });
  await page.waitForTimeout(1700);  // debounced refresh (1500ms + slack)

  const afterNotif = await lastBadgeState(page);
  assert(
    afterNotif === 1,
    `expected badge total = 1 after off-screen notification, got ${afterNotif}. calls=${JSON.stringify(await badgeCalls(page))}`,
  );
  log(`✓ off-screen notification → badge = 1`);

  // ── Off-screen reply_final → incrementUnread(BG_CHAT_B). Different
  //    chat, so the total should climb to 2.
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: BG_CHAT_B,
    message_id: 'mock-reply-badge-b',
    text: 'a final reply for B; user is on VIEWED so this is off-screen',
  });
  await page.waitForTimeout(1700);  // debounced refresh (1500ms + slack)

  const afterReply = await lastBadgeState(page);
  assert(
    afterReply === 2,
    `expected badge total = 2 after off-screen reply_final for second chat, got ${afterReply}. calls=${JSON.stringify(await badgeCalls(page))}`,
  );
  log(`✓ off-screen reply_final → badge = 2`);

  // ── A SECOND notification for BG_CHAT_A should bump A's counter
  //    (now 2) and the global total to 3.
  mock.pushEnvelope({
    type: 'notification',
    chat_id: BG_CHAT_A,
    kind: 'cron',
    content: 'badge-pin-notification-2 — second event for BG_A',
  });
  await page.waitForTimeout(1700);  // debounced refresh (1500ms + slack)

  const afterSecondA = await lastBadgeState(page);
  assert(
    afterSecondA === 3,
    `expected badge total = 3 after second notification for BG_A, got ${afterSecondA}. calls=${JSON.stringify(await badgeCalls(page))}`,
  );
  log(`✓ second notification for same off-screen chat → badge = 3`);

  // ── Switch INTO BG_CHAT_A. clearUnread(BG_CHAT_A) fires, total
  //    drops by A's count (2) → 1.
  await clickRow(page, BG_CHAT_A);
  await page.waitForFunction(
    () => /bg A seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  await page.waitForTimeout(1700);  // clearUnread fires /seen then refreshFromServer; debounce window

  const afterSwitchA = await lastBadgeState(page);
  assert(
    afterSwitchA === 1,
    `expected badge total = 1 after switching into BG_A (clears A's 2), got ${afterSwitchA}. calls=${JSON.stringify(await badgeCalls(page))}`,
  );
  log(`✓ switch into BG_A → badge drops to 1 (BG_B's remaining)`);

  // ── Switch INTO BG_CHAT_B. clearUnread(BG_CHAT_B) → total drops to 0,
  //    which means navigator.clearAppBadge() (not setAppBadge(0)) per
  //    badge.ts's syncBadge implementation.
  await clickRow(page, BG_CHAT_B);
  await page.waitForFunction(
    () => /bg B seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  await page.waitForTimeout(1700);  // clearUnread fires /seen then refreshFromServer; debounce window

  const afterSwitchB = await lastBadgeState(page);
  assert(
    afterSwitchB === 0,
    `expected badge total = 0 after switching into BG_B (clears the last unread), got ${afterSwitchB}. calls=${JSON.stringify(await badgeCalls(page))}`,
  );
  // Specifically verify the cleared path was via clearAppBadge (not setAppBadge(0)).
  const lastCall = await page.evaluate(() => {
    const c = window.__badgeCalls;
    return c.length ? c[c.length - 1].kind : null;
  });
  assert(
    lastCall === 'clear',
    `expected last call to be clearAppBadge, got ${lastCall}. calls=${JSON.stringify(await badgeCalls(page))}`,
  );
  log(`✓ switch into BG_B → badge cleared via navigator.clearAppBadge()`);
}
