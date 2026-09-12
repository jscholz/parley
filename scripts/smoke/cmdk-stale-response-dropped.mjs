// Contract: a slow /search answer to an EARLIER query never repaints
// over the answer to the query the input currently holds.
//
// His report (2026-09-12, and "ages ago"): a session he wanted flashed
// and then vanished. One mechanism: type "alpha", pause, type "beta" —
// if alpha's response is slow it lands after beta's and the sections
// flip to alpha's results while the box says beta. The palette now
// tickets every query (QuerySequence) and drops non-current answers.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'cmdk-stale-response-dropped';
export const DESCRIPTION = 'cmd+K drops a slow server answer to an earlier query instead of repainting over the current one';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const ALPHA = 'parley:mock-stale-alpha';
const BETA = 'parley:mock-stale-beta';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(ALPHA, {
    title: 'Alpha planning',
    source: 'parley',
    lastActiveAt: Date.now() - 10_000,
    messages: [
      { role: 'user', content: 'alpha kickoff notes', parley_id: 'umsg_a0', timestamp: t0 },
      { role: 'assistant', content: 'ok', parley_id: 'msg_a0', timestamp: t0 + 1 },
    ],
  });
  mock.addChat(BETA, {
    title: 'Beta launch',
    source: 'parley',
    lastActiveAt: Date.now(),
    messages: [
      { role: 'user', content: 'beta launch checklist', parley_id: 'umsg_b0', timestamp: t0 + 5 },
      { role: 'assistant', content: 'ok', parley_id: 'msg_b0', timestamp: t0 + 6 },
    ],
  });
  // Any query containing "alpha" answers 1.5 s late; "beta" answers fast.
  mock.setSearchDelay('alpha', 1_500);
  mock.setAutoReplyEnabled(false);
}

const sessRow = (id) => `.cmdk-row[data-kind="session"][data-id="${id}"]`;

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForFunction(
    (id) => document.querySelector(`#sessions-list li[data-chat-id="${id}"]`) != null,
    BETA,
    { timeout: 5_000, polling: 100 },
  );

  await page.locator('#sb-search:visible').first().click();
  await page.waitForSelector('.cmdk-dialog[open]', { timeout: 5_000 });

  await page.fill('.cmdk-input', 'alpha');
  // Let the 300ms debounce dispatch alpha's request (it will take 1.5 s).
  await page.waitForTimeout(450);
  await page.fill('.cmdk-input', 'beta');

  // Beta's answer lands quickly: its message hit appears.
  await page.waitForSelector(`.cmdk-row[data-kind="message"][data-session-id="${BETA}"]`, { timeout: 5_000 });
  assert(await page.locator(sessRow(BETA)).count() === 1, 'beta session row present');
  assert(await page.locator(sessRow(ALPHA)).count() === 0, 'alpha session row absent while beta is the query');
  log('beta answered first ✓');

  // Now alpha's late answer arrives (~1.5 s after dispatch). Nothing may
  // change: no alpha rows, beta rows intact, status not "…".
  await page.waitForTimeout(1_800);
  const queries = mock.getSearchQueries();
  assert(queries.includes('alpha') && queries.includes('beta'), `both queries reached the server (${JSON.stringify(queries)})`);
  assert(await page.locator(sessRow(ALPHA)).count() === 0, 'stale alpha answer did not add its session row');
  assert(
    (await page.locator(`.cmdk-row[data-kind="message"][data-session-id="${ALPHA}"]`).count()) === 0,
    'stale alpha answer did not add its message hits',
  );
  assert(await page.locator(sessRow(BETA)).count() === 1, 'beta session row still present');
  assert(
    (await page.locator(`.cmdk-row[data-kind="message"][data-session-id="${BETA}"]`).count()) === 1,
    'beta message hit still present',
  );
  const status = await page.textContent('.cmdk-status');
  assert(status.trim() === '', `status settled on beta's answer, got "${status}"`);
  assert((await page.inputValue('.cmdk-input')) === 'beta', 'input still reads beta');
  log('late alpha answer dropped; beta results untouched ✓');
}
