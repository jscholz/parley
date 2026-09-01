/**
 * @fileoverview The /transcribe HTTP client + its failure classification.
 * Extracted from memoOutbox.ts so the permanent-vs-transient matrix is
 * unit-testable (memoOutbox itself pulls DOM-bound modules and can't be
 * imported under node --test). The classification decides whether a
 * queued memo is DROPPED (permanent) or retried forever (transient) —
 * getting it wrong either loses audio or wedges the outbox.
 */

import { postJsonWithStallTimeout } from '../../util/stallTimeoutPost.ts';
import type { AttemptBudget, ProgressFn } from '../../util/stallTimeoutPost.ts';

/** Marker for unprocessable-blob failures (Deepgram 400 / corrupt /
 *  unsupported) — caught at the item level to run the drop-from-queue
 *  narration instead of retrying forever. */
export class PermanentTranscribeError extends Error {}

const isPermanentErr = (err: string) => /\b4\d\d\b|corrupt|unsupported|empty body/i.test(err);

/** A bare number keeps the old single-wall-clock call shape working
 *  (used by tests and by any caller that has no bandwidth concern): the
 *  same value bounds all three phases. */
function toBudget(b: number | AttemptBudget): AttemptBudget {
  return typeof b === 'number' ? { stallMs: b, responseMs: b, ceilingMs: b } : b;
}

/** POST one body to /transcribe and return the transcript string.
 *  Throws PermanentTranscribeError for unprocessable blobs, plain
 *  Error (or TimeoutError / StallTimeoutError) for transient failures.
 *
 *  The transport is stall-bounded, not wall-clock-bounded — see
 *  src/util/stallTimeoutPost.ts for why. Classification below is
 *  transport-independent: it only ever looks at the parsed payload. */
export async function postTranscribe(
  url: string,
  body: Blob,
  mimeType: string,
  budget: number | AttemptBudget,
  onProgress?: ProgressFn,
): Promise<string> {
  const { data } = await postJsonWithStallTimeout(url, body, mimeType, toBudget(budget), onProgress);
  if (!data || !data.ok) {
    // Distinguish PERMANENT failures (corrupt blob, unsupported
    // format, Deepgram 400) from TRANSIENT (network, 5xx, timeout).
    // Permanent: drop from queue so we don't retry forever.
    // Transient: throw, queue.flush keeps the item for next round.
    //
    // Symptom: queued audio memos all fail with "deepgram 400
    // corrupt or unsupported data" on each retry — typically
    // blobs recorded while the iOS mic-perm dialog was up
    // (silent / partial). Without this guard the outbox grows
    // unbounded.
    const err = String(data?.error || 'transcription failed');
    if (isPermanentErr(err)) throw new PermanentTranscribeError(err);
    throw new Error(err);
  }
  return (data.transcript || '').trim();
}
