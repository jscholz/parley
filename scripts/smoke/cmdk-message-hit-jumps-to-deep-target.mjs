// Contract: clicking a cmd+K message hit jumps to the target —
// reliably, even under the rapid-click pattern Jonathan flagged
// 2026-06-23 reproducing on "pareto" ("matches very quickly… but when
// i click on the target session it doesn't jump there reliably.
// sometimes it does, but sometimes not on first, or even 4th click").
//
// Pre-fix behavior:
//   cmd+K activate() called backend.resumeSession + replaySessionMessages
//   directly, BYPASSING the switchController begin/commit machinery
//   that the drawer's drillTo path goes through. Without that
//   in-flight dedup, two clicks 200ms apart kicked off two parallel
//   resume pipelines that fought each other (paint-then-paint, switch-
//   then-switch); the second often clobbered the first's render before
//   the drill scroll fired, leaving the chat open at the tail. Tail
//   was rendered (chat looked correct from across the room) but the
//   target row was never centered, hence "click did nothing."
//
// Post-fix: message-hit activations route through main.ts
// drillToChatMessage → sessionDrawer.drillTo, which goes through
// switchCtl.begin/commit (single in-flight per chat) AND uses the
// bounded ?around=<msg_id> window so deep targets render even when
// they're below the initial tail.
//
// Repro shape: open cmd+K, search, then click the hit MULTIPLE times
// in quick succession (mirrors Jonathan's "even 4th click" pattern).
// Post-fix: dedup absorbs the dup clicks; the chat ends up rendered
// with the target row visible. Pre-fix: race depending on timing.
// We also assert the target is in viewport, not just in DOM, to
// catch the case where the around-window paints but scroll never
// fires.
//
// 2026-10-10 ("raptor" → pitch-deck session, chat never centred): the
// hit carries the state.db ROW id (what the plugin's search handed out
// for every row) while the bubble is keyed by the row's parley_id. The
// around window held the row; the DOM lookup by the row id found
// nothing; the client crawled ten tail pages with no spinner and gave
// up silently. The hit below therefore carries the INTEGER row id of a
// row that HAS a parley_id — the client must resolve either. The
// around fetch is slowed so the spinner has to show while it loads.

import {
  waitForReady, openSidebar, assert,
} from './lib.mjs';

export const NAME = 'cmdk-message-hit-jumps-to-deep-target';
export const DESCRIPTION = 'cmd+K message hit that points below the initial tail scrolls the transcript to the target (uses around-window, not tail-only)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'parley:mock-cmdk-deep-target';
const TAIL_LIMIT = 40; // matches the proxy default for /messages
// Total messages = TAIL + DEEP_GAP, so target sits below the tail's
// reach. The around-window fetch is required to surface it.
const DEEP_GAP = 60;
// Mock rows get integer ids 1000+index; the target is index 0.
const TARGET_ROW_ID = 1000;
const AROUND_DELAY_MS = 1200;   // slow link: the drill's load must be visible

export function MOCK_SETUP(mock) {
  const now = Date.now() / 1000;
  // Build a long message list: the DEEP target carries 'pareto'; the
  // rest are filler so the tail-only load can't possibly include it.
  const messages = [];
  // Deepest message — the search target. ts in the past so it sorts
  // first.
  messages.push({
    role: 'user',
    content: 'I keep thinking about the pareto frontier',
    parley_id: 'msg_deep_target',
    timestamp: now - (TAIL_LIMIT + DEEP_GAP) * 60,
  });
  // Filler messages between target and tail.
  for (let i = 0; i < TAIL_LIMIT + DEEP_GAP - 1; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `filler-${i}`,
      parley_id: `msg_filler_${i}`,
      timestamp: now - (TAIL_LIMIT + DEEP_GAP - 1 - i) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Deep target chat',
    source: 'parley',
    lastActiveAt: Date.now(),
    messages,
  });
  // Boot lands on the NEWEST chat: make that a different one, so the hit
  // is a cross-session drill (the field shape — searching from another
  // chat), not a same-session jump.
  mock.addChat('parley:mock-cmdk-decoy', {
    title: 'Somewhere else', source: 'parley', lastActiveAt: Date.now() + 1000,
    messages: [{ role: 'user', content: 'nothing to see here', parley_id: 'msg_decoy', timestamp: now }],
  });
  mock.setAutoReplyEnabled(false);
  // Only the tail loads on open (the mock otherwise serves the whole
  // chat and the target is already in the DOM — a vacuous drill).
  mock.setHistoryFirstPageLimit(TAIL_LIMIT);
  mock.setMessageDelay(CHAT_ID, AROUND_DELAY_MS);
}

export default async function run({ page, log }) {
  // Diagnostics for a failed spinner/drill assertion: the runner only
  // prints the last 30 console lines, which is after the drill's own.
  const trace = [];
  page.on('console', (m) => { const t = m.text(); if (/\[cmdk\]|\[drill|chat-resume\] enter|resumed |transcript-loading|windowCache|around/.test(t)) trace.push(t.slice(0, 200)); });
  const dumpTrace = () => { for (const l of trace.slice(-25)) log(`trace: ${l}`); };
  await waitForReady(page);

  // Mock the search endpoint to return a single hit pointing at the
  // deep target.
  await page.route('**/api/parley/search*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessions: [],
        hits: [{
          session_id: CHAT_ID,
          message_id: TARGET_ROW_ID,          // row id, NOT the parley_id the bubble is keyed by
          role: 'user',
          snippet: 'pareto frontier',
          timestamp: Math.floor(Date.now() / 1000) - 86_400,
          session_title: 'Deep target chat',
          session_source: 'parley',
        }],
      }),
    });
  });

  await openSidebar(page);
  await page.locator('#sb-search:visible').first().click();
  await page.waitForSelector('.cmdk-dialog[open]', { timeout: 5_000 });
  await page.fill('.cmdk-input', 'pareto');

  // The hit row appears after the 300ms debounce + mocked search.
  await page.waitForSelector(
    `.cmdk-row[data-kind="message"][data-id="${TARGET_ROW_ID}"]`,
    { timeout: 5_000 },
  );

  // Click the hit, then click it AGAIN ~200ms later — mirrors the
  // "1st, 2nd, even 4th click" pattern Jonathan reproduced. Pre-fix
  // the second click races the first's resume pipeline and can wipe
  // the drill state; post-fix the switchCtl dedup absorbs it.
  await page.click(
    `.cmdk-row[data-kind="message"][data-id="${TARGET_ROW_ID}"]`,
  );
  // "If there's a load required, the wheel should come up immediately":
  // the target is not in the tail, the around fetch is slow — the
  // transcript must show its loading state within a beat of the click.
  const spinnerAt = Date.now();
  await page.waitForSelector('#transcript.transcript-loading', { timeout: 400 })
    .catch(() => { dumpTrace(); throw new Error('no loading spinner within 400ms of clicking a deep hit that needs a fetch'); });
  log(`loading spinner up ${Date.now() - spinnerAt}ms after the click ✓`);
  // Second click — fire while the first is still in flight. The
  // palette closes on the first click, so we hit the row in the
  // drawer that's now visible (drillTo paints the active highlight
  // synchronously). If the dialog hasn't closed yet, the same row in
  // cmdk still works.
  try {
    await page.waitForTimeout(200);
    // Re-open the palette (it's already closed by first click) and
    // re-click — simulates the user impatient-double-tapping.
    await page.locator('#sb-search:visible').first().click({ timeout: 1_000 });
    await page.fill('.cmdk-input', 'pareto');
    await page.waitForSelector(
      `.cmdk-row[data-kind="message"][data-id="${TARGET_ROW_ID}"]`,
      { timeout: 3_000 },
    );
    await page.click(
      `.cmdk-row[data-kind="message"][data-id="${TARGET_ROW_ID}"]`,
    );
  } catch { /* dialog may already be closed / mid-transition — fine */ }

  // The cmdk dialog closes on activate.
  await page.waitForSelector('.cmdk-dialog[open]', {
    state: 'hidden', timeout: 5_000,
  });

  // Now the transcript must contain the target row. Wait for it to
  // appear in the DOM — the around-window fetch + projection takes a
  // beat. Without the fix this never satisfies because only the tail
  // ever renders.
  const targetSel = `#transcript [data-key="msg_deep_target"]`;
  await page.waitForSelector(targetSel, { timeout: 10_000 });

  // And the target must actually be in the viewport, not just in the
  // DOM. drillScrollTo centers it on screen with a flash.
  const inView = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight + 100;
  }, targetSel);
  assert(inView, 'target row must be in view after cmd+K click — drillScrollTo should have centered it');

  log('cmd+K deep message hit drilled to the target — around-window fetch + scroll ✓');
}
