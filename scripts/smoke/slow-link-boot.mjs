// #188 — slow-link boot budget. The whole point of Path B (cache-first
// config/prefs), Path C2 (content-hashed modules in BUILD_CACHE) and
// #191 (delta resume) is that a WARM client on a bad mobile link paints
// the cached UI without waiting on the network. This smoke proves it
// end-to-end and pins it with a wall-clock budget so a regression that
// quietly re-introduces a network-blocking boot dependency fails loudly.
//
// Flow:
//   1. Unthrottled warm-up: first load installs + activates the SW
//      (clients.claim), but that first page's module fetches happened
//      BEFORE the SW controlled the page — so reload once to pull every
//      hashed /build/*.mjs through the SW and populate BUILD_CACHE.
//      Then open the seeded chat to prime the IDB transcript cache.
//   2. Throttle to slow3g (~400ms RTT, 400kbps — worst realistic
//      mobile) via CDP and reload.
//   3. Assert the cached transcript paints within BOOT_BUDGET_MS, and
//      that ≥90% of hashed build modules reported transferSize 0
//      (served by the SW from BUILD_CACHE, not the throttled link).
//      A network-dependent boot (~700KB of JS at 400kbps) would take
//      15s+ — the budget cleanly separates the two regimes.
//
// Note: /styles/app.css stays network-first in the SW by design, so the
// throttled boot still pays one render-blocking CSS fetch — the budget
// accounts for it.

import { waitForReady, openSidebar, clickRow, throttleNetwork, assert } from './lib.mjs';

export const NAME = 'slow-link-boot';
export const DESCRIPTION = 'warm PWA on a slow3g link boots to cached paint within budget (SW + IDB, no network-blocking boot)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-slow-link-boot';
const MARKER = 'slow-link-boot-marker';

// Generous vs the unthrottled ~500ms boot, brutal vs a network-bound
// boot (15s+ on slow3g). Includes the one render-blocking CSS fetch
// (~2s at 400kbps) + suite-load headroom.
const BOOT_BUDGET_MS = 8_000;

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  const messages = [];
  for (let i = 1; i <= 4; i++) {
    messages.push({ role: 'user', content: `Turn ${i} ${MARKER}`, parley_id: `u_slb_${i}`, timestamp: t0 + i * 2 });
    messages.push({ role: 'assistant', content: `Reply ${i} ${MARKER}`, parley_id: `m_slb_${i}`, timestamp: t0 + i * 2 + 1 });
  }
  mock.addChat(CHAT_ID, { title: 'Slow-link boot chat', messages, lastActiveAt: Date.now() });
}

async function waitForMarker(page, timeout) {
  await page.waitForFunction(
    (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
    MARKER,
    { timeout, polling: 50 },
  );
}

export default async function run({ page, log }) {
  // ── Phase 1: unthrottled warm-up ──
  await waitForReady(page);
  // SW must control the page before a reload routes /build/* through it.
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 10_000 });
  log('SW controlling — reloading once to populate BUILD_CACHE');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await waitForMarker(page, 5_000);
  // Let the IDB cache write + snapshot persist debounce flush.
  await page.waitForTimeout(500);
  log('warm: BUILD_CACHE + IDB transcript cache primed');

  // ── Phase 2: throttled cold boot ──
  await throttleNetwork(page, 'slow3g');
  log('throttled to slow3g (400ms RTT, 400kbps) — reloading');
  const t0 = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMarker(page, BOOT_BUDGET_MS + 5_000);
  const paintMs = Date.now() - t0;
  log(`cached transcript painted in ${paintMs}ms (budget ${BOOT_BUDGET_MS}ms)`);
  assert(paintMs <= BOOT_BUDGET_MS,
    `slow-link boot blew the budget: cached paint took ${paintMs}ms > ${BOOT_BUDGET_MS}ms — ` +
    `something on the boot path is blocking on the throttled network again`);

  // ── Assert hashed modules came from the SW cache, not the link ──
  const stats = await page.evaluate(() => {
    const rs = performance.getEntriesByType('resource')
      .filter(r => /\/build\/.+\.[0-9a-f]{10}\.mjs$/.test(new URL(r.name).pathname));
    return {
      total: rs.length,
      cached: rs.filter(r => r.transferSize === 0).length,
    };
  });
  log(`hashed modules: ${stats.cached}/${stats.total} served with transferSize=0 (SW cache)`);
  assert(stats.total >= 20,
    `expected a hashed-module boot (≥20 /build/*.<sha10>.mjs resources), saw ${stats.total} — ` +
    `is the import-map build live?`);
  assert(stats.cached / stats.total >= 0.9,
    `only ${stats.cached}/${stats.total} hashed modules came from cache — ` +
    `BUILD_CACHE is not serving the boot on a slow link`);
}
