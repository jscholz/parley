/**
 * @fileoverview Unit tests for the pure anchor state machine
 * (src/util/textAnchor.ts) — the logic behind "dictation finals land at
 * the position captured at utterance start, slid across any manual edits
 * that happened while the transcript was in flight" (Jonathan field bug
 * 2026-07-21).
 *
 * Stripped-only TS constraints (see feedback_strip_only_ts.md):
 *   - no parameter properties, no enums, no decorators.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { diffEdit, shiftPoint, shiftSpan } from './textAnchor.ts';

describe('diffEdit — single-region value diff', () => {
  it('returns null for identical values', () => {
    assert.equal(diffEdit('hello', 'hello'), null);
    assert.equal(diffEdit('', ''), null);
  });

  it('detects a pure insertion', () => {
    assert.deepEqual(diffEdit('ab', 'aXb'), { start: 1, removedLen: 0, insertedLen: 1 });
    assert.deepEqual(diffEdit('', 'abc'), { start: 0, removedLen: 0, insertedLen: 3 });
    assert.deepEqual(diffEdit('ab', 'abXY'), { start: 2, removedLen: 0, insertedLen: 2 });
  });

  it('detects a pure deletion', () => {
    assert.deepEqual(diffEdit('aXb', 'ab'), { start: 1, removedLen: 1, insertedLen: 0 });
    assert.deepEqual(diffEdit('abc', ''), { start: 0, removedLen: 3, insertedLen: 0 });
  });

  it('detects a replacement', () => {
    assert.deepEqual(diffEdit('one two three', 'one 2 three'),
      { start: 4, removedLen: 3, insertedLen: 1 });
  });

  it('resolves ambiguous repeats to the earliest position', () => {
    // Inserting an "a" into "aaa" could be anywhere; earliest is chosen.
    assert.deepEqual(diffEdit('aaa', 'aaaa'), { start: 3, removedLen: 0, insertedLen: 1 });
  });

  it('never lets prefix and suffix overlap', () => {
    // old="aa" new="a": prefix would eat both chars; suffix must not
    // double-count. One char removed, position consistent.
    assert.deepEqual(diffEdit('aa', 'a'), { start: 1, removedLen: 1, insertedLen: 0 });
  });
});

describe('shiftPoint — point anchor across an edit', () => {
  const ins = (start: number, n: number) => ({ start, removedLen: 0, insertedLen: n });
  const del = (start: number, n: number) => ({ start, removedLen: n, insertedLen: 0 });

  it('edit strictly after: unchanged', () => {
    assert.equal(shiftPoint(5, ins(6, 3)), 5);
    assert.equal(shiftPoint(5, del(5, 2)), 5); // removal starting AT anchor removes text after it
  });

  it('edit strictly before: shifts by the delta', () => {
    assert.equal(shiftPoint(5, ins(0, 3)), 8);
    assert.equal(shiftPoint(5, del(1, 2)), 3);
    assert.equal(shiftPoint(5, { start: 0, removedLen: 2, insertedLen: 4 }), 7);
  });

  it('pure insertion exactly at the anchor slides it right (typed text stays before the pending insert)', () => {
    assert.equal(shiftPoint(5, ins(5, 4)), 9);
  });

  it('deletion spanning the anchor invalidates it', () => {
    assert.equal(shiftPoint(5, del(3, 4)), null);
    assert.equal(shiftPoint(5, { start: 0, removedLen: 10, insertedLen: 2 }), null);
  });

  it('deletion ending exactly at the anchor shifts (anchor survives at the boundary)', () => {
    assert.equal(shiftPoint(5, del(3, 2)), 3);
  });
});

describe('shiftSpan — utterance span across an edit', () => {
  const ins = (start: number, n: number) => ({ start, removedLen: 0, insertedLen: n });
  const del = (start: number, n: number) => ({ start, removedLen: n, insertedLen: 0 });

  it('edit entirely before the span shifts the anchor', () => {
    assert.equal(shiftSpan(10, 5, ins(0, 3)), 13);
    assert.equal(shiftSpan(10, 5, del(2, 4)), 6);
  });

  it('pure insertion exactly at the anchor counts as before (span slides right)', () => {
    assert.equal(shiftSpan(10, 5, ins(10, 2)), 12);
  });

  it('edit at/after the span end is a no-op', () => {
    assert.equal(shiftSpan(10, 5, ins(15, 3)), 10); // typing exactly at span end
    assert.equal(shiftSpan(10, 5, del(20, 2)), 10);
  });

  it('edit intersecting the span drops it (returns null)', () => {
    assert.equal(shiftSpan(10, 5, ins(12, 1)), null);       // typing inside the dictated text
    assert.equal(shiftSpan(10, 5, del(8, 4)), null);        // deletion crossing the anchor
    assert.equal(shiftSpan(10, 5, del(14, 3)), null);       // deletion crossing the span end
    assert.equal(shiftSpan(10, 5, { start: 0, removedLen: 30, insertedLen: 1 }), null); // full swap
  });

  it('zero-length span (anchor only) still shifts on insertion at it', () => {
    assert.equal(shiftSpan(10, 0, ins(10, 3)), 13);
    assert.equal(shiftSpan(10, 0, ins(11, 3)), 10);
  });
});
