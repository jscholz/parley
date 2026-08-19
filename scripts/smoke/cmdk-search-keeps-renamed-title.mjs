// Contract: when searching in cmd+K, a session the
// user has RENAMED must keep showing that name — not flash the real name
// and then, ~300ms later, get replaced with the raw `sidekick:<uuid>` id.
//
// Why it regressed: the renamed title lives in parley.db
// (conversation_titles, client-cached via the drawer). The hermes FTS
// search index does NOT carry it, so the server search result for that
// session has an empty/auto title. cmdkPalette paints the cached title
// instantly (rerenderSessions), then 300ms later runUnifiedSearch repaints
// the sessions section from the server result — and renderSessionRow's
// `title || snippet || id` fallback drops to the raw id.
//
// Fix: runUnifiedSearch merges the cached override title back in by id
// before repainting. This test drives that exact race: a drawer chat with
// an override title + a server /search response that returns the same id
// WITHOUT a title. We assert the row still reads the override name AFTER
// the debounce+repaint window.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'cmdk-search-keeps-renamed-title';
export const DESCRIPTION = 'cmd+K search keeps a user-renamed session title instead of clobbering it with the raw id from the server result';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'sidekick:mock-rename-7f3a';
const RENAMED = 'Zephyr Pipeline Notes';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 500;
  mock.addChat(CHAT_ID, {
    title: RENAMED,
    source: 'sidekick',
    lastActiveAt: Date.now(),
    messages: [
      { role: 'user', content: 'kick off the zephyr pipeline', sidekick_id: 'umsg_z0', timestamp: t0 },
      { role: 'assistant', content: 'done', sidekick_id: 'msg_z0', timestamp: t0 + 1 },
    ],
  });
  mock.setAutoReplyEnabled(false);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // The drawer must have cached the renamed session (that's the source of
  // the override title the fix relies on).
  await page.waitForFunction(
    (id) => document.querySelector(`#sessions-list li[data-chat-id="${id}"]`) != null,
    CHAT_ID,
    { timeout: 5_000, polling: 100 },
  );

  // Server search returns the SAME session id but NO title — exactly what
  // the hermes FTS index hands back for a client-renamed chat. Registered
  // after the mock harness's routes so this one wins for /search.
  let searchHits = 0;
  await page.route('**/api/parley/search*', async (route) => {
    searchHits++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessions: [{ id: CHAT_ID, source: 'sidekick', title: '', snippet: '' }],
        hits: [],
      }),
    });
  });

  // Open the palette and search for a token in the renamed title.
  await page.locator('#sb-search:visible').first().click();
  await page.waitForSelector('.cmdk-dialog[open]', { timeout: 5_000 });
  await page.fill('.cmdk-input', 'zephyr');

  const rowTitleSel = `.cmdk-row[data-kind="session"][data-id="${CHAT_ID}"] .cmdk-row-title`;

  // Instant cached paint shows the real name first.
  await page.waitForSelector(rowTitleSel, { timeout: 3_000 });
  const initial = await page.textContent(rowTitleSel);
  log(`instant cached paint: "${initial}"`);
  assert(initial === RENAMED, `cached paint should show the renamed title, got "${initial}"`);

  // Wait past the 300ms debounce + server repaint — this is the window
  // where the bug clobbered the title with the raw id.
  await page.waitForFunction(() => true, null, { timeout: 100 });
  await page.waitForTimeout(800);
  assert(searchHits >= 1, `server /search should have fired after debounce (hits=${searchHits})`);

  const afterRepaint = await page.textContent(rowTitleSel);
  log(`after server repaint: "${afterRepaint}" (searchHits=${searchHits})`);
  assert(
    afterRepaint === RENAMED,
    `after the server repaint the row must KEEP the renamed title, not fall back to the raw id — got "${afterRepaint}"`,
  );
  assert(
    afterRepaint !== CHAT_ID,
    `the row must not show the raw chat id "${CHAT_ID}"`,
  );
  log('renamed title survives the server search repaint ✓');
}
