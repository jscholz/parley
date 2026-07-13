// Latency audit A1 (2026-07-13): session delete is OPTIMISTIC — the
// row disappears synchronously at confirm; the server DELETE settles
// in the background. On server failure the row comes BACK with an
// error status (visible failure, not a silent zombie).

import { waitForReady, openSidebar, waitForDrawerQuiet } from './lib.mjs';

export const NAME = 'session-delete-optimistic';
export const DESCRIPTION = 'Delete removes the row instantly (no server wait); a failed DELETE restores the row with an error status';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-del-chat-a';
const CHAT_B = 'mock-del-chat-b';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 120;
  mock.addChat(CHAT_A, {
    title: 'Delete me',
    messages: [{ role: 'user', content: 'DEL-A-SEED', sidekick_id: 'umsg_del_a', timestamp: t0 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addChat(CHAT_B, {
    title: 'Keep me',
    messages: [{ role: 'user', content: 'DEL-B-SEED', sidekick_id: 'umsg_del_b', timestamp: t0 + 10 }],
    lastActiveAt: Date.now() - 1000,
  });
}

async function rowPresent(page, chatId) {
  return page.evaluate(
    (id) => !!document.querySelector(`#sessions-list li[data-chat-id="${id}"]`),
    chatId,
  );
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await waitForDrawerQuiet(page);

  // ── Happy path: row gone SYNCHRONOUSLY (measured in-page) ─────────
  const ms = await page.evaluate(async (id) => {
    const drawer = await import('/build/sessionDrawer.mjs');
    const t0 = performance.now();
    const p = drawer.deleteSessionFromUI(id);   // no await — measure the sync effect
    const gone = !document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
    const dt = performance.now() - t0;
    await p;
    return gone ? dt : -1;
  }, CHAT_A);
  if (ms < 0) throw new Error('row still present after deleteSessionFromUI returned control — delete is not optimistic');
  if (ms > 50) throw new Error(`optimistic removal took ${ms.toFixed(1)}ms — should be synchronous (<50ms)`);
  log(`row removed in ${ms.toFixed(1)}ms (before the server round-trip)`);
  await new Promise((r) => setTimeout(r, 500));
  if (mock.getChat(CHAT_A)) throw new Error('server never received the background DELETE');
  log('background DELETE reached the server');

  // ── Failure path: DELETE 500s → row returns + error status ────────
  mock.setSessionsFailure(0);           // ensure list is healthy
  await page.route('**/api/sidekick/sessions/' + encodeURIComponent(CHAT_B), (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ status: 500, body: 'boom' })
      : route.fallback());
  const res = await page.evaluate(async (id) => {
    const drawer = await import('/build/sessionDrawer.mjs');
    const goneImmediately = (() => {
      const p = drawer.deleteSessionFromUI(id).catch((e) => e?.message || 'failed');
      const gone = !document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
      return { p, gone };
    })();
    const err = await goneImmediately.p;
    return { goneImmediately: goneImmediately.gone, err: String(err) };
  }, CHAT_B);
  log(`failure-path: goneImmediately=${res.goneImmediately} err="${res.err}"`);
  if (!res.goneImmediately) throw new Error('failure-path row was not optimistically removed first');
  // Watch BOTH rollback signals from the same clock: the toast lives 6s
  // from the rollback moment, so polling them sequentially can miss it
  // under suite load (the row-wait alone can eat the toast's lifetime).
  const rollback = await page.evaluate(async (id) => {
    const t0 = performance.now();
    let sawToast = false;
    let sawRow = false;
    const timeline = [];
    let lastSnap = '';
    while (performance.now() - t0 < 8000) {
      if (!sawToast && /Delete failed/i.test(document.querySelector('.toast, [class*="toast"]')?.textContent || '')) sawToast = true;
      if (!sawRow && document.querySelector(`#sessions-list li[data-chat-id="${id}"]`)) sawRow = true;
      const snap = [...document.querySelectorAll('#sessions-list li')]
        .map((r) => r.getAttribute('data-chat-id') || r.className || '?').join(',');
      if (snap !== lastSnap) {
        timeline.push(`+${Math.round(performance.now() - t0)}ms [${snap.slice(0, 120)}]`);
        lastSnap = snap;
      }
      if (sawToast && sawRow) return { sawToast, sawRow, timeline };
      await new Promise((r) => setTimeout(r, 50));
    }
    return { sawToast, sawRow, timeline };
  }, CHAT_B);
  for (const t of (rollback.timeline || []).slice(0, 8)) log(`  timeline: ${t}`);
  if (!rollback.sawRow) {
    const probe = await page.evaluate(async (id) => {
      const ops = await import('/build/sessionOps.mjs').catch(() => null);
      const drawer = await import('/build/sessionDrawer.mjs').catch(() => null);
      return {
        tombstoned: ops ? ops.isRecentlyDeleted(id) : 'n/a',
        cachedLen: drawer?.getCachedSessions ? drawer.getCachedSessions().length : 'n/a',
        cachedIds: drawer?.getCachedSessions ? drawer.getCachedSessions().map((s) => s.id).join(',') : 'n/a',
        listHtml: (document.getElementById('sessions-list')?.innerHTML || '').slice(0, 100),
      };
    }, CHAT_B);
    log(`  probe: ${JSON.stringify(probe)}`);
  }
  if (!rollback.sawRow) throw new Error('row never restored after failed DELETE');
  if (!rollback.sawToast) throw new Error('no visible "Delete failed" toast after rollback');
  log('failed DELETE rolled back: row restored + error toast shown');
}
