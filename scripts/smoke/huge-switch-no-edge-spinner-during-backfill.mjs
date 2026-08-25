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
// WKWebView-stall simulation: the switch-back runs under a CPU throttle
// (so the pump lasts seconds, as it does on device rather than the
// ~110ms it takes on unthrottled desktop), then a synchronous 1000ms
// busy-loop mid-backfill stalls the pump exactly like an iOS rAF stall,
// guaranteeing the rolling suppress window has lapsed; then a
// programmatic scroll-to-top puts the viewport in maybeLoadEarlier's
// trigger zone while the backfill is still incomplete. Pre-fix: a
// ?before= fetch fires and the edge spinner shows during backfill (this
// smoke fails). Post-fix: no fetch, no spinner until the backfill
// completes; the LEGIT scroll-back pagination afterwards still works
// (rows grow past the first page) and its spinner clears on settle.
//
// The throttle is not decoration. Without it the stall outlives the
// whole backfill, the scroll lands on a fully-rendered transcript, and
// the (correct, legitimate) pagination that follows reads as the bug —
// the smoke fails while the product is fine. A non-vacuity assertion
// below pins that the scroll really did land on a partial window.

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
// CPU throttle for the switch-back only. 20x puts the windowed backfill
// at ~4.7s, so the 1000ms stall below lands solidly mid-pump with margin
// on both sides; unthrottled it is ~110ms and the scenario is
// unreachable. See the step-2 comment for why this is load-bearing.
const CPU_THROTTLE = 20;

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
      // below (legit scroll-back load) couldn't fire. parley_id alone
      // keeps stable data-keys; the mock auto-assigns numeric ids.
      parley_id: `edge-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL - idx) * 60,
    });
  }
  messages.push({
    role: 'user',
    content: 'EDGE-TAIL-MARKER final question',
    parley_id: 'edge-msg-tail',
    timestamp: Date.now() / 1000 - 30,
  });
  mock.addChat(HUGE, {
    title: 'Pitch deck (edge spinner)',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(SMALL, {
    title: 'Small sibling',
    source: 'parley',
    messages: [
      { role: 'user', content: 'EDGE-SMALL-MARKER hello', message_id: 'edge-small-1',
        parley_id: 'edge-small-1', timestamp: Date.now() / 1000 - 40 },
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
    if (/\/api\/parley\/sessions\/[^/]+\/messages\?/.test(u) && /[?&]before=/.test(u)) {
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
  //
  //    The switch runs under a CPU throttle because the two halves of
  //    this scenario are otherwise mutually exclusive on desktop
  //    hardware. The stall has to outlive BOTH suppress timers (~1s of
  //    real time) for the structural gate to be the only thing left
  //    holding the line — but an unthrottled headless Chromium finishes
  //    the whole 170-row backfill in ~110ms (measured: 30 rows at 46ms,
  //    200 at 110ms), so the pump is always DONE before the stall ends
  //    and the scroll lands on a fully-rendered transcript where
  //    pagination is legitimately allowed. Throttling stretches the pump
  //    to ~4.7s (its adaptive batch floors at BACKFILL_MIN_BATCH), which
  //    is also the honest shape of the field report: the bug needs a
  //    device slow enough that a human can scroll mid-backfill at all.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  let spinnerSeenDuringBackfill = 0;
  let samples = 0;
  let fetchesDuringBackfill = 0;
  let rowsAtScroll = 0;
  try {
    await clickRow(page, HUGE);
    // Wait for the pump to be demonstrably mid-flight: the initial
    // window has painted AND at least one batch has grown it, but the
    // projection isn't covered yet. Bailing straight into the stall
    // could catch the pre-render moment where the transcript still holds
    // the SMALL chat's single row.
    await page.waitForFunction(
      (n) => {
        const c = document.querySelectorAll('#transcript [data-key]').length;
        return c > 30 && c < n;
      },
      FIRST_PAGE, { timeout: 20_000, polling: 20 });
    const backfillMark = Date.now();
    const stalled = await page.evaluate(() => {
      const el = document.getElementById('transcript');
      const rowsBefore = el.querySelectorAll('[data-key]').length;
      // Synchronous main-thread stall — the pump can't tick, its rolling
      // lazy-load suppress deadline lapses (WKWebView rAF-stall shape).
      // 1000ms: must outlive BOTH the pump's rolling 400ms suppress AND
      // the at-bottom restore's one-shot suppressLazyLoadFor(800) armed
      // at switch time.
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
    rowsAtScroll = stalled.rowsBefore;
    log(`stalled main thread mid-backfill (${rowsAtScroll} rows rendered), scrolled to top`);

    // 3. Sample while the backfill is still incomplete: the edge loader
    //    must never arm and no ?before= fetch may fire.
    for (;;) {
      const s = await page.evaluate(() => ({
        rows: document.querySelectorAll('#transcript [data-key]').length,
        spinner: !!document.getElementById('transcript-edge-loader')?.classList.contains('visible'),
      }));
      samples++;
      if (s.spinner) spinnerSeenDuringBackfill++;
      if (s.rows >= FIRST_PAGE) break;          // backfill complete
      await page.waitForTimeout(25);
      if (samples > 800) throw new Error('backfill never completed');
    }
    fetchesDuringBackfill = beforeFetches.filter((t) => t >= backfillMark).length;
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  log(`backfill complete: ${samples} samples, spinner-during-backfill=${spinnerSeenDuringBackfill}, ` +
      `before-fetches-during-backfill=${fetchesDuringBackfill}`);
  // Non-vacuity guard. Both assertions below are trivially satisfiable by
  // a transcript that finished backfilling before the scroll — which is
  // exactly what an unthrottled run produces, and how this smoke spent
  // its first life reporting a bug that wasn't there. Pin that the
  // scroll actually landed on a PARTIAL window, and that the sampler
  // then watched the rest of the pump run.
  //
  // The upper bound has margin baked in: under the throttle the pump
  // moves ~8 rows per ~250ms, so leaving >=60 rows unrendered guarantees
  // the backfill outlives the 1000ms stall rather than finishing inside
  // it. If a future change speeds the pump up or slows the switch down,
  // this trips loudly instead of quietly going green for free.
  assert(rowsAtScroll > 30 && rowsAtScroll <= FIRST_PAGE - 60,
    `stall/backfill staging broken: scrolled with ${rowsAtScroll} of ${FIRST_PAGE} rows ` +
    'rendered — the backfill was not solidly in flight, so the gate under test was ' +
    'never exercised (verify by deleting the isBackfillActive() check in ' +
    'chat.ts maybeLoadEarlier: this smoke must go red)');
  assert(samples >= 2, 'sampler never observed an incomplete backfill');
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
