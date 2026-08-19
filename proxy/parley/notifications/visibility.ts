// Per-chat user-engagement signal — backs the visibility-aware push
// gate. The PWA POSTs visibility changes here so the proxy can
// distinguish "SSE attached but user isn't actively looking" from
// "user is foregrounded + viewing this chat right now".
//
// Why this exists in addition to hasActiveSubFor + the 30s idle gate
// (commit 529d8c4):
//
//   - SSE-attached is too loose: iOS Safari keeps SSE connections
//     alive for tens of seconds after the PWA backgrounds. With only
//     hasActiveSubFor as the gate, an agent reply that lands during
//     that window suppresses push and the user never sees the message.
//
//   - 30s idle is a coarse heuristic: a chat with deltas flowing every
//     second would never trigger it, even if the user just backgrounded
//     mid-reply.
//
// The visibility signal is the most direct + accurate: the PWA tells
// us, on every document.visibilitychange + every chat switch, what
// chat (if any) the user is actively viewing. The gate trusts the
// signal for a short window (ENGAGED_WINDOW_MS = 10000ms). The PWA
// heartbeats every 8s while foregrounded/focused; hidden and blur clear
// immediately so background replies still push. Beyond the window, fall back to the
// existing hasActiveSubFor + idle gates.
//
// State is in-process only — no persistence. Subscriptions persist
// across proxy restart; visibility doesn't, and that's fine because
// the PWA re-reports on the next visibilitychange or chat switch.

const ENGAGED_WINDOW_MS = 10000;

/** Per-chat last visibility-visible timestamp. Updated on every
 *  POST /api/parley/notifications/visibility with state='visible'.
 *  Read by the dispatch gate via isUserEngaged. */
const lastVisibleAt = new Map<string, number>();

/** Record a visibility transition. `chatId` is the chat the user is
 *  ACTUALLY viewing at the moment of the report. Hidden includes browser
 *  blur on desktop, so clear immediately rather than waiting out the 2s
 *  engagement window and risking a missed blocking approval push. */
export function recordVisibility(state: 'visible' | 'hidden', chatId: string): void {
  if (!chatId) return;
  if (state === 'visible') {
    lastVisibleAt.set(chatId, Date.now());
  } else {
    lastVisibleAt.delete(chatId);
  }
}

/** True if a PWA reported visibility=visible for `chatId` within
 *  the last ENGAGED_WINDOW_MS milliseconds. The push gate skips
 *  dispatch when this returns true — the user is actively looking. */
export function isUserEngaged(chatId: string): boolean {
  if (!chatId) return false;
  const last = lastVisibleAt.get(chatId);
  if (!last) return false;
  return (Date.now() - last) < ENGAGED_WINDOW_MS;
}

/** Test-only seam. Clears in-process state so cases don't leak. */
export function __resetVisibilityForTest(): void {
  lastVisibleAt.clear();
}

/** Test-only seam. Backdates the engagement timestamp for a chat so
 *  tests can exercise the "engaged but stale" boundary without sleeping
 *  ENGAGED_WINDOW_MS in real time. */
export function __backdateVisibilityForTest(chatId: string, msAgo: number): void {
  lastVisibleAt.set(chatId, Date.now() - msAgo);
}

/** Read accessor for diagnostics + tests. */
export function getEngagedWindowMs(): number {
  return ENGAGED_WINDOW_MS;
}
