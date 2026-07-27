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
// Usage: node /tmp/scroll-jump-repro.mjs [--headed] [--no-disable-smooth]
//        [--stop-mid-flight]

import { chromium } from '/home/jscholz/code/sidekick/node_modules/playwright-core/index.mjs';
import {
  CHROMIUM, DEFAULT_URL, waitForReady, openSidebar, clickRow,
  attachConsoleCapture,
} from '/home/jscholz/code/sidekick/scripts/smoke/lib.mjs';
import { installMockBackend } from '/home/jscholz/code/sidekick/scripts/smoke/mock-backend.mjs';
import { writeFileSync } from 'node:fs';

const HEADED = process.argv.includes('--headed');
const DISABLE_SMOOTH = !process.argv.includes('--no-disable-smooth');
const STOP_MID_FLIGHT = process.argv.includes('--stop-mid-flight');
// Emulate iOS WKWebView (the field platform, CAP): WebKit implements NO
// CSS scroll anchoring, so the browser never compensates when content
// above the viewport changes height. Chromium's overflow-anchor:auto was
// masking the app-level compensation gaps in runs 1-3.
const NO_ANCHOR = process.argv.includes('--no-anchor');

const CHAT_ID = 'mock-scroll-jump-repro';
const TOTAL_MSGS = 320;
const FIRST_PAGE = 40;      // rows on the initial tail page
const FETCH_DELAY_MS = 700; // slow-link /messages latency
const WHEEL_DY = -160;      // px per tick, negative = scroll up
const WHEEL_INTERVAL_MS = 45;
const DRIVE_MS = 9_000;

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
      sidekick_id: `jump-${idx}`,
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
    source: 'sidekick',
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

  await waitForReady(page); // ?debug=1 → scroll-write tracing installed
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes(`jumpmsg-${320}`),
    null, { timeout: 15_000, polling: 100 },
  );
  // Let ALL resume passes land (cache-cb + delayed server-cb + reconcile)
  // and the at-bottom repin window (1.5s) expire, so the drive starts from
  // a settled tail-anchored view and every subsequent scroll write is
  // attributable to the backfill-during-scroll path under test.
  // NOTE: variant 1 (drive at 1.4s) caught the scheduleAtBottomRepin RO
  // yanking against the user when the slow server render lands mid-scroll.
  await page.waitForTimeout(4500);

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

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
