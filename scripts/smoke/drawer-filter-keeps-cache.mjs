// Contract: the drawer's inline "Filter sessions" box ADDS server-found
// rows to the cached list while a filter is active; it never replaces
// the cached list (or the IDB list cache) with the search result.
//
// Pre-fix (sessionDrawer.runServerFilterReconcile, until 2026-09-12) the
// server answer overwrote cachedSessions AND putListCache(), so clearing
// the filter left only the rows that had matched — everything else was
// gone until the next server refresh, and rows the client matched on a
// visible name could vanish when the server ranked differently.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'drawer-filter-keeps-cache';
export const DESCRIPTION = 'drawer Filter sessions: server matches merge into the cached list; clearing the filter restores every row without a refetch';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const ROWS = [
  ['parley:mock-dfk-alpha', 'Alpha planning'],
  ['parley:mock-dfk-beta', 'Beta launch'],
  ['parley:mock-dfk-gamma', 'Gamma retro'],
];

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  ROWS.forEach(([id, title], i) => {
    mock.addChat(id, {
      title,
      source: 'parley',
      lastActiveAt: Date.now() - i * 10_000,
      messages: [
        { role: 'user', content: `${title.toLowerCase()} kickoff`, parley_id: `umsg_${i}`, timestamp: t0 + i },
        { role: 'assistant', content: 'ok', parley_id: `msg_${i}`, timestamp: t0 + i + 1 },
      ],
    });
  });
  mock.setAutoReplyEnabled(false);
}

const rowSel = (id) => `#sessions-list li[data-chat-id="${id}"]`;

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  for (const [id] of ROWS) await page.waitForSelector(rowSel(id), { timeout: 5_000 });

  // Slow the list endpoint from here on so a restored drawer within the
  // assertion window can only come from the cache the filter path must
  // not have clobbered. (Aborting the route instead would also kill the
  // health poll and flip the app offline — not what is under test.)
  mock.setSessionsDelay(5_000);

  await page.fill('#sess-filter-input', 'alpha');
  await page.waitForFunction(
    ([keep, drop]) =>
      document.querySelector(`#sessions-list li[data-chat-id="${keep}"]`) != null &&
      document.querySelector(`#sessions-list li[data-chat-id="${drop}"]`) == null,
    [ROWS[0][0], ROWS[1][0]],
    { timeout: 5_000, polling: 100 },
  );
  // The server reconcile fires after its 250ms debounce.
  await page.waitForTimeout(800);
  assert(mock.getSearchQueries().includes('alpha'), `server filter reconcile fired (${JSON.stringify(mock.getSearchQueries())})`);
  log('filter narrowed to alpha and the server answered ✓');

  // Clear the filter: every row must be back at once, from cache.
  await page.fill('#sess-filter-input', '');
  for (const [id] of ROWS) {
    await page.waitForSelector(rowSel(id), { timeout: 1_500 });
  }
  log('all three rows restored after clearing the filter ✓');
  // And a second filter still works off the intact cache.
  await page.fill('#sess-filter-input', 'gamma');
  await page.waitForFunction(
    ([keep, drop]) =>
      document.querySelector(`#sessions-list li[data-chat-id="${keep}"]`) != null &&
      document.querySelector(`#sessions-list li[data-chat-id="${drop}"]`) == null,
    [ROWS[2][0], ROWS[0][0]],
    { timeout: 5_000, polling: 100 },
  );
  log('cache intact for a second filter ✓');
}
