// The rule that decides "the transcript is wobbling on its own" (field
// 2026-10-30: jumping a few px at 3–4 Hz on his laptop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectJitter, type Sample } from '../src/util/jitterWatch.ts';

const series = (tops: number[], commanded = false, step = 100): Sample[] =>
  tops.map((top, i) => ({ t: i * step, top, commanded }));

test('a 3-4 Hz wobble of a few px is jitter', () => {
  const s = series([100, 103, 103, 100, 100, 103, 103, 100, 100, 103, 103, 100]);
  const v = detectJitter(s, s[s.length - 1].t);
  assert.equal(v.jitter, true, JSON.stringify(v));
  assert.equal(v.amplitude, 3);
});

test('holding still is not jitter', () => {
  const s = series(Array(20).fill(100));
  assert.equal(detectJitter(s, 1900).jitter, false);
});

test('a one-off settle (history prepend, image decode) is not jitter', () => {
  const s = series([100, 100, 140, 140, 140, 139.2, 139.2, 139.2]);
  assert.equal(detectJitter(s, 700).jitter, false);
});

test('content streaming in at the live edge moves one way only', () => {
  const s = series([300, 280, 260, 240, 220, 200, 180, 160, 140]);
  assert.equal(detectJitter(s, 800).jitter, false);
});

test("the user's own scrolling never counts", () => {
  const s = series([100, 160, 120, 180, 110, 170, 100, 160, 100, 170], true);
  assert.equal(detectJitter(s, 900).jitter, false);
});

test('sub-pixel noise is not a wiggle', () => {
  const s = series([100, 100.4, 100, 100.4, 100, 100.4, 100, 100.4, 100]);
  assert.equal(detectJitter(s, 800).jitter, false);
});

test('only the last few seconds count', () => {
  const old = series([100, 103, 100, 103, 100, 103, 100]);
  const still = Array.from({ length: 40 }, (_, i) => ({ t: 700 + i * 100, top: 100, commanded: false }));
  assert.equal(detectJitter([...old, ...still], 4600).jitter, false);
});
