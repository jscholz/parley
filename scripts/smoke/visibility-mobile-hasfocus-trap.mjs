// Contract: a push notification fired for a chat being actively viewed.
// Root cause: the
// visibility reporter (src/notifications/visibility.ts) requires
// document.hasFocus() before reporting state='visible' to the proxy. On
// iOS PWAs hasFocus() routinely returns false even when the user is
// actively foregrounded (it's a desktop-centric API). The PWA then
// reports 'hidden' → the proxy's engagement timestamp clears or stales
// past the 10s window → the next reply pushes — even though the user is
// staring at the chat.
//
// Fix: on mobile, trust visibilityState alone. visibilityState='hidden'
// already covers "user backgrounded the PWA"; hasFocus() adds nothing on
// touch devices.
//
// This smoke stubs document.hasFocus() to ALWAYS return false BEFORE the
// PWA boots, launches with a mobile UA, opens a chat, and asserts the
// visibility report carries state='visible'. Without the mobile carve-out
// in visibility.ts, the stubbed hasFocus() forces state='hidden' and the
// assertion fails — that's exactly the field bug.
//
// Stubs both `document.hasFocus` (returns false → trips the bug) AND
// `navigator.userAgent` (iPhone UA → trips `isMobileRuntime()` in
// visibility.ts) via addInitScript. We do NOT use Playwright's mobile
// viewport mode here — it interferes with the sidebar/drawer
// interactions this smoke needs — just the UA is enough since the fix
// keys off `isMobileRuntime()` (a UA regex).

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'visibility-mobile-hasfocus-trap';
export const DESCRIPTION = 'on mobile, visibility reports state=visible regardless of document.hasFocus() (iOS PWA focus-quirk guard)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-vis-hasfocus';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Visibility focus-trap chat',
    messages: [{ role: 'user', content: 'seed', sidekick_id: 'umsg_vh_seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  // CRITICAL: stub hasFocus() to false BEFORE the PWA boots. Reproduces
  // the iOS PWA quirk where document.hasFocus() returns false despite the
  // app being actively foregrounded. addInitScript runs on every navigation
  // before any page script, so visibility.ts sees the stubbed function from
  // the very first compute() call.
  await page.addInitScript(() => {
    try {
      Object.defineProperty(document, 'hasFocus', {
        value: () => false,
        configurable: true,
      });
    } catch { /* if hard-locked elsewhere we'll let the assertion fail */ }
    try {
      // Force `isMobileRuntime()` in visibility.ts to return true via the
      // UA branch. (We don't use Playwright's mobile viewport mode — the
      // touch+sidebar shape breaks clickRow's drawer interaction here.)
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        configurable: true,
      });
    } catch { /* navigator.userAgent might be readonly in some contexts */ }
  });

  // Capture every POST to the visibility endpoint. The mock backend doesn't
  // route this path (it's a proxy concern), so we fulfill 200 ourselves
  // and snapshot the request body for assertion.
  const reports = /** @type {{ state: string; chatId: string }[]} */ ([]);
  await page.route('**/api/parley/notifications/visibility', async (route) => {
    try {
      const body = JSON.parse(route.request().postData() || '{}');
      const state = typeof body?.state === 'string' ? body.state : '';
      const chatId = typeof body?.chat_id === 'string' ? body.chat_id : '';
      reports.push({ state, chatId });
    } catch { /* malformed body — ignore */ }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await waitForReady(page);
  // Sanity: confirm hasFocus() is indeed stubbed inside the PWA — this is
  // the bug-trigger condition.
  const stubbed = await page.evaluate(() => document.hasFocus() === false);
  assert(stubbed, 'precondition: document.hasFocus() must be stubbed to false (iOS PWA quirk simulation)');

  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 5_000, polling: 80 },
  );

  // Wait for the visibility heartbeat to fire (it runs immediately for the
  // first chat-switch report, plus every 8s after). 1.5s is well past the
  // initial report from initVisibilityReporting + reportChatSwitch.
  await page.waitForTimeout(1500);

  // Assertion: at least ONE report for CHAT_ID with state='visible'. With
  // the mobile carve-out, the PWA reports visible despite hasFocus()=false.
  // Without it, every report is 'hidden' (compute() short-circuits on
  // !hasFocus()) and the engagement window never opens.
  const forChat = reports.filter(r => r.chatId === CHAT_ID);
  log(`captured ${reports.length} visibility report(s); ${forChat.length} for the target chat: ${JSON.stringify(forChat.slice(0, 5))}`);
  assert(forChat.length > 0,
    `no visibility reports for ${CHAT_ID} — chat-switch reporter (visibility.ts reportChatSwitch) didn't fire`);
  const visibleReport = forChat.find(r => r.state === 'visible');
  assert(visibleReport,
    'PWA never reported state="visible" for the focused chat despite mobile UA + active engagement. ' +
    'On iOS PWAs document.hasFocus() is unreliable; visibility.ts must skip the hasFocus() check on mobile ' +
    '(the visibilityState !== "hidden" check is sufficient — backgrounding the PWA already flips that).');
  log('mobile PWA correctly reported state=visible despite hasFocus()=false ✓');
}
