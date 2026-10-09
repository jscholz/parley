// A reconcile landing on a slow link must never move the reading position.
//
// Field 2026-10-09 (morning walk, CAP, cellular): phone out of the
// pocket after a long idle, "started scrolling around in one of the
// sessions, and then it did a big jump". Two things land late on a slow
// link while the user is already scrolling:
//   A. the FOREGROUND RECONCILE of the chat on screen (proxyClient:
//      long gap / replay_gap → refetch the transcript →
//      replaySessionMessages with preserveScrollIfLive) — the tail page
//      carries turns that arrived while away, so the store merge is not
//      a no-op. Triggered here through the server's `replay_gap` event
//      (#204), the same reconcile path as a 12-hour gap, so no fake
//      clock (which stalls the mobile viewport's rAF);
//   B. the SERVER CALLBACK of a drawer switch (sessionDrawer.resume:
//      instant cache render, then the /messages fetch seconds later
//      with a transcript that differs → full replay + saved-position
//      restore).
// Both run while the user is mid-scroll. Nothing in either path may
// displace the eye-level bubble by more than the user's own input, and
// neither may snap to the live edge.
//
// WebKit emulation: iOS has no native scroll anchoring, so
// overflow-anchor:none — Chromium would otherwise absorb above-viewport
// shifts and mask app-level regressions.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'foreground-reconcile-no-jump';
export const DESCRIPTION = 'A slow-link reconcile (long-gap foreground, or a drawer switch\'s late server callback) landing mid-scroll never displaces the reading position nor snaps to the live edge (no native anchoring)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const CHAT = 'mock-walk-reconcile';
const OTHER = 'mock-walk-other';
const TOTAL = 160;
const FIRST_PAGE = 60;
const FETCH_DELAY_MS = 1800;      // cellular /messages latency
const WHEEL_DY = -140;
const WHEEL_INTERVAL_MS = 45;
const JUMP_THRESHOLD_PX = 50;
const EDGE_SNAP_PX = 600;         // the read bubble moved > a mobile viewport in one frame

function buildMessages(n, extra = 0) {
  const out = [];
  for (let i = 0; i < n + extra; i++) {
    const idx = i + 1;
    const reps = idx % 5 === 0 ? 14 : (idx % 3 === 0 ? 6 : 2);
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `walkmsg-${idx} ${'content line for height variance '.repeat(reps)}`,
      parley_id: `walk-${idx}`,
      timestamp: Date.now() / 1000 - (n + extra - idx) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  mock.addChat(CHAT, { title: 'Walk reconcile', source: 'parley', messages: buildMessages(TOTAL), lastActiveAt: Date.now() - 1000 });
  mock.addChat(OTHER, { title: 'Elsewhere', source: 'parley', messages: buildMessages(6), lastActiveAt: Date.now() - 2000 });
}

/** Open a chat by firing the session row's own click handler — the
 *  production path (resumeSession → cache render → server callback) —
 *  without the sidebar UI, which the mobile-emulated viewport cannot
 *  click through (see pin-drawer-cycle-scrollback). */
async function openChat(page, chatId) {
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, chatId);
}

const TRACE_RE = /chat-resume\]|sessionDrawer: resumed|cache-match|server-render|proxy-client: reconcil|forceScrollToBottom|restoreDomAnchor|windowed|prependHistory|\[scroll-jump\]|mergeTail|transcript-loading|clear\(/;

async function installRecorder(page) {
  await page.addStyleTag({ content: '#transcript { overflow-anchor: none; }' });
  await page.evaluate((tickPx) => {
    const t = document.getElementById('transcript');
    const rec = { frames: [], wheel: [] };
    window.__jumpRec = rec;
    window.__jumpRecStop = false;
    // Credit each tick with the CSS px it scrolls, not e.deltaY: under the
    // mobile emulation (deviceScaleFactor 3) CDP reports deltaY/3 while
    // the scroller still moves the full tick.
    t.addEventListener('wheel', () => rec.wheel.push({ t: performance.now(), dy: tickPx }), { passive: true });
    const centerNow = () => {
      const r = t.getBoundingClientRect();
      let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      while (el && el !== t && !(el.classList?.contains('line') && el.hasAttribute('data-key'))) el = el.parentElement;
      if (!el || el === t) return { key: null, y: 0 };
      return { key: el.getAttribute('data-key'), y: Math.round(el.getBoundingClientRect().top - r.top) };
    };
    let prevKey = null;
    const step = () => {
      const c = centerNow();
      // Where did the bubble that was under the eye LAST frame go? (null:
      // it is no longer in the DOM.) A real jump is that bubble leaving
      // the neighbourhood of the viewport; scrollTop alone cannot tell a
      // snap from a load-earlier re-seat that moves scrollTop by the
      // prepended height while every visible bubble stays put.
      let prevY = null;
      if (prevKey) {
        const el = t.querySelector(`.line[data-key="${CSS.escape(prevKey)}"]`);
        if (el) prevY = Math.round(el.getBoundingClientRect().top - t.getBoundingClientRect().top);
      }
      rec.frames.push({ t: performance.now(), st: t.scrollTop, sh: t.scrollHeight, ch: t.clientHeight, key: c.key, y: c.y, prevY });
      prevKey = c.key;
      if (!window.__jumpRecStop) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, Math.abs(WHEEL_DY));
}

async function driveWheel(page, cdp, ms) {
  const box = await page.evaluate(() => {
    const r = document.getElementById('transcript').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: WHEEL_DY });
    await page.waitForTimeout(WHEEL_INTERVAL_MS);
  }
}

function findJumps(rec) {
  const inputBetween = (a, b) => rec.wheel.filter((w) => w.t > a - 25 && w.t <= b).reduce((s, w) => s + Math.abs(w.dy), 0);
  const jumps = [];
  for (let i = 1; i < rec.frames.length; i++) {
    const f0 = rec.frames[i - 1], f1 = rec.frames[i];
    const input = inputBetween(f0.t, f1.t);
    if (f0.key && f0.key === f1.key) {
      // The SAME bubble displaced more than the user's own input: an
      // uncompensated settle or a restore fighting the user. (scrollTop
      // alone is not evidence — the settle compensator's writes change
      // scrollTop precisely so the eye-level content does NOT move.)
      const shift = Math.abs(f1.y - f0.y);
      if (shift > input + JUMP_THRESHOLD_PX) jumps.push({ kind: 'shift', t: Math.round(f1.t), key: f1.key, from: f0.y, to: f1.y, shift, input });
    } else if (f0.key) {
      // A different bubble under the eye: the one the user was reading
      // must still be within a viewport of where it was (a snap to an
      // edge or a collapse throws it thousands of px away or out of the
      // DOM). Load-earlier re-seats move scrollTop by the prepended height
      // but leave every visible bubble where it was, so they pass.
      if (f1.prevY == null) jumps.push({ kind: 'vanished', t: Math.round(f1.t), fromKey: f0.key, toKey: f1.key, from: f0.st, to: f1.st, shift: Math.abs(f1.st - f0.st), input });
      else if (Math.abs(f1.prevY - f0.y) > input + EDGE_SNAP_PX) jumps.push({ kind: 'snap', t: Math.round(f1.t), fromKey: f0.key, toKey: f1.key, prevWas: f0.y, prevNow: f1.prevY, shift: Math.abs(f1.prevY - f0.y), input });
    }
  }
  return jumps;
}

export default async function run({ page, log, mock }) {
  const fetches = [];
  page.on('response', (r) => { if (r.url().includes(`/sessions/${CHAT}/messages`) && !/before=/.test(r.url())) fetches.push({ t: Date.now(), status: r.status() }); });
  const cdp = await page.context().newCDPSession(page);
  const trace = [];
  page.on('console', (m) => { const t = m.text(); if (TRACE_RE.test(t)) trace.push(`${Date.now() % 100000} ${t.replace(/http:\/\/[^ ]*\/build\//g, '').slice(0, 220)}`); });
  const dumpTrace = (label) => { for (const l of trace.slice(-40)) log(`${label} trace: ${l}`); };

  await waitForReady(page);
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT}"]`, { state: 'attached', timeout: 10_000 });
  await openChat(page, CHAT);
  await page.waitForFunction((n) => (document.getElementById('transcript')?.textContent || '').includes(`walkmsg-${n}`), TOTAL, { timeout: 15_000, polling: 100 });
  await page.waitForTimeout(2500);                                        // resume passes + repin window settle
  log('chat on screen at the live edge ✓');

  // ── A. long-gap foreground reconcile lands mid-scroll ──────────────
  // Overnight: three turns arrived that this client never saw (addChat
  // replaces silently), and the link is slow.
  mock.addChat(CHAT, { title: 'Walk reconcile', source: 'parley', messages: buildMessages(TOTAL, 3), lastActiveAt: Date.now() });
  mock.setMessageDelay(CHAT, FETCH_DELAY_MS);
  await installRecorder(page);
  const fetchesBefore = fetches.length;
  // The stream comes back with a cursor the ring no longer covers: the
  // server says replay_gap, proxyClient owes a reconcile (500ms debounce).
  mock.emitReplayGap('ring evicted while backgrounded');
  // The user is already scrolling up when the reconcile is scheduled
  // and when its fetch lands (~2.3s later, slow link).
  await driveWheel(page, cdp, 4_000);
  let rec = await page.evaluate(() => { window.__jumpRecStop = true; return window.__jumpRec; });
  assert(fetches.length > fetchesBefore, 'the long-gap reconcile never fetched the transcript (vacuous run)');
  const landedA = await page.evaluate((n) => (document.getElementById('transcript')?.textContent || '').includes(`walkmsg-${n}`), TOTAL + 3);
  assert(landedA, 'the reconcile did not render the overnight turns (vacuous run)');
  let jumps = findJumps(rec);
  if (jumps.length) dumpTrace('A');
  for (const j of jumps.slice(0, 8)) log(`A JUMP ${JSON.stringify(j)}`);
  const lastA = rec.frames[rec.frames.length - 1];
  assert(lastA.sh - lastA.st - lastA.ch > 300, `A: the view ended at the live edge (${lastA.sh - lastA.st - lastA.ch}px from bottom) — the reconcile snapped the scrolled-up user to the bottom`);
  assert(jumps.length === 0, `A: eye-level content jumped ${jumps.length}× while the long-gap reconcile landed mid-scroll (max ${Math.max(0, ...jumps.map((j) => j.shift))}px)`);
  log(`A: long-gap reconcile landed mid-scroll, ${rec.frames.length} frames, no jump ✓`);

  // ── B. drawer switch: instant cache render, server callback lands late ─
  // Park at the live edge again (the position he left the chat in), go
  // elsewhere, let more turns arrive, come back on the slow link and
  // scroll up at once.
  mock.setMessageDelay(CHAT, 0);
  await page.evaluate(() => document.getElementById('transcript').scrollTo({ top: 1e9, behavior: 'instant' }));
  await page.waitForTimeout(800);
  trace.length = 0;
  await openChat(page, OTHER);
  await page.waitForFunction(() => (document.getElementById('transcript')?.textContent || '').includes('walkmsg-6'), null, { timeout: 8_000, polling: 100 });
  mock.addChat(CHAT, { title: 'Walk reconcile', source: 'parley', messages: buildMessages(TOTAL, 6), lastActiveAt: Date.now() });
  mock.setMessageDelay(CHAT, FETCH_DELAY_MS);
  const fetchesB = fetches.length;
  await openChat(page, CHAT);
  await page.waitForFunction((n) => (document.getElementById('transcript')?.textContent || '').includes(`walkmsg-${n}`), TOTAL, { timeout: 8_000, polling: 50 });
  await installRecorder(page);
  await driveWheel(page, cdp, 4_000);
  rec = await page.evaluate(() => { window.__jumpRecStop = true; return window.__jumpRec; });
  assert(fetches.length > fetchesB, 'B: the switch never fetched the transcript from the server (vacuous run)');
  const landedB = await page.evaluate((n) => (document.getElementById('transcript')?.textContent || '').includes(`walkmsg-${n}`), TOTAL + 6);
  assert(landedB, 'B: the late server callback did not render the new turns (vacuous run)');
  jumps = findJumps(rec);
  if (jumps.length) dumpTrace('B');
  for (const j of jumps.slice(0, 8)) log(`B JUMP ${JSON.stringify(j)}`);
  const lastB = rec.frames[rec.frames.length - 1];
  assert(lastB.sh - lastB.st - lastB.ch > 300, `B: the view ended at the live edge (${lastB.sh - lastB.st - lastB.ch}px from bottom) — the late server callback snapped the scrolled-up user to the bottom`);
  assert(jumps.length === 0, `B: eye-level content jumped ${jumps.length}× while the late server callback landed mid-scroll (max ${Math.max(0, ...jumps.map((j) => j.shift))}px)`);
  log(`B: late server callback landed mid-scroll, ${rec.frames.length} frames, no jump ✓`);
}
