// Token semantics for the hardening Phase-1 paint gate. The module is
// a pure leaf with module-level state and no reset, so every case
// establishes its own state via the public API (begin/setOptimistic/
// setViewed) rather than assuming a clean slate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as switchCtl from './switchController.ts';

test('switch token: current until superseded by a newer begin()', () => {
  const a = switchCtl.begin('chat-a');
  assert.equal(switchCtl.canPaint(a), true);
  const b = switchCtl.begin('chat-b');
  assert.equal(switchCtl.canPaint(a), false, 'superseded switch must not paint');
  assert.equal(switchCtl.canPaint(b), true);
});

test('switch token: invalidate() kills the live switch', () => {
  const a = switchCtl.begin('chat-a');
  switchCtl.invalidate();
  assert.equal(switchCtl.canPaint(a), false);
});

test('commit promotes optimistic→viewed only while current', () => {
  const a = switchCtl.begin('chat-a');
  const b = switchCtl.begin('chat-b');
  assert.equal(switchCtl.commit(a), false, 'stale switch must not claim the view');
  assert.notEqual(switchCtl.viewedId(), 'chat-a');
  assert.equal(switchCtl.commit(b), true);
  assert.equal(switchCtl.viewedId(), 'chat-b');
});

test('view token: paints while its chat is focused, dies when focus moves', () => {
  const b = switchCtl.begin('chat-b');
  switchCtl.commit(b);
  switchCtl.clearOptimisticIfCurrent(b);
  const view = switchCtl.viewTokenFor('chat-b');
  assert.equal(switchCtl.canPaint(view), true, 'focused chat repaints');

  // A click flips optimistic synchronously — the view token for the
  // old chat must die IMMEDIATELY, before the new switch commits.
  // This is the backendEventHandlers hole the token model closes:
  // viewedId() still says chat-b here, but focus has moved.
  switchCtl.begin('chat-c');
  assert.equal(switchCtl.viewedId(), 'chat-b', 'viewed lags until the incoming chat paints');
  assert.equal(switchCtl.canPaint(view), false, 'stale view token must not paint over an in-flight switch');
});

test('view token for a never-focused chat never paints', () => {
  const b = switchCtl.begin('chat-b');
  switchCtl.commit(b);
  switchCtl.clearOptimisticIfCurrent(b);
  assert.equal(switchCtl.canPaint(switchCtl.viewTokenFor('chat-z')), false);
});

test('clearOptimisticIfCurrent: only the owning token may release the highlight', () => {
  const a = switchCtl.begin('chat-a');
  const b = switchCtl.begin('chat-b');
  switchCtl.clearOptimisticIfCurrent(a);
  assert.equal(switchCtl.optimisticId(), 'chat-b', 'stale token must not clear the newer claim');
  switchCtl.clearOptimisticIfCurrent(b);
  assert.equal(switchCtl.optimisticId(), null);
});
