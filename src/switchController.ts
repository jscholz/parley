/**
 * @fileoverview Single owner of the session-switch epoch.
 *
 * Session focus used to live in three loosely-coupled globals inside
 * sessionDrawer (optimisticActiveId, viewedSessionId, resumeGen), read
 * with inconsistent precedence at ~15 sites — and only resumeGen carried
 * any epoch protection, scoped to resume()'s own body. The result was a
 * split-brain: the drawer highlight (painted by refresh() off a stale
 * pre-await snapshot) and the transcript (gated by a lagging viewed id)
 * could disagree, producing the A→B→A highlight bounce on slow links.
 *
 * This module makes "which switch is current" a single source of truth.
 * A switch mints one token via begin(); EVERY async continuation that
 * wants to write focus, highlight, or transcript checks isCurrent(tok)
 * (or routes through ifStillFocused) and no-ops when superseded. Only the
 * latest switch can write.
 *
 * State machine:
 *   - `optimistic` — the row to highlight while a switch is in flight.
 *     Set synchronously at click/begin so refresh() paints the clicked
 *     row even before the transcript fetch resolves.
 *   - `viewed` — the session whose transcript is COMMITTED on screen.
 *     Promoted from optimistic on the first render (cache or, for a cold
 *     chat, server) via commit(). This is what the live-delta / SSE /
 *     engagement gates read.
 *   - `gen` — monotonic generation. begin() bumps it; a token is "current"
 *     iff its gen still equals the live gen.
 *
 * The token carries an optional targetMessageId (the pin/activity drill
 * anchor) so a future range-aware cache can resolve "which cached window
 * to paint for this switch" without a side channel — the controller owns
 * WHAT we're switching to (session + anchor); sessionCache owns the best
 * cached range for that target.
 *
 * Pure leaf module: no app imports, so it stays trivially testable and
 * cycle-free. The side effects of "a view changed" (badge clear, activity
 * read-marking, reportChatSwitch, highlight clear) stay in
 * sessionDrawer.setViewed — this module only owns the identity + epoch.
 */

export interface SwitchToken {
  readonly gen: number;
  readonly id: string;
  /** Pin/activity drill anchor, if this switch targets a specific bubble. */
  readonly targetMessageId?: string;
}

/** Paint authority for a chat that is ALREADY focused — background
 *  reconciles (foreground resume, post-final durable refresh) that
 *  repaint what's on screen rather than switching to something new.
 *  Dies the moment focus moves: focus flips synchronously at click
 *  (setOptimistic), so a continuation holding a ViewToken for the old
 *  chat can never paint over the new one. Distinguished from
 *  SwitchToken by the absence of `gen`. */
export interface ViewToken {
  readonly view: true;
  readonly id: string;
}

/** What paint paths accept: a supersedable switch (authorizes TAKING
 *  OVER the pane) or a view token (authorizes REPAINTING the focused
 *  chat). Checked by canPaint at paint time, not mint time. */
export type PaintToken = SwitchToken | ViewToken;

/** Mint a view token for a chat believed to be on screen. Cheap and
 *  unconditional — validity is evaluated by canPaint() when the paint
 *  actually happens, which is what makes late continuations safe. */
export function viewTokenFor(id: string): ViewToken {
  return { view: true, id };
}

/** THE paint gate (hardening invariant #1): may `tok` write the
 *  transcript pane right now? Switch tokens paint while their epoch is
 *  live; view tokens paint while their chat is still the focused one.
 *  Every replay/resume render funnels through this via
 *  replaySessionMessages — call sites don't hand-roll epoch checks. */
export function canPaint(tok: PaintToken): boolean {
  if ('gen' in tok) return tok.gen === gen;
  return focusedId() === tok.id;
}

let gen = 0;
let optimistic: string | null = null;
let viewed: string | null = null;

/** Open a new switch: bump the generation and claim the optimistic
 *  highlight synchronously. Returns the token that authorizes every
 *  subsequent write for THIS switch. */
export function begin(id: string, targetMessageId?: string): SwitchToken {
  gen += 1;
  optimistic = id;
  return { gen, id, targetMessageId };
}

/** True iff `tok` is still the live switch (no newer begin()/invalidate()
 *  has superseded it). Async continuations gate on this. */
export function isCurrent(tok: SwitchToken): boolean {
  return tok.gen === gen;
}

/** Supersede the current switch without starting a new one — used when a
 *  chat is deleted out from under an in-flight resume so its render
 *  continuation bails. Callers clear optimistic/viewed as appropriate. */
export function invalidate(): void {
  gen += 1;
}

/** Commit `tok`'s session as the on-screen view (optimistic → viewed),
 *  iff still current. Returns whether the commit happened. No-op when
 *  superseded so a stale render can't claim the view. */
export function commit(tok: SwitchToken): boolean {
  if (tok.gen !== gen) return false;
  viewed = tok.id;
  return true;
}

/** Highlight/engagement focus: the in-flight click target if any, else
 *  the committed view. */
export function focusedId(): string | null {
  return optimistic ?? viewed;
}

/** The session whose transcript is committed on screen — what the
 *  live-delta / SSE / render gates compare against. */
export function viewedId(): string | null {
  return viewed;
}

/** The in-flight switch target, or null when no switch is pending. */
export function optimisticId(): string | null {
  return optimistic;
}

/** Synchronously claim the optimistic highlight without minting a token —
 *  the click/keyboard/drill handlers call this so a scheduleRefresh racing
 *  the async resume() paints the clicked row, not the old one. */
export function setOptimistic(id: string | null): void {
  optimistic = id;
}

/** Set the committed view directly (raw — no side effects). The
 *  side-effecting entry point is sessionDrawer.setViewed. */
export function setViewed(id: string | null): void {
  viewed = id;
}

/** Clear the optimistic highlight iff `tok` is still current and it still
 *  points at `tok.id` — the resume() finally-block cleanup. A newer switch
 *  already owns optimistic; touching it would corrupt that switch. */
export function clearOptimisticIfCurrent(tok: SwitchToken): void {
  if (tok.gen === gen && optimistic === tok.id) optimistic = null;
}

/** Run `fn` only if focus hasn't moved away from `expectedId` — the guard
 *  for fire-and-forget repaints / reconciles that don't own a token
 *  (refresh repaint, onResume SSE reconcile, pollers). */
export function ifStillFocused(expectedId: string | null, fn: () => void): void {
  if (focusedId() === expectedId) fn();
}
