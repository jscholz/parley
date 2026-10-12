// continuesPastSendword — the rule both call engines use to tell a
// mid-sentence "over" from a final one (field 2026-10-12).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { continuesPastSendword, sendwordConfirmMs } from './handsfree.ts';

test('same segment: words after the phrase are continued speech; truncation is not', () => {
  assert.equal(continuesPastSendword('and it fell over because', 'over', true), true);
  assert.equal(continuesPastSendword('and it fell over, because', 'over', true), true);
  assert.equal(continuesPastSendword('and it fell', 'over', true), false);
  assert.equal(continuesPastSendword('and it fell over', 'over', true), false);
  assert.equal(continuesPastSendword('and it fell over.', 'over', true), false);
});

test('new segment: any words continue, unless it ends in the phrase itself', () => {
  assert.equal(continuesPastSendword('because people', 'over', false), true);
  assert.equal(continuesPastSendword('right over', 'over', false), false);
  assert.equal(continuesPastSendword('   ', 'over', false), false);
  assert.equal(continuesPastSendword('...', 'over', false), false);
});

test('word boundaries: "moreover"/"overall" are not the phrase', () => {
  assert.equal(continuesPastSendword('fell over overall', 'over', true), true);
  assert.equal(continuesPastSendword('moreover', 'over', true), false);
});

test('multi-word phrase and empty phrase', () => {
  assert.equal(continuesPastSendword('that is all over and out then', 'over and out', true), true);
  assert.equal(continuesPastSendword('that is all over and out', 'over and out', true), false);
  assert.equal(continuesPastSendword('anything', '', false), false);
});

test('sendwordConfirmMs: 0 stays instant; seconds → ms', () => {
  assert.equal(sendwordConfirmMs(0), 0);
  assert.equal(sendwordConfirmMs(1.5), 1500);
  assert.equal(sendwordConfirmMs(-1), 0);
});
