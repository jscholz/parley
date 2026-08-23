// Session-switch long-task budget (follow-up to huge-session-switch-
// instant-highlight, approved 2026-08-02): the row highlight now paints
// before the heavy replay, but the replay itself still occupied the
// main thread in ONE multi-second task — typing, scrolling, or another
// switch stalled until it finished. This smoke pins the fix: the mem
// fast-path replay of a huge transcript must be TIME-SLICED (eager
// viewport window + batched backfill), with no single main-thread task
// over ~300ms during the switch, and the full transcript must still
// materialize completely.
//
// Long-task probe: a self-rescheduling 5ms timer measures the max gap
// between consecutive ticks — a synchronous task of duration D shows up
// as a gap ≈ D (timer tasks can't interleave a blocked main thread).
// This avoids the PerformanceObserver('longtask') availability question
// and measures exactly what we care about: responsiveness.
//
// Pre-fix: switch-back renders all rows in one task → max gap ≈ 1.5s+.
// Post-fix: initial window + ≤~50ms batches → max gap well under 300ms.
//
// The chat is exactly 180 messages (< the 200-row first page) so ONE
// server page covers the whole transcript: hasMore=false, no lazy-load
// pagination noise, and the expected rendered row count is exactly 180.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'huge-session-switch-no-long-task';
export const DESCRIPTION = 'huge-session switch-back replay is time-sliced — no main-thread task over ~300ms';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const HUGE = 'mock-nolongtask-huge';
const SMALL = 'mock-nolongtask-sibling';
const N_MSGS = 180;   // < 200-row first page → single page, no pagination
const MAX_TASK_MS = 300;

function fatMarkdown(idx) {
  return [
    `## Deck section ${idx}`,
    '',
    '| metric | Q1 | Q2 | Q3 | Q4 |',
    '|---|---|---|---|---|',
    `| revenue ${idx} | 1.2 | 3.4 | 5.6 | 7.8 |`,
    `| burn ${idx} | 0.4 | 0.5 | 0.6 | 0.7 |`,
    `| runway ${idx} | 18 | 17 | 16 | 15 |`,
    '',
    '```python',
    `def projection_${idx}(base, growth):`,
    '    series = [base]',
    '    for quarter in range(12):',
    '        series.append(series[-1] * (1 + growth))',
    '    return series',
    '',
    `print(projection_${idx}(100, 0.14))`,
    '```',
    '',
    `- takeaway ${idx}.1: growth compounding beats linear hiring`,
    `- takeaway ${idx}.2: gross margin expands after platform migration`,
    `- takeaway ${idx}.3: **bold claim ${idx}** needs a citation`,
    '',
    `Closing paragraph for section ${idx}: the pitch narrative connects the`,
    'wedge to the platform, and the platform to the moat. Repeat until the',
    'partner meeting nods along and the term sheet materializes.',
  ].join('\n');
}

export function MOCK_SETUP(mock) {
  const messages = [];
  for (let i = 0; i < N_MSGS - 1; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user'
        ? `Question ${idx}: how does slide ${idx} land?`
        : fatMarkdown(idx),
      parley_id: `nlt-msg-${idx}`,
      message_id: `nlt-msg-${idx}`,
      timestamp: Date.now() / 1000 - (N_MSGS - idx) * 60,
    });
  }
  messages.push({
    role: 'user',
    content: 'NLT-TAIL-MARKER final question',
    parley_id: 'nlt-msg-tail',
    message_id: 'nlt-msg-tail',
    timestamp: Date.now() / 1000 - 30,
  });
  mock.addChat(HUGE, {
    title: 'Pitch deck (no-long-task)',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(SMALL, {
    title: 'Small sibling',
    source: 'parley',
    messages: [
      { role: 'user', content: 'NLT-SMALL-MARKER hello', message_id: 'nlt-small-1',
        parley_id: 'nlt-small-1', timestamp: Date.now() / 1000 - 40 },
    ],
    lastActiveAt: Date.now() - 30_000,
  });
}

const rowCount = () => document.querySelectorAll('#transcript [data-key]').length;

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. Open the huge chat and wait for the COMPLETE transcript (windowed
  //    replay backfills; completeness is row count, not just the tail
  //    marker). Populates the in-memory transcriptStore for the mem
  //    fast path on switch-back.
  await clickRow(page, HUGE);
  await page.waitForFunction(
    (n) => document.querySelectorAll('#transcript [data-key]').length >= n
      && /NLT-TAIL-MARKER/.test(document.getElementById('transcript')?.textContent || ''),
    N_MSGS, { timeout: 20_000, polling: 100 });
  log('huge chat fully rendered on first open');
  await page.waitForTimeout(400);

  // 2. Switch to the small sibling.
  await clickRow(page, SMALL);
  await page.waitForFunction(
    () => /NLT-SMALL-MARKER/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 5_000, polling: 50 });
  await page.waitForTimeout(300);

  // 3. Arm the main-thread gap probe, then switch back to the huge chat.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__gapMax = 0;
    w.__gapStop = false;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      if (now - last > w.__gapMax) w.__gapMax = now - last;
      last = now;
      if (!w.__gapStop) setTimeout(tick, 5);
    };
    setTimeout(tick, 5);
  });
  await clickRow(page, HUGE);

  // 4. Wait for the transcript to be COMPLETE again (tail marker + full
  //    row count — backfill must finish), then stop the probe.
  await page.waitForFunction(
    (n) => document.querySelectorAll('#transcript [data-key]').length >= n
      && /NLT-TAIL-MARKER/.test(document.getElementById('transcript')?.textContent || ''),
    N_MSGS, { timeout: 20_000, polling: 100 });
  // One extra beat so any trailing batch/settle work lands inside the
  // probe window rather than escaping measurement.
  await page.waitForTimeout(400);
  const res = await page.evaluate((n) => {
    const w = /** @type {any} */ (window);
    w.__gapStop = true;
    return {
      gapMax: Math.round(w.__gapMax),
      rows: document.querySelectorAll('#transcript [data-key]').length,
      expected: n,
    };
  }, N_MSGS);

  log(`switch-back complete: ${res.rows}/${res.expected} rows, max main-thread gap ${res.gapMax}ms`);
  assert(res.rows >= res.expected,
    `transcript incomplete after switch-back: ${res.rows}/${res.expected} rows rendered`);
  assert(res.gapMax < MAX_TASK_MS,
    `BUG: a main-thread task blocked for ~${res.gapMax}ms during the huge-session ` +
    `switch (budget ${MAX_TASK_MS}ms). The transcript replay must be time-sliced ` +
    '(eager viewport window + batched backfill), not one synchronous render.');
  log('switch-back replay stayed under the long-task budget ✓');
}
