// #226 UX: when a scroll triggers a pagination load, the user must get
// immediate feedback that their scroll registered. chat.ts shows an
// edge-anchored ring spinner (#transcript-edge-loader, .at-top for older
// history) while maybeLoadEarlier's fetch is in flight, then hides it.
//
// This smoke seeds a paginated chat (first page = 10 of 30), DELAYS the
// before-cursor /messages response by ~700ms so the in-flight window is
// observable, scrolls to the top to trigger loadEarlier, and asserts:
//   (a) #transcript-edge-loader.visible.at-top appears during the load,
//   (b) it goes away once the older page has landed.
//
// Failing-first: with no spinner wired into maybeLoadEarlier the element
// never gains .visible and (a) times out.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'scroll-load-shows-spinner';
export const DESCRIPTION = 'scroll-to-top pagination shows an edge spinner while the older page loads, then hides it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-scroll-spinner';

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(10);
  const messages = [];
  for (let i = 0; i < 30; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `msg-${idx} user marker` : `msg-${idx} agent reply`,
      timestamp: Date.now() / 1000 - (30 - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Scroll-load spinner test',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  await page.waitForFunction(
    () => /msg-30 agent reply/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('first page rendered (latest 10) ✓');

  // Delay the before-cursor pagination response so the in-flight spinner
  // window is wide enough to observe deterministically. Count the
  // before-cursor fetches so we can prove the load actually fired (under
  // the windowed render the prepended older page sits in the store but
  // outside the visible DOM window, so textContent is not a reliable
  // proof — the network request is).
  let beforeHits = 0;
  await page.route('**/api/parley/sessions/**/messages?*', async (route) => {
    if (/[?&]before=/.test(route.request().url())) {
      beforeHits++;
      await new Promise((r) => setTimeout(r, 700));
    }
    await route.continue();
  });

  // Wait out the open-render load-earlier suppression window, then scroll
  // to the top to trigger maybeLoadEarlier (same gesture as the
  // load-earlier-history smoke).
  await page.waitForTimeout(1000);
  const box = await page.locator('#transcript').boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
  }
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) {
      t.scrollTo({ top: 0, behavior: 'instant' });
      t.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  });

  // (a) Spinner appears at the top while the delayed page is in flight.
  await page.waitForSelector('#transcript-edge-loader.visible.at-top', { timeout: 3_000 });
  log('edge spinner visible at top during load ✓');

  // (b) Spinner clears once the older page lands.
  await page.waitForFunction(
    () => {
      const el = document.getElementById('transcript-edge-loader');
      return !el || !el.classList.contains('visible');
    },
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('edge spinner hidden after older page landed ✓');

  // Sanity: the spinner reflected a real load, not a no-op — the
  // before-cursor fetch fired (and was the one we delayed).
  assert(beforeHits > 0, 'no before= pagination fetch fired — spinner was a no-op');
  log(`older page fetched (${beforeHits} before= request) ✓`);
}
