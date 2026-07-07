/**
 * @fileoverview Precondition tests for the activity reconcile hook —
 * the logic that decides, on every server snapshot, (a) which local-only
 * pending approvals to carry so a racing GET can't wipe an actionable
 * row, (b) when "agent moved on" auto-dismisses a pending approval, and
 * (c) when the firstServerHydrate migration pushes local rows UP to a
 * never-synced server instead of letting an empty snapshot wipe them.
 * (c) is the dangerous one: with the wrong precondition it re-POSTs
 * deleted items back to the server (the zombie un-delete).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileActivity,
  type ActivityItem,
  type ActivityPost,
} from './activityStore.ts';

function item(over: Partial<ActivityItem> & { id: string }): ActivityItem {
  return {
    chatId: 'chat1',
    kind: 'notification',
    title: 't',
    body: 'b',
    createdAt: 1000,
    urgent: false,
    read: false,
    messageId: null,
    resolved: undefined,
    ...over,
  };
}

function toMap(...items: ActivityItem[]): Map<string, ActivityItem> {
  return new Map(items.map((i) => [i.id, i]));
}

function capture() {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const post: ActivityPost = (path, body) => posts.push({ path, body });
  return { posts, post };
}

describe('reconcileActivity: carry pending approvals', () => {
  it('carries a local unresolved approval missing from the snapshot', () => {
    const { posts, post } = capture();
    const pending = item({ id: 'ap1', kind: 'approval', urgent: true });
    const next = toMap();
    const res = reconcileActivity(next, toMap(pending), { firstServerHydrate: false }, post);
    assert.notEqual(res, 'skip');
    assert.ok(next.has('ap1'), 'pending approval must stay visible + actionable');
    assert.equal(posts.length, 0, 'carry is local-only, no server write');
  });

  it('does NOT carry a resolved approval (never resurrects a decided one)', () => {
    const { post } = capture();
    const decided = item({ id: 'ap1', kind: 'approval', resolved: 'denied' });
    const next = toMap();
    reconcileActivity(next, toMap(decided), { firstServerHydrate: false }, post);
    assert.ok(!next.has('ap1'));
  });

  it('does NOT carry non-approval rows (server snapshot wins for those)', () => {
    const { post } = capture();
    const reply = item({ id: 'r1', kind: 'agent_reply' });
    const next = toMap();
    reconcileActivity(next, toMap(reply), { firstServerHydrate: false }, post);
    assert.ok(!next.has('r1'));
  });

  it('server copy of an approval wins over the local one', () => {
    const { post } = capture();
    const local = item({ id: 'ap1', kind: 'approval', body: 'local' });
    const server = item({ id: 'ap1', kind: 'approval', body: 'server', resolved: 'approved' });
    const next = toMap(server);
    reconcileActivity(next, toMap(local), { firstServerHydrate: false }, post);
    assert.equal(next.get('ap1')!.body, 'server');
    assert.equal(next.get('ap1')!.resolved, 'approved');
  });
});

describe('reconcileActivity: superseded-approval prune ("agent moved on")', () => {
  it('dismisses an unresolved approval with a newer non-approval in the same chat', () => {
    const { posts, post } = capture();
    const approval = item({ id: 'ap1', kind: 'approval', createdAt: 1000 });
    const reply = item({ id: 'r1', kind: 'agent_reply', createdAt: 2000 });
    const next = toMap(approval, reply);
    reconcileActivity(next, toMap(), { firstServerHydrate: false }, post);
    const pruned = next.get('ap1')!;
    assert.equal(pruned.resolved, 'dismissed', 'kept with a Dismissed pill, not deleted');
    assert.equal(pruned.read, true);
    assert.deepEqual(posts, [
      { path: '/api/sidekick/activity/resolve', body: { id: 'ap1', resolution: 'dismissed' } },
    ]);
  });

  it('leaves the approval pending when the newer item is in a DIFFERENT chat', () => {
    const { posts, post } = capture();
    const approval = item({ id: 'ap1', kind: 'approval', chatId: 'chatA', createdAt: 1000 });
    const reply = item({ id: 'r1', kind: 'agent_reply', chatId: 'chatB', createdAt: 2000 });
    const next = toMap(approval, reply);
    reconcileActivity(next, toMap(), { firstServerHydrate: false }, post);
    assert.equal(next.get('ap1')!.resolved, undefined);
    assert.equal(posts.length, 0);
  });

  it('leaves the approval pending when the same-chat item is OLDER', () => {
    const { post } = capture();
    const approval = item({ id: 'ap1', kind: 'approval', createdAt: 2000 });
    const reply = item({ id: 'r1', kind: 'agent_reply', createdAt: 1000 });
    const next = toMap(approval, reply);
    reconcileActivity(next, toMap(), { firstServerHydrate: false }, post);
    assert.equal(next.get('ap1')!.resolved, undefined);
  });

  it('a newer APPROVAL does not supersede (only non-approval activity counts)', () => {
    const { post } = capture();
    const older = item({ id: 'ap1', kind: 'approval', createdAt: 1000 });
    const newer = item({ id: 'ap2', kind: 'approval', createdAt: 2000 });
    const next = toMap(older, newer);
    reconcileActivity(next, toMap(), { firstServerHydrate: false }, post);
    assert.equal(next.get('ap1')!.resolved, undefined);
    assert.equal(next.get('ap2')!.resolved, undefined);
  });

  it('an already-resolved approval is not re-resolved (sticky outcome)', () => {
    const { posts, post } = capture();
    const approval = item({ id: 'ap1', kind: 'approval', createdAt: 1000, resolved: 'approved' });
    const reply = item({ id: 'r1', kind: 'agent_reply', createdAt: 2000 });
    const next = toMap(approval, reply);
    reconcileActivity(next, toMap(), { firstServerHydrate: false }, post);
    assert.equal(next.get('ap1')!.resolved, 'approved');
    assert.equal(posts.length, 0);
  });

  it('a newer "⏳ Still working…" heartbeat row does NOT supersede (agent is still ON the approval)', () => {
    // Field bug 2026-07-07: the hermes plugin persists push-delivered
    // progress heartbeats as agent_reply Activity rows, so the snapshot
    // contains "newer non-approval" rows for a chat whose agent is
    // BLOCKED on the approval. Opening the tray (render →
    // refreshFromServer → prune) dismissed the pending approval the
    // moment the user came to action it.
    const { posts, post } = capture();
    const approval = item({ id: 'ap1', kind: 'approval', createdAt: 1000 });
    const beat = item({
      id: 'hb1', kind: 'agent_reply', createdAt: 2000,
      body: '⏳ Still working... (15 min elapsed — iteration 38/60, running: terminal)',
    });
    const next = toMap(approval, beat);
    reconcileActivity(next, toMap(), { firstServerHydrate: false }, post);
    assert.equal(next.get('ap1')!.resolved, undefined, 'heartbeat must not dismiss a pending approval');
    assert.equal(posts.length, 0);
  });

  it('emoji-stripped heartbeat body is still recognized (structural fallback matcher)', () => {
    const { post } = capture();
    const approval = item({ id: 'ap1', kind: 'approval', createdAt: 1000 });
    const beat = item({
      id: 'hb1', kind: 'agent_reply', createdAt: 2000,
      body: 'Still working... (3 min elapsed — iteration 10/60, running: terminal)',
    });
    const next = toMap(approval, beat);
    reconcileActivity(next, toMap(), { firstServerHydrate: false }, post);
    assert.equal(next.get('ap1')!.resolved, undefined);
  });

  it('a newer REAL reply still supersedes even when heartbeats are interleaved', () => {
    const { posts, post } = capture();
    const approval = item({ id: 'ap1', kind: 'approval', createdAt: 1000 });
    const beat = item({
      id: 'hb1', kind: 'agent_reply', createdAt: 2000,
      body: '⏳ Still working... (3 min elapsed — iteration 5/60, running: terminal)',
    });
    const real = item({ id: 'r1', kind: 'agent_reply', createdAt: 3000, body: 'Done. Built the thing.' });
    const next = toMap(approval, beat, real);
    reconcileActivity(next, toMap(), { firstServerHydrate: false }, post);
    assert.equal(next.get('ap1')!.resolved, 'dismissed', 'real reply = agent moved on, heartbeat presence changes nothing');
    assert.equal(posts.length, 1);
  });

  it('a CARRIED approval can still be pruned by a newer snapshot row', () => {
    const { posts, post } = capture();
    // Local-only pending approval; the snapshot lacks it but contains a
    // newer reply in the same chat — carry, then dismiss.
    const approval = item({ id: 'ap1', kind: 'approval', createdAt: 1000 });
    const reply = item({ id: 'r1', kind: 'agent_reply', createdAt: 2000 });
    const next = toMap(reply);
    reconcileActivity(next, toMap(approval), { firstServerHydrate: false }, post);
    assert.equal(next.get('ap1')!.resolved, 'dismissed');
    assert.equal(posts.length, 1);
  });
});

describe('reconcileActivity: firstServerHydrate push-up preconditions', () => {
  it('pushes local rows UP and skips the apply: first hydrate + empty server + non-empty local', () => {
    const { posts, post } = capture();
    const a = item({ id: 'n1', createdAt: 5_000 });
    const b = item({ id: 'n2', kind: 'agent_reply', createdAt: 6_000 });
    const res = reconcileActivity(toMap(), toMap(a, b), { firstServerHydrate: true }, post);
    assert.equal(res, 'skip', 'must abort the apply so local rows are not wiped');
    const upPosts = posts.filter((p) => p.path === '/api/sidekick/activity');
    assert.deepEqual(upPosts.map((p) => p.body.id).sort(), ['n1', 'n2']);
    // created_at goes up in Unix seconds (server convention), not ms.
    assert.equal(upPosts.find((p) => p.body.id === 'n1')!.body.created_at, 5);
  });

  it('does NOT push up when the server snapshot has rows (synced profile)', () => {
    const { posts, post } = capture();
    const serverRow = item({ id: 's1' });
    const local = item({ id: 'n1' });
    const next = toMap(serverRow);
    const res = reconcileActivity(next, toMap(local), { firstServerHydrate: true }, post);
    assert.notEqual(res, 'skip');
    assert.equal(posts.length, 0, 'no migration POSTs — the empty-server precondition failed');
    assert.ok(!next.has('n1'), 'local non-approval row defers to the server snapshot');
  });

  it('does NOT push up on a non-first refresh (empty server wins → rows were deleted elsewhere)', () => {
    const { posts, post } = capture();
    const local = item({ id: 'n1' });
    const next = toMap();
    const res = reconcileActivity(next, toMap(local), { firstServerHydrate: false }, post);
    assert.notEqual(res, 'skip');
    assert.equal(posts.length, 0, 'pushing here would zombie-resurrect cross-device deletes');
    assert.equal(next.size, 0);
  });

  it('carried pending approvals defuse the push-up (next no longer empty)', () => {
    const { posts, post } = capture();
    const pending = item({ id: 'ap1', kind: 'approval' });
    const next = toMap();
    const res = reconcileActivity(next, toMap(pending), { firstServerHydrate: true }, post);
    assert.notEqual(res, 'skip', 'carry runs before the precondition check');
    assert.ok(next.has('ap1'), 'approval survives via carry, not via migration');
    assert.equal(posts.length, 0);
  });

  it('does NOT push up when local is also empty (nothing to migrate)', () => {
    const { posts, post } = capture();
    const res = reconcileActivity(toMap(), toMap(), { firstServerHydrate: true }, post);
    assert.notEqual(res, 'skip');
    assert.equal(posts.length, 0);
  });
});
