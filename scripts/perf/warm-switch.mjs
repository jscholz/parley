// Perf scenario: warm-cache session switch latency.
//
// Setup: create TWO seed chats (each with one reply) within ONE
// BrowserContext so both end up in IDB. Then within that SAME context:
//   - Visit A → ensure cached
//   - Visit B → ensure cached
//   - For N iterations: switch A→B, switch B→A, measure each paint time
//
// Captures per iteration:
//   warm_switch_paint : clickRow → first .line in #transcript (warm)
//
// Real backend: warm switch still hits the gateway for delta-resume
// (per-chat tail refresh after switch-back). That round-trip is part
// of the user-visible latency we want to measure.

import {
  launchSharedBrowser, launchBrowser, waitForReady, clickNewChat, send,
  openSidebar, clickRow, captureNextChatId, SEL,
} from '../smoke/lib.mjs';
import { runN, waitMs, deleteChatByApi } from './lib.mjs';
import { performance } from 'node:perf_hooks';

export const NAME = 'warm-switch';
export const DESCRIPTION = 'Warm-cache switch (cached IDB) → first transcript bubble repainted';
export const DEFAULT_RUNS = 5;
export const BACKEND = 'real';

const SMOKE_URL = process.env.SMOKE_URL || 'http://127.0.0.1:3001';

export default async function run({ N = DEFAULT_RUNS, log = console.log } = {}) {
  const { browser, closeShared } = await launchSharedBrowser({ headed: false });
  const samples = { warm_switch_paint: [] };
  const createdIds = [];
  let cleanup = null;
  try {
    // Single shared context so IDB warms across visits.
    const ctx = await launchBrowser(browser, {});
    cleanup = ctx.cleanup;
    const page = ctx.page;
    await waitForReady(page, undefined, { timeout: 45_000 });

    // Seed A
    let p = captureNextChatId(page, { timeoutMs: 30_000 });
    await clickNewChat(page);
    const seedA = await p;
    createdIds.push(seedA);
    await send(page, 'hi');
    await page.waitForSelector(SEL.agentFinal, { timeout: 120_000 });

    // Seed B
    p = captureNextChatId(page, { timeoutMs: 30_000 });
    await clickNewChat(page);
    const seedB = await p;
    createdIds.push(seedB);
    await send(page, 'hi');
    await page.waitForSelector(SEL.agentFinal, { timeout: 120_000 });

    log(`  setup: seeds A=${seedA} B=${seedB}`);

    await openSidebar(page);
    // Make sure both rows are present.
    await page.waitForSelector(`#sessions-list li[data-chat-id="${seedA}"]`, { timeout: 15_000 });
    await page.waitForSelector(`#sessions-list li[data-chat-id="${seedB}"]`, { timeout: 15_000 });

    // Prime both into cache by visiting each once.
    await clickRow(page, seedA);
    await waitMs(
      page,
      (tid) => document.querySelector('#sessions-list li.active')?.dataset?.chatId === tid
        && document.querySelectorAll('#transcript .line.agent').length > 0,
      { timeoutMs: 30_000, label: 'prime A', args: seedA },
    );
    await page.waitForTimeout(500); // let delta-resume settle
    await clickRow(page, seedB);
    await waitMs(
      page,
      (tid) => document.querySelector('#sessions-list li.active')?.dataset?.chatId === tid
        && document.querySelectorAll('#transcript .line.agent').length > 0,
      { timeoutMs: 30_000, label: 'prime B', args: seedB },
    );

    // N warm switches: alternate B→A→B→A…
    let currentlyOn = seedB;
    for (let i = 0; i < N; i++) {
      const target = currentlyOn === seedB ? seedA : seedB;
      // Quiesce so background delta-resume doesn't race the click.
      await page.waitForTimeout(800);
      const tClick = performance.now();
      await clickRow(page, target);
      // Two-stage paint: active class flips (optimistic) → transcript repaints.
      const dtActive = await waitMs(
        page,
        (tid) => document.querySelector('#sessions-list li.active')?.dataset?.chatId === tid,
        { timeoutMs: 10_000, label: 'active class flip', args: target },
      );
      const dtPaint = await waitMs(
        page,
        (tid) => {
          const active = document.querySelector('#sessions-list li.active')?.dataset?.chatId;
          if (active !== tid) return false;
          return document.querySelectorAll('#transcript .line.agent').length > 0;
        },
        { timeoutMs: 30_000, label: 'warm switch paint', args: target },
      );
      samples.warm_switch_paint.push(dtPaint);
      log(`  [warm-switch ${i + 1}/${N}] ${currentlyOn.slice(-6)}→${target.slice(-6)} active=${Math.round(dtActive)}ms paint=${Math.round(dtPaint)}ms`);
      currentlyOn = target;
    }
  } finally {
    if (cleanup) await cleanup();
    for (const id of createdIds) {
      await deleteChatByApi(SMOKE_URL, id);
    }
    log(`  teardown: deleted ${createdIds.length} test chats`);
    await closeShared();
  }
  return samples;
}
