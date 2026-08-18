#!/usr/bin/env node
// Remote Playwright harness: trace the Parley "Open in chat" drill.
//
// Runs on a remote machine (jons-macbook-air) so we can exploit real
// network distance to fontbrain/London — the latency is what surfaces
// the drill race (slow highlight flicker + redundant transcript fetches).
//
// Drives installed Google Chrome via channel:'chrome' with a dedicated
// throwaway profile. Headless: no window, never touches a running browser.
//
// Instruments page-side:
//   - MutationObserver on #sessions-list → timestamped active-row data-chat-id
//     (catches the target→origin→target highlight flicker)
//   - fetch + XHR hooks → timings for /sessions/*/messages, /items, loadEarlier
//   - target bubble [data-key] visibility poll
//
// Scenario: open the pins drawer, click a .pin-item-jump-btn, record until
// the target bubble is on screen (or timeout). Repeats to measure cold (cache
// miss) vs warm (cached) — the user reports it "never gets faster" warm.
//
// Env:
//   PARLEY_URL   (default https://fontbrain.taile0c895.ts.net:3001)
//   PIN_INDEX      which pin to click (default 0)
//   REPEATS        click count: 1=cold only, 2=cold+warm (default 2)
//   DRILL_TIMEOUT  ms to wait for bubble visible (default 30000)
//   PROFILE_DIR    persistent profile (default ~/.sidekick-harness-profile)

import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

const URL = process.env.PARLEY_URL || process.env.PARLEY_URL || 'https://fontbrain.taile0c895.ts.net:3001';
const PIN_INDEX = Number(process.env.PIN_INDEX || 0);
const REPEATS = Number(process.env.REPEATS || 2);
const DRILL_TIMEOUT = Number(process.env.DRILL_TIMEOUT || 30000);
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(os.homedir(), '.parley-harness-profile');

// Injected into every page before app scripts. Sets up trace buffers +
// hooks. Timings are raw performance.now(); the runner stamps clickT and
// rebases in the report.
function instrument() {
  const T = (window.__trace = {
    clickT: 0,
    fetches: [],      // { url, start, end }
    activeRows: [],   // { id, t }
  });

  const rel = (u) => String(u || '').replace(/^https?:\/\/[^/]+/, '');
  const interesting = (u) =>
    /\/sessions\/[^/]+\/messages/.test(u) ||
    /\/items\b/.test(u) ||
    /[?&](before|firstId|after|around)=/.test(u) ||
    /loadEarlier/i.test(u);

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const u = rel(typeof args[0] === 'string' ? args[0] : args[0] && args[0].url);
    if (!interesting(u)) return origFetch.apply(this, args);
    const rec = { url: u, start: performance.now(), end: null };
    T.fetches.push(rec);
    return origFetch.apply(this, args).then(
      (r) => { rec.end = performance.now(); return r; },
      (e) => { rec.end = performance.now(); rec.error = String(e); throw e; },
    );
  };

  const OrigXHR = window.XMLHttpRequest;
  function HookedXHR() {
    const xhr = new OrigXHR();
    let rec = null;
    const open = xhr.open;
    xhr.open = function (method, url, ...rest) {
      const u = rel(url);
      if (interesting(u)) { rec = { url: u, start: 0, end: null, xhr: true }; }
      return open.call(this, method, url, ...rest);
    };
    const send = xhr.send;
    xhr.send = function (...a) {
      if (rec) { rec.start = performance.now(); T.fetches.push(rec); }
      xhr.addEventListener('loadend', () => { if (rec) rec.end = performance.now(); });
      return send.apply(this, a);
    };
    return xhr;
  }
  window.XMLHttpRequest = HookedXHR;

  const recordActive = (list) => {
    const active = list.querySelector('li.active');
    const id = active ? active.getAttribute('data-chat-id') : null;
    const last = T.activeRows[T.activeRows.length - 1];
    if (!last || last.id !== id) T.activeRows.push({ id, t: performance.now() });
  };
  const attach = () => {
    const list = document.getElementById('sessions-list');
    if (!list) { setTimeout(attach, 100); return; }
    const obs = new MutationObserver(() => recordActive(list));
    obs.observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    recordActive(list);
  };
  attach();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const report = { url: URL, pinIndex: PIN_INDEX, runs: [] };
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.addInitScript(instrument);

    page.on('console', (m) => { if (process.env.VERBOSE) console.error('[page]', m.text()); });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // App boot: drawer rows arrive a few seconds in over the link. They
    // live in a collapsed drawer (attached but not "visible") so wait on
    // attachment, not visibility.
    await page.waitForSelector('#sessions-list li[data-chat-id]', { state: 'attached', timeout: 45000 });

    // Open the pins drawer. Toggle exists in two variants (rail + drawer);
    // one is display:none depending on layout, so click the visible one via
    // JS (fires the same handler, no layout box required).
    const openPins = () => page.evaluate(() => {
      const cands = [...document.querySelectorAll('#btn-pin-drawer, #btn-pin-drawer-rail')];
      const btn = cands.find((e) => e.offsetParent !== null) || cands[0];
      if (btn) btn.click();
      return !!btn;
    });
    if (!(await openPins())) throw new Error('pins drawer toggle not found');
    await page.waitForSelector('.pin-drawer-item .pin-item-jump-btn', { state: 'attached', timeout: 15000 });

    const pins = await page.$$eval('.pin-drawer-item', (els) =>
      els.map((el) => ({ chatId: el.getAttribute('data-chat-id'), msgId: el.getAttribute('data-msg-id') })),
    );
    if (!pins.length) throw new Error('no pins to drill');
    const target = pins[PIN_INDEX] || pins[0];
    // Sidebar rows are keyed `sidekick:<uuid>`; pins may store either form.
    const bareId = String(target.chatId || '').replace(/^parley:/, '');
    const tgtIds = [bareId, `sidekick:${bareId}`];
    report.target = target;

    for (let run = 0; run < REPEATS; run++) {
      // Drift back to a neutral session so each run is a real cross-session
      // drill (not a no-op same-session click). Click the first sidebar row
      // that ISN'T the target.
      await page.evaluate((tgt) => {
        const rows = [...document.querySelectorAll('#sessions-list li[data-chat-id]')];
        const row = rows.find((r) => !tgt.includes(r.getAttribute('data-chat-id')));
        if (row) row.click();
      }, tgtIds);
      await sleep(1500);

      // Re-open pins (switching sessions may have changed the drawer).
      await openPins();
      await page.waitForSelector('.pin-drawer-item .pin-item-jump-btn', { state: 'attached', timeout: 10000 }).catch(() => {});

      const present = await page.$(`.pin-drawer-item[data-msg-id="${target.msgId}"] .pin-item-jump-btn`);
      if (!present) { report.runs.push({ run, error: 'jump button gone' }); continue; }

      // Reset trace + stamp click time, then click the jump button via JS
      // (fires the exact onclick → drill → onPinClick path).
      await page.evaluate(() => {
        window.__trace.clickT = performance.now();
        window.__trace.fetches.length = 0;
        window.__trace.activeRows.length = 0;
      });
      const clickWall = Date.now();
      await page.evaluate((msgId) => {
        const btn = document.querySelector(`.pin-drawer-item[data-msg-id="${CSS.escape(msgId)}"] .pin-item-jump-btn`);
        if (btn) btn.click();
      }, target.msgId);

      // Wait until target bubble is visible (intersects viewport) or timeout.
      // Also record when the bubble first EXISTS in the DOM (rendered but
      // maybe not scrolled to) — distinguishes a scroll failure from a deep
      // target that needs pagination to even render.
      let bubbleVisibleAt = null;
      let bubbleExistsAt = null;
      const deadline = Date.now() + DRILL_TIMEOUT;
      while (Date.now() < deadline) {
        const st = await page.evaluate((key) => {
          const el = document.querySelector(`#transcript [data-key="${CSS.escape(key)}"]`);
          if (!el) return { exists: false, visible: false };
          const r = el.getBoundingClientRect();
          const vh = window.innerHeight || 900;
          const visible = r.height > 0 && r.bottom > 0 && r.top < vh;
          return { exists: true, visible };
        }, target.msgId);
        if (st.exists && bubbleExistsAt == null) bubbleExistsAt = Date.now();
        if (st.visible) { bubbleVisibleAt = Date.now(); break; }
        await sleep(100);
      }

      // Settle a moment to capture any late flicker / background refetch.
      await sleep(2000);

      const trace = await page.evaluate(() => {
        const T = window.__trace;
        const base = T.clickT;
        return {
          activeRows: T.activeRows.map((r) => ({ id: r.id, t: Math.round(r.t - base) })),
          fetches: T.fetches.map((f) => ({
            url: f.url,
            start: Math.round(f.start - base),
            end: f.end == null ? null : Math.round(f.end - base),
            xhr: !!f.xhr,
          })),
        };
      });

      // First active-row transition to the target after click = highlight time.
      const firstTargetActive = trace.activeRows.find((r) => r.id && tgtIds.includes(r.id));
      // Flicker = active-row settled on something OTHER than target after a
      // first target hit (target→origin→target).
      const flicker = (() => {
        let sawTarget = false, flips = 0;
        for (const r of trace.activeRows) {
          const isTgt = r.id && tgtIds.includes(r.id);
          if (isTgt) sawTarget = true;
          else if (sawTarget && r.id) flips++;
        }
        return flips;
      })();

      report.runs.push({
        run,
        kind: run === 0 ? 'cold' : 'warm',
        clickToBubbleMs: bubbleVisibleAt ? bubbleVisibleAt - clickWall : null,
        clickToBubbleExistsMs: bubbleExistsAt ? bubbleExistsAt - clickWall : null,
        bubbleVisible: !!bubbleVisibleAt,
        bubbleEverRendered: !!bubbleExistsAt,
        clickToHighlightMs: firstTargetActive ? firstTargetActive.t : null,
        highlightFlips: flicker,
        transcriptFetches: trace.fetches.length,
        activeRowSequence: trace.activeRows,
        fetches: trace.fetches,
      });
    }
  } catch (e) {
    report.error = String(e && e.stack || e);
  } finally {
    await ctx.close();
  }
  console.log(JSON.stringify(report, null, 2));
}

main();
