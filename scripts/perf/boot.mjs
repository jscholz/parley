// Perf scenario: cold-boot timing.
//
// Each iteration: fresh BrowserContext (empty IDB/localStorage),
// page.goto → measure when key UI milestones appear.
//
// No artificial seeding — boot prefetches the user's real top-N drawer
// rows, which is the load profile we actually want to measure. Cleanup
// is a no-op (we create nothing).
//
// Captures per iteration:
//   nav_to_composer  : goto start → #composer-input present in DOM
//   nav_to_connected : goto start → header text reads "Connected"
//   nav_to_drawer    : goto start → sessions-list shows ≥1 row
//                      (proxy for "drawer prefetch returned")

import { launchSharedBrowser, launchBrowser, DEFAULT_URL } from '../smoke/lib.mjs';
import { runN, waitMs } from './lib.mjs';
import { performance } from 'node:perf_hooks';

export const NAME = 'boot';
export const DESCRIPTION = 'Cold boot → composer present + Connected + drawer populated';
export const DEFAULT_RUNS = 3;
export const BACKEND = 'real';

export default async function run({ N = DEFAULT_RUNS, log = console.log } = {}) {
  const { browser, closeShared } = await launchSharedBrowser({ headed: false });
  const samples = {
    nav_to_composer: [],
    nav_to_connected: [],
    nav_to_drawer: [],
  };
  try {
    await runN(N, async (i) => {
      const { page, cleanup } = await launchBrowser(browser, {});
      try {
        const url = `${DEFAULT_URL}?debug=1`;
        const t0 = performance.now();
        // Await navigation so execution context is stable before we
        // start polling — pre-nav waitMs.evaluate throws "execution
        // context destroyed" when the navigation tears down the doc.
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        // Now run all three milestone waits in PARALLEL. Each samples
        // (performance.now() - t0) so all three numbers are independent
        // latencies from goto-start, not strictly-ordered serial waits.
        const composerP = page
          .waitForSelector('#composer-input', { timeout: 30_000 })
          .then(() => performance.now() - t0);
        const connectedP = waitMs(
          page,
          () => /Connected/.test(document.body.innerText),
          { timeoutMs: 30_000, pollMs: 100, label: 'Connected header' },
        ).then(() => performance.now() - t0);
        const drawerP = waitMs(
          page,
          () => document.querySelectorAll('#sessions-list li[data-chat-id]').length > 0,
          { timeoutMs: 30_000, pollMs: 100, label: 'drawer populated' },
        ).then(() => performance.now() - t0).catch(() => NaN);
        const [dtComposer, dtConnected, dtDrawer] = await Promise.all([composerP, connectedP, drawerP]);
        samples.nav_to_composer.push(dtComposer);
        samples.nav_to_connected.push(dtConnected);
        if (Number.isFinite(dtDrawer)) samples.nav_to_drawer.push(dtDrawer);
        log(`  [boot ${i + 1}/${N}] composer=${Math.round(dtComposer)}ms connected=${Math.round(dtConnected)}ms drawer=${Number.isFinite(dtDrawer) ? Math.round(dtDrawer) + 'ms' : '—'}`);
      } finally {
        await cleanup();
      }
    });
  } finally {
    await closeShared();
  }
  return samples;
}
