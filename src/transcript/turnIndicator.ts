/**
 * @fileoverview Turn-status indicator decision model (field 2026-09-08).
 *
 * Bug: the in-transcript "Working" bubble (`transcript/store.ts`'s
 * `turnStatus`, rendered by projection.ts as the bottom-pinned
 * turn-status line) was set ONLY by a `status` envelope — the hermes
 * plugin's conversion of the gateway's periodic progress heartbeat,
 * gated by `agent.gateway_notify_interval` (default 180s, not
 * overridden). `typing` envelopes arrive roughly every 2s throughout a
 * turn but only ever flipped the header's ephemeral activity dot
 * (`subs.onActivity`), never the transcript. Net effect: a turn under
 * ~3 minutes — the common case — showed no in-transcript indicator at
 * all, which read as "flaky" rather than "always absent early."
 *
 * Fix: `typing` now paints a plain "Thinking" placeholder (reusing
 * `formatTurnStatus('')`, not a second hardcoded string) the first
 * time it's seen for an otherwise-quiet turn. A later `status` always
 * upgrades that placeholder IN PLACE — never a second bubble. The
 * whole thing self-heals if neither signal arrives for
 * TURN_INDICATOR_STALE_MS, so a missed terminal envelope can't leave
 * the bubble spinning forever.
 *
 * `reduceTurnIndicator` is the pure decision — given the previous
 * state, an incoming signal, and an explicit `now`, it decides
 * show/upgrade/clear with no DOM and no clock reads, so it's unit
 * tested without sleeping. Everything below the pure-function section
 * is impure per-chat bookkeeping that feeds it into
 * `transcript/store.ts`'s `setTurnStatus`, which projection already
 * knows how to render.
 */

import { formatTurnStatus } from '../util/progressHeartbeat.ts';
import { setTurnStatus } from './store.ts';

/** Silence window after which a turn indicator self-clears. Real
 *  `typing` pulses arrive ~every 2s while a turn is in flight (measured
 *  84 in a 3-minute window), so 15s is several missed beats in a row —
 *  generous enough to never fire while a turn is genuinely still
 *  going, tight enough that a dead turn's bubble doesn't outlive it by
 *  more than a few seconds. Reused for two distinct self-heals (see
 *  `reduceTurnIndicator` doc): a missed terminal envelope, and a stuck
 *  `justEnded` latch — one clock, one constant. */
export const TURN_INDICATOR_STALE_MS = 15_000;

export type TurnIndicatorEvent =
  | { kind: 'typing' }
  | { kind: 'status'; text: string; done: boolean };

/**
 * `rawText`: the heartbeat text backing the current label, or `null`
 *   when nothing should render. `''` is a valid, distinct value — the
 *   typing-only placeholder — `formatTurnStatus('')` is "Thinking".
 * `at`: last time this state was confirmed by a live typing/status
 *   signal. Drives staleness (both self-heals below).
 * `justEnded`: true immediately after a `status: done`. Guards against
 *   a straggler `typing` for the SAME turn — delivery order between
 *   the terminal status and the last typing pulse isn't guaranteed —
 *   resurrecting the bubble it just closed. Cleared by the next
 *   non-done status, or once the state goes stale (same clock as
 *   above — a stuck latch self-heals exactly like a missed terminal
 *   envelope would, so a genuinely new turn's typing is never blocked
 *   for more than TURN_INDICATOR_STALE_MS).
 */
export interface TurnIndicatorState {
  rawText: string | null;
  at: number;
  justEnded: boolean;
}

export const IDLE_TURN_INDICATOR: TurnIndicatorState = { rawText: null, at: 0, justEnded: false };

export function isTurnIndicatorStale(state: TurnIndicatorState, now: number): boolean {
  return now - state.at >= TURN_INDICATOR_STALE_MS;
}

/**
 * Pure decision: given the previous state, an incoming typing/status
 * signal, and `now`, returns the next state. Rules:
 *
 *  - A state older than TURN_INDICATOR_STALE_MS is treated as fresh
 *    idle FIRST. This is the single mechanism behind both self-heals:
 *    a missed terminal envelope (stale non-null rawText resets to
 *    nothing) and a stuck `justEnded` latch (stale latch resets so a
 *    later turn's typing isn't blocked forever).
 *  - `status` with `done: false` always wins: sets/upgrades the label
 *    and clears any latch — "upgrade, never duplicate."
 *  - `status` with `done: true` clears the label and latches
 *    `justEnded`.
 *  - `typing` while latched just-ended: a no-op, returning the INPUT
 *    unchanged (not `base`) — `at` is deliberately not bumped, so the
 *    staleness clock keeps counting from the `done` event itself, not
 *    from the straggler that triggered this call.
 *  - `typing` with an existing label (placeholder or upgraded): keeps
 *    the label, bumps `at`. Typing is itself a liveness signal — it
 *    must not let an in-flight turn's indicator go stale just because
 *    the last `status` heartbeat happened to be a while ago (heartbeats
 *    can be minutes apart; typing is not).
 *  - `typing` with no label and no latch: sets the plain "Thinking"
 *    placeholder (`rawText: ''`).
 */
export function reduceTurnIndicator(
  prev: TurnIndicatorState,
  event: TurnIndicatorEvent,
  now: number,
): TurnIndicatorState {
  const base = isTurnIndicatorStale(prev, now) ? IDLE_TURN_INDICATOR : prev;

  if (event.kind === 'status') {
    return event.done
      ? { rawText: null, at: now, justEnded: true }
      : { rawText: event.text, at: now, justEnded: false };
  }

  // 'typing'
  if (base.justEnded) return prev;
  if (base.rawText !== null) return { ...base, at: now };
  return { rawText: '', at: now, justEnded: false };
}

/** Render label for a state ("Thinking" / parsed heartbeat), or `null`
 *  to show nothing. Re-checks staleness so a caller reading state
 *  without having just called `reduceTurnIndicator` never renders a
 *  dead bubble. */
export function turnIndicatorLabel(state: TurnIndicatorState, now: number): string | null {
  if (isTurnIndicatorStale(state, now)) return null;
  return state.rawText === null ? null : formatTurnStatus(state.rawText);
}

// ── impure per-chat wiring ───────────────────────────────────────────────
//
// Keyed by chatId — exactly like transcript/store.ts's own per-chat
// `states` map, so a typing envelope for a background chat only ever
// touches that chat's entry and never paints the viewed chat's
// transcript (the reconciler already re-renders only the active chat
// on `notify`; this map just keeps the decision state chat-scoped
// upstream of that).

const indicators = new Map<string, TurnIndicatorState>();

function apply(chatId: string, event: TurnIndicatorEvent, now: number): void {
  const prev = indicators.get(chatId) ?? IDLE_TURN_INDICATOR;
  const next = reduceTurnIndicator(prev, event, now);
  indicators.set(chatId, next);
  setTurnStatus(chatId, next.rawText);
}

export interface NoteOpts {
  /** Set from `env._replay === true`. A replayed `typing` must not
   *  resurrect a dead turn's indicator any more than a replayed
   *  `status` may — the SSE ring replay (proxy/parley/stream.ts) and
   *  the inflight-cache replay (proxyClient.ts's replayInflight) both
   *  stamp `_replay: true` on EVERY envelope type generically,
   *  `typing` included, so the gate lives here rather than trusting
   *  each call site to remember it. */
  isReplay?: boolean;
  now?: number;
}

/** `typing` envelope for `chatId`. No-ops on replay (see `NoteOpts`). */
export function noteTyping(chatId: string, opts: NoteOpts = {}): void {
  if (opts.isReplay) return;
  apply(chatId, { kind: 'typing' }, opts.now ?? Date.now());
}

/** `status` envelope for `chatId` — always upgrades the label in
 *  place; `done` clears it and latches against a same-turn straggler
 *  `typing`. No-ops on replay, same as `noteTyping`. */
export function noteStatus(chatId: string, text: string, done: boolean, opts: NoteOpts = {}): void {
  if (opts.isReplay) return;
  apply(chatId, { kind: 'status', text, done }, opts.now ?? Date.now());
}

/** Sweep every chat with live bookkeeping and clear any that's gone
 *  stale (no typing/status signal in TURN_INDICATOR_STALE_MS) — the
 *  self-heal for a missed terminal envelope. `now` is injectable so
 *  tests drive it without a real timer; production wires this to a
 *  real interval via `startTurnIndicatorSweep`. */
export function sweepStaleTurnIndicators(now: number = Date.now()): void {
  for (const [chatId, state] of indicators) {
    if (state.rawText === null && !state.justEnded) continue;
    if (!isTurnIndicatorStale(state, now)) continue;
    indicators.set(chatId, IDLE_TURN_INDICATOR);
    setTurnStatus(chatId, null);
  }
}

/** Test-only: drop all per-chat bookkeeping between scenarios. */
export function resetTurnIndicators(): void {
  indicators.clear();
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Real wall-clock sweep, started once from proxyClient's connect().
 *  Interval is well under the 15s stale threshold so a dead turn's
 *  bubble never outlives it by more than a couple of seconds. */
export function startTurnIndicatorSweep(intervalMs: number = 5_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepStaleTurnIndicators(), intervalMs);
}

export function stopTurnIndicatorSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
