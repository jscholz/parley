// Scroll-jump repro harness (exploration; field bug 2026-07-27).
// Long chat forcing windowed pagination + slow /messages fetches; drive
// REAL wheel scrolling via CDP Input.dispatchMouseEvent while load-earlier
// backfill lands. Records per-frame scrollTop/scrollHeight + a DOM anchor
// (first visible .line[data-key]) + all [scroll-write]/[autoscroll] diag
// lines (captured in-page with performance.now() for exact correlation).
//
// JUMP definition:
//   (a) the same anchor bubble's viewport-y shifts between consecutive
//       rAF frames by far more than the user's wheel input could explain, or
//   (b) scrollTop moves AGAINST the user's scroll direction (down while
//       the user only ever wheels up) by > threshold.
//
// Usage: node scripts/scroll-jump-diag-harness.mjs [--headed] [--no-disable-smooth]
//        [--stop-mid-flight] [--wheel-dy=N] [--wheel-interval=N]
//        [--settle-wait=N] [--base-url=URL] [--total-msgs=N]
//        [--first-page=N] [--fetch-delay=N] [--drive-ms=N]
//
// --base-url (default http://127.0.0.1:3001, so old invocations are
//   unchanged): the harness has NO server of its own — it only mocks
//   /api/parley/* via Playwright page.route(); the static PWA shell still
//   has to come from a real HTTP origin. Pointing this at :3001
//   unconditionally means every run drives the OWNER'S LIVE deployment,
//   which is silent as long as nobody rebuilds between arms — that
//   produced a false "55px before, 0px after" result on 2026-09-0x (both
//   numbers came from the same unrebuilt code). Prefer
//   scripts/run-scroll-jump-diag-isolated.mjs, which builds the CURRENT
//   worktree, boots a throwaway server on a free port, and passes its
//   --base-url through automatically.
// --total-msgs / --first-page / --fetch-delay / --drive-ms: knobs for
//   reaching the MID-ZONE repro (backfill lands while scrollTop is
//   comfortably above the top edge, not clamped to 0) rather than only
//   the top-edge case. A longer transcript + gentler wheel + a SHORT
//   fetch delay makes a prepend land before continuous wheeling has
//   walked scrollTop down to 0. See prependHistory's temporary
//   [scroll-jump] prepend-snapshot diag line (chat.ts) and the
//   PREPEND SNAPSHOTS report section below for proof either way.
//
// --wheel-dy / --wheel-interval (field 2026-09-05, laptop PWA race):
//   the defaults (-160px every 45ms) fling through the whole document
//   fast enough to catch MANY settle-driven jumps quickly, but each CDP
//   dispatch is a coarse, discrete tick — good for the content-visibility
//   settle-storm case, but unlikely to land inside the narrow synchronous
//   window between prependHistory's pre-render snapshot and its
//   restoreDomAnchor write. A gentler, higher-frequency drive
//   (--wheel-dy=-28 --wheel-interval=8, ~60Hz) trades traversal speed for
//   many more chances to land a tick inside that window — this is what
//   reproduced the reported laptop/Chromium jump (55px residual on a
//   tracked bubble, restoreDomAnchor writing scrollTop 0→9300 mid-drive).
// --settle-wait: ms to wait after the initial replay completes before the
//   drive starts (default 4500, calibrated for the default drive). The
//   initial multi-pass resume cascade this mock chat needs to reach
//   msg 320 can itself take >10s of page-time; if the drive/recorder
//   attaches before that cascade's own restoreDomAnchor calls finish, they
//   get misattributed to the synthetic drive. Bump this if `dbg` lines
//   show resume-cascade restoreDomAnchor calls landing after the drive
//   starts.

import { chromium } from '/home/jscholz/code/parley/node_modules/playwright-core/index.mjs';
import {
  CHROMIUM, DEFAULT_URL, waitForReady, openSidebar, clickRow,
  attachConsoleCapture,
} from '/home/jscholz/code/parley/scripts/smoke/lib.mjs';
import { installMockBackend } from '/home/jscholz/code/parley/scripts/smoke/mock-backend.mjs';
import { writeFileSync } from 'node:fs';

function argNum(flag, dflt) {
  const arg = process.argv.find(a => a.startsWith(`${flag}=`));
  return arg ? Number(arg.slice(flag.length + 1)) : dflt;
}
function argStr(flag, dflt) {
  const arg = process.argv.find(a => a.startsWith(`${flag}=`));
  return arg ? arg.slice(flag.length + 1) : dflt;
}

const HEADED = process.argv.includes('--headed');
const DISABLE_SMOOTH = !process.argv.includes('--no-disable-smooth');
const STOP_MID_FLIGHT = process.argv.includes('--stop-mid-flight');
// Emulate iOS WKWebView (the field platform, CAP): WebKit implements NO
// CSS scroll anchoring, so the browser never compensates when content
// above the viewport changes height. Chromium's overflow-anchor:auto was
// masking the app-level compensation gaps in runs 1-3.
const NO_ANCHOR = process.argv.includes('--no-anchor');

const CHAT_ID = 'mock-scroll-jump-repro';
const BASE_URL = argStr('--base-url', DEFAULT_URL);
const TOTAL_MSGS = argNum('--total-msgs', 320);
const FIRST_PAGE = argNum('--first-page', 40);       // rows on the initial tail page
const FETCH_DELAY_MS = argNum('--fetch-delay', 700); // slow-link /messages latency
const WHEEL_DY = argNum('--wheel-dy', -160);          // px per tick, negative = scroll up
const WHEEL_INTERVAL_MS = argNum('--wheel-interval', 45);
const SETTLE_WAIT_MS = argNum('--settle-wait', 4500);
const DRIVE_MS = argNum('--drive-ms', 9_000);

function makeMessages(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    // Varied heights: mostly short, every 5th tall — so prepended pages
    // change scrollHeight non-uniformly like real content.
    const reps = idx % 5 === 0 ? 14 : (idx % 3 === 0 ? 6 : 2);
    out.push({
      role,
      content: `jumpmsg-${idx} ${'content line for height variance '.repeat(reps)}`,
      // NO message_id: the mock only emits a numeric firstId pagination
      // cursor when ids are the auto-assigned integers (string ids →
      // firstId null → load-earlier disabled).
      parley_id: `jump-${idx}`,
      timestamp: Date.now() / 1000 - (count - idx) * 60,
    });
  }
  return out;
}

async function main() {
  const args = [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ];
  if (DISABLE_SMOOTH) args.push('--disable-smooth-scrolling');
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: !HEADED, args });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const getConsole = attachConsoleCapture(page, 2000);

  // In-page trace: catch [dbg] console lines (diag routes through
  // console.log('[dbg]', ...)) with performance.now() so [scroll-write]
  // lines correlate exactly with the frame recorder.
  await page.addInitScript(() => {
    window.__dbgTrace = [];
    const orig = console.log.bind(console);
    console.log = (...a) => {
      try {
        if (a[0] === '[dbg]') {
          const line = a.slice(1).map(x => String(x)).join(' ');
          if (/\[scroll-write\]|\[autoscroll\]|\[chat-resume\]|loadEarlier|\[scroll-jump\]/.test(line)) {
            window.__dbgTrace.push({ t: performance.now(), line });
          }
        }
      } catch {}
      orig(...a);
    };
  });

  const mock = await installMockBackend(page);
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  mock.addChat(CHAT_ID, {
    title: 'Scroll jump repro',
    source: 'parley',
    messages: makeMessages(TOTAL_MSGS),
    lastActiveAt: Date.now() - 1000,
  });
  mock.setMessageDelay(CHAT_ID, FETCH_DELAY_MS);

  // Track /messages?before= fetches node-side for landing times.
  const fetches = [];
  page.on('request', (req) => {
    if (/\/messages\?.*before=/.test(req.url())) fetches.push({ url: req.url(), start: Date.now() });
  });
  page.on('response', (res) => {
    const f = fetches.find(f => f.url === res.url() && !f.end);
    if (f) f.end = Date.now();
  });

  console.log(`[harness] base-url=${BASE_URL} total-msgs=${TOTAL_MSGS} first-page=${FIRST_PAGE} fetch-delay=${FETCH_DELAY_MS} wheel-dy=${WHEEL_DY} wheel-interval=${WHEEL_INTERVAL_MS} drive-ms=${DRIVE_MS}`);
  await waitForReady(page, BASE_URL); // ?debug=1 → scroll-write tracing installed
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    (total) => (document.getElementById('transcript')?.textContent || '').includes(`jumpmsg-${total}`),
    TOTAL_MSGS, { timeout: 15_000, polling: 100 },
  );
  // Let ALL resume passes land (cache-cb + delayed server-cb + reconcile)
  // and the at-bottom repin window (1.5s) expire, so the drive starts from
  // a settled tail-anchored view and every subsequent scroll write is
  // attributable to the backfill-during-scroll path under test.
  // NOTE: variant 1 (drive at 1.4s) caught the scheduleAtBottomRepin RO
  // yanking against the user when the slow server render lands mid-scroll.
  await page.waitForTimeout(SETTLE_WAIT_MS);

  if (NO_ANCHOR) {
    await page.addStyleTag({ content: '#transcript { overflow-anchor: none; }' });
    console.log('WebKit emulation: overflow-anchor disabled on transcript');
  }

  // Frame/wheel/scroll recorder.
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    const rec = { frames: [], wheel: [], scroll: [], epoch: performance.now() };
    window.__rec = rec;
    t.addEventListener('wheel', (e) => rec.wheel.push({ t: performance.now(), dy: e.deltaY }), { passive: true });
    t.addEventListener('scroll', () => rec.scroll.push({ t: performance.now(), st: t.scrollTop, sh: t.scrollHeight }), { passive: true });
    const anchorNow = () => {
      const ct = t.getBoundingClientRect().top;
      for (const el of t.querySelectorAll('.line[data-key]')) {
        const r = el.getBoundingClientRect();
        if (r.bottom > ct + 1) return { key: el.getAttribute('data-key'), y: Math.round(r.top - ct) };
      }
      return { key: null, y: 0 };
    };
    // The user's READING position: the .line under the viewport center.
    // Distinguishes a real visible jump from the first-visible anchor's own
    // remeasure (its top can move while on-screen content stays put).
    const centerNow = () => {
      const r = t.getBoundingClientRect();
      let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      while (el && el !== t && !(el.classList?.contains('line') && el.hasAttribute('data-key'))) el = el.parentElement;
      if (!el || el === t) return { ckey: null, cy: 0 };
      return { ckey: el.getAttribute('data-key'), cy: Math.round(el.getBoundingClientRect().top - r.top) };
    };
    const step = () => {
      const a = anchorNow();
      const c = centerNow();
      rec.frames.push({ t: performance.now(), st: t.scrollTop, sh: t.scrollHeight, key: a.key, y: a.y, ckey: c.ckey, cy: c.cy });
      if (!window.__recStop) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  // Drive REAL wheel scrolling through CDP at the transcript center.
  const box = await page.evaluate(() => {
    const r = document.getElementById('transcript').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const cdp = await ctx.newCDPSession(page);
  const t0 = Date.now();
  let ticks = 0;
  while (Date.now() - t0 < DRIVE_MS) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: WHEEL_DY,
    });
    ticks++;
    if (STOP_MID_FLIGHT) {
      // Variant: stop wheeling as soon as a backfill fetch is in flight,
      // hold a stationary reading position while it lands.
      const inflight = fetches.some(f => !f.end);
      if (inflight) break;
    }
    await page.waitForTimeout(WHEEL_INTERVAL_MS);
  }
  // Post-drive settle window: watch for late shifts with no user input.
  await page.waitForTimeout(2500);

  const data = await page.evaluate(() => { window.__recStop = true; return { rec: window.__rec, dbg: window.__dbgTrace }; });
  const out = {
    meta: { ticks, wheelDy: WHEEL_DY, disableSmooth: DISABLE_SMOOTH, stopMidFlight: STOP_MID_FLIGHT, fetches },
    ...data,
  };
  writeFileSync('/tmp/scroll-jump-trace.json', JSON.stringify(out));
  console.log(`recorded ${data.rec.frames.length} frames, ${data.rec.scroll.length} scroll events, ${data.rec.wheel.length} wheel events, ${data.dbg.length} dbg lines, ${fetches.length} backfill fetches`);

  // ── Analysis ──────────────────────────────────────────────────────────
  const frames = data.rec.frames;
  const wheel = data.rec.wheel;
  const lastWheelBefore = (t) => {
    let last = -Infinity;
    for (const w of wheel) { if (w.t <= t) last = w.t; else break; }
    return last;
  };
  const wheelInputBetween = (a, b) =>
    wheel.filter(w => w.t > a && w.t <= b).reduce((s, w) => s + Math.abs(w.dy), 0);

  const jumps = [];
  for (let i = 1; i < frames.length; i++) {
    const f0 = frames[i - 1], f1 = frames[i];
    // Widen the attribution window 25ms before the pair: a wheel tick
    // landing right at the frame boundary applies in the NEXT frame.
    const input = wheelInputBetween(f0.t - 25, f1.t);
    // (a) same-anchor viewport shift beyond user input + slack
    if (f0.key && f0.key === f1.key) {
      const shift = Math.abs(f1.y - f0.y);
      if (shift > input + 60) {
        jumps.push({ kind: 'anchor-shift', t: f1.t, key: f1.key, from: f0.y, to: f1.y, shift, input });
      }
    }
    // (a') CENTER-element shift — the user-visible reading position.
    if (f0.ckey && f0.ckey === f1.ckey) {
      const shift = Math.abs(f1.cy - f0.cy);
      if (shift > input + 60) {
        jumps.push({ kind: 'center-shift', t: f1.t, key: f1.ckey, from: f0.cy, to: f1.cy, shift, input });
      }
    }
    // (b) scrollTop moved DOWN (user only wheels up). Exclude prepend
    // compensation: those frames also grow scrollHeight by ≈ the same px.
    const dst = f1.st - f0.st;
    const dsh = f1.sh - f0.sh;
    if (dst > 60 + input && Math.abs(dst - dsh) > 60) {
      jumps.push({ kind: 'scrolltop-reversal', t: f1.t, dst, dsh, input, st: f1.st });
    }
  }
  console.log(`\nJUMPS DETECTED: ${jumps.length}`);
  for (const j of jumps.slice(0, 40)) {
    console.log(' ', JSON.stringify(j));
    // Nearby dbg lines (±120ms)
    for (const d of data.dbg) {
      if (Math.abs(d.t - j.t) < 120) console.log(`      dbg@${Math.round(d.t)}: ${d.line}`);
    }
  }
  if (!jumps.length) {
    console.log('no jumps by detector; dumping scroll-write lines during drive for review:');
    for (const d of data.dbg.slice(-60)) console.log(`  dbg@${Math.round(d.t)}: ${d.line}`);
  }

  // ── MAX_DEVIATION_PX — the acceptance metric ────────────────────────
  // For every consecutive frame pair where the SAME ANCHOR bubble (the
  // first-visible .line — an internal bookkeeping handle, NOT necessarily
  // on-screen; it can be tracked while scrolled fully above the viewport)
  // is present in both frames, the residual = |Δy| beyond what the
  // wheel input in that window could explain. 0 kinds compensation is
  // invisible; the JUMPS list above uses a wider +60px slack tuned to
  // suppress noise, so this can be nonzero even when JUMPS DETECTED=0.
  //
  // CAVEAT (field 2026-09-08, top-edge investigation): this metric nets
  // out only WHEEL input, not compensated content growth — unlike the
  // scrolltop-reversal check above, which treats a scrollTop delta as
  // benign when scrollHeight grew by ~the same amount. A settle-storm
  // correction pass that is fully explained by matching scrollHeight
  // growth (dst≈dsh, i.e. provably invisible to anything not itself
  // resizing) can still register a nonzero anchor residual here, because
  // the anchor tracked at that instant was off-screen (y<0, scrolled
  // above the viewport) and its OWN measured position wobbles slightly
  // as nearby still-settling content resolves — see MAX_CENTER_DEVIATION_PX
  // below for the user-visible-reading-position version of this same
  // measurement, which is what actually answers "would the user have
  // seen this."
  let maxDeviation = 0;
  let maxDeviationDetail = null;
  for (let i = 1; i < frames.length; i++) {
    const f0 = frames[i - 1], f1 = frames[i];
    const input = wheelInputBetween(f0.t - 25, f1.t);
    if (f0.key && f0.key === f1.key) {
      const residual = Math.max(0, Math.abs(f1.y - f0.y) - input);
      if (residual > maxDeviation) {
        maxDeviation = residual;
        maxDeviationDetail = { t: f1.t, key: f1.key, from: f0.y, to: f1.y, input, onScreen: f0.y >= 0 && f1.y >= 0 };
      }
    }
  }
  console.log(`\nMAX_DEVIATION_PX=${Math.round(maxDeviation)}  (anchor-tracked; may be off-screen — see onScreen below and MAX_CENTER_DEVIATION_PX)`);
  if (maxDeviationDetail) {
    console.log('  detail:', JSON.stringify(maxDeviationDetail));
    for (const d of data.dbg) {
      if (Math.abs(d.t - maxDeviationDetail.t) < 150) console.log(`    dbg@${Math.round(d.t)}: ${d.line}`);
    }
  }

  // ── MAX_CENTER_DEVIATION_PX — the user-visible-reading-position version
  // Identical math, but tracked on the CENTER element (the .line under
  // the viewport's vertical midpoint) rather than the first-visible
  // anchor. This is the harness's own definition of "the user's READING
  // position" (see centerNow()'s comment above) and is ALWAYS on-screen
  // by construction — so a nonzero value here is a real, would-have-
  // been-seen jump, not an artifact of an off-screen bookkeeping handle
  // remeasuring. Prefer this number when judging user impact; keep
  // MAX_DEVIATION_PX (anchor) only as a secondary diagnostic — it can
  // cry wolf (see the caveat above) on settle-storm frames where the
  // anchor is transiently above the viewport.
  let maxCenterDeviation = 0;
  let maxCenterDeviationDetail = null;
  for (let i = 1; i < frames.length; i++) {
    const f0 = frames[i - 1], f1 = frames[i];
    const input = wheelInputBetween(f0.t - 25, f1.t);
    if (f0.ckey && f0.ckey === f1.ckey) {
      const residual = Math.max(0, Math.abs(f1.cy - f0.cy) - input);
      if (residual > maxCenterDeviation) {
        maxCenterDeviation = residual;
        maxCenterDeviationDetail = { t: f1.t, key: f1.ckey, from: f0.cy, to: f1.cy, input };
      }
    }
  }
  console.log(`MAX_CENTER_DEVIATION_PX=${Math.round(maxCenterDeviation)}  (center-tracked; always on-screen — the number that answers "did the user see a jump")`);
  if (maxCenterDeviationDetail) {
    console.log('  detail:', JSON.stringify(maxCenterDeviationDetail));
    for (const d of data.dbg) {
      if (Math.abs(d.t - maxCenterDeviationDetail.t) < 150) console.log(`    dbg@${Math.round(d.t)}: ${d.line}`);
    }
  }

  // ── PREPEND SNAPSHOTS — proof the MID-ZONE case was exercised ──────
  // Reads the temporary `[scroll-jump] prepend-snapshot` diag line added
  // to chat.ts's prependHistory (both arms): for every prepend, the
  // scrollTop AT the pre-render snapshot and how long ago the last user
  // scroll gesture landed. shouldSeatAbsolutely's gesture-fresh path
  // (the candidate fix) only ever engages when scrollTop > TOP_EDGE_PX
  // (8) AND the gesture is fresh (< UPWARD_GESTURE_FRESH_MS, 400 on the
  // fix branch) — i.e. exactly the MID_ZONE_LO..150 band below with
  // freshGesture=true. A run where every snapshot is at scrollTop<=8 (or
  // every gesture is stale) never touches the changed code path and is
  // not a valid arm for this scenario.
  const TOP_EDGE_PX = 8;
  const LOAD_EARLIER_THRESHOLD_PX = 150;
  const GESTURE_FRESH_MS = 400;
  const snapRe = /\[scroll-jump\] prepend-snapshot scrollTop=(-?\d+) gestureAgeMs=(-?\d+)/;
  const snapshots = [];
  for (const d of data.dbg) {
    const m = d.line.match(snapRe);
    if (m) snapshots.push({ t: d.t, scrollTop: Number(m[1]), gestureAgeMs: Number(m[2]) });
  }
  console.log(`\nPREPEND SNAPSHOTS: ${snapshots.length}`);
  let midZoneFreshCount = 0;
  for (const s of snapshots) {
    const midZone = s.scrollTop > TOP_EDGE_PX && s.scrollTop <= LOAD_EARLIER_THRESHOLD_PX;
    const freshGesture = s.gestureAgeMs < GESTURE_FRESH_MS;
    if (midZone && freshGesture) midZoneFreshCount++;
    console.log(`  t=${Math.round(s.t)} scrollTop=${s.scrollTop} gestureAgeMs=${s.gestureAgeMs} midZone=${midZone} freshGesture=${freshGesture}`);
  }
  console.log(`MID_ZONE_FRESH_GESTURE_PREPENDS=${midZoneFreshCount} (band: ${TOP_EDGE_PX}px < scrollTop <= ${LOAD_EARLIER_THRESHOLD_PX}px, gestureAgeMs < ${GESTURE_FRESH_MS})`);

  await browser.close();

  const assertMaxPx = argNum('--assert-max-px', null);
  if (assertMaxPx !== null && maxDeviation > assertMaxPx) {
    console.error(`\nFAIL: MAX_DEVIATION_PX=${Math.round(maxDeviation)} exceeds --assert-max-px=${assertMaxPx}`);
    process.exit(1);
  }
  // Playwright/CDP can leave a handle open that keeps the event loop
  // alive past browser.close() — exit explicitly so a passing run (no
  // --assert-max-px violation) doesn't need a timeout(1) to reap it.
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
