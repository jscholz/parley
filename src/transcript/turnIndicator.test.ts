// Field 2026-09-08: the in-transcript "Working" bubble only ever came
// from a `status` envelope (hermes plugin's conversion of the gateway's
// periodic heartbeat, default 180s), so any turn under ~3 minutes showed
// no indicator at all. This suite covers the pure decision
// (`reduceTurnIndicator` / `turnIndicatorLabel`) and the thin per-chat
// wiring (`noteTyping` / `noteStatus` / `sweepStaleTurnIndicators`) that
// feeds `transcript/store.ts`.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceTurnIndicator, turnIndicatorLabel, isTurnIndicatorStale,
  IDLE_TURN_INDICATOR, TURN_INDICATOR_STALE_MS,
  noteTyping, noteStatus, noteTurnEnded, noteTurnStarted, sweepStaleTurnIndicators, resetTurnIndicators,
} from './turnIndicator.ts';
import { getState } from './store.ts';

const T0 = 1_000_000;

describe('reduceTurnIndicator — pure decision', () => {
  it('typing with no status shows "Thinking"', () => {
    const s = reduceTurnIndicator(IDLE_TURN_INDICATOR, { kind: 'typing' }, T0);
    assert.equal(s.rawText, '');
    assert.equal(turnIndicatorLabel(s, T0), 'Thinking');
  });

  it('status upgrades the placeholder in place (no duplicate)', () => {
    const thinking = reduceTurnIndicator(IDLE_TURN_INDICATOR, { kind: 'typing' }, T0);
    const upgraded = reduceTurnIndicator(
      thinking,
      { kind: 'status', text: '⏳ Working — 3 min — iteration 4/60, terminal', done: false },
      T0 + 1000,
    );
    assert.equal(turnIndicatorLabel(upgraded, T0 + 1000), 'Working · 3 min · iteration 4/60 · terminal');
    // Further typing pulses keep the richer label — never downgrade
    // back to "Thinking".
    const stillUpgraded = reduceTurnIndicator(upgraded, { kind: 'typing' }, T0 + 3000);
    assert.equal(turnIndicatorLabel(stillUpgraded, T0 + 3000),
      'Working · 3 min · iteration 4/60 · terminal');
  });

  it('status done clears the indicator', () => {
    const working = reduceTurnIndicator(
      IDLE_TURN_INDICATOR, { kind: 'status', text: '⏳ Working — 1 min', done: false }, T0);
    const ended = reduceTurnIndicator(working, { kind: 'status', text: '', done: true }, T0 + 500);
    assert.equal(turnIndicatorLabel(ended, T0 + 500), null);
    assert.equal(ended.justEnded, true);
  });

  it('typing after done within the same turn does not resurrect', () => {
    // Rule implemented: a `status: done` latches `justEnded`; a typing
    // pulse arriving while latched is a no-op (delivery order between
    // the terminal status and a last straggler typing pulse is not
    // guaranteed). The latch itself expires via the SAME staleness
    // clock as everything else — see the boundary test below — so a
    // genuinely new turn is never blocked for more than
    // TURN_INDICATOR_STALE_MS.
    const working = reduceTurnIndicator(
      IDLE_TURN_INDICATOR, { kind: 'status', text: '⏳ Working — 1 min', done: false }, T0);
    const ended = reduceTurnIndicator(working, { kind: 'status', text: '', done: true }, T0 + 500);
    const straggler = reduceTurnIndicator(ended, { kind: 'typing' }, T0 + 700);
    assert.equal(turnIndicatorLabel(straggler, T0 + 700), null,
      'a typing pulse landing shortly after done must not resurrect the bubble');
    assert.deepEqual(straggler, ended, 'the straggler is a pure no-op — state is untouched');
  });

  it('staleness boundary: just inside 15s a live indicator survives, at/after it self-clears', () => {
    const thinking = reduceTurnIndicator(IDLE_TURN_INDICATOR, { kind: 'typing' }, T0);
    const justInside = T0 + TURN_INDICATOR_STALE_MS - 1;
    assert.equal(isTurnIndicatorStale(thinking, justInside), false);
    assert.equal(turnIndicatorLabel(thinking, justInside), 'Thinking');

    const atBoundary = T0 + TURN_INDICATOR_STALE_MS;
    assert.equal(isTurnIndicatorStale(thinking, atBoundary), true);
    assert.equal(turnIndicatorLabel(thinking, atBoundary), null);

    // A typing pulse AT the stale boundary treats the old state as
    // idle first, then opens a fresh placeholder — self-heal for a
    // turn whose terminal envelope never arrived.
    const resurrected = reduceTurnIndicator(thinking, { kind: 'typing' }, atBoundary);
    assert.equal(turnIndicatorLabel(resurrected, atBoundary), 'Thinking');
  });

  it('staleness boundary also expires a stuck justEnded latch', () => {
    const ended: ReturnType<typeof reduceTurnIndicator> =
      { rawText: null, at: T0, justEnded: true };
    const stillLatched = reduceTurnIndicator(ended, { kind: 'typing' }, T0 + TURN_INDICATOR_STALE_MS - 1);
    assert.equal(turnIndicatorLabel(stillLatched, T0 + TURN_INDICATOR_STALE_MS - 1), null);

    const afterStale = reduceTurnIndicator(ended, { kind: 'typing' }, T0 + TURN_INDICATOR_STALE_MS);
    assert.equal(turnIndicatorLabel(afterStale, T0 + TURN_INDICATOR_STALE_MS), 'Thinking',
      'a new turn\'s typing must not be blocked forever by a previous turn\'s done-latch');
  });
});

describe('noteTyping / noteStatus — per-chat wiring into transcript/store', () => {
  beforeEach(() => {
    resetTurnIndicators();
  });

  it('typing paints "Thinking" via transcriptStore.setTurnStatus', () => {
    // store.setTurnStatus stamps its own real-time `at` (it's the
    // render-facing side, independent of this module's own staleness
    // clock) — only the raw text is ours to assert here.
    const chatId = `chat-note-typing-${Math.random()}`;
    noteTyping(chatId, { now: T0 });
    assert.equal(getState(chatId).turnStatus?.text, '');
  });

  it('replay envelopes are ignored for both typing and status', () => {
    const chatId = `chat-note-replay-${Math.random()}`;
    noteTyping(chatId, { now: T0, isReplay: true });
    assert.equal(getState(chatId).turnStatus, null,
      'a replayed typing envelope must not resurrect the indicator');
    noteStatus(chatId, '⏳ Working — 1 min', false, { now: T0, isReplay: true });
    assert.equal(getState(chatId).turnStatus, null,
      'a replayed status envelope must not resurrect the indicator');
  });

  it('a second chat\'s typing does not affect the first', () => {
    const chatA = `chat-note-a-${Math.random()}`;
    const chatB = `chat-note-b-${Math.random()}`;
    noteStatus(chatA, '⏳ Working — 2 min', false, { now: T0 });
    noteTyping(chatB, { now: T0 + 10 });
    assert.equal(getState(chatA).turnStatus?.text, '⏳ Working — 2 min',
      'chat A keeps its own status text');
    assert.equal(getState(chatB).turnStatus?.text, '',
      'chat B gets its own independent placeholder');
  });

  it('sweepStaleTurnIndicators self-clears a chat with no recent signal', () => {
    const chatId = `chat-note-sweep-${Math.random()}`;
    noteTyping(chatId, { now: T0 });
    sweepStaleTurnIndicators(T0 + TURN_INDICATOR_STALE_MS - 1);
    assert.notEqual(getState(chatId).turnStatus, null, 'not stale yet — must still be showing');
    sweepStaleTurnIndicators(T0 + TURN_INDICATOR_STALE_MS);
    assert.equal(getState(chatId).turnStatus, null, 'stale — sweep must clear it');
  });
});

// ── end-of-turn (field 2026-09-11) ─────────────────────────────────────
// "Stale thinking dots at the end of turns, which go away when I do
// /agents or /status." Nothing was wired to reply_final, so the dots sat
// out the staleness window; the slash command only "fixed" it because its
// own turn reset the bookkeeping.
describe('noteTurnEnded', () => {
  it('clears the indicator immediately when a turn finishes', () => {
    const chatId = `chat-end-${Math.random()}`;
    noteTyping(chatId, { now: T0 });
    assert.equal(getState(chatId).turnStatus?.text, '');
    noteTurnEnded(chatId, { now: T0 + 10 });
    assert.equal(getState(chatId).turnStatus, null);
  });

  it('does NOT clear on an interim (heartbeat) final — the turn is still running', () => {
    const chatId = `chat-end-interim-${Math.random()}`;
    noteTyping(chatId, { now: T0 });
    noteStatus(chatId, '⏳ Working — 2 min — iteration 7/60, terminal', false, { now: T0 + 5 });
    const mid = getState(chatId).turnStatus?.text;
    noteTurnEnded(chatId, { now: T0 + 10, interim: true });
    assert.equal(getState(chatId).turnStatus?.text, mid,
      'an interim final must leave the indicator alone');
  });

  it('ignores a replayed final so it cannot kill a live turn', () => {
    const chatId = `chat-end-replay-${Math.random()}`;
    noteTyping(chatId, { now: T0 });
    noteTurnEnded(chatId, { now: T0 + 10, isReplay: true });
    assert.equal(getState(chatId).turnStatus?.text, '');
  });

  it('leaves other chats alone', () => {
    const a = `chat-end-a-${Math.random()}`;
    const b = `chat-end-b-${Math.random()}`;
    noteTyping(a, { now: T0 });
    noteTyping(b, { now: T0 });
    noteTurnEnded(a, { now: T0 + 10 });
    assert.equal(getState(a).turnStatus, null);
    assert.equal(getState(b).turnStatus?.text, '');
  });
});

// ── turn start releases the end-of-turn latch (field 2026-09-11) ───────
// The latch that stops a straggler `typing` resurrecting a finished turn
// also muted the FIRST dots of the next turn for the whole staleness
// window. A user message is the unambiguous new-turn signal.
describe('noteTurnStarted', () => {
  it('lets the next turn paint immediately after a finished one', () => {
    const chatId = `chat-restart-${Math.random()}`;
    noteTyping(chatId, { now: T0 });
    noteTurnEnded(chatId, { now: T0 + 10 });
    assert.equal(getState(chatId).turnStatus, null);
    // Without the release this typing is refused for TURN_INDICATOR_STALE_MS.
    noteTurnStarted(chatId, {});
    noteTyping(chatId, { now: T0 + 20 });
    assert.equal(getState(chatId).turnStatus?.text, '',
      "a new turn's first typing must paint at once");
  });

  it('still suppresses a straggler typing when no new turn began', () => {
    const chatId = `chat-straggler-${Math.random()}`;
    noteTyping(chatId, { now: T0 });
    noteTurnEnded(chatId, { now: T0 + 10 });
    noteTyping(chatId, { now: T0 + 20 });
    assert.equal(getState(chatId).turnStatus, null,
      'a stray typing with no user message before it must stay ignored');
  });

  it('ignores a replayed user message', () => {
    const chatId = `chat-restart-replay-${Math.random()}`;
    noteTyping(chatId, { now: T0 });
    noteTurnEnded(chatId, { now: T0 + 10 });
    noteTurnStarted(chatId, { isReplay: true });
    noteTyping(chatId, { now: T0 + 20 });
    assert.equal(getState(chatId).turnStatus, null);
  });
});
