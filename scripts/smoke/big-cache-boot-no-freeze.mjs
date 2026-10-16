// Booting into (and switching to) a chat whose local cache holds
// thousands of rows must not freeze the page (field 2026-10-16, laptop
// dev-mode log: boot resume of [pitch deck] with 2,879 cached rows took
// 10.7 s on the main thread — ~535 bubbles each running autoScroll and a
// whole-transcript snapshot persist — and every click queued behind it:
// "a blocking cache-miss fill").
//
// Seeds a 2,900-row chat, opens it (cache fills), reloads (boot resume
// from the big cache), then measures main-thread blocking from
// navigation to settled, and a switch away and back.
import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'big-cache-boot-no-freeze';
export const DESCRIPTION = 'Boot resume and switch into a chat with ~2,900 cached rows stay responsive (no multi-second main-thread block)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const BIG = 'parley:mock-big-cache';
const OTHER = 'parley:mock-big-cache-other';
const N = 2900;

export function MOCK_SETUP(mock) {
  const t0 = Math.floor(Date.now() / 1000) - N * 30;
  const msgs = [];
  for (let i = 0; i < N; i += 2) {
    msgs.push({ role: 'user', content: `question ${i} — ` + 'some context words '.repeat(6), parley_id: `umsg_bc${i}`, timestamp: t0 + i * 30 });
    msgs.push({ role: 'assistant', content: `**Answer ${i}.** ` + 'A paragraph of reply text with a [link](https://example.com) and `code`. '.repeat(4), message_id: `msg_bc${i}`, timestamp: t0 + i * 30 + 10 });
  }
  mock.addChat(BIG, { title: 'Big cached chat', lastActiveAt: Date.now() - 1000, messages: msgs });
  mock.addChat(OTHER, { title: 'Small chat', lastActiveAt: Date.now() - 5000, messages: [
    { role: 'user', content: 'hi', parley_id: 'umsg_bco', timestamp: t0 }, { role: 'assistant', content: 'hello', message_id: 'msg_bco', timestamp: t0 + 1 } ] });
  mock.setHistoryFirstPageLimit?.(N);   // one page = the whole history, like a cache grown by scrolling back
}

const LT = () => {
  window.__lt = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true });
};
const open = (page, cid) => page.evaluate((c) => { document.body.classList.add('sidebar-expanded'); document.querySelector(`#sessions-list li[data-chat-id="${c}"] .sess-body`)?.dispatchEvent(new MouseEvent('click', { bubbles: true })); }, cid);
const blocking = (page, sinceMs = 0) => page.evaluate((s) => {
  const xs = window.__lt.filter((e) => e.start >= s);
  return { max: Math.round(Math.max(0, ...xs.map((e) => e.dur))), total: Math.round(xs.reduce((a, e) => a + e.dur, 0)) };
}, sinceMs);

export default async function run({ page, log }) {
  await page.addInitScript(LT);
  await waitForReady(page);
  await pollUntil(page, (cid) => !!document.querySelector(`#sessions-list li[data-chat-id="${cid}"]`), BIG, { timeout: 10000, label: 'big chat not listed' });
  await open(page, BIG);
  await pollUntil(page, () => /Answer 2898/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 30000, label: 'big chat did not paint' });
  await page.waitForTimeout(3000);   // the app's own cache write settles (one 200-row page)

  // Grow the cached transcript to the full history — the shape on his
  // laptop after scrolling far back (2,879 rows) — in the app's own IDB
  // cache format, rows exactly as the history endpoint serves them.
  const seeded = await page.evaluate(async ({ cid, n }) => {
    const rec = await new Promise((resolve, reject) => {
      const req = indexedDB.open('parley-sessions');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const get = db.transaction('messages', 'readonly').objectStore('messages').get(cid);
        get.onsuccess = () => resolve({ db, rec: get.result });
        get.onerror = () => reject(get.error);
      };
    });
    const { db, rec: cur } = rec;
    const tail = cur.messages;
    const t0 = tail[0];
    const base = (tail.find((m) => /question/.test(m.content || '')) || t0);
    const rows = [];
    const firstTs = Math.floor(Date.now() / 1000) - n * 30;
    for (let i = 0; i < n; i += 2) {
      rows.push({ id: 1000 + i, role: 'user', content: `question ${i} — ` + 'some context words '.repeat(6), parley_id: `umsg_bc${i}`, timestamp: firstTs + i * 30 });
      rows.push({ id: `msg_bc${i}`, role: 'assistant', content: `**Answer ${i}.** ` + 'A paragraph of reply text with a [link](https://example.com) and `code`. '.repeat(4), timestamp: firstTs + i * 30 + 10 });
    }
    void base;
    const next = { ...cur, messages: rows, pagination: { ...cur.pagination, firstId: 1000, hasMore: false, partial: false }, updatedAt: Date.now() };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').put(next);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    return rows.length;
  }, { cid: BIG, n: N });
  log(`seeded the IDB cache with ${seeded} rows`);

  // Boot resume from the big cache.
  const bootLogs = [];
  const onLog = (m) => { const t = m.text(); if (/boot-timing|chat-resume|window|replay|cache|mem-render|resume/i.test(t)) bootLogs.push(`${Date.now() % 100000} ${t.slice(0, 150)}`); };
  page.on('console', onLog);
  await page.addInitScript(() => { try { localStorage.setItem('parley_debug', '1'); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await pollUntil(page, () => /Answer 2898/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 30000, label: 'boot resume did not paint' });
  await page.waitForTimeout(2500);
  page.off('console', onLog);
  if (process.env.BOOT_TRACE) for (const l of bootLogs.slice(0, 40)) log('   ' + l);
  const boot = await blocking(page);
  log(`boot resume: longest block ${boot.max} ms, total ${boot.total} ms`);
  assert(boot.max < 400, `boot resume froze the page for ${boot.max} ms (field: 10.7 s)`);

  // Switch away and back.
  await open(page, OTHER);
  await pollUntil(page, () => /hello/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 8000, label: 'small chat did not paint' });
  await page.waitForTimeout(1500);
  const t0 = await page.evaluate(() => performance.now());
  await open(page, BIG);
  const hl = await page.evaluate(async (c) => { const t = performance.now(); while (performance.now() - t < 10000) { if (document.querySelector(`#sessions-list li[data-chat-id="${c}"].active`)) return Math.round(performance.now() - t); await new Promise((r) => setTimeout(r, 5)); } return -1; }, BIG);
  await pollUntil(page, () => /Answer 2898/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 15000, label: 'switch back did not paint' });
  await page.waitForTimeout(2500);
  const sw = await blocking(page, t0);
  log(`switch back: row highlighted in ${hl} ms, longest block ${sw.max} ms, total ${sw.total} ms`);
  assert(sw.max < 400, `switch back froze the page for ${sw.max} ms`);
}
