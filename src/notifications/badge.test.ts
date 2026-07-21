/**
 * @fileoverview Stale-snapshot guard tests for badge.ts — the unread
 * layer's port of util/serverBackedStore.ts's mutationEpoch /
 * pendingWrites / writesSettled discard. A GET /notifications/unread
 * that was in flight when a local mutation (clearUnread / markUnread /
 * unmarkUnread's applyLocal) happened is STALE: applying it visibly
 * reverts the optimistic chip/badge for a full round trip (measured
 * 2026-07-21: chip wiped at exactly +2s with a 2s-delayed stale GET;
 * iOS foregrounding fires visibilitychange+focus refreshes, so a stale
 * GET is nearly always in flight across the user's tap).
 *
 * Three race windows, mirroring the base store's guard:
 *   1. GET issued BEFORE the local mutation → mutationEpoch moved.
 *   2. GET lands while a seen/mark POST is in flight → pendingWrites>0.
 *   3. GET's snapshot predates a POST that already SETTLED by the time
 *      the GET's response arrives → writesSettled moved.
 * All three: discard + schedule one trailing (debounced) refresh.
 *
 * Strip-only TS: no enums / parameter properties (test file aborts at
 * load otherwise).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as badge from './badge.ts';

type Call = {
  url: string;
  method: string;
  resolve: (r: unknown) => void;
  promise: Promise<unknown>;
};

/** Controllable fetch: every call is held open until the test resolves
 *  it, so each race window can be staged deterministically. */
function makeFetchRig() {
  const calls: Call[] = [];
  const impl = ((url: unknown, init?: { method?: string }) => {
    let resolve!: (r: unknown) => void;
    const promise = new Promise((res) => { resolve = res; });
    calls.push({ url: String(url), method: init?.method ?? 'GET', resolve, promise });
    return promise;
  }) as unknown as typeof fetch;
  const gets = () => calls.filter((c) => c.method === 'GET');
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { calls, impl, gets, posts };
}

function okJson(body: unknown) {
  return { ok: true, json: async () => body };
}

/** Let already-resolved continuations run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('badge stale-snapshot guard', () => {
  beforeEach(() => badge._resetForTests());

  it('window 1: GET started before markUnread cannot revert the optimistic mark', async () => {
    const rig = makeFetchRig();
    badge._setFetchForTests(rig.impl);

    // Stale GET in flight (e.g. the visibilitychange/focus refresh a
    // foregrounding fires just before the user taps "mark unread")…
    const staleGet = badge._refreshForTests();
    // …then the local mutation lands mid-flight. POST is held open.
    const markP = badge.markUnread('c1');
    assert.equal(badge.unreadFor('c1'), 1, 'applyLocal must flip synchronously');

    // Stale snapshot (taken pre-mark: no unread anywhere) arrives.
    rig.gets()[0].resolve(okJson({ chats: [] }));
    await staleGet;
    assert.equal(badge.unreadFor('c1'), 1,
      'stale GET must be discarded, not revert the optimistic mark');
    assert.equal(badge._debugForTests().refreshScheduled, true,
      'discard must schedule one trailing refresh');

    // POST settles; markUnread's own trailing refresh fires with the
    // canonical (marked) snapshot and applies cleanly.
    rig.posts()[0].resolve({ ok: true });
    await markP;
    await tick();
    const trailing = rig.gets()[1];
    assert.ok(trailing, 'markUnread fires its reconcile GET after the POST');
    trailing.resolve(okJson({ chats: [{ chat_id: 'c1', unread_count: 0, marked_unread: true }] }));
    await tick();
    assert.equal(badge.unreadFor('c1'), 1);
    assert.equal(badge.isMarkedUnread('c1'), true);
  });

  it('window 2: GET landing while a seen POST is still pending is discarded', async () => {
    const rig = makeFetchRig();
    badge._setFetchForTests(rig.impl);

    // clearUnread on a chat with no LOCAL unread state: no applyLocal,
    // so no epoch bump — only the pendingWrites counter can catch this.
    const clearP = badge.clearUnread('c2');
    const get = badge._refreshForTests();
    rig.gets()[0].resolve(okJson({ chats: [{ chat_id: 'c2', unread_count: 3 }] }));
    await get;
    assert.equal(badge.unreadFor('c2'), 0,
      'GET racing a pending seen POST must be discarded (server still says 3)');

    rig.posts()[0].resolve({ ok: true });
    await tick();
    // clearUnread's trailing reconcile GET — feed it the post-seen truth.
    rig.gets()[1]?.resolve(okJson({ chats: [] }));
    await clearP;
    assert.equal(badge.unreadFor('c2'), 0);
  });

  it('window 3: GET whose response arrives after a write already settled is discarded', async () => {
    const rig = makeFetchRig();
    badge._setFetchForTests(rig.impl);

    // GET snapshots first…
    const get = badge._refreshForTests();
    // …a seen POST starts AND settles while the GET response is in
    // transit (pendingWrites back to 0 at landing time)…
    const clearP = badge.clearUnread('c3');
    rig.posts()[0].resolve({ ok: true });
    await tick();
    // …then the pre-write snapshot lands.
    rig.gets()[0].resolve(okJson({ chats: [{ chat_id: 'c3', unread_count: 2 }] }));
    await get;
    assert.equal(badge.unreadFor('c3'), 0,
      'settled-write window must discard the pre-write snapshot');

    rig.gets()[1]?.resolve(okJson({ chats: [] }));
    await clearP;
  });

  it('clean refresh (no racing write) applies the snapshot', async () => {
    const rig = makeFetchRig();
    badge._setFetchForTests(rig.impl);

    const get = badge._refreshForTests();
    rig.gets()[0].resolve(okJson({ chats: [{ chat_id: 'c4', unread_count: 2, marked_unread: false }] }));
    await get;
    assert.equal(badge.unreadFor('c4'), 2, 'guard must not block legitimate refreshes');
    assert.equal(badge._debugForTests().refreshScheduled, false,
      'no trailing refresh needed on a clean apply');
  });
});
