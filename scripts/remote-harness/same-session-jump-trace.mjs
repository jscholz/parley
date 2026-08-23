#!/usr/bin/env node
// Remote Playwright harness: trace SAME-SESSION deep pin jumps.
//
// Regression guard: jumping BETWEEN pin views WITHIN one long session
// is slow (5-20s), while interleaving with OTHER sessions is fast. The
// sibling open-in-chat-trace.mjs deliberately drifts to a neutral row
// between clicks (cross-session); this one does the OPPOSITE: it stays
// inside one chat and jumps among that chat's pins back-to-back, which
// is the exact slow case.
//
// Env:
//   PARLEY_URL   (default http://127.0.0.1:3001)
//   CHAT           bare/full chat id to confine jumps to (default the
//                  pitch deck: ae6435b5-53aa-4819-b594-d21652c89397)
//   DRILL_TIMEOUT  ms to wait for the target bubble (default 30000)
//   PROFILE_DIR    persistent profile (default ~/.parley-harness-profile)

import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

const URL = process.env.PARLEY_URL || process.env.PARLEY_URL || 'https://fontbrain.taile0c895.ts.net:3001';
const CHAT_FILTER = (process.env.CHAT || 'ae6435b5-53aa-4819-b594-d21652c89397').replace(/^parley:/, '');
const DRILL_TIMEOUT = Number(process.env.DRILL_TIMEOUT || 30000);
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(os.homedir(), '.parley-harness-profile');

function instrument() {
  const T = (window.__trace = { clickT: 0, fetches: [] });
  const rel = (u) => String(u || '').replace(/^https?:\/\/[^/]+/, '');
  const interesting = (u) =>
    /\/sessions\/[^/]+\/messages/.test(u) || /\/items\b/.test(u) || /loadEarlier/i.test(u);
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const u = rel(typeof args[0] === 'string' ? args[0] : args[0] && args[0].url);
    if (!interesting(u)) return origFetch.apply(this, args);
    const rec = { url: u, start: performance.now(), end: null, bytes: null };
    T.fetches.push(rec);
    return origFetch.apply(this, args).then(
      async (r) => {
        rec.end = performance.now();
        try { rec.bytes = Number(r.clone().headers.get('content-length')) || null; } catch {}
        return r;
      },
      (e) => { rec.end = performance.now(); rec.error = String(e); throw e; },
    );
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPins(page) {
  return page.evaluate(() => {
    const cands = [...document.querySelectorAll('#btn-pin-drawer, #btn-pin-drawer-rail')];
    const btn = cands.find((e) => e.offsetParent !== null) || cands[0];
    if (btn) btn.click();
    return !!btn;
  });
}

async function drill(page, msgId) {
  await page.evaluate(() => {
    window.__trace.clickT = performance.now();
    window.__trace.fetches.length = 0;
  });
  const clickWall = Date.now();
  await page.evaluate((mid) => {
    const btn = document.querySelector(`.pin-drawer-item[data-msg-id="${CSS.escape(mid)}"] .pin-item-jump-btn`);
    if (btn) btn.click();
  }, msgId);

  let bubbleVisibleAt = null;
  let bubbleExistsAt = null;
  const deadline = Date.now() + DRILL_TIMEOUT;
  while (Date.now() < deadline) {
    const st = await page.evaluate((key) => {
      const el = document.querySelector(`#transcript [data-key="${CSS.escape(key)}"]`);
      if (!el) return { exists: false, visible: false };
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || 900;
      return { exists: true, visible: r.height > 0 && r.bottom > 0 && r.top < vh };
    }, msgId);
    if (st.exists && bubbleExistsAt == null) bubbleExistsAt = Date.now();
    if (st.visible) { bubbleVisibleAt = Date.now(); break; }
    await sleep(80);
  }
  await sleep(1500);  // capture late background refetch
  const trace = await page.evaluate(() => {
    const T = window.__trace, base = T.clickT;
    return T.fetches.map((f) => ({
      url: f.url,
      start: Math.round(f.start - base),
      ms: f.end == null ? null : Math.round(f.end - f.start),
      bytes: f.bytes,
    }));
  });
  return {
    msgId,
    clickToBubbleMs: bubbleVisibleAt ? bubbleVisibleAt - clickWall : null,
    clickToExistsMs: bubbleExistsAt ? bubbleExistsAt - clickWall : null,
    bubbleVisible: !!bubbleVisibleAt,
    fetches: trace,
  };
}

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true,
  });
  const report = { url: URL, chatFilter: CHAT_FILTER, jumps: [] };
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.addInitScript(instrument);
    page.on('console', (m) => { if (process.env.VERBOSE) console.error('[page]', m.text()); });
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#sessions-list li[data-chat-id]', { state: 'attached', timeout: 45000 });

    if (!(await openPins(page))) throw new Error('pins drawer toggle not found');
    await page.waitForSelector('.pin-drawer-item .pin-item-jump-btn', { state: 'attached', timeout: 15000 });

    const allPins = await page.$$eval('.pin-drawer-item', (els) =>
      els.map((el) => ({ chatId: el.getAttribute('data-chat-id'), msgId: el.getAttribute('data-msg-id') })));
    const pins = allPins.filter((p) => String(p.chatId || '').replace(/^parley:/, '') === CHAT_FILTER);
    report.pinsInChat = pins.length;
    if (pins.length < 2) throw new Error(`need >=2 pins in chat ${CHAT_FILTER}, found ${pins.length}`);

    // First jump = cold open of the session to a deep target (cross-session
    // entry). Subsequent jumps are SAME-SESSION (the slow case) — no drift.
    for (let i = 0; i < pins.length; i++) {
      await openPins(page);  // drawer may toggle shut after a drill
      await page.waitForSelector(`.pin-drawer-item[data-msg-id="${pins[i].msgId}"] .pin-item-jump-btn`,
        { state: 'attached', timeout: 10000 }).catch(() => {});
      const r = await drill(page, pins[i].msgId);
      r.kind = i === 0 ? 'cold-open (cross-session entry)' : 'SAME-SESSION jump';
      report.jumps.push(r);
    }
  } catch (e) {
    report.error = String((e && e.stack) || e);
  } finally {
    await ctx.close();
  }
  console.log(JSON.stringify(report, null, 2));
}

main();
