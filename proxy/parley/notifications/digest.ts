// Bundle-digest counter — collapses rapid same-chat push bursts into
// a single (count-prefixed) banner on iOS.
//
// How this works given Apple's relay semantics:
//
// We tag every push for the same chat with the same `chat:<id>` value
// (see dispatch.ts:envelopeToPayload). Apple's web-push relay then
// REPLACES the prior banner with the new one instead of stacking —
// the user sees one banner per chat at any moment.
//
// Without a counter, that one banner only shows the LATEST message —
// the user loses count of how many arrived. With this counter, we
// prefix the title with `(N)` so the user sees:
//
//   Clawdian        "Let me check that..."
//   (2) Clawdian    "Here's what I found:"
//   (3) Clawdian    "Actually, one more thing..."
//
// = same single banner, updated three times, final state shows "(3)".
//
// State is per-chat, in-process. A `BURST_WINDOW_MS` of 30s gives a
// natural reset — once 30s pass with no pushes for the chat, the
// counter starts over at 1. No deferral, no timer scheduling: each
// push goes out immediately, the counter just decorates the title.

const BURST_WINDOW_MS = 30_000;

interface DigestEntry {
  count: number;
  resetAt: number;
}

const counts = new Map<string, DigestEntry>();

/** Record a push for `chatId` and return the resulting count. The
 *  caller's job is to use the count to format the payload title.
 *  Count = 1 means the first push in this burst window (no
 *  decoration). Count >= 2 means we're in a burst (prefix title
 *  with "(N) "). The window slides forward on every push so a chat
 *  with sustained activity keeps counting up. */
export function recordPushAndGetCount(chatId: string): number {
  if (!chatId) return 1;
  const now = Date.now();
  const entry = counts.get(chatId);
  if (!entry || entry.resetAt < now) {
    counts.set(chatId, { count: 1, resetAt: now + BURST_WINDOW_MS });
    return 1;
  }
  entry.count += 1;
  // Slide the window forward — sustained activity keeps the counter
  // alive. Once 30s pass with no pushes, the next push starts a
  // fresh burst.
  entry.resetAt = now + BURST_WINDOW_MS;
  return entry.count;
}

/** Apply the count to a payload title in place. Count 1 = no change
 *  (first push in burst). Count >= 2 = prefix with "(N) ". */
export function decorateTitleForCount(title: string, count: number): string {
  if (count <= 1) return title;
  return `(${count}) ${title}`;
}

/** Test-only seam. */
export function __resetDigestForTest(): void {
  counts.clear();
}

/** Test-only seam — simulate the entry being last-touched `msInPast`
 *  milliseconds ago, so the next push decides expiry based on a
 *  realistic resetAt rather than an arbitrary past timestamp. */
export function __backdateDigestForTest(chatId: string, msInPast: number): void {
  const entry = counts.get(chatId);
  if (entry) {
    // If we simulate the entry as last-touched `msInPast` ago, then
    // its resetAt at that time was `(then) + BURST_WINDOW_MS`. Right
    // now that's `Date.now() - msInPast + BURST_WINDOW_MS`. With
    // msInPast > BURST_WINDOW_MS the entry tests as expired; with
    // msInPast < BURST_WINDOW_MS it's still alive.
    entry.resetAt = Date.now() - msInPast + BURST_WINDOW_MS;
  }
}

export function getBurstWindowMs(): number {
  return BURST_WINDOW_MS;
}
