// The counting rules behind rewind (/undo N) and fork (/branch + /undo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userTurnsFrom, userTurnsAfter, branchChatIdFromReply } from './messageActions.ts';

const rows = [
  { id: 1, parley_id: 'umsg_a', role: 'user', content: 'first' },
  { id: 2, parley_id: 'msg_a', role: 'assistant', content: 'reply one' },
  { id: 3, parley_id: 'umsg_b', role: 'user', content: 'second' },
  { id: 4, parley_id: 'msg_b', role: 'assistant', content: 'reply two' },
  { id: 5, parley_id: 'umsg_c', role: 'user', content: '/undo 1' },
  { id: 6, parley_id: 'umsg_d', role: 'user', content: 'third' },
] as any[];

test('rewind to a user message counts it and every later user turn', () => {
  assert.equal(userTurnsFrom(rows, 'umsg_a'), 3);
  assert.equal(userTurnsFrom(rows, 'umsg_b'), 2);
  assert.equal(userTurnsFrom(rows, 'umsg_d'), 1);
});

test('a persisted slash command is not a user turn hermes would count', () => {
  assert.equal(userTurnsFrom(rows, 'umsg_c'), 1, 'only "third" after the command row');
});

test('fork from a reply undoes the user turns after it; from the last message nothing', () => {
  assert.equal(userTurnsAfter(rows, 'msg_a'), 2);
  assert.equal(userTurnsAfter(rows, 'msg_b'), 1);
  assert.equal(userTurnsAfter(rows, 'umsg_d'), 0);
});

test('an unknown message counts nothing', () => {
  assert.equal(userTurnsFrom(rows, 'nope'), 0);
  assert.equal(userTurnsAfter(rows, 'nope'), 0);
});

test('the branch reply link yields the new chat id', () => {
  assert.equal(branchChatIdFromReply('Branched into a new chat: /?chat=parley%3Aabc-123&msg=m1'), 'parley:abc-123');
  assert.equal(branchChatIdFromReply('Opened https://parley.local/?chat=parley:xyz) — enjoy'), 'parley:xyz');
  assert.equal(branchChatIdFromReply('no link here'), null);
});
