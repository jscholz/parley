// Contract (#206e): pasting a raw hermes session id (or a fragment of one)
// finds the owning chat in BOTH filter surfaces:
//   1. the drawer's "Filter sessions" box (client-side, instant), and
//   2. the cmd+K palette's sessions section (cached paint + server repaint).
//
// Field bug 2026-06-11: a row's own id is the `sidekick:<uuid>` chat id, so
// searching for the agent-reported session id `20260611_223425_98bd2b`
// matched nothing anywhere. Fix plumbs `session_ids` (space-joined raw ids,
// GROUP_CONCAT over the chat's session tree incl. rotated/compacted
// children) through the listing into the shared sessionFilter haystack, and
// teaches the plugin's server search an id-match pre-pass.
//
// The server /search route is overridden to return the id-match the patched
// plugin now produces (with the stale empty title hermes search results
// carry), so the cmd+K assertion also covers the title-merge repaint path.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'session-id-filter-matches';
export const DESCRIPTION = 'raw hermes session ids (and fragments) match in the drawer Filter sessions box and the cmd+K sessions section via session_ids metadata';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const TARGET = 'sidekick:mock-sid-root';
const OTHER = 'sidekick:mock-sid-other';
const TITLE = 'Investor Call Notes';
const FULL_ID = '20260611_223425_98bd2b';
const FRAGMENT = '98bd2b';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 500;
  mock.addChat(TARGET, {
    title: TITLE,
    source: 'sidekick',
    lastActiveAt: Date.now(),
    // Root session + a rotated child — the child id is the one the agent
    // reports and the user pastes.
    sessionIds: `20260601_120000_aaaaaa ${FULL_ID}`,
    messages: [
      { role: 'user', content: 'prep the investor call', sidekick_id: 'umsg_s0', timestamp: t0 },
      { role: 'assistant', content: 'on it', sidekick_id: 'msg_s0', timestamp: t0 + 1 },
    ],
  });
  mock.addChat(OTHER, {
    title: 'Unrelated Chat',
    source: 'sidekick',
    lastActiveAt: Date.now() - 60_000,
    messages: [
      { role: 'user', content: 'something else', sidekick_id: 'umsg_s1', timestamp: t0 - 100 },
      { role: 'assistant', content: 'sure', sidekick_id: 'msg_s1', timestamp: t0 - 99 },
    ],
  });
  mock.setAutoReplyEnabled(false);
}

const rowSel = (id) => `#sessions-list li[data-chat-id="${id}"]`;

async function waitForFilterResult(page, presentId, absentId) {
  // Filter render is debounced 100ms; poll for the settled state.
  await page.waitForFunction(
    ([keep, drop]) =>
      document.querySelector(`#sessions-list li[data-chat-id="${keep}"]`) != null &&
      document.querySelector(`#sessions-list li[data-chat-id="${drop}"]`) == null,
    [presentId, absentId],
    { timeout: 5_000, polling: 100 },
  );
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Models the patched plugin's id-match pre-pass: server search returns
  // the owning chat (stale empty title, as hermes search results carry).
  await page.route('**/api/parley/search*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessions: [{ id: TARGET, source: 'sidekick', title: '', snippet: '' }],
        hits: [],
      }),
    });
  });

  await openSidebar(page);
  await page.waitForSelector(rowSel(TARGET), { timeout: 5_000 });
  await page.waitForSelector(rowSel(OTHER), { timeout: 5_000 });

  // --- Surface 1: drawer Filter sessions box ---
  await page.fill('#sess-filter-input', FRAGMENT);
  await waitForFilterResult(page, TARGET, OTHER);
  log(`drawer filter "${FRAGMENT}" keeps ${TARGET}, drops ${OTHER} ✓`);

  await page.fill('#sess-filter-input', FULL_ID);
  await waitForFilterResult(page, TARGET, OTHER);
  log(`drawer filter full id "${FULL_ID}" matches ✓`);

  // A non-matching id-shaped query must filter the target out too —
  // proves the match comes from session_ids, not a pass-through.
  await page.fill('#sess-filter-input', '20991231_000000_zzzzzz');
  await page.waitForFunction(
    (id) => document.querySelector(`#sessions-list li[data-chat-id="${id}"]`) == null,
    TARGET,
    { timeout: 5_000, polling: 100 },
  );
  log('non-matching session id filters the row out ✓');

  await page.fill('#sess-filter-input', '');
  await page.waitForSelector(rowSel(OTHER), { timeout: 5_000 });

  // --- Surface 2: cmd+K sessions section ---
  await page.locator('#sb-search:visible').first().click();
  await page.waitForSelector('.cmdk-dialog[open]', { timeout: 5_000 });
  await page.fill('.cmdk-input', FRAGMENT);

  const cmdkRowSel = `.cmdk-row[data-kind="session"][data-id="${TARGET}"]`;

  // Instant cached paint (applyFilter over cached sessions w/ sessionIds).
  await page.waitForSelector(cmdkRowSel, { timeout: 3_000 });
  const cachedTitle = await page.textContent(`${cmdkRowSel} .cmdk-row-title`);
  log(`cmd+K cached paint: "${cachedTitle}"`);
  assert(cachedTitle === TITLE, `cached paint should show "${TITLE}", got "${cachedTitle}"`);

  // Past the 300ms debounce + server repaint: the row must survive (server
  // result includes the id-match) and keep the cached title despite the
  // server's empty one.
  await page.waitForTimeout(800);
  const afterRepaint = await page.textContent(`${cmdkRowSel} .cmdk-row-title`);
  log(`cmd+K after server repaint: "${afterRepaint}"`);
  assert(
    afterRepaint === TITLE,
    `after server repaint the session row must keep the title "${TITLE}", got "${afterRepaint}"`,
  );

  const otherInCmdk = await page.$(`.cmdk-row[data-kind="session"][data-id="${OTHER}"]`);
  assert(otherInCmdk == null, 'the unrelated chat must not match the session id query');

  log('session-id matches in drawer filter + cmd+K sessions ✓');
}
