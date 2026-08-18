// Perf scenario: scroll-up "load earlier" on a big chat.
//
// Target: a chat with several thousand state.db rows so the load-earlier
// SQL path actually exercises real work. The canonical worst-case in
// Jonathan's account is `[pitch deck]` / "Visual Trajectories Pitch
// Strategy" (chat_id ae6435b5-..., ~5400 msgs). The chat id is
// overridable via SMOKE_SCROLL_CHAT for reproducibility on other
// boxes.
//
// Two numbers, side by side:
//
//   pwa_scroll_to_paint : t(scroll-to-top fired) → t(new rows
//                          prepended). Measures what the user feels
//                          (spinner-time). Includes gateway query +
//                          proxy serialize + network + PWA projection
//                          + DOM apply.
//
//   blob_load_ms        : direct curl to the gateway for the same
//                          before-cursor page. The gateway-only floor.
//                          Gap between this and pwa_scroll_to_paint is
//                          client-side overhead and is the optimization
//                          headroom.
//
// Cleanup: nothing to delete — we only READ an existing chat.
//
// 2026-06-23: created alongside the unread-loop-block fix to chase the
// remaining big-session scroll latency Jonathan flagged.

import {
  launchSharedBrowser, launchBrowser, waitForReady, openSidebar, clickRow,
  DEFAULT_URL,
} from '../smoke/lib.mjs';
import { runN, waitMs, percentile, fmtMs } from './lib.mjs';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';

export const NAME = 'scroll-page';
export const DESCRIPTION = 'Scroll-up load-earlier on a big chat — spinner time vs gateway-blob ceiling';
export const DEFAULT_RUNS = 3;
export const BACKEND = 'real';

// Worst-case Jonathan chat by msg-count (state.db query 2026-06-23):
// ae6435b5 = "Visual Trajectories Pitch Strategy" with 5425 msgs.
// Override via env when running against a different account.
const TARGET_CHAT_ID = process.env.SMOKE_SCROLL_CHAT
  || 'sidekick:ae6435b5-53aa-4819-b594-d21652c89397';

// Gateway HTTP port + token for the blob-load reference. We hit the
// gateway directly (bypassing the proxy) so the reference number is
// pure gateway-side work — same SQL the proxy /messages route would
// invoke, but with zero proxy/network-to-proxy overhead.
const GATEWAY_PORT = Number(process.env.SMOKE_GATEWAY_PORT || 8645);
const HERMES_TOKEN = process.env.PARLEY_PLATFORM_TOKEN
  || process.env.SIDEKICK_PLATFORM_TOKEN
  || readTokenFromEnv()
  || '';

function readTokenFromEnv() {
  try {
    const env = readFileSync(`${process.env.HOME}/.hermes/.env`, 'utf8');
    const m = env.match(/^SIDEKICK_PLATFORM_TOKEN=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

async function blobLoad(chatId, before, limit) {
  // Direct gateway hit — the "ceiling" reference. Pure gateway SQL
  // + serialize, no proxy, no PWA. Returns { ms, bytes }.
  const url = `http://127.0.0.1:${GATEWAY_PORT}/v1/conversations/${encodeURIComponent(chatId)}/items?limit=${limit}${before ? `&before=${before}` : ''}`;
  const t0 = performance.now();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${HERMES_TOKEN}` } });
  const body = await r.arrayBuffer();
  const ms = performance.now() - t0;
  return { ms, bytes: body.byteLength, status: r.status };
}

export default async function run({ N = DEFAULT_RUNS, log = console.log } = {}) {
  const { browser, closeShared } = await launchSharedBrowser({ headed: false });
  const samples = {
    pwa_scroll_to_paint: [],
    blob_load_ms:        [],
    blob_load_kb:        [],
  };
  try {
    await runN(N, async (i) => {
      const { page, cleanup } = await launchBrowser(browser, {});
      try {
        await waitForReady(page, undefined, { timeout: 45_000 });
        await openSidebar(page);
        await page.waitForSelector(
          `#sessions-list li[data-chat-id="${TARGET_CHAT_ID}"]`,
          { timeout: 60_000 },
        );
        await clickRow(page, TARGET_CHAT_ID);
        // Initial load: wait until transcript has the tail page.
        await waitMs(page, () => {
          const t = document.getElementById('transcript');
          if (!t) return false;
          return t.querySelectorAll('.line.s0, .line.user, .line.agent').length >= 10;
        }, { timeoutMs: 30_000, label: 'initial tail load' });
        // Let any post-paint settling finish (delta-resume, image
        // enrichment, etc.) before timing the scroll.
        await page.waitForTimeout(800);

        // Capture the BEFORE state: top row's data attributes + total count.
        // We'll detect "page added" by count delta — the PWA prepends new
        // rows at the top when load-earlier returns.
        const before = await page.evaluate(() => {
          const t = document.getElementById('transcript');
          const rows = t ? t.querySelectorAll('.line.s0, .line.user, .line.agent') : [];
          return { count: rows.length, scrollTop: t ? t.scrollTop : 0 };
        });

        // Pick a representative `before=<cursor>` for the blob-load
        // reference. The PWA's first load-earlier query uses the first
        // visible message's id as the cursor; we mirror that.
        const firstId = await page.evaluate(() => {
          const t = document.getElementById('transcript');
          const r = t?.querySelector('.line.s0, .line.user, .line.agent');
          // The PWA stamps id on the .line element via various paths;
          // the projection's data-msg-id is the most common. Fall back
          // to integer parse of the row index attribute.
          return r?.getAttribute('data-msg-id')
            || r?.dataset?.msgId
            || null;
        });

        // Blob-load reference — same query the PWA is about to fire,
        // hit directly against the gateway. Records the floor.
        const blob = await blobLoad(TARGET_CHAT_ID, firstId, 40);
        if (blob.status !== 200) {
          throw new Error(`blob-load returned HTTP ${blob.status}`);
        }

        // Drive the scroll-to-top to trigger load-earlier. The PWA's
        // scroll handler fires the request when scrollTop crosses a
        // small threshold near 0.
        const tClick = performance.now();
        await page.evaluate(() => {
          const t = document.getElementById('transcript');
          if (t) t.scrollTop = 0;
          // Re-dispatch in case the scroll handler is debounced and
          // missed our programmatic set.
          if (t) t.dispatchEvent(new Event('scroll', { bubbles: true }));
        });

        // Wait until count grows above the initial — that's the new
        // page being prepended.
        const dtPaint = await waitMs(
          page,
          (initial) => {
            const t = document.getElementById('transcript');
            if (!t) return false;
            const rows = t.querySelectorAll('.line.s0, .line.user, .line.agent');
            return rows.length > initial.count;
          },
          { timeoutMs: 60_000, label: 'scroll-up new page paint', args: before },
        );

        samples.pwa_scroll_to_paint.push(dtPaint);
        samples.blob_load_ms.push(blob.ms);
        samples.blob_load_kb.push(blob.bytes / 1024);
        log(`  [scroll-page ${i + 1}/${N}] pwa=${fmtMs(dtPaint)} blob=${fmtMs(blob.ms)} (${(blob.bytes / 1024).toFixed(1)}kb, before=${firstId || '-'})`);
      } finally {
        await cleanup();
      }
    });
  } finally {
    await closeShared();
  }
  return samples;
}
