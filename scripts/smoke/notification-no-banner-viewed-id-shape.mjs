// Bug A (#234, field 2026-06-15): a slash-command (/background) reply for
// the chat the user is CURRENTLY VIEWING raised a spurious in-app
// notification banner.
//
// Root cause (backendEvents.ts handleNotification): the off-screen test
// was a raw `chatId !== switchCtl.focusedId()` compare. Post-v0.383
// chat_ids are prefixed `sidekick:<uuid>`, but the viewed id can be the
// bare uuid (and vice versa). A prefixed env.chat_id never string-equals
// the bare viewed id, so a notification for the on-screen chat took the
// OFF-SCREEN branch: badge bump + banner. inAppBanner.ts even strips
// `^sidekick:` for display, confirming notifications arrive prefixed.
//
// FIX: normalize the `^sidekick:` prefix on both sides of the
// `chatId !== focusedId()` compare. (We deliberately keep comparing
// against focusedId() — during an in-flight switch the chat you LEFT
// should still accrue a badge/banner; that off-screen behavior is pinned
// by notification-during-session-switch-unread.)
//
// Repro: view a chat whose drawer id is the BARE form; push a notification
// whose chat_id is the SAME chat but `sidekick:`-prefixed. Assert no
// banner appears (the on-screen .system row path is fine and expected).

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'notification-no-banner-viewed-id-shape';
export const DESCRIPTION = 'a notification whose chat_id differs only by the parley: prefix from the VIEWED chat must not raise a banner (#234)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_BARE = 'mock-234-viewed';
const NOTIF_PREFIXED = `sidekick:${VIEWED_BARE}`;
const BANNER_MARKER = 'background-result-marker-234';

export function MOCK_SETUP(mock) {
  mock.addChat(VIEWED_BARE, {
    source: 'sidekick',
    title: 'Viewed chat (bare id)',
    messages: [
      { role: 'user', content: '/background do a thing',
        sidekick_id: 'umsg_234_seed', timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  await clickRow(page, VIEWED_BARE);
  await page.waitForFunction(
    () => /do a thing/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('viewing the bare-id chat ✓');

  // The /background reply lands as a notification envelope, but with the
  // PREFIXED chat_id shape — the exact mismatch that fooled the raw compare.
  mock.pushEnvelope({
    type: 'notification',
    chat_id: NOTIF_PREFIXED,
    kind: 'cron',
    content: `Cronjob Response: background task\n(job_id: mock-234)\n---\n\n${BANNER_MARKER} — your background task finished.`,
    sidekick_id: 'notif_234_1',
  });
  log('pushed prefixed-id notification for the viewed chat');

  // Give the banner its full chance to mount (show() is synchronous on
  // receipt; 1.2s is generous headroom).
  await page.waitForTimeout(1_200);

  const state = await page.evaluate(() => {
    const banner = document.getElementById('in-app-banner');
    return {
      bannerVisible: !!banner && banner.classList.contains('visible'),
      bannerText: banner?.textContent || '',
    };
  });

  assert(
    !state.bannerVisible,
    `notification for the VIEWED chat raised a banner (id-shape mismatch leaked to off-screen path): ${state.bannerText}`,
  );
  log('no banner for the viewed chat despite the parley: prefix mismatch ✓');

  // Sanity: it still took the on-screen path and rendered a .system row.
  const hasSystemRow = await page.evaluate((marker) => {
    const lines = Array.from(document.querySelectorAll('#transcript .line.system'));
    return lines.some((l) => (l.textContent || '').includes(marker));
  }, BANNER_MARKER);
  assert(hasSystemRow, 'on-screen notification did not render a .system row — it was misrouted');
  log('on-screen .system row rendered (correct path) ✓');
}
