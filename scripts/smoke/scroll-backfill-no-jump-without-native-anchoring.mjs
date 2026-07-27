// FAILING-FIRST repro (field bug 2026-07-27, Jonathan): "when I'm
// scrolling in sessions the scroll often JUMPS. Some sort of loading
// artifact — if everything is loaded it seems to go away."
//
// Invariant pinned: while the user is ACTIVELY scrolling through a
// transcript whose older history is still backfilling (scroll-up
// pagination in flight / landing), the content at the user's eye level
// must not shift by more than the user's own input — even on a platform
// WITHOUT native CSS scroll anchoring.
//
// Mechanism (diagnosed via /tmp/scroll-jump-repro.mjs traces, 2026-07-27):
//   1. `.line { content-visibility: auto; contain-intrinsic-size: auto
//      100px }` means never-rendered rows above the viewport (fresh
//      backfill pages, cold rows) occupy 100px placeholders and settle to
//      real heights AS THE USER SCROLLS UP through them — each settle
//      changes the height of content ABOVE the viewport.
//   2. Chromium absorbs that with native scroll anchoring
//      (`overflow-anchor: auto` — styles/app.css calls it "our
//      scroll-jump fix"). iOS WKWebView — the CAP app, where the bug is
//      felt — DOES NOT IMPLEMENT scroll anchoring at all.
//   3. The app-level compensation (chat.prependHistory →
//      restoreDomAnchor's convergence loop) is killed by the user's own
//      wheel/touch gesture (#202 cancelPendingScrollRestores), so during
//      ACTIVE scrolling only the first synchronous re-seat runs; every
//      subsequent placeholder settle above the viewport lands
//      uncompensated → 60-105px eye-level jumps, repeatedly, until all
//      rows have been rendered once (contain-intrinsic-size:auto then
//      remembers real sizes → "goes away when everything is loaded").
//
// This smoke emulates the field platform by setting `overflow-anchor:
// none` on the transcript (WebKit behavior), drives REAL wheel scrolling
// via CDP while two slow load-earlier pages land, records the viewport-
// center bubble each frame, and fails on any single-frame eye-level
// shift not attributable to the user's wheel input. Measured on the
// unfixed tree: 10-19 jumps of 53-104px per run; with native anchoring
// left on (Chromium default): 0 — proving the app had no compensation
// of its own during user scrolling before the fix below landed.
//
// FIXED 2026-07-27: chat.ts's relative settle compensator (the
// [scroll-jump] block around ensureSettleCompensator) applies
// scrollTop += d in the same rendering update as each above-viewport
// settle whenever the transcript's effective overflow-anchor is none.
// It is deliberately gesture-IMMUNE — relative deltas compose with
// concurrent user scrolling, which is exactly the case restoreDomAnchor
// can't cover. Measured on this smoke: 19 jumps → 0; on the diag
// harness: --no-anchor 10 → 0, anchored control 0 → 0 (the compensator
// idles while the browser anchors — no double compensation).

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'scroll-backfill-no-jump-without-native-anchoring';
export const DESCRIPTION = 'active scrolling while load-earlier backfill lands must not shift the eye-level content (WebKit: no native scroll anchoring)';
export const STATUS = 'implemented';   // fix landed 2026-07-27 — see header
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-scroll-backfill-jump';
const TOTAL_MSGS = 320;
const FIRST_PAGE = 40;        // rows on the initial tail page → forces pagination
const FETCH_DELAY_MS = 700;   // slow-link /messages latency
const WHEEL_DY = -160;        // px per tick; negative = scroll up
const WHEEL_INTERVAL_MS = 45;
const DRIVE_MS = 9_000;
// Slack over attributed wheel input. Headless Chromium applies CDP wheel
// ticks instantly (verified: --disable-smooth-scrolling and default runs
// produce byte-identical jump sets), and a tick landing at a frame
// boundary is credited via the ±25ms attribution window below — so any
// same-bubble displacement beyond input+50px in ONE frame is not user
// motion. The uncompensated settles measure 61-104px; the anchored
// (Chromium-default) control run measures 0 events over this threshold.
const JUMP_THRESHOLD_PX = 50;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    // Varied heights so backfilled pages settle non-uniformly from their
    // 100px content-visibility placeholders — the real-content shape.
    // NO message_id: the mock only emits a numeric firstId pagination
    // cursor for auto-assigned integer ids (string ids disable
    // load-earlier entirely and the smoke would be vacuous).
    const reps = idx % 5 === 0 ? 14 : (idx % 3 === 0 ? 6 : 2);
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `jumpmsg-${idx} ${'content line for height variance '.repeat(reps)}`,
      sidekick_id: `jump-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Backfill scroll-jump repro',
    source: 'sidekick',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
  mock.setMessageDelay(CHAT_ID, FETCH_DELAY_MS);
}

export default async function run({ page, log }) {
  // Track load-earlier fetches so the run can prove backfill actually
  // engaged (boundary-adversarial: a smoke that never paginates would
  // pass vacuously).
  const backfills = [];
  page.on('request', (req) => {
    if (/\/messages\?.*before=/.test(req.url())) backfills.push(req.url());
  });

  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    (n) => (document.getElementById('transcript')?.textContent || '').includes(`jumpmsg-${n}`),
    TOTAL_MSGS,
    { timeout: 15_000, polling: 100 },
  );
  // Let every resume pass land (cache-cb + delayed server-cb + reconcile)
  // and the at-bottom repin window (1.5s) expire, so the only "loading"
  // in the recorded window is the scroll-driven backfill under test.
  await page.waitForTimeout(4500);

  // WebKit emulation: iOS WKWebView (CAP) has NO native scroll anchoring.
  // Chromium's overflow-anchor:auto otherwise absorbs the above-viewport
  // settles and masks the missing app-level compensation.
  await page.addStyleTag({ content: '#transcript { overflow-anchor: none; }' });

  // Per-frame recorder: the .line under the viewport CENTER is the
  // user's reading position — the thing that must not jump. Also record
  // wheel events (user input truth) for attribution.
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    const rec = { frames: [], wheel: [] };
    window.__jumpRec = rec;
    t.addEventListener('wheel', (e) => rec.wheel.push({ t: performance.now(), dy: e.deltaY }), { passive: true });
    const centerNow = () => {
      const r = t.getBoundingClientRect();
      let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      while (el && el !== t && !(el.classList?.contains('line') && el.hasAttribute('data-key'))) el = el.parentElement;
      if (!el || el === t) return { key: null, y: 0 };
      return { key: el.getAttribute('data-key'), y: Math.round(el.getBoundingClientRect().top - r.top) };
    };
    const step = () => {
      const c = centerNow();
      rec.frames.push({ t: performance.now(), st: t.scrollTop, sh: t.scrollHeight, key: c.key, y: c.y });
      if (!window.__jumpRecStop) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  // Drive REAL wheel scrolling (CDP input, not programmatic scrollTo) at
  // the transcript center for the whole window — through the top edge,
  // the in-flight fetches, and both prepend landings.
  const box = await page.evaluate(() => {
    const r = document.getElementById('transcript').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const cdp = await page.context().newCDPSession(page);
  const t0 = Date.now();
  while (Date.now() - t0 < DRIVE_MS) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: WHEEL_DY,
    });
    await page.waitForTimeout(WHEEL_INTERVAL_MS);
  }

  const rec = await page.evaluate(() => { window.__jumpRecStop = true; return window.__jumpRec; });
  assert(
    backfills.length >= 1,
    'load-earlier backfill never fired — the staged pagination window did not engage (vacuous run)',
  );
  log(`recorded ${rec.frames.length} frames, ${rec.wheel.length} wheel ticks, ${backfills.length} backfill fetches`);

  // A JUMP: between consecutive rAF frames, the SAME center bubble's
  // viewport-y moved farther than the user's wheel input (±25ms window
  // for boundary ticks) + threshold. Key handoffs (bubble scrolling past
  // center) are excluded — only same-key displacement counts.
  const wheelInputBetween = (a, b) =>
    rec.wheel.filter((w) => w.t > a - 25 && w.t <= b).reduce((s, w) => s + Math.abs(w.dy), 0);
  const jumps = [];
  for (let i = 1; i < rec.frames.length; i++) {
    const f0 = rec.frames[i - 1];
    const f1 = rec.frames[i];
    if (!f0.key || f0.key !== f1.key) continue;
    const shift = Math.abs(f1.y - f0.y);
    const input = wheelInputBetween(f0.t, f1.t);
    if (shift > input + JUMP_THRESHOLD_PX) {
      jumps.push({ t: Math.round(f1.t), key: f1.key, from: f0.y, to: f1.y, shift, input });
    }
  }
  for (const j of jumps.slice(0, 10)) log(`JUMP ${JSON.stringify(j)}`);
  assert(
    jumps.length === 0,
    `eye-level content jumped ${jumps.length}× during scroll-while-backfill ` +
    `(max shift ${Math.max(0, ...jumps.map((j) => j.shift))}px; threshold ${JUMP_THRESHOLD_PX}px over user input). ` +
    'Without native scroll anchoring (iOS WKWebView), above-viewport content-visibility settles land ' +
    'uncompensated while the user scrolls — restoreDomAnchor\'s convergence is gesture-cancelled (#202) ' +
    'and nothing replaces it.',
  );
  log('eye-level content held steady through backfill under active scrolling ✓');
}
