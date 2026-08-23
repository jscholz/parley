/**
 * @fileoverview Store-level tests — specifically the contract for
 * draining stale inflight envelopes on durable refresh.
 *
 * Contract evolution:
 *
 * v1 (commit 4d2f7dd, 2026-05-18): `setDurable` dropped EVERY
 * completed-turn envelope (anything up to & including the last
 * reply_final), assuming durable was authoritative for those turns.
 * Fixed the ghost-tail bug where durable rows arrived with
 * parley_id NULL (the plugin's link-table write had silently
 * failed) — projection couldn't dedup against inflight by key,
 * resulting in duplicate ghost bubbles. Dropping inflight removed
 * the duplicate at the cost of trusting durable absolutely.
 *
 * v2 (this file, 2026-05-19): `setDurable` only drops envelopes
 * whose `reply_final.message_id` is present in durable's
 * `parley_id` set. The v1 assumption broke for background-chat
 * replies: SSE delivered reply_final to the inflight store, but
 * a subsequent switch-in fired setDurable BEFORE the plugin had
 * mirrored the assistant row into state.db / parley.db. With
 * v1 the inflight envelope (the only source of truth) got nuked
 * and the user saw a blank session until a second switch-away-
 * and-back (by which time the mirror caught up).
 *
 * The v1 ghost-tail symptom is addressed at the source by the
 * supplemental store self-heal (phase-3 fingerprint linker,
 * phase-4 orphan drop) — durable rows should now reliably arrive
 * with parley_id. When the link write somehow still fails, v2
 * leaves the inflight envelope alone; the user sees a brief
 * duplicate rather than missing content, which is the safer
 * trade.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getState, setDurable, appendInflight, clearInflightThroughReplyFinal,
  spliceWindow, fillGap, prependDurable, appendDurable,
} from './store.ts';
import type { ConversationItem, ParleyEnvelope } from './types.ts';

const CHAT = 'orphan-test';

function reset(): void {
  // Force a fresh state by wiping durable + inflight.
  setDurable(CHAT, [], { firstId: null, hasMore: false });
  const s = getState(CHAT);
  s.inflight.length = 0;
  s.pendingSends.length = 0;
}

function userMsg(message_id: string, text: string): ParleyEnvelope {
  return { type: 'user_message', chat_id: CHAT, message_id, text };
}
function replyDelta(message_id: string, text: string): ParleyEnvelope {
  return { type: 'reply_delta', chat_id: CHAT, message_id, text };
}
function replyFinal(message_id: string, text?: string): ParleyEnvelope {
  return { type: 'reply_final', chat_id: CHAT, message_id, text };
}
function typing(): ParleyEnvelope {
  return { type: 'typing', chat_id: CHAT };
}
function durableUserRow(id: number, content: string, parley_id?: string): ConversationItem {
  const row: ConversationItem = { id, role: 'user', content, timestamp: 1_779_120_000 + id };
  if (parley_id) row.parley_id = parley_id;
  return row;
}
function durableAssistantRow(id: number, content: string, parley_id?: string): ConversationItem {
  const row: ConversationItem = { id, role: 'assistant', content, timestamp: 1_779_120_000 + id };
  if (parley_id) row.parley_id = parley_id;
  return row;
}

describe('store: setDurable conditionally drains completed-turn inflight envelopes', () => {
  it('keeps in-progress turn envelopes untouched when no reply_final present', () => {
    reset();
    appendInflight(CHAT, userMsg('umsg_A', 'hello'));
    appendInflight(CHAT, typing());
    appendInflight(CHAT, replyDelta('msg_A', 'hi'));
    // Active turn: no reply_final yet → setDurable must NOT drop these.
    setDurable(CHAT, [], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    assert.equal(s.inflight.length, 3);
    assert.equal(s.inflight[0].type, 'user_message');
    assert.equal(s.inflight[2].type, 'reply_delta');
  });

  it('drops a completed turn when durable contains the reply_final.message_id as parley_id', () => {
    reset();
    appendInflight(CHAT, userMsg('umsg_A', 'hello'));
    appendInflight(CHAT, typing());
    appendInflight(CHAT, replyDelta('msg_A', 'hi'));
    appendInflight(CHAT, replyFinal('msg_A', 'hi'));
    // Durable mirror caught up: assistant row carries the SSE-shape
    // message_id as parley_id. Projection dedup will key off this
    // parley_id, so the store can safely drain the inflight copy.
    setDurable(CHAT, [
      durableUserRow(1, 'hello', 'umsg_A'),
      durableAssistantRow(2, 'hi', 'msg_A'),
    ], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    assert.equal(s.inflight.length, 0);
  });

  it('drops only the completed-turn envelopes whose mirror landed; preserves the trailing in-progress turn', () => {
    reset();
    // Turn 1 — closed, mirrored
    appendInflight(CHAT, userMsg('umsg_A', 'q1'));
    appendInflight(CHAT, replyDelta('msg_A', 'a1'));
    appendInflight(CHAT, replyFinal('msg_A', 'a1'));
    // Turn 2 — closed, mirrored
    appendInflight(CHAT, userMsg('umsg_B', 'q2'));
    appendInflight(CHAT, replyDelta('msg_B', 'a2'));
    appendInflight(CHAT, replyFinal('msg_B', 'a2'));
    // Turn 3 — in progress (no reply_final yet)
    appendInflight(CHAT, userMsg('umsg_C', 'q3'));
    appendInflight(CHAT, typing());
    appendInflight(CHAT, replyDelta('msg_C', 'a3 streaming…'));
    setDurable(CHAT, [
      durableUserRow(1, 'q1', 'umsg_A'),
      durableAssistantRow(2, 'a1', 'msg_A'),
      durableUserRow(3, 'q2', 'umsg_B'),
      durableAssistantRow(4, 'a2', 'msg_B'),
    ], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    // Only the trailing in-progress turn 3 envelopes survive.
    assert.equal(s.inflight.length, 3);
    assert.equal(s.inflight[0].type, 'user_message');
    assert.equal((s.inflight[0] as any).message_id, 'umsg_C');
    assert.equal(s.inflight[2].type, 'reply_delta');
  });

  it('preserves completed-turn envelopes when durable is stale (background-chat race)', () => {
    // A reply landing in chat A via SSE
    // while user is on chat B. User switches to A; replaySessionMessages
    // calls setDurable(A, server_messages_for_A, ...) and the server's
    // /messages response doesn't include the new reply yet (state.db
    // / parley.db write-through hasn't landed). Without this fix,
    // the inflight reply_final got nuked under the v1 assumption that
    // durable was authoritative — and the user saw a blank session
    // until they switched away and back.
    reset();
    appendInflight(CHAT, userMsg('umsg_A', 'hello'));
    appendInflight(CHAT, replyDelta('msg_A', 'hi'));
    appendInflight(CHAT, replyFinal('msg_A', 'hi'));
    // Server-side mirror hasn't caught up: durable has the user row
    // but NOT the assistant row. Inflight is the only copy of the
    // reply — must not be dropped.
    setDurable(CHAT, [
      durableUserRow(1, 'hello', 'umsg_A'),
    ], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    assert.equal(s.inflight.length, 3,
      `expected all 3 envelopes preserved (durable stale); got ${s.inflight.length}`);
    assert.equal((s.inflight[2] as any).message_id, 'msg_A');
  });

  it('preserves completed-turn envelopes when durable rows lack parley_id', () => {
    // Historical scenario (ghost tail): the plugin's link-table write
    // silently failed, leaving durable
    // assistant rows with parley_id NULL. Under v1 the store
    // nuked the inflight on the assumption that durable was good;
    // under v2 we don't assume — supplemental-store's phase-3/4
    // self-heal is the real fix for the underlying NULL-parley_id
    // bug, and v2 keeping the inflight envelope shows a brief
    // duplicate at worst (the projection will eventually dedup once
    // the link gets re-established), never blank content.
    reset();
    appendInflight(CHAT, userMsg('umsg_ghost', 'This is great'));
    appendInflight(CHAT, replyDelta('msg_ghost', 'Yep'));
    appendInflight(CHAT, replyFinal('msg_ghost', 'Yep'));
    // Durable rows arrive without parley_id — the bug shape.
    setDurable(CHAT, [
      { id: 100, role: 'user', content: 'This is great', timestamp: 1_779_121_069 },
      { id: 101, role: 'assistant', content: 'Yep', timestamp: 1_779_121_069 },
    ], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    assert.equal(s.inflight.length, 3,
      `expected inflight preserved when durable lacks parley_id (safer than nuking content); got ${s.inflight.length}`);
  });
});

describe('store: targeted post-final inflight drain', () => {
  it('clears through the named reply_final and preserves a trailing in-progress turn', () => {
    reset();
    appendInflight(CHAT, userMsg('umsg_A', 'q1'));
    appendInflight(CHAT, replyDelta('msg_A', 'a1'));
    appendInflight(CHAT, replyFinal('msg_A', 'a1'));
    appendInflight(CHAT, userMsg('umsg_B', 'q2'));
    appendInflight(CHAT, replyDelta('msg_B', 'a2 streaming'));

    clearInflightThroughReplyFinal(CHAT, 'msg_A');

    const s = getState(CHAT);
    assert.equal(s.inflight.length, 2);
    assert.equal((s.inflight[0] as any).message_id, 'umsg_B');
    assert.equal((s.inflight[1] as any).message_id, 'msg_B');
  });

  it('does nothing when the named reply_final is not present', () => {
    reset();
    appendInflight(CHAT, userMsg('umsg_A', 'q1'));
    appendInflight(CHAT, replyDelta('msg_A', 'a1'));

    clearInflightThroughReplyFinal(CHAT, 'msg_missing');

    const s = getState(CHAT);
    assert.equal(s.inflight.length, 2);
  });
});

// ── #227 / #1: gap-aware window splice + fill ───────────────────────────
//
// These exercise spliceWindow (drill a pin window alongside the tail with
// a gap marker instead of replacing it) + fillGap (shrink/close the gap as
// the user loads across it). The whole point is that the pin and the tail
// stop being MUTUALLY EXCLUSIVE: after a drill the tail is STILL in the
// buffer (hasMoreNewer stays false), so scroll-to-bottom is instant, and
// the missing range is a VISIBLE gap, not a silent hole.

const SEC = 1_779_120_000;
function row(id: number, role: 'user' | 'assistant', content: string): ConversationItem {
  return { id, parley_id: `s${id}`, role, content, timestamp: SEC + id };
}
function freshChat(name: string): string {
  setDurable(name, [], { firstId: null, hasMore: false });
  return name;
}

describe('store: spliceWindow (gap-aware drill)', () => {
  it('replaces into an empty buffer (floating window)', () => {
    const C = freshChat('splice-empty');
    const win = [row(10, 'user', 'q'), row(11, 'assistant', 'a')];
    const res = spliceWindow(C, win, { firstId: 9, hasMore: true, lastId: 11, hasMoreNewer: true });
    assert.equal(res, 'replaced');
    const s = getState(C);
    assert.equal(s.durable.length, 2);
    assert.equal(s.durable.some(r => r.role === 'gap'), false);
    assert.equal(s.pagination.hasMoreNewer, true);
  });

  it('splices a disjoint OLDER window alongside the tail with a gap, KEEPING the tail cursor', () => {
    const C = freshChat('splice-disjoint');
    setDurable(C, [row(100, 'user', 'tq'), row(101, 'assistant', 'ta')],
      { firstId: 100, hasMore: true, lastId: 101, hasMoreNewer: false });
    const win = [row(10, 'user', 'wq'), row(11, 'assistant', 'wa')];
    const res = spliceWindow(C, win, { firstId: 9, hasMore: true, lastId: 11, hasMoreNewer: true });
    assert.equal(res, 'spliced');
    const s = getState(C);
    // [w10, w11, gap, t100, t101]
    assert.equal(s.durable.length, 5);
    const gap = s.durable[2];
    assert.equal(gap.role, 'gap');
    assert.equal(gap.gap_older_id, 's11', 'older boundary = window newest');
    assert.equal(gap.gap_newer_id, 's100', 'newer boundary = tail oldest');
    assert.equal(gap.gap_after_id, 11, 'fill cursor = numeric id of older boundary');
    // Tail cursor preserved → buffer still reaches the live edge.
    assert.equal(s.pagination.hasMoreNewer, false);
    assert.equal(s.pagination.firstId, 9, 'older cursor moves to the window');
  });

  it('is idempotent — re-splicing the SAME window is a no-op (cache→server double render)', () => {
    const C = freshChat('splice-idem');
    setDurable(C, [row(100, 'user', 'tq'), row(101, 'assistant', 'ta')],
      { firstId: 100, hasMore: true, lastId: 101, hasMoreNewer: false });
    const win = [row(10, 'user', 'wq'), row(11, 'assistant', 'wa')];
    spliceWindow(C, win, { firstId: 9, hasMore: true, lastId: 11, hasMoreNewer: true });
    const res2 = spliceWindow(C, win, { firstId: 9, hasMore: true, lastId: 11, hasMoreNewer: true });
    assert.equal(res2, 'noop');
    const s = getState(C);
    assert.equal(s.durable.length, 5, 'no duplicate rows or second gap');
    assert.equal(s.durable.filter(r => r.role === 'gap').length, 1);
  });

  it('merges (no gap) when the window OVERLAPS the existing run', () => {
    const C = freshChat('splice-overlap');
    setDurable(C, [row(11, 'assistant', 'shared'), row(12, 'user', 'tq')],
      { firstId: 11, hasMore: true, lastId: 12, hasMoreNewer: false });
    const win = [row(10, 'user', 'wq'), row(11, 'assistant', 'shared')];
    const res = spliceWindow(C, win, { firstId: 9, hasMore: true, lastId: 11, hasMoreNewer: true });
    assert.equal(res, 'merged');
    const s = getState(C);
    assert.equal(s.durable.some(r => r.role === 'gap'), false);
    assert.equal(s.durable.length, 3, 'shared row 11 deduped');
    assert.equal(s.pagination.firstId, 9);
  });
});

describe('store: fillGap (shrink/close a discontinuity)', () => {
  function setupGap(name: string): string {
    const C = freshChat(name);
    setDurable(C, [row(100, 'user', 'tq'), row(101, 'assistant', 'ta')],
      { firstId: 100, hasMore: true, lastId: 101, hasMoreNewer: false });
    spliceWindow(C, [row(10, 'user', 'wq'), row(11, 'assistant', 'wa')],
      { firstId: 9, hasMore: true, lastId: 11, hasMoreNewer: true });
    return C;
  }

  it('closes the gap when fetched rows reach the newer-side run (overlap)', () => {
    const C = setupGap('fill-overlap');
    // loadLater(11) returns 12 then the tail boundary (100, already present).
    fillGap(C, 11, [row(12, 'assistant', 'mid'), row(100, 'user', 'tq')], false);
    const s = getState(C);
    assert.equal(s.durable.some(r => r.role === 'gap'), false, 'gap closed');
    assert.deepEqual(s.durable.map(r => r.id), [10, 11, 12, 100, 101], 'row 12 inserted, dup 100 dropped');
  });

  it('advances the cursor and KEEPS the gap when more newer rows remain', () => {
    const C = setupGap('fill-partial');
    fillGap(C, 11, [row(12, 'assistant', 'm1'), row(13, 'user', 'm2')], false);
    const s = getState(C);
    const gap = s.durable.find(r => r.role === 'gap')!;
    assert.ok(gap, 'gap survives a partial fill');
    assert.equal(gap.gap_after_id, 13, 'cursor advances to last fetched row');
    assert.deepEqual(s.durable.map(r => r.id), [10, 11, 12, 13, gap.id, 100, 101]);
  });

  it('closes the gap when the server reports no more newer rows (reachedTail)', () => {
    const C = setupGap('fill-tail');
    fillGap(C, 11, [row(12, 'assistant', 'm1')], true);
    const s = getState(C);
    assert.equal(s.durable.some(r => r.role === 'gap'), false);
    assert.deepEqual(s.durable.map(r => r.id), [10, 11, 12, 100, 101]);
  });
});

describe('store: prepend/append dedup hygiene (#1 silent-hole guard)', () => {
  it('prependDurable drops rows already in the buffer (no stacked duplicates)', () => {
    const C = freshChat('prepend-dedup');
    setDurable(C, [row(5, 'user', 'a'), row(6, 'assistant', 'b')], { firstId: 5, hasMore: true });
    prependDurable(C, [row(4, 'user', 'z'), row(5, 'user', 'a')], { firstId: 4, hasMore: true });
    const s = getState(C);
    assert.deepEqual(s.durable.map(r => r.id), [4, 5, 6], 'dup row 5 not re-prepended');
  });

  it('appendDurable drops rows already in the buffer', () => {
    const C = freshChat('append-dedup');
    setDurable(C, [row(5, 'user', 'a'), row(6, 'assistant', 'b')],
      { firstId: 5, hasMore: false, lastId: 6, hasMoreNewer: true });
    appendDurable(C, [row(6, 'assistant', 'b'), row(7, 'user', 'c')], { lastId: 7, hasMoreNewer: false });
    const s = getState(C);
    assert.deepEqual(s.durable.map(r => r.id), [5, 6, 7], 'dup row 6 not re-appended');
  });
});
