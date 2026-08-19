/**
 * In-process AgentEventPayload → per-runId queue router.
 *
 * Openclaw's plugin SDK exposes `api.agent.events.registerAgentEvent
 * Subscription({ handle })` which fires for every agent event globally.
 * We need per-runId fan-out so each /v1/responses HTTP handler can
 * drain only its own turn's events. This module wraps that with a
 * registry of per-runId queues.
 *
 * Lifecycle:
 *   1. /v1/responses handler calls `claimRun(runId)` → registers a
 *      bounded queue, returns an async-iterable drain function.
 *   2. AgentEventSubscription routes incoming events with that runId
 *      into the queue.
 *   3. Handler drains until it sees a lifecycle "end" event, then
 *      calls `releaseRun(runId)` (clean up the queue).
 *
 * Unmatched events (runId not claimed) go to a global broadcast queue
 * — that's what /v1/events (out-of-turn SSE) drains from. Out-of-turn
 * implementation lands in a follow-up commit.
 */

const QUEUE_HIGH_WATER = 1024;
const GLOBAL_HIGH_WATER = 2048;

export class AgentEventBus {
  constructor({ logger } = {}) {
    this.logger = logger ?? console;
    this.runQueues = new Map();   // runId → { queue, waiters, closed }
    this.globalQueue = [];        // unmatched events (for /v1/events)
    this.globalWaiters = [];
  }

  /** Hook from registerAgentEventSubscription's handle callback.
   *  Routes events to the matching per-run queue, or to the global
   *  broadcast queue if no run claims this id. */
  onEvent(event) {
    const runId = event?.runId;
    const target = runId ? this.runQueues.get(runId) : null;
    if (target && !target.closed) {
      this._push(target, event);
      return;
    }
    // Unclaimed — broadcast to global subscribers.
    if (this.globalQueue.length >= GLOBAL_HIGH_WATER) {
      this.globalQueue.shift();  // drop oldest under back-pressure
    }
    this.globalQueue.push(event);
    while (this.globalWaiters.length > 0) {
      const w = this.globalWaiters.shift();
      w(this.globalQueue.shift());
    }
  }

  _push(target, event) {
    if (target.queue.length >= QUEUE_HIGH_WATER) {
      target.queue.shift();  // drop oldest; back-pressure is on us
      this.logger.warn?.(
        `[parley] run queue high water for ${event.runId}, dropped oldest`,
      );
    }
    target.queue.push(event);
    while (target.waiters.length > 0 && target.queue.length > 0) {
      const w = target.waiters.shift();
      w(target.queue.shift());
    }
  }

  /** Reserve event delivery for a run. Returns an object with:
   *    - `next()` → Promise<event>  (drain one event, blocking)
   *    - `close()` → void           (release the queue)
   *  The caller is expected to detect terminal events (lifecycle.end
   *  or error) and call close() — we don't auto-release on lifecycle
   *  to keep the lifecycle-detection policy in the handler. */
  claimRun(runId) {
    if (this.runQueues.has(runId)) {
      throw new Error(`run ${runId} already claimed`);
    }
    const entry = { queue: [], waiters: [], closed: false };
    this.runQueues.set(runId, entry);
    return {
      next: () => new Promise((resolve) => {
        if (entry.queue.length > 0) resolve(entry.queue.shift());
        else entry.waiters.push(resolve);
      }),
      close: () => {
        entry.closed = true;
        this.runQueues.delete(runId);
        // Wake any waiters so they unblock on the disposal.
        for (const w of entry.waiters) w(null);
        entry.waiters.length = 0;
      },
    };
  }

  /** Push a pre-translated parley envelope into the global stream.
   *  Used by /v1/responses (POST receipt → user_message) for cross-
   *  device sync. Wrapped in a sentinel so the iterator can tell
   *  envelopes apart from raw agent events. */
  pushEnvelope(envelope) {
    if (this.globalQueue.length >= GLOBAL_HIGH_WATER) this.globalQueue.shift();
    this.globalQueue.push({ __envelope: envelope });
    while (this.globalWaiters.length > 0 && this.globalQueue.length > 0) {
      const w = this.globalWaiters.shift();
      w(this.globalQueue.shift());
    }
  }

  /** Async iterator for the global (unclaimed) event stream. Used by
   *  /v1/events. Each consumer gets independent draining via the
   *  per-call promise — multiple iterators race fairly on FIFO order. */
  async *globalIterator({ signal } = {}) {
    while (!signal?.aborted) {
      let event;
      if (this.globalQueue.length > 0) {
        event = this.globalQueue.shift();
      } else {
        event = await new Promise((resolve) => {
          const onAbort = () => resolve(null);
          signal?.addEventListener('abort', onAbort, { once: true });
          this.globalWaiters.push((e) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(e);
          });
        });
      }
      if (!event) break;
      yield event;
    }
  }
}
