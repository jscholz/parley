// Contract (#206d): cmd+K message-search hits show the message's date+time
// in the meta line ("Jun 11, 10:34 PM" style, year appended when not the
// current year). The timestamp was always present in the server hit payload
// (plugin sends unix seconds) but was silently dropped at render time, so
// users couldn't tell a hit from last night apart from one from last month.
//
// Also pins the degraded path: a hit WITHOUT a timestamp (0/missing — older
// plugins, DOM-rebuilt hits) renders its meta without a trailing time and
// without stray separators.
//
// The expected string is computed IN-PAGE with the exact toLocaleDateString/
// toLocaleTimeString options formatHitTime uses, so the assertion is
// locale/timezone-safe rather than hardcoding an en-US rendering.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'cmdk-hit-timestamp';
export const DESCRIPTION = 'cmd+K message hits render the hit timestamp as date+time in the meta line; hits without a timestamp render cleanly without one';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'parley:mock-hit-ts';
// Yesterday — guaranteed same calendar year as the browser clock, so the
// expected format has no year component.
const HIT_TS = Math.floor(Date.now() / 1000) - 86_400;

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 500;
  mock.addChat(CHAT_ID, {
    title: 'Timestamp Probe',
    source: 'parley',
    lastActiveAt: Date.now(),
    messages: [
      { role: 'user', content: 'what time was that?', parley_id: 'umsg_t0', timestamp: t0 },
      { role: 'assistant', content: 'late', parley_id: 'msg_t0', timestamp: t0 + 1 },
    ],
  });
  mock.setAutoReplyEnabled(false);
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Server search returns two hits: one with a real timestamp, one without.
  // Registered after the harness routes so this one wins for /search.
  await page.route('**/api/parley/search*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessions: [],
        hits: [
          {
            session_id: CHAT_ID, message_id: 'hit-with-ts', role: 'user',
            snippet: 'needle in the evening', timestamp: HIT_TS,
            session_title: 'Timestamp Probe', session_source: 'parley',
          },
          {
            session_id: CHAT_ID, message_id: 'hit-no-ts', role: 'assistant',
            snippet: 'needle without a clock', timestamp: 0,
            session_title: 'Timestamp Probe', session_source: 'parley',
          },
        ],
      }),
    });
  });

  await openSidebar(page);
  await page.locator('#sb-search:visible').first().click();
  await page.waitForSelector('.cmdk-dialog[open]', { timeout: 5_000 });
  await page.fill('.cmdk-input', 'needle');

  // 300ms debounce before the server search fires.
  await page.waitForSelector('.cmdk-row[data-kind="message"][data-id="hit-with-ts"]', { timeout: 5_000 });

  // Expected string built with formatHitTime's exact options, in-page.
  const expected = await page.evaluate((ts) => {
    const d = new Date(ts * 1000);
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${date}, ${time}`;
  }, HIT_TS);
  assert(expected.length > 0, 'expected time string must be non-empty');

  const metaWith = await page.textContent('.cmdk-row[data-kind="message"][data-id="hit-with-ts"] .cmdk-row-meta');
  log(`hit meta (with ts): "${metaWith}" — expecting suffix "${expected}"`);
  assert(
    metaWith && metaWith.includes(expected),
    `hit meta must include the formatted date+time "${expected}", got "${metaWith}"`,
  );
  assert(
    metaWith.includes('Timestamp Probe') && metaWith.includes('user'),
    `meta must keep the existing title/role parts, got "${metaWith}"`,
  );

  const metaWithout = await page.textContent('.cmdk-row[data-kind="message"][data-id="hit-no-ts"] .cmdk-row-meta');
  log(`hit meta (no ts): "${metaWithout}"`);
  assert(
    metaWithout && !/\d{1,2}:\d{2}/.test(metaWithout),
    `a hit without a timestamp must not render a time, got "${metaWithout}"`,
  );
  assert(
    !metaWithout.trim().endsWith('·'),
    `meta must not end with a dangling separator, got "${metaWithout}"`,
  );

  log('message hits carry date+time; missing timestamps degrade cleanly ✓');
}
