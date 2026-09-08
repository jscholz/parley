// Session-switch scroll-jump repro (field bug, laptop PWA, 2026-09-0x).
//
// Distinct from scroll-jump-diag-harness.mjs (which drives continuous
// wheel scrolling through a scroll-BACK backfill). This scenario is a
// SESSION SWITCH: click into a chat → instant IndexedDB-cache render →
// hold a mid-transcript reading position → a DELAYED server reconcile
// lands with a MISMATCHED id space on the newest rows (the cache and
// the server page disagree, so sessionDrawer's sameTranscript() returns
// false and a full re-render replaces the transcript) → does the row
// the user is looking at stay at the same on-screen offset?
//
// Field trace this reproduces (see task brief): a session switch's cache
// render settles, then ~6s later the server fetch returns a page whose
// newest rows don't overlap the cached ones (two id spaces mixed in one
// chat — cache tail was ms-timestamp ids, server tail was small numeric
// ids). sessionDrawer.resume() drops the merge (cacheFuller requires
// overlap) and fires a full re-render. sameTranscript() is false purely
// because the id SEQUENCE differs — a length-only-equal transcript with
// different tail ids reproduces that condition without needing the mock
// to actually understand two id spaces.
//
// Usage: node scripts/scroll-jump-switch-repro.mjs [--headed]
//        [--base-url=URL] [--total-msgs=N] [--anchor-idx=N]
//        [--tail-mismatch=N] [--fetch-delay=N] [--assert-max-center-px=N]
//
// Prefer scripts/run-scroll-jump-switch-isolated.mjs, which builds the
// CURRENT worktree and boots its own throwaway server — never point
// --base-url at :3001 (see CONTRIBUTING.md → "Smoke tests"; that port is
// the owner's live deployment).

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
const BASE_URL = argStr('--base-url', DEFAULT_URL);
// Deliberately kept BELOW transcript/index.ts's WINDOW_MIN_TOTAL (80): at
// or above that threshold a session switch engages the windowed-replay
// pump (time-sliced backfill across many rAF frames), which has its own
// pinned/autoscroll interplay — a real mechanism, but a SEPARATE one from
// what this scenario targets (the plain anchor-restore path in
// replaySessionMessages). Keeping n<80 means both the cache render and
// the delayed server re-render are single synchronous full renders, so
// any jump we see is attributable to the restore logic under test, not
// pump/autoscroll cross-talk.
const TOTAL_MSGS = argNum('--total-msgs', 60);
const ANCHOR_MIN_IDX = argNum('--anchor-min-idx', 15);    // reject a settled anchor outside this safe band
const ANCHOR_MAX_IDX = argNum('--anchor-max-idx', 40);
// The mismatch band brackets the expected anchor band (with margin) —
// NOT a pure tail suffix. A tail-only mismatch (rows strictly BELOW the
// user's reading position) never moves the anchor: removing/inserting
// DOM nodes after a row can't shift that row's own rect.top. The real
// field bug put the user mid-transcript while the WHOLE page got
// replaced/reconciled around them, so the mismatch has to bracket
// (include) the row they're reading for a jump to even be possible.
const MISMATCH_START_IDX = argNum('--mismatch-start-idx', Math.max(1, ANCHOR_MIN_IDX - 10));
const MISMATCH_END_IDX = argNum('--mismatch-end-idx', ANCHOR_MAX_IDX + 10);
const FETCH_DELAY_MS = argNum('--fetch-delay', 4000);     // delayed server reconcile
const SETTLE_WAIT_MS = argNum('--settle-wait', 800);      // let the FIRST (real) render settle before scrolling
const POST_DELAY_SETTLE_MS = argNum('--post-settle', 2500); // watch window after the delayed render lands
const SCROLL_TICKS = argNum('--scroll-ticks', 10);
const WHEEL_DY = argNum('--wheel-dy', -160);

const CHAT_ID = 'mock-switch-jump-repro';
const OTHER_ID = 'mock-switch-jump-other';

function makeMessages(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const reps = idx % 5 === 0 ? 10 : (idx % 3 === 0 ? 4 : 2);
    out.push({
      role,
      content: `switchmsg-${idx} ${'content line for height variance '.repeat(reps)}`,
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
    '--disable-smooth-scrolling',
  ];
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: !HEADED, args });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const getConsole = attachConsoleCapture(page, 2000);

  await page.addInitScript(() => {
    window.__dbgTrace = [];
    const orig = console.log.bind(console);
    console.log = (...a) => {
      try {
        if (a[0] === '[dbg]') {
          const line = a.slice(1).map(x => String(x)).join(' ');
          if (/\[scroll-write\]|\[autoscroll\]|\[chat-resume\]|\[scroll-jump\]|sessionDrawer:|cmdk/.test(line)) {
            window.__dbgTrace.push({ t: performance.now(), line });
          }
        }
      } catch {}
      orig(...a);
    };
  });

  const mock = await installMockBackend(page);

  // Force the delta-resume path (proxyClient.ts fetchSessionMessagesDelta)
  // into its FALLBACK branch for CHAT_ID's switch-back: the real field
  // bug's "200-row page replaces a 215-row cache" shape comes from that
  // fallback (a bare, UN-MERGED newest-page fetch — see
  // proxyClient.ts:272), not the delta loop's normal success path (which
  // merges onto the cache and can't produce the reported id-space
  // collision because it only ever APPENDS rows newer than the cache's
  // own cursor). Failing the `after=` request specifically (leaving the
  // bare/`before=` mock routes untouched) reproduces exactly which path
  // the field trace took, without needing the mock to model two
  // genuinely disjoint id epochs. Registered AFTER installMockBackend so
  // it's tried first; falls through to the real mock for every other
  // request (visit 1 never even calls `after=` — no cache yet).
  await page.route(new RegExp(`/sessions/${CHAT_ID}/messages\\?.*after=`), async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'mock delta-resume outage' }) });
  });
  mock.addChat(CHAT_ID, {
    title: 'Switch jump repro',
    source: 'parley',
    messages: makeMessages(TOTAL_MSGS),
    lastActiveAt: Date.now() - 5000,
  });
  mock.addChat(OTHER_ID, {
    title: 'Other chat',
    source: 'parley',
    messages: makeMessages(5),
    lastActiveAt: Date.now() - 1000,
  });

  console.log(`[harness] base-url=${BASE_URL} total-msgs=${TOTAL_MSGS} mismatch-band=[${MISMATCH_START_IDX},${MISMATCH_END_IDX}] fetch-delay=${FETCH_DELAY_MS}`);
  await waitForReady(page, BASE_URL);
  await openSidebar(page);

  // ── Visit 1: populates the IndexedDB cache with the ORIGINAL tail ids.
  await clickRow(page, CHAT_ID);
  // Wait for every row to be PAINTED (not just "the last message's text
  // is somewhere in the DOM" — with windowing this can be true almost
  // immediately while a backfill is still growing the window). Below
  // WINDOW_MIN_TOTAL this render is a single synchronous full render, so
  // this should already be true on the first poll; the loop is a safety
  // margin, not a load-bearing wait.
  await page.waitForFunction(
    (total) => document.querySelectorAll('#transcript .line[data-key^="jump-"]').length === total,
    TOTAL_MSGS, { timeout: 15_000, polling: 50 },
  );
  // scrollHeight stability — no pending layout growth (image/tool-row
  // reflow, settle compensator) before we start scrolling.
  await page.waitForFunction(() => {
    const t = document.getElementById('transcript');
    if (!t) return false;
    if (window.__lastSh === t.scrollHeight && window.__lastShCount >= 3) return true;
    window.__lastShCount = window.__lastSh === t.scrollHeight ? (window.__lastShCount || 0) + 1 : 1;
    window.__lastSh = t.scrollHeight;
    return false;
  }, null, { timeout: 5_000, polling: 100 }).catch(() => {});
  await page.waitForTimeout(SETTLE_WAIT_MS);

  // Scroll to a mid-transcript reading position via REAL wheel input (so
  // isPinnedToBottom/lastUserGestureAt update exactly as a real user
  // action would), then let it settle so the anchor gets saved.
  const box = await page.evaluate(() => {
    const r = document.getElementById('transcript').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const cdp = await ctx.newCDPSession(page);
  for (let i = 0; i < SCROLL_TICKS; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: WHEEL_DY,
    });
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(600); // let the scroll listener's save land + settle compensator quiesce

  const anchorBeforeSwitch = await page.evaluate(() => {
    const t = document.getElementById('transcript');
    const ct = t.getBoundingClientRect().top;
    for (const el of t.querySelectorAll('.line[data-key]')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > ct + 1) return { key: el.getAttribute('data-key'), y: Math.round(r.top - ct) };
    }
    return null;
  });
  console.log(`[harness] anchor before switch-away: ${JSON.stringify(anchorBeforeSwitch)}`);
  const anchorIdxNum = anchorBeforeSwitch?.key ? Number(anchorBeforeSwitch.key.replace('jump-', '')) : null;
  if (anchorIdxNum == null || anchorIdxNum < ANCHOR_MIN_IDX || anchorIdxNum > ANCHOR_MAX_IDX) {
    console.log(`[harness] WARNING: anchor idx=${anchorIdxNum} outside safe band [${ANCHOR_MIN_IDX}, ${ANCHOR_MAX_IDX}] — tune --scroll-ticks/--wheel-dy`);
  }
  if (anchorIdxNum != null && (anchorIdxNum < MISMATCH_START_IDX || anchorIdxNum > MISMATCH_END_IDX)) {
    console.log(`[harness] WARNING: anchor idx=${anchorIdxNum} falls OUTSIDE the mismatch band [${MISMATCH_START_IDX},${MISMATCH_END_IDX}] — the mismatch can't move a row it doesn't touch; this run would trivially read 0px`);
  }

  // ── Leave the chat (flushes the scroll position) ───────────────────
  await clickRow(page, OTHER_ID);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('switchmsg-5'),
    null, { timeout: 10_000, polling: 100 },
  );
  // Let OTHER_ID's own (tiny) render fully settle so none of its layout
  // churn leaks into the recorded window below — this scenario is about
  // the SERVER RE-RENDER of CHAT_ID, not OTHER_ID's unrelated settle.
  await page.waitForTimeout(400);

  // ── Mutate the mock's tail rows so the NEXT server fetch disagrees
  //    with what's cached — same id SEQUENCE length, but rows in
  //    [MISMATCH_START_IDX, MISMATCH_END_IDX] (a band BRACKETING the
  //    user's reading position, not a pure tail suffix) get a NEW
  //    parley_id (data-key) as well as a new numeric id.
  //
  //    Two things learned getting here (both worth keeping as comments,
  //    not just history):
  //     1. Changing only message_id (leaving data-key/parley_id alone)
  //        is a no-op for the reconciler — keys.ts: "durable rows key
  //        off parley_id || id". With parley_id unchanged the
  //        reconciler sees IDENTICAL keys and does zero DOM work no
  //        matter what sessionDrawer's sameTranscript() (which compares
  //        `.id`, NOT parley_id) decided upstream. The real field bug's
  //        two id spaces are different KEYS, not just different `.id`s.
  //     2. A mismatch confined to rows BELOW the user's anchor never
  //        moves it: removing/inserting DOM nodes after a row can't
  //        shift that row's own rect.top. The field capture had the
  //        user mid-transcript while the page around them changed, so
  //        the mismatch has to BRACKET their reading position.
  const chat = mock.getChat(CHAT_ID);
  const n = chat.messages.length;
  const bandStart = Math.max(0, MISMATCH_START_IDX - 1); // 1-based → 0-based
  const bandEnd = Math.min(n, MISMATCH_END_IDX);
  for (let i = bandStart; i < bandEnd; i++) {
    // Deliberately a DIFFERENT height than the row it replaces (short,
    // fixed content) — a raw scrollTop restore only ever looks correct
    // by ACCIDENT when the swapped-in rows happen to occupy the same
    // height as what they replaced (as same-shape mock content does).
    // Real edits/replacements have no such guarantee — BUT deliberately
    // making every mutated row much SHORTER (as an earlier version of
    // this harness did) confounds the measurement below with pure row-
    // height variance: restoreDomAnchor preserves the row at the
    // viewport TOP exactly (by design — see chat.ts getDomAnchor), so
    // if rows between the anchor and the viewport CENTER change height,
    // the center measurement drifts even with a flawless anchor
    // restore, which isn't the mechanism this fix targets. Reuse
    // makeMessages' own height formula so mutated rows are a similar
    // SIZE to what they replace — isolating the measurement to "did the
    // KEY-based restore survive," not "did the content also change
    // shape."
    const idx1 = i + 1;
    const reps = idx1 % 5 === 0 ? 10 : (idx1 % 3 === 0 ? 4 : 2);
    chat.messages[i] = {
      ...chat.messages[i],
      message_id: 9_000_000 + i,
      parley_id: `ts-${9_000_000 + i}`,
      // Keep the ORIGINAL 1-based index readable in the text (as
      // "switchmsg-N") even though the key/id changed — lets the
      // analysis below identify "which logical row is under the
      // viewport" by CONTENT, independent of DOM key churn (a same-key
      // frame-to-frame tracker is blind exactly when the key itself
      // gets swapped out, which is the case this scenario forces).
      content: `switchmsg-${idx1} (edited) ${'content line for height variance '.repeat(reps)}`,
    };
  }
  console.log(`[harness] mutated rows [${bandStart + 1}, ${bandEnd}] (1-based) of ${n}`);
  mock.setMessageDelay(CHAT_ID, FETCH_DELAY_MS);

  // ── Switch back: this fires BOTH the instant cache render (from the
  //    IDB snapshot written by visit 1) AND the delayed server fetch
  //    (mocked above). Let the CACHE render's own insert + anchor-restore
  //    settle FIRST — its own transient churn (reconciler inserting rows
  //    one at a time, autoScroll firing per insert, restoreDomAnchor's
  //    multi-frame convergence) is a separate, already-transient event,
  //    not what this scenario measures. Recording starts clean, right
  //    before the delayed server response can land, so every frame in
  //    the recorded window is attributable to the SERVER re-render. ──
  const switchBackAt = Date.now();
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    (total) => document.querySelectorAll('#transcript .line[data-key^="jump-"]').length === total,
    TOTAL_MSGS, { timeout: 5_000, polling: 20 },
  ).catch(() => {});
  await page.waitForFunction(() => {
    const t = document.getElementById('transcript');
    if (!t) return false;
    if (window.__lastSh2 === t.scrollHeight && window.__lastSh2Count >= 3) return true;
    window.__lastSh2Count = window.__lastSh2 === t.scrollHeight ? (window.__lastSh2Count || 0) + 1 : 1;
    window.__lastSh2 = t.scrollHeight;
    return false;
  }, null, { timeout: 3_000, polling: 30 }).catch(() => {});
  await page.waitForTimeout(300); // restoreDomAnchor's rAF convergence tail

  const anchorAfterCacheRender = await page.evaluate(() => {
    const t = document.getElementById('transcript');
    const ct = t.getBoundingClientRect().top;
    for (const el of t.querySelectorAll('.line[data-key]')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > ct + 1) return { key: el.getAttribute('data-key'), y: Math.round(r.top - ct) };
    }
    return null;
  });
  console.log(`[harness] anchor after cache-render settle (pre-server-render): ${JSON.stringify(anchorAfterCacheRender)}`);

  // CONTENT-based reading-position check, independent of DOM key: a
  // same-key frame tracker (below) is structurally blind at the exact
  // moment a row's key gets swapped out from under it (the scenario this
  // harness forces on purpose) — there's no "same object" across that
  // swap to diff. Parsing "switchmsg-N" out of whatever bubble sits at
  // the viewport center answers the more basic question directly: is the
  // user looking at the SAME logical message, at the SAME pixel offset,
  // before and after? function is injected into the page both times so
  // "before"/"after" use identical logic.
  const centerLogicalFn = () => {
    const t = document.getElementById('transcript');
    const r = t.getBoundingClientRect();
    let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    while (el && el !== t && !(el.classList?.contains('line') && el.hasAttribute('data-key'))) el = el.parentElement;
    if (!el || el === t) return null;
    const m = (el.textContent || '').match(/switchmsg-(\d+)/);
    return { idx: m ? Number(m[1]) : null, key: el.getAttribute('data-key'), y: Math.round(el.getBoundingClientRect().top - r.top) };
  };
  const centerLogicalBefore = await page.evaluate(centerLogicalFn);
  console.log(`[harness] logical reading position BEFORE server re-render: ${JSON.stringify(centerLogicalBefore)}`);

  // ── Frame recorder (identical anchor/center definitions to
  //    scroll-jump-diag-harness.mjs) — armed AFTER the cache render has
  //    settled, so it captures ONLY the delayed server-render event. ──
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    const rec = { frames: [], scroll: [], epoch: performance.now() };
    window.__rec = rec;
    t.addEventListener('scroll', () => rec.scroll.push({ t: performance.now(), st: t.scrollTop, sh: t.scrollHeight }), { passive: true });
    const anchorNow = () => {
      const ct = t.getBoundingClientRect().top;
      for (const el of t.querySelectorAll('.line[data-key]')) {
        const r = el.getBoundingClientRect();
        if (r.bottom > ct + 1) return { key: el.getAttribute('data-key'), y: Math.round(r.top - ct) };
      }
      return { key: null, y: 0 };
    };
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

  // Wait through whatever remains of the delayed server reconcile + a
  // post-settle window. Some of FETCH_DELAY_MS has already elapsed while
  // we waited for the cache render to settle above.
  const elapsedSinceSwitchBack = Date.now() - switchBackAt;
  const remainingDelay = Math.max(0, FETCH_DELAY_MS - elapsedSinceSwitchBack);
  await page.waitForTimeout(remainingDelay + POST_DELAY_SETTLE_MS);

  const centerLogicalAfter = await page.evaluate(() => {
    const t = document.getElementById('transcript');
    const r = t.getBoundingClientRect();
    let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    while (el && el !== t && !(el.classList?.contains('line') && el.hasAttribute('data-key'))) el = el.parentElement;
    if (!el || el === t) return null;
    const m = (el.textContent || '').match(/switchmsg-(\d+)/);
    return { idx: m ? Number(m[1]) : null, key: el.getAttribute('data-key'), y: Math.round(el.getBoundingClientRect().top - r.top) };
  });
  console.log(`[harness] logical reading position AFTER server re-render + settle: ${JSON.stringify(centerLogicalAfter)}`);
  if (centerLogicalBefore?.idx != null && centerLogicalAfter?.idx != null) {
    console.log(`[harness] READING_INDEX_DRIFT=${centerLogicalAfter.idx - centerLogicalBefore.idx} rows  READING_Y_DRIFT_PX=${centerLogicalAfter.y - centerLogicalBefore.y}px`);
  }

  const data = await page.evaluate(() => { window.__recStop = true; return { rec: window.__rec, dbg: window.__dbgTrace }; });
  const out = {
    meta: { totalMsgs: TOTAL_MSGS, mismatchStartIdx: MISMATCH_START_IDX, mismatchEndIdx: MISMATCH_END_IDX, fetchDelayMs: FETCH_DELAY_MS, switchBackAt, anchorBeforeSwitch },
    ...data,
  };
  writeFileSync('/tmp/scroll-jump-switch-trace.json', JSON.stringify(out));
  console.log(`recorded ${data.rec.frames.length} frames, ${data.rec.scroll.length} scroll events, ${data.dbg.length} dbg lines`);

  const frames = data.rec.frames;

  // No wheel input during the recorded window (the user let go of the
  // wheel before switching away) — any frame-to-frame shift on the SAME
  // tracked row is entirely app-caused.
  let maxDeviation = 0, maxDeviationDetail = null;
  let maxCenterDeviation = 0, maxCenterDeviationDetail = null;
  for (let i = 1; i < frames.length; i++) {
    const f0 = frames[i - 1], f1 = frames[i];
    if (f0.key && f0.key === f1.key) {
      const residual = Math.abs(f1.y - f0.y);
      if (residual > maxDeviation) {
        maxDeviation = residual;
        maxDeviationDetail = { t: f1.t, key: f1.key, from: f0.y, to: f1.y, onScreen: f0.y >= 0 && f1.y >= 0 };
      }
    }
    if (f0.ckey && f0.ckey === f1.ckey) {
      const residual = Math.abs(f1.cy - f0.cy);
      if (residual > maxCenterDeviation) {
        maxCenterDeviation = residual;
        maxCenterDeviationDetail = { t: f1.t, key: f1.ckey, from: f0.cy, to: f1.cy };
      }
    }
  }

  console.log(`\nMAX_DEVIATION_PX=${Math.round(maxDeviation)}  (anchor-tracked; may be off-screen)`);
  if (maxDeviationDetail) {
    console.log('  detail:', JSON.stringify(maxDeviationDetail));
    for (const d of data.dbg) if (Math.abs(d.t - maxDeviationDetail.t) < 200) console.log(`    dbg@${Math.round(d.t)}: ${d.line}`);
  }
  console.log(`MAX_CENTER_DEVIATION_PX=${Math.round(maxCenterDeviation)}  (center-tracked; always on-screen — the acceptance number)`);
  if (maxCenterDeviationDetail) {
    console.log('  detail:', JSON.stringify(maxCenterDeviationDetail));
    for (const d of data.dbg) if (Math.abs(d.t - maxCenterDeviationDetail.t) < 200) console.log(`    dbg@${Math.round(d.t)}: ${d.line}`);
  }

  // Dump the dbg trace around the switch-back so a human/agent can see
  // exactly which resume rung fired without re-running under --headed.
  console.log('\n--- dbg trace (full) ---');
  for (const d of data.dbg) console.log(`  dbg@${Math.round(d.t)}: ${d.line}`);

  await browser.close();

  const assertMaxCenterPx = argNum('--assert-max-center-px', null);
  if (assertMaxCenterPx !== null && maxCenterDeviation > assertMaxCenterPx) {
    console.error(`\nFAIL: MAX_CENTER_DEVIATION_PX=${Math.round(maxCenterDeviation)} exceeds --assert-max-center-px=${assertMaxCenterPx}`);
    process.exit(1);
  }
  // READING_Y_DRIFT_PX is the acceptance number for THIS scenario (see
  // the comment above centerLogicalFn): a same-key tracker like
  // MAX_CENTER_DEVIATION_PX is structurally blind exactly when the
  // scenario swaps the key out from under the viewport center, which is
  // the whole point of the mismatch band. It answers "is the user
  // looking at the same message, same pixel, before and after."
  const assertMaxReadingDriftPx = argNum('--assert-max-reading-drift-px', null);
  const readingDrift = (centerLogicalBefore?.idx != null && centerLogicalAfter?.idx != null)
    ? Math.abs(centerLogicalAfter.y - centerLogicalBefore.y) : null;
  if (assertMaxReadingDriftPx !== null && readingDrift !== null && readingDrift > assertMaxReadingDriftPx) {
    console.error(`\nFAIL: READING_Y_DRIFT_PX=${readingDrift} exceeds --assert-max-reading-drift-px=${assertMaxReadingDriftPx}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
