// Field 2026-08-04 (CAP/WKWebView): after an instant switch to a huge
// chat, an edge spinner near the TOP of the transcript kept spinning
// 30-60s. Root cause: scroll-edge pagination fired DURING the windowed
// backfill. The pump's only guard was a rolling suppressLazyLoadFor(400)
// — on real WKWebView hardware, rAF/timer stalls (touch-scroll
// throttling, foreground transitions) open >400ms gaps between pump
// ticks, the timer lapses, and a scroll near the (partial) window top
// fires maybeLoadEarlier. The fetched rows land ABOVE the full buffer,
// outside the window slice — they never render, scrollTop stays at the
// partial top, and the loop refires page after page: an invisible
// pagination cascade with the edge spinner cycling the whole time.
//
// Fix under test: edge pagination is STRUCTURALLY gated on
// isBackfillActive() (state, not a timer), and the pump's terminal
// paths clear any stale edge loader (IfIdle — a legit in-flight
// pagination keeps its own spinner).
//
// WKWebView-stall simulation: a synchronous 700ms busy-loop mid-backfill
// stalls the pump exactly like an iOS rAF stall, guaranteeing the
// rolling suppress window has lapsed; then a programmatic scroll-to-top
// puts the viewport in maybeLoadEarlier's trigger zone while the
// backfill is still incomplete. Pre-fix: a ?before= fetch fires and the
// edge spinner shows during backfill (this smoke fails). Post-fix: no
// fetch, no spinner until the backfill completes; the LEGIT scroll-back
// pagination afterwards still works (rows grow past the first page) and
// its spinner clears on settle.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'huge-switch-no-edge-spinner-during-backfill';
export const DESCRIPTION = 'edge pagination is structurally suppressed during switch backfill — no phantom edge spinner';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const HUGE = 'mock-edge-spinner-huge';
const SMALL = 'mock-edge-spinner-sibling';
const TOTAL = 260;        // > 200-row first page → hasMore=true, deeper rows exist server-side
const FIRST_PAGE = 200;   // mock default page size (explicit for clarity)
const STALL_MS = 1200;    // slow /messages so a phantom fetch's spinner is observable

export function MOCK_SETUP(mock) {
  mock.setMessageDelay(HUGE, STALL_MS);
  const messages = [];
  for (let i = 0; i < TOTAL - 1; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user'
        ? `edge question ${idx}: slide ${idx}?`
        : [
            `### Section ${idx}`,
            '',
            '| metric | Q1 | Q2 | Q3 | Q4 |',
            '|---|---|---|---|---|',
            `| revenue ${idx} | 1.2 | 3.4 | 5.6 | 7.8 |`,
            '',
            '```python',
            `def projection_${idx}(base, growth):`,
            '    return [base * (1 + growth) ** q for q in range(12)]',
            '```',
            '',
            `- point ${idx}.1 with some length to it`,
            `- point ${idx}.2 **bold claim** needs a citation`,
            '',
            `Paragraph for section ${idx} so the backfill batches carry real`,
            'render cost and the post-stall catch-up spans several pump ticks.',
          ].join('\n'),
      // NO message_id: the mock uses message_id verbatim as the row id,
      // and a STRING id makes it emit firstId=null (numeric-only
      // cursor) — pagination would be structurally dead and step 4
      // below (legit scroll-back load) couldn't fire. sidekick_id alone
      // keeps stable data-keys; the mock auto-assigns numeric ids.
      sidekick_id: `edge-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL - idx) * 60,
    });
  }
  messages.push({
    role: 'user',
    content: 'EDGE-TAIL-MARKER final question',
    sidekick_id: 'edge-msg-tail',
    timestamp: Date.now() / 1000 - 30,
  });
  mock.addChat(HUGE, {
    title: 'Pitch deck (edge spinner)',
    source: 'sidekick',
    messages,
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(SMALL, {
    title: 'Small sibling',
    source: 'sidekick',
    messages: [
      { role: 'user', content: 'EDGE-SMALL-MARKER hello', message_id: 'edge-small-1',
        sidekick_id: 'edge-small-1', timestamp: Date.now() / 1000 - 40 },
    ],
    lastActiveAt: Date.now() - 30_000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Count ?before= pagination fetches, with timestamps, so we can split
  // "during backfill" (bug) from "after backfill" (legit).
  const beforeFetches = [];
  page.on('request', (req) => {
    const u = req.url();
    if (/\/api\/sidekick\/sessions\/[^/]+\/messages\?/.test(u) && /[?&]before=/.test(u)) {
      beforeFetches.push(Date.now());
    }
  });

  // 1. Open huge (server page = newest 200 rows), then park on sibling.
  await clickRow(page, HUGE);
  await page.waitForFunction(
    (n) => document.querySelectorAll('#transcript [data-key]').length >= n,
    FIRST_PAGE, { timeout: 25_000, polling: 100 });
  log('huge chat open: first page rendered');
  await page.waitForTimeout(400);
  await clickRow(page, SMALL);
  await page.waitForFunction(
    () => /EDGE-SMALL-MARKER/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 5_000, polling: 50 });
  await page.waitForTimeout(300);

  // 2. Switch back (mem fast path → windowed backfill), let the first
  //    batches land, then simulate the WKWebView stall + scroll-to-top.
  await clickRow(page, HUGE);
  await page.waitForTimeout(100);
  const backfillMark = Date.now();
  const stalled = await page.evaluate(() => {
    const el = document.getElementById('transcript');
    const rowsBefore = el.querySelectorAll('[data-key]').length;
    // Synchronous main-thread stall — the pump can't tick, its rolling
    // lazy-load suppress deadline lapses (WKWebView rAF-stall shape).
    // 1000ms: must outlive BOTH the pump's rolling 400ms suppress AND
    // the at-bottom restore's one-shot suppressLazyLoadFor(800) armed at
    // switch time (this evaluate starts ~100ms after the switch).
    const t0 = performance.now();
    while (performance.now() - t0 < 1000) { /* busy */ }
    // Land in maybeLoadEarlier's trigger zone while the backfill is
    // still incomplete, and run the scroll LISTENER synchronously in
    // this same task — on WKWebView, queued scroll events get processed
    // while the pump is still starved, i.e. BEFORE any pump tick can
    // re-arm its rolling suppress timer. (In Chromium the pump's 150ms
    // backstop timer, queued during the stall, would otherwise run
    // first and mask the timer lapse this smoke exists to pin.)
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    return { rowsBefore };
  });
  log(`stalled main thread mid-backfill (${stalled.rowsBefore} rows rendered), scrolled to top`);

  // 3. Sample while the backfill is still incomplete: the edge loader
  //    must never arm and no ?before= fetch may fire.
  let spinnerSeenDuringBackfill = 0;
  let samples = 0;
  for (;;) {
    const s = await page.evaluate(() => ({
      rows: document.querySelectorAll('#transcript [data-key]').length,
      spinner: !!document.getElementById('transcript-edge-loader')?.classList.contains('visible'),
    }));
    samples++;
    if (s.spinner) spinnerSeenDuringBackfill++;
    if (s.rows >= FIRST_PAGE) break;          // backfill complete
    await page.waitForTimeout(25);
    if (samples > 400) throw new Error('backfill never completed (10s)');
  }
  const fetchesDuringBackfill = beforeFetches.filter((t) => t >= backfillMark).length;
  log(`backfill complete: ${samples} samples, spinner-during-backfill=${spinnerSeenDuringBackfill}, ` +
      `before-fetches-during-backfill=${fetchesDuringBackfill}`);
  // The primary signals are the fetch count + spinner class; the sample
  // count just proves the loop observed the tail of the backfill at all
  // (the stall guarantees the scroll landed while it was incomplete).
  assert(samples >= 1, 'sampler never ran — stall/backfill timing assumptions broken');
  assert(fetchesDuringBackfill === 0,
    'BUG: a ?before= pagination fetch fired DURING the switch backfill — the rows it ' +
    'returns land above the window slice and never render, so the loop cascades ' +
    '(the 30-60s phantom spinner). Edge pagination must be structurally gated on ' +
    'isBackfillActive(), not a rolling timer.');
  assert(spinnerSeenDuringBackfill === 0,
    'BUG: the edge spinner was visible during the switch backfill.');

  // 4. LEGIT pagination after backfill: user is at the top with
  //    hasMore=true — the scroll-back load must still fire, grow the
  //    transcript past the first page, and its spinner must clear on
  //    settle (never persist). Wait out the pump's trailing 400ms
  //    lazy-load suppress first, then nudge the scroll so a FRESH scroll
  //    event fires (maybeLoadEarlier only runs on scroll events; the
  //    stall-time scroll already happened inside the suppress window).
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const el = document.getElementById('transcript');
    el.scrollTo({ top: 30, behavior: 'instant' });
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const el = document.getElementById('transcript');
    el.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForFunction(
    (n) => document.querySelectorAll('#transcript [data-key]').length > n,
    FIRST_PAGE, { timeout: 15_000, polling: 100 });
  await page.waitForFunction(
    () => !document.getElementById('transcript-edge-loader')?.classList.contains('visible'),
    null, { timeout: 10_000, polling: 100 });
  const finalRows = await page.evaluate(() =>
    document.querySelectorAll('#transcript [data-key]').length);
  log(`post-backfill legit pagination: grew to ${finalRows} rows, spinner cleared ✓`);
  assert(finalRows > FIRST_PAGE, 'legit scroll-back pagination broken by the backfill gate');
  log('no phantom edge spinner during backfill; legit pagination intact ✓');
}
