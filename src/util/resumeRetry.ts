/**
 * Retry policy for a transcript resume that failed on the wire.
 *
 * Field report 2026-09-10 (CAP, flaky 5G): he switched away from a chat
 * and back, and the transcript came back EMPTY — only the live turn
 * indicator, which arrives over SSE and so is independent of the
 * transcript load. The switch blanks the transcript by design
 * ("switch-then-load"), the cache render is skipped when nothing is
 * cached for that chat, and if the `/messages` fetch then fails there is
 * nothing left to paint. The failure path set a status line and refreshed
 * the DRAWER, but nothing ever retried the transcript, so the blank was
 * permanent until the user switched away and back again.
 *
 * The status text said "reconnecting…", which is true of the SSE stream
 * and misleading here: his header read "Connected" the whole time,
 * because the stream never dropped — only the one-off fetch did. So
 * there was no reconnect event to heal it either.
 *
 * Bounded on purpose: a chat that genuinely cannot load should stop
 * hammering a bad link and leave the (accurate) error on screen.
 */

/** Backoff for attempt N (1-based), in ms. */
export const RESUME_RETRY_DELAYS_MS = [800, 2_400, 6_000] as const;

export type ResumeRetryDecision =
  | { retry: true; delayMs: number; attempt: number }
  | { retry: false; reason: string };

/**
 * Should a failed resume be retried, and after how long?
 *
 * @param attemptsSoFar how many retries have already been scheduled for this chat
 * @param opts.stillViewed the user is still on this chat (a switch away cancels)
 * @param opts.renderedSomething the cache render already painted rows — the user
 *   is looking at real (if stale) content, so a retry is a nicety, not a rescue;
 *   the ordinary reconcile paths will catch up and we do not churn the view
 * @param opts.offline the device knows it has no link — waiting for the
 *   reconnect is better than burning attempts against a dead radio
 */
export function shouldRetryResume(
  attemptsSoFar: number,
  opts: { stillViewed: boolean; renderedSomething: boolean; offline?: boolean },
): ResumeRetryDecision {
  if (!opts.stillViewed) return { retry: false, reason: 'switched-away' };
  if (opts.renderedSomething) return { retry: false, reason: 'already-rendered' };
  if (opts.offline) return { retry: false, reason: 'offline' };
  if (attemptsSoFar >= RESUME_RETRY_DELAYS_MS.length) {
    return { retry: false, reason: 'attempts-exhausted' };
  }
  return {
    retry: true,
    attempt: attemptsSoFar + 1,
    delayMs: RESUME_RETRY_DELAYS_MS[attemptsSoFar],
  };
}
