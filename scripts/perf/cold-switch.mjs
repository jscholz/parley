// Perf scenario: cold-cache session switch latency.
//
// Each iteration: fresh BrowserContext (empty IDB, empty in-memory store)
//   → boot to ready → open drawer → click seed chat → measure paint time.
//
// Originally tried to push seed out of the top-N drawer prefetch by
// creating filler chats AFTER it, but the proxy's lazy newSession does
// not persist empty chats to the server — they exist only locally —
// so they can't shove seed out of the server's "most recent" list.
// Instead we accept that some iterations may race prefetch (the drawer
// pre-fetches seed before the user clicks); the variance across N tells
// us whether we're seeing a cold-fetch path or a warm-cache hit.
//
// Captures per iteration:
//   click_to_first_bubble : clickRow → first .line in #transcript

import {
  launchSharedBrowser, launchBrowser, waitForReady, clickNewChat, send,
  deleteChat, captureNextChatId, openSidebar, clickRow, SEL,
} from '../smoke/lib.mjs';
import { runN, waitMs, deleteChatByApi, tapHttp } from './lib.mjs';
import { performance } from 'node:perf_hooks';

export const NAME = 'cold-switch';
export const DESCRIPTION = 'Cold-cache switch (fresh ctx) → first transcript bubble painted';
export const DEFAULT_RUNS = 5;
export const BACKEND = 'real';

const SMOKE_URL = process.env.SMOKE_URL || 'http://127.0.0.1:3001';

async function setupSeed(browser, log, createdIds) {
  // createdIds is passed in from the caller and mutated in place so that
  // partial setup state is recoverable for teardown even if we throw.
  const { page, cleanup } = await launchBrowser(browser, {});
  try {
    await waitForReady(page, undefined, { timeout: 45_000 });
    const chatIdP = captureNextChatId(page, { timeoutMs: 30_000 });
    await clickNewChat(page);
    const seedId = await chatIdP;
    createdIds.push(seedId);
    await send(page, 'hi');
    await page.waitForSelector(SEL.agentFinal, { timeout: 120_000 });
    log(`  setup: seed=${seedId} (with reply)`);
    return { seedId };
  } finally {
    await cleanup();
  }
}

export default async function run({ N = DEFAULT_RUNS, log = console.log } = {}) {
  const { browser, closeShared } = await launchSharedBrowser({ headed: false });
  const samples = {
    click_to_first_bubble: [],
    messages_fetch_ms: [],
  };
  const createdIds = [];
  try {
    const setup = await setupSeed(browser, log, createdIds);
    const { seedId } = setup;

    await runN(N, async (i) => {
      const { page, cleanup } = await launchBrowser(browser, {});
      try {
        await waitForReady(page, undefined, { timeout: 45_000 });
        await openSidebar(page);
        await page.waitForSelector(
          `#sessions-list li[data-chat-id="${seedId}"]`,
          { timeout: 60_000 },
        );
        // Wipe per-chat caches THEN reload. The IDB wipe ensures the
        // post-reload prefetch can't repopulate from a stale cached row;
        // the reload itself clears the in-memory transcriptStore so the
        // post-reload click can't be served from RAM. Combined, this
        // forces a true cold round-trip on click.
        await page.evaluate(async () => {
          const drop = (name) => new Promise((res) => {
            const r = indexedDB.deleteDatabase(name);
            r.onsuccess = r.onerror = r.onblocked = () => res();
          });
          await Promise.all([
            drop('parley-sessions'),
            drop('parley-chat'),
            drop('parley-windows'),
          ]);
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForReady(page, undefined, { timeout: 45_000 });
        await openSidebar(page);
        await page.waitForSelector(
          `#sessions-list li[data-chat-id="${seedId}"]`,
          { timeout: 60_000 },
        );
        // Capture /messages timing for the seed chat. The chat id
        // contains a ':' which the client percent-encodes in URLs, so
        // decode before matching.
        const { entries, stop } = tapHttp(
          page,
          (req) => {
            const url = req.url();
            if (!url.includes('/api/parley/sessions/')) return false;
            if (!url.includes('/messages')) return false;
            try {
              return decodeURIComponent(url).includes(seedId);
            } catch { return false; }
          },
        );
        try {
          const tClick = performance.now();
          await clickRow(page, seedId);
          const dtPaint = await waitMs(
            page,
            () => {
              const t = document.getElementById('transcript');
              if (!t) return false;
              return t.querySelectorAll('.line.s0, .line.user, .line.agent').length > 0;
            },
            { timeoutMs: 60_000, label: 'first transcript bubble after cold switch' },
          );
          await page.waitForTimeout(500); // give in-flight /messages a beat
          const fetchEntries = entries.filter((e) => e.status >= 200 && e.status < 400);
          const dtFetch = fetchEntries.length
            ? Math.max(...fetchEntries.map((e) => e.durationMs))
            : NaN;
          samples.click_to_first_bubble.push(dtPaint);
          if (Number.isFinite(dtFetch)) samples.messages_fetch_ms.push(dtFetch);
          log(`  [cold-switch ${i + 1}/${N}] paint=${Math.round(dtPaint)}ms /messages=${Number.isFinite(dtFetch) ? Math.round(dtFetch) + 'ms' : '—'} (${fetchEntries.length} fetches)`);
        } finally {
          stop();
        }
      } finally {
        await cleanup();
      }
    });
  } finally {
    // Teardown — delete every chat we created. Use the API directly so
    // we don't need a live page.
    for (const id of createdIds) {
      await deleteChatByApi(SMOKE_URL, id);
    }
    log(`  teardown: deleted ${createdIds.length} test chats`);
    await closeShared();
  }
  return samples;
}
