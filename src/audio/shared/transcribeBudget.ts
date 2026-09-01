/**
 * @fileoverview How long ONE /transcribe attempt is allowed to take.
 *
 * Pure arithmetic, deliberately split out of memoOutbox so the ladder is
 * unit-testable without a DOM — the two field wedges this file exists to
 * prevent were both budget-arithmetic bugs, and both shipped because the
 * number was buried inline in a flush handler.
 *
 * TWO instruments, because the budget has to survive two different
 * unknowns:
 *
 *  1. STALL (src/util/stallTimeoutPost.ts) bounds the upload by "no bytes
 *     moved", which is bandwidth-independent. This is what makes a slow
 *     link work AT ALL, and it is the primary fix.
 *
 *  2. ESCALATION (here) grows every bound with the number of prior failed
 *     attempts. This is the guarantee, not the mechanism: whatever the
 *     stall detector cannot see — a proxy that buffers the whole body so
 *     progress events lie, a server that is merely slow, an environment
 *     with no upload events at all — still gets a materially larger
 *     budget on each retry, so the queue drains instead of looping.
 *     Capped, so a genuinely broken upload still fails in bounded time.
 *
 * The attempt counter is PERSISTED on the queue row (see
 * queue.bumpAttempts). An escalation that resets on reload is the same
 * infinite loop wearing a hat.
 */

/** Base "no bytes moved" window for a fresh attempt. Comfortably above
 *  the ~1-3s inter-packet gaps of even a bad mobile link, well below the
 *  point where a user assumes the app is dead. */
export const BASE_STALL_MS = 20_000;
/** Escalated stall windows stop growing here. */
export const MAX_STALL_MS = 120_000;
/** Escalated response windows stop growing here. */
export const MAX_RESPONSE_MS = 240_000;
/** Absolute per-attempt cap. A trickle that never technically stalls
 *  still has to terminate, or it blocks the serialized flush forever. */
export const CEILING_MS = 600_000;
/** Escalation saturates here (attempts >= 3 → 8x). Bounds both the
 *  worst-case wait AND the number of times queue.bumpAttempts has to
 *  write the row back to IndexedDB. */
export const MAX_ESCALATION_FACTOR = 8;

/** Blobs above this get the long-clip response budgets. Unchanged from
 *  the pre-fix ladder — see baseResponseMs. */
const LARGE_BLOB_BYTES = 1_000_000;

/** 1, 2, 4, 8, 8, 8, … for attempts 0, 1, 2, 3, … */
export function escalationFactor(attempts: number | undefined): number {
  const a = Number.isFinite(attempts) && (attempts as number) > 0 ? Math.floor(attempts as number) : 0;
  return Math.min(2 ** a, MAX_ESCALATION_FACTOR);
}

/**
 * Wall-clock budget for the SERVER's response on a first attempt.
 *
 * Preserved verbatim from the pre-fix ladder, because this half of it
 * was never wrong: Deepgram batch latency really does grow with audio
 * length, and nothing about the response phase is observable as
 * "progress", so a wall clock is the right instrument here. What was
 * wrong was using this same number to bound the UPLOAD.
 *
 *   < 1MB                      15s   — a minute or less of audio
 *   > 1MB                      60s
 *   > 1MB and chunking-sized  120s   — undecodable long clip forced
 *                                      through the single-shot path
 */
export function baseResponseMs(sizeBytes: number, chunkedCandidate: boolean): number {
  if (sizeBytes > LARGE_BLOB_BYTES) return chunkedCandidate ? 120_000 : 60_000;
  return 15_000;
}

export interface BudgetInput {
  sizeBytes: number;
  /** needsChunking(durationMs, size) — a long clip that fell back to
   *  single-shot because it could not be decoded. */
  chunkedCandidate?: boolean;
  /** Prior FAILED attempts for this queue item (0 on a fresh blob). */
  attempts?: number;
  /** Override the first-attempt response budget. The chunked path passes
   *  its per-chunk budget here (which the failure smoke shrinks via
   *  setChunkTimeoutMsForTest). */
  baseResponseMsOverride?: number;
}

export interface AttemptBudget {
  stallMs: number;
  responseMs: number;
  ceilingMs: number;
  /** Escalation multiplier applied — logged so a field report can show
   *  the budget actually grew rather than "it passed eventually". */
  factor: number;
}

/** Budget for attempt number `attempts` (0-based) of a single upload. */
export function transcribeBudget(input: BudgetInput): AttemptBudget {
  const factor = escalationFactor(input.attempts);
  const base = input.baseResponseMsOverride ?? baseResponseMs(input.sizeBytes, !!input.chunkedCandidate);
  return {
    stallMs: Math.min(BASE_STALL_MS * factor, MAX_STALL_MS),
    responseMs: Math.min(base * factor, MAX_RESPONSE_MS),
    ceilingMs: CEILING_MS,
    factor,
  };
}
