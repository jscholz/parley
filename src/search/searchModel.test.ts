// Strip-only TS. Scope caps + the stable repaint rule (2026-11-08).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { stableOrder, scopeCaps, SCOPES } from './searchModel.ts';

test('stableOrder keeps painted rows in place, appends newcomers in rank order, drops the dropped', () => {
  assert.deepEqual(stableOrder(['a', 'b', 'c'], ['c', 'x', 'a', 'y']), ['a', 'c', 'x', 'y']);
  assert.deepEqual(stableOrder([], ['x', 'y']), ['x', 'y']);
  assert.deepEqual(stableOrder(['a', 'b'], ['b', 'a']), ['a', 'b'], 'a pure reorder changes nothing');
  assert.deepEqual(stableOrder(['a', 'b'], []), []);
  assert.deepEqual(stableOrder(['a', 'a', 'b'], ['b', 'a']), ['a', 'b'], 'duplicates collapse');
});

test('scopeCaps: All keeps categories short with a tiny instant cap; a single scope lifts its cap', () => {
  assert.deepEqual(SCOPES, ['all', 'sessions', 'artifacts', 'messages']);
  const all = scopeCaps('all');
  assert.ok(all.sessionsInstant <= 3 && all.sessions >= all.sessionsInstant && all.limit <= 20);
  assert.ok(scopeCaps('sessions').sessions > all.sessions);
  assert.ok(scopeCaps('artifacts').limit > 8 && scopeCaps('artifacts').sessions === 0);
  assert.ok(scopeCaps('messages').limit > all.limit && scopeCaps('messages').sessions === 0);
});
