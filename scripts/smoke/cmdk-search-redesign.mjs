// Contract (search redesign, 2026-09-12 — his report: "it's not clear why
// it matches sessions… I'd expect session results to match the session
// name and message hits to match the string… I search 'fix cron', briefly
// see a session I want, then it disappears"):
//
//   1. Sessions section = rows whose VISIBLE name contains every term.
//      A chat whose messages match but whose name does not is NOT a
//      session hit — it shows up under Messages instead.
//   2. The instant client paint SURVIVES the server answer (add/merge,
//      never replace). The title-only match stays on screen.
//   3. Matched text is marked (<mark>) in both session titles and
//      message excerpts; a message row's meta names the chat, the role,
//      and "+N more in this chat" when the backend collapsed hits.
//   4. "No matching sessions." only appears AFTER the server answers.
//
// Drives the mock backend's own /search route (a contract-faithful
// model of the plugin) — no per-test route override.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'cmdk-search-redesign';
export const DESCRIPTION = 'cmd+K: sessions match the visible name and survive the server repaint; message hits show marked excerpts with chat/role/+N meta; empty state waits for the server';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const TITLED = 'parley:mock-search-titled';
const BODIES = 'parley:mock-search-bodies';
const TITLE_ONLY = 'Fix R2 investor calendar cron';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 900;
  // Name matches "fix cron"; no message body contains "fix".
  mock.addChat(TITLED, {
    title: TITLE_ONLY,
    source: 'parley',
    lastActiveAt: Date.now() - 30_000,
    messages: [
      { role: 'user', content: 'please look at the calendar sync', parley_id: 'umsg_t0', timestamp: t0 },
      { role: 'assistant', content: 'done', parley_id: 'msg_t0', timestamp: t0 + 1 },
    ],
  });
  // Name does NOT match; five message bodies do.
  const bodies = [];
  for (let i = 0; i < 5; i++) {
    bodies.push({ role: 'user', content: `attempt ${i}: fix the cron job again`, parley_id: `umsg_b${i}`, timestamp: t0 + 10 + i * 2 });
    bodies.push({ role: 'assistant', content: `ack ${i}`, parley_id: `msg_b${i}`, timestamp: t0 + 11 + i * 2 });
  }
  mock.addChat(BODIES, {
    title: 'Daily recap',
    source: 'parley',
    lastActiveAt: Date.now(),
    messages: bodies,
  });
  mock.setAutoReplyEnabled(false);
}

const sessRow = (id) => `.cmdk-row[data-kind="session"][data-id="${id}"]`;

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForFunction(
    (id) => document.querySelector(`#sessions-list li[data-chat-id="${id}"]`) != null,
    TITLED,
    { timeout: 5_000, polling: 100 },
  );

  await page.locator('#sb-search:visible').first().click();
  await page.waitForSelector('.cmdk-dialog[open]', { timeout: 5_000 });
  await page.fill('.cmdk-input', 'fix cron');

  // Instant paint: the title match is on screen before any network.
  await page.waitForSelector(sessRow(TITLED), { timeout: 3_000 });
  assert(
    (await page.locator('ul[data-section="sessions"] .cmdk-empty').count()) === 0,
    'no "No matching sessions" before the server answers',
  );
  log('instant paint shows the title match ✓');

  // Server answer lands (300ms debounce + mock). Wait for the messages
  // section to populate — that's the same repaint that used to wipe the
  // sessions section.
  await page.waitForSelector(`.cmdk-row[data-kind="message"][data-session-id="${BODIES}"]`, { timeout: 5_000 });
  await page.waitForTimeout(300);
  const queries = mock.getSearchQueries();
  assert(queries.includes('fix cron'), `server search fired (${JSON.stringify(queries)})`);

  // (2) The title-only match survives.
  assert(await page.locator(sessRow(TITLED)).count() === 1, 'title-only session match still present after the server repaint');
  // (1) The body-only chat is NOT a session hit.
  assert(await page.locator(sessRow(BODIES)).count() === 0, 'a chat whose messages match but whose name does not is not a session hit');
  // (3) Title marks: "Fix" and "cron" wrapped in <mark>.
  const titleMarks = await page.locator(`${sessRow(TITLED)} .cmdk-row-title mark`).allTextContents();
  assert(
    titleMarks.map((s) => s.toLowerCase()).join('|') === 'fix|cron',
    `session title marks the matched terms, got ${JSON.stringify(titleMarks)}`,
  );
  log('session row survives with marked terms ✓');

  // (3) Message hits: capped at 3 for the chat, marked excerpt, meta.
  const hitRows = page.locator(`.cmdk-row[data-kind="message"][data-session-id="${BODIES}"]`);
  const hitCount = await hitRows.count();
  assert(hitCount === 3, `per-chat cap of 3 message hits, got ${hitCount}`);
  const firstMarks = await hitRows.first().locator('.cmdk-row-title mark').allTextContents();
  assert(
    firstMarks.map((s) => s.toLowerCase()).join('|') === 'fix|cron',
    `excerpt marks the matched terms, got ${JSON.stringify(firstMarks)}`,
  );
  const firstMeta = await hitRows.first().locator('.cmdk-row-meta').textContent();
  assert(firstMeta.includes('Daily recap'), `hit meta names the chat: "${firstMeta}"`);
  assert(firstMeta.includes('user'), `hit meta names the role: "${firstMeta}"`);
  assert(firstMeta.includes('+2 more in this chat'), `hit meta reports collapsed hits: "${firstMeta}"`);
  const status = await page.textContent('.cmdk-status');
  assert(status.trim() === '', `messages status clears when hits exist, got "${status}"`);
  log('message hits: marked excerpts, chat/role/+N meta ✓');

  // (4) No-match query: empty state only after the server answers.
  await page.fill('.cmdk-input', 'zzqx nothing');
  assert(
    (await page.locator('ul[data-section="sessions"] .cmdk-empty').count()) === 0,
    'empty state is withheld until the server answers',
  );
  await page.waitForFunction(
    () => document.querySelector('ul[data-section="sessions"] .cmdk-empty')?.textContent === 'No matching sessions.',
    null,
    { timeout: 5_000, polling: 100 },
  );
  const status2 = await page.textContent('.cmdk-status');
  assert(status2.trim() === 'no matches', `messages status reads "no matches", got "${status2}"`);
  log('empty states arrive with the server answer ✓');
}
