// Unread-driven warm-up policy (2026-10-12). Strip-only TS.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { createUnreadWarm, type WarmDeps } from './unreadWarm.ts';

function harness(opts: { unread?: Map<string, number>; viewed?: string | null; cache?: Record<string, any>; pages?: Record<string, any[]> } = {}) {
  const unread = opts.unread ?? new Map<string, number>();
  const cache: Record<string, { messages: any[]; pagination: any }> = opts.cache ?? {};
  const pages = opts.pages ?? {};
  const fetched: string[] = [];
  const stale: string[] = [];
  let viewed = opts.viewed ?? null;
  const deps: WarmDeps = {
    unreadChats: () => unread,
    viewedId: () => viewed,
    getCache: async (id) => cache[id] ?? null,
    fetchFull: async (id) => { fetched.push(id); const m = pages[id]; return m ? { messages: m, firstId: m[0]?.id ?? null, hasMore: false } : { messages: [] }; },
    putCache: async (id, messages, pagination) => { cache[id] = { messages, pagination }; },
    mergeNewestPage: (c, p) => { const ids = new Set(p.map((x: any) => String(x.id))); return [...c.filter((x: any) => !ids.has(String(x.id))), ...p]; },
    capTranscript: (messages, pagination) => ({ messages, pagination }),
    markMemStale: (id) => { stale.push(id); },
  };
  const warm = createUnreadWarm(deps);
  return { warm, unread, cache, pages, fetched, stale, setViewed: (v: string | null) => { viewed = v; } };
}

const row = (id: number, t = 'm') => ({ id, role: 'assistant', content: `${t}${id}` });

test('a chat that turns unread is fetched once and cached; a repeat poke is a no-op', async () => {
  const h = harness({ unread: new Map([['a', 1]]), pages: { a: [row(1), row(2)] } });
  h.warm.poke(); await h.warm.idle();
  assert.deepEqual(h.fetched, ['a']);
  assert.equal(h.cache.a.messages.length, 2);
  assert.deepEqual(h.stale, ['a']);
  h.warm.poke(); await h.warm.idle();
  assert.deepEqual(h.fetched, ['a'], 'same unread count → no refetch');
});

test('a higher unread count re-warms; the viewed chat is never warmed', async () => {
  const h = harness({ unread: new Map([['a', 1], ['v', 3]]), viewed: 'v', pages: { a: [row(1)], v: [row(9)] } });
  h.warm.poke(); await h.warm.idle();
  assert.deepEqual(h.fetched, ['a']);
  h.unread.set('a', 2);
  h.warm.poke(); await h.warm.idle();
  assert.deepEqual(h.fetched, ['a', 'a']);
});

test('fuller overlapping cache is merged, not clobbered; a non-overlapping page replaces', async () => {
  const h = harness({
    unread: new Map([['a', 1], ['b', 1]]),
    cache: { a: { messages: [row(1), row(2), row(3)], pagination: { firstId: 1, hasMore: true } },
             b: { messages: [row(1), row(2), row(3)], pagination: { firstId: 1, hasMore: true } } },
    pages: { a: [row(3), row(4)], b: [row(40), row(41)] },
  });
  h.warm.poke(); await h.warm.idle();
  assert.deepEqual(h.cache.a.messages.map((m: any) => m.id), [1, 2, 3, 4]);
  assert.equal(h.cache.a.pagination.hasMore, true, 'deep cursor kept');
  assert.deepEqual(h.cache.b.messages.map((m: any) => m.id), [40, 41], 'no splice across a hole');
});

test('a chat that is read again is forgotten, so becoming unread later warms afresh', async () => {
  const h = harness({ unread: new Map([['a', 1]]), pages: { a: [row(1)] } });
  h.warm.poke(); await h.warm.idle();
  h.unread.delete('a'); h.warm.poke(); await h.warm.idle();
  h.unread.set('a', 1); h.warm.poke(); await h.warm.idle();
  assert.deepEqual(h.fetched, ['a', 'a']);
});

test('a failed fetch does not stall the queue or retry on the same count', async () => {
  const h = harness({ unread: new Map([['x', 1], ['a', 1]]), pages: { a: [row(1)] } });
  const orig = h.warm; void orig;
  // make x throw
  const deps = (h as any);
  const warm = createUnreadWarm({
    unreadChats: () => h.unread, viewedId: () => null,
    getCache: async () => null,
    fetchFull: async (id) => { if (id === 'x') throw new Error('offline'); h.fetched.push(id); return { messages: [row(1)] }; },
    putCache: async (id, m, p) => { h.cache[id] = { messages: m, pagination: p }; },
    mergeNewestPage: (c, p) => [...c, ...p], capTranscript: (m, p) => ({ messages: m, pagination: p }),
    markMemStale: () => {},
  });
  warm.poke(); await warm.idle();
  assert.deepEqual(h.fetched, ['a']);
  assert.equal(warm.warmedCount('x'), 1, 'attempt recorded; next count change retries');
  void deps;
});
