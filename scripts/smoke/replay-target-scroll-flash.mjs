// Phase 0 smoke (pre-refactor): pin the cmdk drill-to-message UX —
// when a search hit is clicked, replaySessionMessages finds the
// targeted bubble in the just-rendered DOM and:
//   1. Scrolls it into view (center).
//   2. Adds class `.search-target-flash` for 1500ms.
//
// Refactor target: src/sessionResume.ts extraction (Phase 2). The
// scroll-flash branch (main.ts:4234-4243) is a small but stateful
// post-render side effect — easy to forget to carry over in the lift.
// Without this pin, a regression that drops the flash leaves cmdk
// hits silently scrolling to nothing-visible (the actual bubble's at
// the top of the viewport but the user doesn't know which one they
// were looking for).

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'replay-target-scroll-flash';
export const DESCRIPTION = 'cmdk message-hit click adds .search-target-flash to the target bubble';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-scroll-flash';
const TARGET_TEXT = 'this is the bubble cmdk should drill into';
const QUERY = 'cmdk should drill';
// The mock-backend assigns integer ids 1000+i. The target message is
// the 21st (0-indexed 20) so its id is 1020. cmdk's rebuildVisibleHits
// passes message_ids through parseInt — they must round-trip as
// integers. Bubbles whose source row has no sidekick_id use the
// integer id as data-message-id; for parity with the cmdk hit we omit
// sidekick_id on the target row.
const TARGET_INTEGER_ID = 1020;

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Drill-target test',
    messages: [
      // 20 fillers (indices 0..19, ids 1000..1019).
      ...Array.from({ length: 20 }, (_, i) => ({
        role: 'user',
        content: `filler msg ${i + 1}`,
        sidekick_id: `umsg_filler_${i + 1}`,
        timestamp: Date.now() / 1000 - (60 - i),
      })),
      // Target — index 20, integer id 1020. No sidekick_id so the
      // bubble's data-message-id matches the cmdk hit's parseInt'd id.
      {
        role: 'user',
        content: TARGET_TEXT,
        timestamp: Date.now() / 1000 - 30,
      },
      ...Array.from({ length: 15 }, (_, i) => ({
        role: 'user',
        content: `more filler ${i + 1}`,
        sidekick_id: `umsg_more_${i + 1}`,
        timestamp: Date.now() / 1000 - (25 - i),
      })),
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  // Mock /api/parley/search — return a single message-hit pointing
  // at the target chat + sidekick_id. Shape matches what
  // proxyClient.search expects: { sessions: [], hits: [...] } with
  // each hit carrying session_id (the prefixed gateway id) + message_id.
  await page.route('**/api/parley/search*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessions: [],
        hits: [{
          session_id: CHAT_ID,
          message_id: TARGET_INTEGER_ID,  // integer per the proxy contract
          role: 'user',
          snippet: TARGET_TEXT.slice(0, 80),
          timestamp: Date.now() / 1000 - 30,
          session_title: 'Drill-target test',
          session_source: 'sidekick',
        }],
      }),
    });
  });

  await waitForReady(page);
  await openSidebar(page);

  // Open cmdk palette. The shortcut is platform-detected (Mac: metaKey
  // only, Linux/Windows: ctrlKey only — see cmdkPalette.ts:80). Playwright
  // headless chromium on Linux reads as Linux, so fire Ctrl+K. If the
  // detection ever flips, fall back to clicking the magnifier button.
  await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', {
      key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true,
    });
    document.dispatchEvent(ev);
  });
  await page.waitForSelector('.cmdk-input', { timeout: 3_000, state: 'visible' });
  log('cmdk palette opened ✓');

  // Type the query. cmdk debounces the messages_fts call; 250ms is
  // the documented debounce, give it 500ms to settle.
  await page.fill('.cmdk-input', QUERY);
  await page.waitForTimeout(600);

  // Click the message hit. cmdk renders hits as rows with a stable
  // selector — try a few likely shapes.
  const hitClicked = await page.evaluate((targetId) => {
    // cmdk renders each message hit as <li class="cmdk-row" data-id="N">.
    const byDataId = document.querySelector(`#cmdk-messages-list li.cmdk-row[data-id="${targetId}"]`)
      || document.querySelector(`li.cmdk-row[data-id="${targetId}"]`);
    if (byDataId) { byDataId.click(); return 'by-data-id'; }
    const rows = Array.from(document.querySelectorAll('.cmdk-hit, .cmdk-result, .cmdk-row, .cmdk-message-hit'));
    const target = rows.find((r) => (r.textContent || '').includes('cmdk should drill'));
    if (target) { target.click(); return 'by-text'; }
    return null;
  }, String(TARGET_INTEGER_ID));
  assert(hitClicked, `failed to find a cmdk hit row for the target message; the palette may render hits under a different selector than expected`);
  log(`cmdk hit clicked (via ${hitClicked}) ✓`);

  // Wait for the target bubble's data-message-id to appear with the
  // flash class. The flash is added in main.ts:4241 after
  // scrollIntoView, and removed via setTimeout 1500ms later. We poll
  // fast (50ms) inside a tight window so we don't miss the class.
  await page.waitForFunction(
    (targetId) => {
      const el = document.querySelector(`#transcript .line[data-message-id="${targetId}"]`);
      return !!el && el.classList.contains('search-target-flash');
    },
    String(TARGET_INTEGER_ID),
    { timeout: 4_000, polling: 50 },
  );
  log('.search-target-flash applied to the target bubble ✓');

  // Also pin the cleanup branch — class should be REMOVED within 1700ms
  // (1500ms timeout + DOM update slack).
  await page.waitForFunction(
    (targetId) => {
      const el = document.querySelector(`#transcript .line[data-message-id="${targetId}"]`);
      return !!el && !el.classList.contains('search-target-flash');
    },
    String(TARGET_INTEGER_ID),
    { timeout: 2_500, polling: 100 },
  );
  log('.search-target-flash auto-removed after the 1500ms flash window ✓');
}
