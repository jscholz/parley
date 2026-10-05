/**
 * Regression: the upstream /v1/events reconnect loop leaked one 'abort'
 * listener per reconnect on the process-lifetime AbortSignal (field
 * 2026-10-05: ~186 reconnects/day since 2026-09-23 → 2,600 listeners and a
 * MaxListenersExceededWarning on every reconnect). The listener must come
 * off when the backoff timer fires normally.
 *
 * Strip-only TS: no enums / parameter properties.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import { runUpstreamEventsLoop } from '../stream.ts';

function terminatingUpstream(drops: { n: number }, maxDrops: number, ctrl: AbortController) {
  return {
    subscribeEvents() {
      // An upstream whose SSE ends immediately, `maxDrops` times, then
      // the test aborts the loop (as process shutdown would).
      return {
        async *[Symbol.asyncIterator]() {
          drops.n += 1;
          if (drops.n >= maxDrops) queueMicrotask(() => ctrl.abort());
          throw new Error('terminated');
        },
      };
    },
  } as any;
}

test('reconnect backoff does not accumulate abort listeners on the long-lived signal', async () => {
  const ctrl = new AbortController();
  const drops = { n: 0 };
  // Shrink the backoff so 12 reconnects take well under a second: the
  // loop's delays are module constants, so patch setTimeout's clock via
  // a tiny delay floor instead — Node honours sub-ms timers as ~1ms.
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((fn: any, _ms?: number, ...rest: any[]) => realSetTimeout(fn, 1, ...rest)) as any;
  try {
    await runUpstreamEventsLoop(terminatingUpstream(drops, 12, ctrl), ctrl.signal);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.ok(drops.n >= 12, `expected ≥12 reconnects, got ${drops.n}`);
  // Every listener a finished backoff registered must be gone; the one a
  // pending backoff may still hold is removed by the abort itself.
  assert.ok(getEventListeners(ctrl.signal, 'abort').length <= 1,
    `abort listeners leaked: ${getEventListeners(ctrl.signal, 'abort').length}`);
});
