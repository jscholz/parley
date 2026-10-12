// Full tool output on demand (2026-10-12). Strip-only TS.
import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';

import * as store from './store.ts';
import { ensureFullToolOutput, fetchFailed, fmtBytes, _setFetcherForTests, _setViewedChatForTests } from './toolOutput.ts';

const CHAT = 'parley:tool-output-test';

beforeEach(() => {
  store.clearAll(CHAT);
  store.setDurable(CHAT, [
    { id: 'umsg_1', parley_id: 'umsg_1', role: 'user', content: 'run it', timestamp: 1 },
    { id: 42, role: 'tool', content: 'preview…', tool_call_id: 'c1', tool_name: 'terminal', truncated: true, contentBytes: 50_000, timestamp: 2 },
  ], { firstId: null, hasMore: false });
  _setViewedChatForTests(() => CHAT);
});

test('fetches once, patches the durable row, and notifies', async () => {
  const calls: string[] = [];
  _setFetcherForTests(async (chat, id) => { calls.push(`${chat}/${id}`); return { content: 'FULL'.repeat(1000) }; });
  let notified = 0;
  const off = store.subscribe((id) => { if (id === CHAT) notified += 1; });
  const [a, b] = await Promise.all([ensureFullToolOutput(42), ensureFullToolOutput(42)]);
  off();
  assert.equal(a, true); assert.equal(b, true);
  assert.deepEqual(calls, [`${CHAT}/42`], 'in-flight de-duplicated');
  const row = store.getState(CHAT).durable.find((d) => String(d.id) === '42')!;
  assert.equal(row.content.length, 4000);
  assert.equal(row.truncated, false);
  assert.equal(row.contentBytes, undefined);
  assert.equal(notified, 1);
});

test('a failed fetch is remembered for the retry affordance; retry fetches again', async () => {
  let n = 0;
  _setFetcherForTests(async () => { n += 1; if (n === 1) throw new Error('offline'); return { content: 'ok' }; });
  assert.equal(await ensureFullToolOutput(42), false);
  assert.equal(fetchFailed(CHAT, 42), true);
  assert.equal(await ensureFullToolOutput(42), false, 'no automatic re-fetch while failed');
  assert.equal(n, 1);
  assert.equal(await ensureFullToolOutput(42, { retry: true }), true);
  assert.equal(fetchFailed(CHAT, 42), false);
});

test('a 404 (row gone) is a quiet failure; an unknown row id patches nothing', async () => {
  _setFetcherForTests(async () => null);
  assert.equal(await ensureFullToolOutput(42), false);
  _setFetcherForTests(async () => ({ content: 'x' }));
  assert.equal(await ensureFullToolOutput(999, { retry: true }), false);
});

test('fmtBytes', () => {
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(2048), '2.0 KB');
  assert.equal(fmtBytes(81_389), '79 KB');
  assert.equal(fmtBytes(3 * 1024 * 1024), '3.0 MB');
});
