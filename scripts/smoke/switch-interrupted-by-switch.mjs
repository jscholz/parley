// Mid-flight-interrupt matrix cell (hardening proposal §test-carve):
// a second SWITCH fired while the first switch's history fetch is
// still in flight. The first switch's continuation must die silently —
// its content must NEVER paint, not even transiently (we poll DURING
// the window, per the carve: "no foreign content ever painted — poll
// during, not just after").
//
//   Variant 1: A → B(slow) → C(fast) mid-flight. Final view = C;
//              B's late response never touches the pane.
//   Variant 2: foreground-reconcile of A in flight (slow) when the
//              user clicks B. The late A reconcile must not repaint
//              A over B — the row-click sibling of the CAP walking-
//              test bug pinned in new-chat-wins-inflight-switch.
//
// Uses mock.setMessageDelay to hold the fetch open and real UI clicks
// inside the window (decision #1, 2026-07-12).

import { waitForReady, openSidebar, clickRow, waitForDrawerQuiet } from './lib.mjs';

export const NAME = 'switch-interrupted-by-switch';
export const DESCRIPTION = 'Second switch fired mid-flight: the first switch\'s late continuation never paints; foreground-reconcile variant included';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-sis-chat-a';
const CHAT_B = 'mock-sis-chat-b';
const CHAT_C = 'mock-sis-chat-c';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT_A, {
    title: 'SIS A',
    messages: [{ role: 'user', content: 'SIS-A-SEED', parley_id: 'umsg_sis_a', timestamp: t0 }],
    lastActiveAt: Date.now() - 3000,
  });
  mock.addChat(CHAT_B, {
    title: 'SIS B',
    messages: [{ role: 'user', content: 'SIS-B-SEED', parley_id: 'umsg_sis_b', timestamp: t0 + 10 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addChat(CHAT_C, {
    title: 'SIS C',
    messages: [{ role: 'user', content: 'SIS-C-SEED', parley_id: 'umsg_sis_c', timestamp: t0 + 20 }],
    lastActiveAt: Date.now() - 1000,
  });
}

/** Start sampling #transcript every 50ms for foreign markers; any hit
 *  is recorded with a timestamp so a TRANSIENT paint (flashed then
 *  cleaned up) still fails the run. */
async function armForeignWatch(page, markers) {
  await page.evaluate((ms) => {
    window.__sisForeign = [];
    window.__sisMarkers = ms;
    if (window.__sisTimer) clearInterval(window.__sisTimer);
    window.__sisTimer = setInterval(() => {
      const text = document.getElementById('transcript')?.textContent || '';
      for (const m of window.__sisMarkers) {
        if (text.includes(m)) window.__sisForeign.push(`${m}@${Math.round(performance.now())}`);
      }
    }, 50);
  }, markers);
}

async function readForeignWatch(page) {
  return page.evaluate(() => {
    if (window.__sisTimer) { clearInterval(window.__sisTimer); window.__sisTimer = null; }
    return window.__sisForeign || [];
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // ── Variant 1: switch interrupted by switch ───────────────────────
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('SIS-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  log('viewing A');

  mock.setMessageDelay(CHAT_B, 2500);
  await clickRow(page, CHAT_B);
  await new Promise((r) => setTimeout(r, 250));   // B fetch in flight
  await armForeignWatch(page, ['SIS-B-SEED']);    // from here on, B is foreign
  await clickRow(page, CHAT_C);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('SIS-C-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  log('C painted while B fetch still pending');

  // Let B's delayed response land, sampling the whole time.
  await new Promise((r) => setTimeout(r, 3000));
  const foreign1 = await readForeignWatch(page);
  const after1 = await page.evaluate(() => ({
    text: document.getElementById('transcript')?.textContent || '',
    loading: document.getElementById('transcript')?.classList.contains('transcript-loading') ?? false,
    edgeLoaders: document.querySelectorAll('.transcript-edge-loader:not([hidden])').length,
  }));
  if (foreign1.length) {
    throw new Error(`interrupted switch's content painted (even transiently): ${foreign1.slice(0, 5).join(', ')}`);
  }
  if (!after1.text.includes('SIS-C-SEED')) throw new Error('C content vanished after B\'s late response landed');
  if (after1.loading) throw new Error('stale spinner left armed over C after B\'s late response');
  log('variant 1 OK: B\'s late continuation never painted; C stable, no spinner');

  // ── Variant 2: foreground-reconcile interrupted by switch ─────────
  mock.setMessageDelay(CHAT_B, 0);
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('SIS-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
  // Seed lastReconnectAt (first forceReconnect computes gap=0), then
  // fire a foreground with A's history held open.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await new Promise((r) => setTimeout(r, 700));
  mock.setMessageDelay(CHAT_A, 2500);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await new Promise((r) => setTimeout(r, 700));   // debounce drained, A reconcile in flight
  await clickRow(page, CHAT_B);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('SIS-B-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await armForeignWatch(page, ['SIS-A-SEED']);    // A is now foreign
  log('switched to B while A\'s reconcile fetch still pending');

  await new Promise((r) => setTimeout(r, 3000));  // late A reconcile lands
  const foreign2 = await readForeignWatch(page);
  const after2 = await page.evaluate(() => ({
    text: document.getElementById('transcript')?.textContent || '',
    loading: document.getElementById('transcript')?.classList.contains('transcript-loading') ?? false,
  }));
  if (foreign2.length) {
    throw new Error(`late foreground-reconcile repainted the OLD chat over B: ${foreign2.slice(0, 5).join(', ')}`);
  }
  if (!after2.text.includes('SIS-B-SEED')) throw new Error('B content vanished after A\'s late reconcile landed');
  if (after2.loading) throw new Error('stale reconcile spinner left armed over B');
  log('variant 2 OK: late foreground-reconcile never repainted A over B');
}
