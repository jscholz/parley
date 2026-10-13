import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { noteRender, LOOP_RENDERS_PER_SEC, _resetForTests } from './renderLoopGuard.ts';

beforeEach(() => _resetForTests());

test('normal render rates pass through', () => {
  for (let i = 0; i < LOOP_RENDERS_PER_SEC; i++) assert.equal(noteRender('c', 1000 + i), false);
});
test('more than the threshold within a second trips the guard', () => {
  let tripped = false;
  for (let i = 0; i <= LOOP_RENDERS_PER_SEC + 5; i++) tripped = noteRender('c', 1000) || tripped;
  assert.equal(tripped, true);
});
test('the window slides: spaced renders never trip it', () => {
  for (let i = 0; i < 1000; i++) assert.equal(noteRender('c', i * 20), false);
});
test('chats are counted separately', () => {
  for (let i = 0; i < LOOP_RENDERS_PER_SEC; i++) { noteRender('a', 1000); noteRender('b', 1000); }
  assert.equal(noteRender('a', 1000), true);
  _resetForTests();
  assert.equal(noteRender('b', 1000), false);
});
