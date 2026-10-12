// classifyBarGesture — a touch on a reply's play bar is a tap, a scroll
// or a scrub (field 2026-10-12: scrolling started a reply).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyBarGesture, BAR_SLOP_PX } from '../src/audio/turn-based/barGesture.ts';

test('inside the slop it is still undecided (a tap if released there)', () => {
  assert.equal(classifyBarGesture(0, 0), 'pending');
  assert.equal(classifyBarGesture(BAR_SLOP_PX - 1, -(BAR_SLOP_PX - 1)), 'pending');
});
test('vertical movement is a scroll, never a scrub', () => {
  assert.equal(classifyBarGesture(2, 40), 'scroll');
  assert.equal(classifyBarGesture(-3, -25), 'scroll');
  assert.equal(classifyBarGesture(20, 20), 'scroll', 'a diagonal tie goes to scroll');
});
test('horizontal movement is a scrub drag', () => {
  assert.equal(classifyBarGesture(30, 4), 'drag');
  assert.equal(classifyBarGesture(-15, 2), 'drag');
});
