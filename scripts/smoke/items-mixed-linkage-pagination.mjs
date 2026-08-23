// B2-refactor regression gate: items endpoint must correctly surface
// a chat whose messages are a mix of:
//   - modern rows with `parley_id` (umsg_*/msg_*) — write-through path
//   - legacy rows with no `parley_id` (cross-channel or pre-link)
// across the load-earlier pagination boundary, with no dupes and
// correct chronological order.
//
// This smoke exercises the read path that B2 will refactor (items
// endpoint reading state.db.messages + JOINing parley.db.msg_links
// for the parley_id annotation). Establishes a green baseline
// BEFORE B2 lands; afterward it's a regression gate that breaks loudly
// if B2's JOIN drops fields, dupes rows, or mis-orders the page.

import {
  waitForReady, openSidebar, clickRow, assert,
} from './lib.mjs';

export const NAME = 'items-mixed-linkage-pagination';
export const DESCRIPTION = 'Items endpoint surfaces modern + legacy rows correctly across the load-earlier boundary';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-mixed-linkage';
const T0 = Math.floor(Date.now() / 1000) - 600;

export function MOCK_SETUP(mock) {
  // 10 messages alternating legacy / modern. First-page cap = 4 so
  // the user has to load-earlier twice to see all of them.
  mock.addChat(CHAT_ID, {
    title: 'Mixed linkage pagination test',
    source: 'parley',
    messages: [
      // Page 3 (oldest) — legacy rows (no parley_id)
      { role: 'user', content: 'oldest q (legacy)', timestamp: T0 + 0 },
      { role: 'assistant', content: 'oldest a (legacy)', timestamp: T0 + 1 },
      // Page 2 — mix
      { role: 'user', content: 'middle q (legacy)', timestamp: T0 + 10 },
      { role: 'assistant', content: 'middle a (modern)',
        parley_id: 'msg_middle_modern', timestamp: T0 + 11 },
      { role: 'user', content: 'middle q2 (modern)',
        parley_id: 'umsg_middle_q2', timestamp: T0 + 12 },
      { role: 'assistant', content: 'middle a2 (legacy)', timestamp: T0 + 13 },
      // Page 1 (newest) — all modern
      { role: 'user', content: 'recent q', parley_id: 'umsg_recent_q',
        timestamp: T0 + 100 },
      { role: 'assistant', content: 'recent a', parley_id: 'msg_recent_a',
        timestamp: T0 + 101 },
      { role: 'user', content: 'newest q', parley_id: 'umsg_newest_q',
        timestamp: T0 + 110 },
      { role: 'assistant', content: 'newest a', parley_id: 'msg_newest_a',
        timestamp: T0 + 111 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
  // Force pagination — first page = 4 rows, two more pages needed.
  mock.setHistoryFirstPageLimit(4);
}

async function lineDump(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line'))
      .map(el => ({
        cls: el.className,
        key: el.getAttribute('data-key') || null,
        text: (el.textContent || '').trim().slice(0, 60),
      })),
  );
}

async function transcriptText(page) {
  return page.evaluate(() =>
    (document.getElementById('transcript')?.textContent || '').replace(/\s+/g, ' ').trim(),
  );
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  // Wait for first page (newest 4) to render.
  await page.waitForFunction(
    () => /newest a/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 80 },
  );
  log('newest page rendered ✓');

  // Drive load-earlier twice by scrolling to the top + dispatching
  // a scroll event (the listener wires off scroll events, not just
  // scrollTop assignments — same pattern as load-earlier-history.mjs).
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const t = document.getElementById('transcript');
      if (t) {
        t.scrollTop = 0;
        t.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    });
    await page.waitForTimeout(600);
  }

  // After two load-earliers, all 10 messages should be visible — both
  // legacy AND modern, no dupes, in chronological order.
  await page.waitForFunction(
    () => /oldest a \(legacy\)/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 5_000, polling: 100 },
  );

  const dump = await lineDump(page);
  log(`total .line count after two load-earliers: ${dump.length}`);
  log(`  dump: ${JSON.stringify(dump)}`);

  // Exactly 10 bubbles, no duplicates.
  assert(
    dump.length === 10,
    `expected 10 bubbles (4 user + 4 assistant from page 1+2+3 trios, modulo overlap); got ${dump.length}`,
  );

  // Every original marker is visible exactly once.
  const tx = await transcriptText(page);
  const markers = [
    'oldest q (legacy)', 'oldest a (legacy)',
    'middle q (legacy)', 'middle a (modern)',
    'middle q2 (modern)', 'middle a2 (legacy)',
    'recent q', 'recent a',
    'newest q', 'newest a',
  ];
  for (const m of markers) {
    const count = tx.split(m).length - 1;
    assert(count === 1, `marker "${m}" should appear exactly once; saw ${count}`);
  }
  log('all 10 markers present exactly once (no dupes across mixed linkage) ✓');

  // Spot check: data-key surfaces the parley_id when present, falls
  // back to the integer id when absent.
  const keys = dump.map(d => d.key);
  // Modern rows should be keyed by parley_id
  assert(keys.includes('msg_newest_a'), `expected msg_newest_a in keys; got ${JSON.stringify(keys)}`);
  assert(keys.includes('umsg_newest_q'), `expected umsg_newest_q in keys; got ${JSON.stringify(keys)}`);
  // Legacy rows should be keyed by integer id (mock assigns 1000+i)
  const integerKeys = keys.filter(k => /^\d+$/.test(k || ''));
  assert(integerKeys.length === 4,
    `expected 4 integer-id keys (legacy rows); got ${integerKeys.length}: ${JSON.stringify(integerKeys)}`);
  log('key shape: modern → parley_id, legacy → integer id ✓');
}
