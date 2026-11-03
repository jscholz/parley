// The one rule for another device's copy of a chat's draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRemote } from './draftSync.ts';

test('a newer edit elsewhere replaces an older local draft', () => {
  assert.equal(resolveRemote({ text: 'laptop', stamp: 1_000 }, { text: 'phone', updatedAt: 2_000 }), 'apply');
});

test('what the user typed more recently is never overwritten by an older copy', () => {
  assert.equal(resolveRemote({ text: 'typing now', stamp: 5_000 }, { text: 'old phone text', updatedAt: 2_000 }), 'keep');
});

test('a newer send or clear elsewhere empties this draft too', () => {
  assert.equal(resolveRemote({ text: 'already sent from the phone', stamp: 1_000 }, { text: '', updatedAt: 3_000 }), 'apply');
});

test('identical text is a no-op whatever the stamps say', () => {
  assert.equal(resolveRemote({ text: 'same', stamp: 9_000 }, { text: 'same', updatedAt: 1 }), 'same');
  assert.equal(resolveRemote({ text: '', stamp: 0 }, { text: '', updatedAt: 1 }), 'same');
});

test('a device that never edited the chat takes whatever the server holds', () => {
  assert.equal(resolveRemote({ text: '', stamp: 0 }, { text: 'from elsewhere', updatedAt: 1 }), 'apply');
});
