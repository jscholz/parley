/**
 * @fileoverview Pure-projection tests — covers the join between
 * durable, inflight, and pendingSends, the dedup rules, and the sort
 * ordering. The reconciler is exercised in a separate browser smoke;
 * here we only test the data transform.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { project } from './projection.ts';
import { miniMarkdown } from '../util/markdown.ts';
import type { ChatState, ConversationItem, SidekickEnvelope, PendingSend } from './types.ts';

function state(partial: Partial<ChatState>): ChatState {
  return {
    durable: [],
    inflight: [],
    pendingSends: [],
    pagination: { firstId: null, hasMore: false, lastId: null, hasMoreNewer: false },
    decorations: [],
    ...partial,
  };
}

const T0 = 1_747_000_000_000;
function u(id: string, text: string, ts = T0): ConversationItem {
  return { id, sidekick_id: id, role: 'user', content: text, timestamp: ts };
}
function a(id: string, text: string, ts = T0, toolCalls?: string): ConversationItem {
  return { id, sidekick_id: id, role: 'assistant', content: text, timestamp: ts, tool_calls: toolCalls };
}
function tool(id: string, callId: string, name: string, content: string, ts = T0): ConversationItem {
  return { id, role: 'tool', content, tool_call_id: callId, tool_name: name, timestamp: ts };
}

describe('project: durable only', () => {
  it('empty state → empty specs', () => {
    assert.deepEqual(project(state({})), []);
  });

  it('user → assistant pair', () => {
    const s = state({ durable: [u('umsg_1', 'hello'), a('msg_1', 'hi', T0 + 1000)] });
    const out = project(s);
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, 'user');
    assert.equal(out[0].key, 'umsg_1');
    assert.equal(out[1].kind, 'assistant');
    assert.equal(out[1].key, 'msg_1');
  });

  it('assistant tool_calls fold into activity row keyed to the preceding user', () => {
    const tc = JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } }]);
    const s = state({
      durable: [
        u('umsg_1', 'search please'),
        a('msg_1', 'searching...', T0 + 1, tc),
        tool('5', 'c1', 'web_search', '{"results":[]}', T0 + 2),
      ],
    });
    const out = project(s);
    // user (T0) → activity row (T0) → assistant (T0+1) → tool merged into activity row
    const kinds = out.map(s => s.kind);
    assert.deepEqual(kinds, ['user', 'activityRow', 'assistant']);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.key, 'turn:umsg_1');
    assert.equal(ar.tools.length, 1);
    assert.equal(ar.tools[0].callId, 'c1');
    assert.equal(ar.tools[0].name, 'web_search');
    assert.equal(ar.tools[0].result, '{"results":[]}');
    assert.equal(ar.complete, true);
  });

  it('hermes unix-seconds timestamps get normalized to ms', () => {
    const sec = 1_747_000_000;  // < 1e12
    const s = state({ durable: [{ id: 'u1', sidekick_id: 'umsg_1', role: 'user', content: 'x', timestamp: sec }] });
    const out = project(s);
    assert.equal(out[0].timestamp, sec * 1000);
  });
});

describe('project: inflight', () => {
  it('user_message envelope produces a user bubble when no durable match', () => {
    const env: SidekickEnvelope = { type: 'user_message', chat_id: 'c', message_id: 'umsg_2', text: 'hello' };
    const s = state({ inflight: [env] });
    const out = project(s);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'user');
    assert.equal(out[0].key, 'umsg_2');
    assert.equal(out[0].text, 'hello');
  });

  it('user_message envelope matching durable does not duplicate', () => {
    const s = state({
      durable: [u('umsg_1', 'hi')],
      inflight: [{ type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'hi' }],
    });
    const out = project(s);
    assert.equal(out.filter(s => s.kind === 'user').length, 1);
  });

  it('streaming reply_delta concatenates into one assistant bubble; reply_final flips streaming off', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'reply_delta', chat_id: 'c', text: 'hel', message_id: 'msg_x' },
        { type: 'reply_delta', chat_id: 'c', text: 'lo', message_id: 'msg_x' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_x' },
      ],
    });
    const out = project(s);
    const ag = out.find(x => x.kind === 'assistant');
    assert.ok(ag && ag.kind === 'assistant');
    assert.equal(ag.text, 'hello');
    assert.equal(ag.streaming, false);
  });

  it('tool_call + tool_result land in an activity row keyed to the in-flight turn', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 'web', args: { q: 'x' } },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'web', result: 'ok', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.key, 'turn:umsg_1');
    assert.equal(ar.tools[0].callId, 'c1');
    assert.equal(ar.tools[0].result, 'ok');
    assert.equal(ar.tools[0].durationMs, 42);
    assert.equal(ar.complete, false);
  });

  it('tool_result without a prior tool_call still uses tool_name when present', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'search_files', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
  });

  it('tool_result without a name infers common tools from result shape', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: '', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
  });

  it('tool_result with placeholder name still infers common tools from result shape', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'tool', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
  });

  it('tool_result with placeholder name infers cronjob from scheduled skill result', () => {
    const result = JSON.stringify({
      success: true,
      job: { job_id: 'abc', name: 'R2 Pulse comms check-in', skill: 'comms-sweep' },
      skills: ['comms-sweep'],
    });
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'tool', result, duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'cronjob');
  });

  it('tool_result renames an earlier placeholder tool_call when the result carries the real name', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 'tool', args: {} },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'search_files', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
    assert.equal(ar.tools[0].result, '{"total_count":1,"matches":[]}');
  });

  it('ordering: user → activity row → assistant within the same turn', () => {
    const s = state({
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'reply_delta', chat_id: 'c', text: 'a', message_id: 'msg_1' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 't', args: {} },
      ],
    });
    const out = project(s);
    const kinds = out.map(s => s.kind);
    assert.deepEqual(kinds, ['user', 'activityRow', 'assistant']);
  });
});

describe('project: pending sends', () => {
  it('pending send not yet acknowledged renders with pending=true', () => {
    const p: PendingSend = { messageId: 'umsg_x', text: 'hi', sentAt: T0, source: 'text' };
    const s = state({ pendingSends: [p] });
    const out = project(s);
    assert.equal(out.length, 1);
    const u = out[0];
    assert.ok(u.kind === 'user');
    assert.equal(u.pending, true);
    assert.equal(u.source, 'text');
  });

  it('pending send superseded by inflight user_message echo: only one bubble, source preserved', () => {
    const p: PendingSend = { messageId: 'umsg_x', text: 'hi', sentAt: T0, source: 'voice', attachments: [{ dataUrl: 'data:', mimeType: 'image/png' }] };
    const s = state({
      pendingSends: [p],
      inflight: [{ type: 'user_message', chat_id: 'c', message_id: 'umsg_x', text: 'hi' }],
    });
    const out = project(s);
    const users = out.filter(s => s.kind === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0].kind, 'user');
    // From inflight branch, source + attachments came from pending lookup.
    if (users[0].kind === 'user') {
      assert.equal(users[0].source, 'voice');
      assert.equal(users[0].attachments?.length, 1);
    }
  });

  it('failed pending send: pending=false, failed=true', () => {
    const p: PendingSend = { messageId: 'umsg_x', text: 'hi', sentAt: T0, failed: true };
    const out = project(state({ pendingSends: [p] }));
    assert.equal(out.length, 1);
    if (out[0].kind === 'user') {
      assert.equal(out[0].pending, false);
      assert.equal(out[0].failed, true);
    }
  });

  it('inflight reply timestamp never predates the pending user message that started the turn', () => {
    // Regression: the new-user-message branch set currentTurnTs but did
    // NOT advance inflightTs past it (unlike the already-durable branch).
    // When the last durable message is from a PRIOR day, the synthetic
    // anchor (lastTimestamp+1) stays on that prior day, so the streaming
    // assistant bubble inherits a prior-day timestamp → the reconciler's
    // day-boundary calc stamps a stale date on the in-flight bubble that
    // vanishes once it lands durable with the real (today) timestamp.
    const DAY = 86_400_000;
    const TS_PREV = T0;            // last durable message: a prior day
    const TS_NOW = T0 + 2 * DAY;   // pending send: today
    const s = state({
      durable: [u('umsg_old', 'old', TS_PREV), a('msg_old', 'old reply', TS_PREV + 1000)],
      pendingSends: [{ messageId: 'umsg_new', text: 'today msg', sentAt: TS_NOW, source: 'text' }],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_new', text: 'today msg' },
        { type: 'reply_delta', chat_id: 'c', message_id: 'msg_new', text: 'streaming reply' },
      ],
    });
    const out = project(s);
    const user = out.find(x => x.kind === 'user' && x.key === 'umsg_new');
    const reply = out.find(x => x.kind === 'assistant' && x.key === 'msg_new');
    assert.ok(user && reply && user.kind === 'user' && reply.kind === 'assistant');
    assert.ok(
      reply.timestamp >= user.timestamp,
      `inflight reply ts (${reply.timestamp}) must not predate user ts (${user.timestamp})`,
    );
    const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
    assert.equal(dayKey(reply.timestamp), dayKey(user.timestamp),
      'inflight reply must share the user message\'s calendar day (no stale date sub-line)');
  });
});

describe('project: dedup keys', () => {
  it('sidekick_id is preferred over numeric id for user key', () => {
    const s = state({ durable: [{ id: 42, sidekick_id: 'umsg_x', role: 'user', content: 'q', timestamp: T0 }] });
    const out = project(s);
    assert.equal(out[0].key, 'umsg_x');
  });

  it('numeric id falls back when sidekick_id absent', () => {
    const s = state({ durable: [{ id: 42, role: 'user', content: 'q', timestamp: T0 }] });
    const out = project(s);
    assert.equal(out[0].key, '42');
  });

  it('inflight reply_final does NOT duplicate a durable assistant row that arrived without sidekick_id (field bug 2026-05-19)', () => {
    // Active-chat dupe scenario: user sent a message, plugin mirrored
    // the assistant row but the link write didn't land (sidekick_id NULL).
    // Without content-fallback dedup, durable keyed by integer "101" and
    // inflight keyed by "msg_xyz" rendered as two separate bubbles.
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'umsg_q', role: 'user', content: 'hey test message', timestamp: T0 },
        // Assistant row arrived without sidekick_id — the bug shape.
        { id: 101, role: 'assistant', content: 'Hey — received.', timestamp: T0 + 1000 },
      ],
      inflight: [
        { type: 'reply_delta', chat_id: 'c', message_id: 'msg_xyz', text: 'Hey — received.' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_xyz' },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1,
      `expected exactly 1 assistant bubble (durable keyed by integer id); `
      + `got ${assistantBubbles.length}: ${JSON.stringify(assistantBubbles.map(a => ({ key: a.key, text: (a as any).text })))}`);
    // The surviving bubble is the durable one (keyed by integer id), not
    // the inflight one — durable is the canonical source once both exist.
    assert.equal(assistantBubbles[0].key, '101');
  });

  it('inflight reply_final preserved when no matching durable assistant row exists (background-race contract)', () => {
    // Counterpart to the dupe test: when durable doesn't have the
    // assistant row yet (background-chat reply landed via SSE but
    // mirror hasn't caught up), the inflight envelope must render.
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'umsg_q', role: 'user', content: 'hey', timestamp: T0 },
      ],
      inflight: [
        { type: 'reply_delta', chat_id: 'c', message_id: 'msg_xyz', text: 'Hi back.' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_xyz' },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1);
    assert.equal(assistantBubbles[0].key, 'msg_xyz');
    assert.equal((assistantBubbles[0] as any).text, 'Hi back.');
  });

  it('durable-vs-durable: items endpoint returning two assistant rows with same content renders ONE bubble (field bug 2026-05-19)', () => {
    // Server-side bug shape: `sidekick.db.msg_links` had two rows for
    // the same logical assistant message — one from envelope write-
    // through (sidekick_id="msg_xyz", real timestamp), one from
    // reconcile Pass 2 fallback (sidekick_id="legacy:101", timestamp=0
    // because... still unknown). The items endpoint returned both;
    // projection's key-based dedup saw them as different (different
    // sidekick_ids); both rendered. Result: one user-visible reply
    // duplicated, with one copy showing 01:00 BST (= unix 0 → UTC+1).
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'umsg_q', role: 'user', content: 'hey test message', timestamp: T0 },
        // Bad duplicate row — timestamp=0.
        { id: 101, sidekick_id: 'legacy:101', role: 'assistant', content: 'Hey — received.', timestamp: 0 },
        // Good row — real timestamp.
        { id: 102, sidekick_id: 'msg_xyz', role: 'assistant', content: 'Hey — received.', timestamp: T0 + 1000 },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1,
      `expected ONE assistant bubble (dedup by content); got ${assistantBubbles.length}: `
      + `${JSON.stringify(assistantBubbles.map(b => ({ key: b.key, ts: b.timestamp, text: (b as any).text })))}`);
    // Winner is the row with the real timestamp (msg_xyz at T0+1000).
    assert.equal(assistantBubbles[0].key, 'msg_xyz');
  });

  it('durable-vs-durable: two assistant rows with same content + same valid timestamp picks the higher id deterministically', () => {
    // Defensive: if BOTH rows have real timestamps that happen to match
    // (e.g. plugin write-through + reconcile Pass 2 fired in the same
    // second), the projection must still emit one bubble — pick by
    // a stable tiebreak so future runs render identically.
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'msg_a', role: 'assistant', content: 'same text', timestamp: T0 + 1000 },
        { id: 101, sidekick_id: 'msg_b', role: 'assistant', content: 'same text', timestamp: T0 + 1000 },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1);
    // Higher id wins on tie ("msg_b" > "msg_a" lex order).
    assert.equal(assistantBubbles[0].key, 'msg_b');
  });

  it('durable-vs-durable dedup does NOT collapse genuinely different content', () => {
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'msg_a', role: 'assistant', content: 'first reply', timestamp: T0 + 1000 },
        { id: 101, sidekick_id: 'msg_b', role: 'assistant', content: 'second reply', timestamp: T0 + 2000 },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 2);
  });

  it('inflight reply_final preserved when durable has DIFFERENT-content assistant row without sidekick_id', () => {
    // Defensive: the content match must be exact. A no-link durable row
    // with text "old reply" must not steal the inflight bubble for
    // "new reply".
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'umsg_q', role: 'user', content: 'q', timestamp: T0 },
        { id: 101, role: 'assistant', content: 'old reply', timestamp: T0 + 1000 },
      ],
      inflight: [
        { type: 'reply_delta', chat_id: 'c', message_id: 'msg_new', text: 'new reply' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_new' },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 2);
    assert.deepEqual(assistantBubbles.map(b => b.key).sort(), ['101', 'msg_new']);
  });

  it('notification with matching sidekick_id renders once when durable and inflight both contain it', () => {
    const s = state({
      durable: [
        { id: 101, sidekick_id: 'notif_1', role: 'assistant', kind: 'cron', content: 'Cron done', timestamp: T0 },
      ],
      inflight: [
        { type: 'notification', chat_id: 'c', kind: 'cron', content: 'Cron done', sidekick_id: 'notif_1' },
      ],
    });
    const out = project(s);
    const notifications = out.filter(o => o.kind === 'notification');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].key, 'notif_1');
  });
});

describe('project: ordering across turns', () => {
  it('two turns end-to-end: u1 → ar1 → a1 → u2 → ar2 → a2', () => {
    const tc = JSON.stringify([{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }]);
    const s = state({
      durable: [
        u('umsg_1', 'q1', T0),
        a('msg_1', 'a1', T0 + 1000, tc),
        tool('5', 'c1', 't', 'ok', T0 + 2000),
        u('umsg_2', 'q2', T0 + 3000),
        a('msg_2', 'a2', T0 + 4000),
      ],
    });
    const out = project(s);
    const seq = out.map(s => `${s.kind}:${s.key}`);
    assert.deepEqual(seq, [
      'user:umsg_1',
      'activityRow:turn:umsg_1',
      'assistant:msg_1',
      'user:umsg_2',
      'assistant:msg_2',
    ]);
  });

  it('preserves durable server order when adjacent turns share the same timestamp', () => {
    const sameSecond = 1_779_298_560;
    const s = state({
      durable: [
        u('umsg_1', 'Going via a skill is a good idea', sameSecond - 60),
        tool('5', 'c1', 'skill_view', '{"name":"r2-raise-brain"}', sameSecond - 59),
        a('msg_done', 'Done. Split is live.', sameSecond),
        u('umsg_2', '> I preserved the old monolithic skill here', sameSecond),
        tool('6', 'c2', 'skill_view', '{"name":"hermes-agent"}', sameSecond),
        a('msg_good', 'Good push. You were right.', sameSecond),
      ],
    });
    const out = project(s);
    assert.deepEqual(out.map(s => `${s.kind}:${s.key}`), [
      'user:umsg_1',
      'activityRow:turn:umsg_1',
      'assistant:msg_done',
      'user:umsg_2',
      'activityRow:turn:umsg_2',
      'assistant:msg_good',
    ]);
  });
});

describe('project: user double-write dedup (time-windowed)', () => {
  it('collapses two identical user rows written seconds apart (the backend double-write)', () => {
    // Field 2026-05-27: native write (44459) + platform-ingest twin (44461),
    // same content, ~4s apart, different ids → must render ONE bubble.
    const s = state({ durable: [
      u('44459', 'Hey. I migrated you from Cortex to FontBrain.', T0),
      u('44461', 'Hey. I migrated you from Cortex to FontBrain.', T0 + 4000),
    ]});
    const out = project(s);
    const userSpecs = out.filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 1, `expected 1 user bubble, got ${userSpecs.length}`);
  });

  it('PRESERVES legitimate verbatim repeats far apart (voice-test phrases)', () => {
    // "1 2 3 ... 20" said again 2 minutes later is a real repeat, NOT a dup.
    const s = state({ durable: [
      u('m1', '1 2 3 4 5', T0),
      u('m2', '1 2 3 4 5', T0 + 120_000),
    ]});
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 2, `far-apart repeats must both survive, got ${userSpecs.length}`);
  });

  it('three rapid duplicates collapse to one; a later legit repeat survives', () => {
    const s = state({ durable: [
      u('d1', 'over', T0),
      u('d2', 'over', T0 + 2000),
      u('d3', 'over', T0 + 5000),
      u('later', 'over', T0 + 300_000),  // 5 min later → legit
    ]});
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 2, `expected 2 (one cluster + one legit), got ${userSpecs.length}`);
  });
});

describe('project: envelope-shadowed user twin (reconcile-lag window)', () => {
  it('drops the unannotated state.db twin of a umsg_ envelope copy (turn-length skew)', () => {
    // Field 2026-07-04: user sent at 11:47:54 (envelope-only copy with a
    // umsg_* sidekick_id + epoch-ms id), state.db row batch-written at
    // turn END 11:49:25 — 91s apart, far beyond the 30s double-write
    // window below. Until the background reconcile links them, the items
    // endpoint serves BOTH → two user bubbles with different timestamps.
    const sent = T0;
    const turnEnd = T0 + 91_000;
    const s = state({ durable: [
      { id: String(sent), sidekick_id: 'umsg_1783162074267_x', role: 'user', content: 'single hand the boat?', timestamp: sent },
      { id: '67182', role: 'user', content: 'single hand the boat?', timestamp: turnEnd },
    ]});
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 1, `expected 1 user bubble, got ${userSpecs.length}`);
    assert.equal(userSpecs[0].key, 'umsg_1783162074267_x',
      'the envelope copy must win — true send time, and its key stays stable once the link heals');
  });

  it('pairs 1:1 — a legit repeat with only ONE unlinked state twin keeps two bubbles', () => {
    // Two real sends of the same text; the second turn's state row isn't
    // reconciled yet (unannotated) while the first is already linked. The
    // shadow pass must drop only the second send's twin, not fold the
    // repeat into one bubble.
    const s = state({ durable: [
      { id: '67100', sidekick_id: 'umsg_first', role: 'user', content: 'ok', timestamp: T0 },
      { id: String(T0 + 120_000), sidekick_id: 'umsg_second', role: 'user', content: 'ok', timestamp: T0 + 120_000 },
      { id: '67200', role: 'user', content: 'ok', timestamp: T0 + 180_000 },
    ]});
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 2, `expected 2 bubbles (linked + envelope), got ${userSpecs.length}`);
  });

  it('does NOT shadow when the skew exceeds the turn-length bound', () => {
    // An ancient envelope copy must never swallow a fresh identical send —
    // beyond the bound they are independent messages.
    const s = state({ durable: [
      { id: String(T0), sidekick_id: 'umsg_old', role: 'user', content: 'hi', timestamp: T0 },
      { id: '67300', role: 'user', content: 'hi', timestamp: T0 + 45 * 60_000 },
    ]});
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 2, `45-min-apart rows are independent, got ${userSpecs.length}`);
  });
});

describe('notification update path renders markdown (not plaintext)', () => {
  // Regression: updateNotification used to overwrite the bubble's .text with
  // escapeHtml(text).replace(/\n/g,'<br>') on every reconcile pass, flattening
  // the markdown-rendered bubble back to literal **bold** / `code` / - bullets.
  // The fix mirrors updateAssistant: re-render via miniMarkdown. This asserts
  // the exact HTML the update path now writes (renderNotificationHtml ===
  // miniMarkdown(text)) contains rendered markup, not the raw source tokens.
  const cronText = '**Done.** Built `widget` and:\n- item one\n- item two';

  it('produces rendered markup, not literal markdown source', () => {
    const html = miniMarkdown(cronText);
    assert.match(html, /<strong>Done\.<\/strong>/, 'bold must render to <strong>');
    assert.match(html, /<code>widget<\/code>/, 'inline code must render to <code>');
    assert.match(html, /<li>item one<\/li>/, 'bullets must render to <li>');
    assert.match(html, /<ul>/, 'bullet block must be wrapped in <ul>');
    assert.doesNotMatch(html, /\*\*Done\.\*\*/, 'must not leave literal ** bold markers');
    assert.doesNotMatch(html, /^- item|\n- item/, 'must not leave literal - bullet markers');
  });

  it('empty notification text is safe', () => {
    // updateNotification coerces undefined → '' before calling miniMarkdown,
    // which yields a harmless empty paragraph (same as the assistant path).
    const empty: string | undefined = undefined;
    assert.equal(miniMarkdown(empty || ''), '<p></p>');
  });
});

describe('project: gap (discontinuity placeholder)', () => {
  // A `role:'gap'` durable row marks a KNOWN discontinuity between two
  // non-contiguous runs (e.g. a pin window spliced alongside the tail).
  // The projection must emit a 'gap' spec carrying the boundary ids so
  // the reconciler can render an inline "…" the user can load — making
  // the missing range VISIBLE instead of a silent hole (the #223 /
  // missing-user-bubble class). Failing-first: before the projection
  // learned about role:'gap', the marker fell through the durable walk
  // and produced NO spec, so two non-adjacent turns rendered as if
  // adjacent — exactly the lost-user-bubble symptom.
  function gap(ts: number): ConversationItem {
    return { id: `gapmark_${ts}`, role: 'gap', content: '', timestamp: ts };
  }

  it('emits a gap spec between two segments, carrying both boundary ids', () => {
    const s = state({
      durable: [
        u('umsg_1', 'older q', T0),
        a('msg_1', 'older a', T0 + 1),
        gap(T0 + 2),
        u('umsg_9', 'newer q', T0 + 3),
        a('msg_9', 'newer a', T0 + 4),
      ],
    });
    const out = project(s);
    const kinds = out.map(x => x.kind);
    assert.deepEqual(kinds, ['user', 'assistant', 'gap', 'user', 'assistant']);
    const g = out.find(x => x.kind === 'gap');
    assert.ok(g && g.kind === 'gap', 'a gap spec must be emitted');
    assert.equal(g.olderId, 'msg_1', 'olderId = id of the run above the gap');
    assert.equal(g.newerId, 'umsg_9', 'newerId = id of the run below the gap');
    assert.equal(g.key, 'gap:msg_1:umsg_9');
  });

  it('gap at the head carries null olderId', () => {
    const s = state({ durable: [gap(T0 - 1), u('umsg_1', 'q', T0), a('msg_1', 'a', T0 + 1)] });
    const g = project(s).find(x => x.kind === 'gap');
    assert.ok(g && g.kind === 'gap');
    assert.equal(g.olderId, null);
    assert.equal(g.newerId, 'umsg_1');
  });

  it('gap at the tail carries null newerId', () => {
    const s = state({ durable: [u('umsg_1', 'q', T0), a('msg_1', 'a', T0 + 1), gap(T0 + 2)] });
    const g = project(s).find(x => x.kind === 'gap');
    assert.ok(g && g.kind === 'gap');
    assert.equal(g.olderId, 'msg_1');
    assert.equal(g.newerId, null);
  });

  it('no gap row → no gap spec (inert for the normal contiguous transcript)', () => {
    const s = state({ durable: [u('umsg_1', 'q', T0), a('msg_1', 'a', T0 + 1)] });
    assert.equal(project(s).some(x => x.kind === 'gap'), false);
  });
});

describe('decorations (owner-scoped system lines, hardening phase 4)', () => {
  it('projects decorations as keyed systemLine specs interleaved by timestamp', () => {
    const s = state({
      durable: [u('umsg_1', 'question', T0), a('msg_1', 'answer', T0 + 2000)],
      decorations: [{ key: 'deco_1', kind: 'system', text: 'Model: gpt-5.5', timestamp: T0 + 1000 }],
    });
    const specs = project(s);
    const kinds = specs.map(x => x.kind);
    assert.deepEqual(kinds, ['user', 'systemLine', 'assistant'], 'system line slots between the rows by timestamp');
    const line = specs[1];
    assert.equal(line.kind, 'systemLine');
    assert.equal(line.key, 'deco_1', 'stable reconcile key rides through');
    assert.equal((line as any).text, 'Model: gpt-5.5');
  });

  it('same-ms ties render the system line AFTER the row it annotates', () => {
    const s = state({
      durable: [u('umsg_1', 'q', T0)],
      decorations: [{ key: 'deco_2', kind: 'system', text: 'New chat started', timestamp: T0 }],
    });
    const kinds = project(s).map(x => x.kind);
    assert.deepEqual(kinds, ['user', 'systemLine']);
  });

  it('decorations survive a durable replace (setDurable-shape input)', () => {
    // The bucket is orthogonal: projecting with fresh durable rows and
    // the SAME decorations still yields the line exactly once.
    const deco = [{ key: 'deco_3', kind: 'system' as const, text: 'note', timestamp: T0 + 10 }];
    const before = project(state({ durable: [u('umsg_1', 'q', T0)], decorations: deco }));
    const after = project(state({ durable: [u('umsg_1', 'q', T0), a('msg_2', 'a', T0 + 5000)], decorations: deco }));
    assert.equal(before.filter(x => x.kind === 'systemLine').length, 1);
    assert.equal(after.filter(x => x.kind === 'systemLine').length, 1);
  });
});
