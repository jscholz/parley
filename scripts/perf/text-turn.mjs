// Perf scenario: send "hi" in a fresh chat, measure latencies.
//
// Captures per iteration:
//   send_to_first_bubble : t0 = composer-send click → any .line.agent in DOM
//                          (the user's "I see something happening" moment)
//   send_to_first_text   : t0 → first non-empty .text inside .line.agent
//                          (first visible token; matters when first bubble
//                          renders as a thinking-dots placeholder)
//   send_to_final        : t0 → first finalized agent bubble (matches
//                          scripts/smoke/text-turn.mjs end condition)
//
// Real backend: each iteration creates and DELETES one chat. Cleanup
// fires whether the iteration succeeds or throws.

import {
  launchSharedBrowser, launchBrowser, waitForReady, clickNewChat, send,
  deleteChat, captureNextChatId, SEL,
} from '../smoke/lib.mjs';
import { runN, waitMs } from './lib.mjs';

export const NAME = 'text-turn';
export const DESCRIPTION = 'Fresh chat → "hi" → first agent bubble + first text + finalized';
export const DEFAULT_RUNS = 3;
export const BACKEND = 'real';

export default async function run({ N = DEFAULT_RUNS, log = console.log } = {}) {
  const { browser, closeShared } = await launchSharedBrowser({ headed: false });
  const samples = {
    send_to_first_bubble: [],
    send_to_first_text: [],
    send_to_final: [],
  };
  try {
    await runN(N, async (i) => {
      const { page, cleanup } = await launchBrowser(browser, {});
      const createdIds = [];
      try {
        await waitForReady(page, undefined, { timeout: 45_000 });
        const chatIdP = captureNextChatId(page);
        await clickNewChat(page);
        const chatId = await chatIdP;
        createdIds.push(chatId);

        const t0 = await send(page, 'hi');
        // first .line.agent ANY (including streaming/pending placeholders).
        // Each metric measured as `Date.now() - t0` AFTER its predicate
        // resolves so all three are independent of poll start ordering.
        await waitMs(
          page,
          () => !!document.querySelector('.line.agent'),
          { timeoutMs: 120_000, label: 'first agent bubble' },
        );
        const dtFirst = Date.now() - t0;
        await waitMs(
          page,
          () => {
            const els = document.querySelectorAll('.line.agent .text');
            for (const el of els) {
              if ((el.textContent || '').trim().length > 0) return true;
            }
            return false;
          },
          { timeoutMs: 120_000, label: 'first agent text' },
        );
        const dtFirstText = Date.now() - t0;
        await page.waitForSelector(SEL.agentFinal, { timeout: 120_000 });
        const dtFinal = Date.now() - t0;

        samples.send_to_first_bubble.push(dtFirst);
        samples.send_to_first_text.push(dtFirstText);
        samples.send_to_final.push(dtFinal);
        log(`  [text-turn ${i + 1}/${N}] first=${Math.round(dtFirst)}ms text=${Math.round(dtFirstText)}ms final=${dtFinal}ms`);
      } finally {
        for (const id of createdIds) {
          try { await deleteChat(page, id); } catch { /* ignore */ }
        }
        await cleanup();
      }
    });
  } finally {
    await closeShared();
  }
  return samples;
}
