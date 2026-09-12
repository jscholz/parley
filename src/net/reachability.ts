/**
 * @fileoverview Evidence-based server reachability, independent of the
 * live SSE stream.
 *
 * Field report 2026-09-12 (one bar of 5G on a walk): websites loaded,
 * yet Parley sat on "disconnected" with four memos queued. `connected`
 * is owned by the EventSource opening — a long-lived connection, the
 * hardest thing to establish on a lossy link — and every opportunistic
 * path (outbox flush, queued sends, the retry pollers) was gated on it.
 * So a link that could carry a short POST was never asked to.
 *
 * This module records what the network actually did: an ANSWERED request
 * (any HTTP status — the server spoke) marks the server reachable; a
 * network-class failure (fetch rejected, timed out, aborted) marks it
 * not. Callers use it to
 *   - keep trying while the stream is down (`attemptDelayMs` backoff),
 *   - show "connected, live updates paused" instead of "disconnected"
 *     when HTTP works but the stream does not (`recentlyReachable`),
 *   - decide whether a failure should burn a bounded retry budget
 *     (only when the server was reachable — a dead link must not
 *     exhaust a budget meant for "reachable but refusing").
 *
 * Pure module state + injectable clocks so it unit-tests without DOM.
 */

/** How long an answered request counts as evidence the server is up. */
export const REACHABLE_WINDOW_MS = 20_000;
/** Backoff for opportunistic attempts while nothing is answering. */
export const ATTEMPT_BASE_MS = 10_000;
export const ATTEMPT_MAX_MS = 120_000;
/** Cadence when the stream is up and the queue is just being swept. */
export const CONNECTED_SWEEP_MS = 30_000;

let lastAnsweredAt = 0;
let lastFailureAt = 0;
let consecutiveFailures = 0;

/** The server answered (2xx/4xx/5xx alike — the bytes made it both ways). */
export function noteAnswered(now: number = Date.now()): void {
  lastAnsweredAt = now;
  consecutiveFailures = 0;
}

/** A request never got an answer: fetch rejected, timed out, or stalled. */
export function noteNetworkFailure(now: number = Date.now()): void {
  lastFailureAt = now;
  consecutiveFailures += 1;
}

/** True when an answer landed within the window and nothing has failed
 *  since. */
export function recentlyReachable(now: number = Date.now()): boolean {
  if (!lastAnsweredAt) return false;
  if (lastFailureAt > lastAnsweredAt) return false;
  return now - lastAnsweredAt < REACHABLE_WINDOW_MS;
}

export function failuresInARow(): number {
  return consecutiveFailures;
}

/** Delay before the next opportunistic attempt. With the stream up, a
 *  steady sweep; with it down, exponential backoff on consecutive
 *  failures (10s, 20s, 40s, 80s, 120s cap) so a dead link is probed
 *  gently but a link that just came back is caught within seconds. */
export function attemptDelayMs(opts: { streamConnected: boolean; failures?: number }): number {
  if (opts.streamConnected) return CONNECTED_SWEEP_MS;
  const n = Math.max(0, Math.floor(opts.failures ?? consecutiveFailures));
  return Math.min(ATTEMPT_BASE_MS * 2 ** n, ATTEMPT_MAX_MS);
}

/** Whether to fire a network attempt right now. The only hard stop is
 *  the OS saying there is no network at all; a down stream is not a
 *  reason to sit on queued work. */
export function shouldAttempt(opts: { onLine: boolean | undefined }): boolean {
  return opts.onLine !== false;
}

/** Does a connectivity-class failure count against a bounded retry
 *  budget? Only if the server was believed reachable at the time —
 *  otherwise the budget would burn on a dead link and strand the item
 *  as "failed" the moment signal returns. */
export function countsAgainstBudget(opts: { streamConnected: boolean; now?: number }): boolean {
  return opts.streamConnected || recentlyReachable(opts.now ?? Date.now());
}

/** Test hook. */
export function _reset(): void {
  lastAnsweredAt = 0;
  lastFailureAt = 0;
  consecutiveFailures = 0;
}
