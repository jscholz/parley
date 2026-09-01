/**
 * @fileoverview The /transcribe budget ladder.
 *
 * Two field wedges came out of this arithmetic and they point in
 * OPPOSITE directions, which is why both halves are pinned here:
 *
 *  - 2026-06-09: a flat 15s ceiling was too SHORT for 3-minute memos
 *    (Deepgram couldn't answer in time) → permanent-retry loop. Fixed by
 *    scaling the response budget with blob size. That ladder is asserted
 *    below verbatim — a regression here re-wedges long memos.
 *
 *  - 2026-09-01: that same size-derived wall clock was used to bound the
 *    UPLOAD, where size is only a proxy for duration if bandwidth is
 *    good. A ~400KB dictation at ~20-25 KB/s needed 17-20s, got 15s, and
 *    looped forever. The upload is now stall-bounded (see
 *    util/stallTimeoutPost.ts); this module additionally guarantees
 *    ESCALATION so the loop terminates even when the stall detector
 *    can't see the problem.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  transcribeBudget, escalationFactor, baseResponseMs,
  BASE_STALL_MS, MAX_STALL_MS, MAX_RESPONSE_MS, CEILING_MS, MAX_ESCALATION_FACTOR,
} from './transcribeBudget.ts';

const SMALL = 400 * 1024;      // Jonathan's stuck dictation
const LARGE = 5 * 1024 * 1024;

describe('baseResponseMs — the pre-fix ladder, preserved', () => {
  it('sub-1MB memos keep the snappy 15s response budget', () => {
    assert.equal(baseResponseMs(SMALL, false), 15_000);
    assert.equal(baseResponseMs(1_000_000, false), 15_000);
  });

  it('blobs over 1MB keep 60s', () => {
    assert.equal(baseResponseMs(1_000_001, false), 60_000);
    assert.equal(baseResponseMs(LARGE, false), 60_000);
  });

  it('a long clip that fell back to single-shot keeps 120s', () => {
    // Regression guard for dictate-chunked-failures scenario C, which
    // asserts the 120000ms budget appears in the attempt log.
    assert.equal(baseResponseMs(3 * 1024 * 1024, true), 120_000);
  });
});

describe('escalationFactor', () => {
  it('doubles per recorded failure and then saturates', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9].map(escalationFactor), [1, 2, 4, 8, 8, 8]);
    assert.equal(escalationFactor(3), MAX_ESCALATION_FACTOR);
  });

  it('treats missing / negative / fractional counts as a fresh attempt', () => {
    assert.equal(escalationFactor(undefined), 1);
    assert.equal(escalationFactor(-5), 1);
    assert.equal(escalationFactor(NaN), 1);
    assert.equal(escalationFactor(0.5), 1);
  });
});

describe('transcribeBudget — first attempt', () => {
  it('gives a small blob a stall window that outlasts the old 15s wall clock', () => {
    // THE FIELD BUG. The old code allowed this blob 15s TOTAL; three
    // logged attempts died at 17.1s / 20.1s / 19.6s. The stall window
    // alone must exceed that, and it bounds IDLE time rather than
    // elapsed time, so a 60s upload at 7 KB/s is fine too.
    const b = transcribeBudget({ sizeBytes: SMALL, attempts: 0 });
    assert.equal(b.stallMs, BASE_STALL_MS);
    assert.ok(b.stallMs > 15_000, 'a fresh stall window must beat the old flat ceiling');
    assert.equal(b.responseMs, 15_000);
    assert.equal(b.factor, 1);
  });

  it('keeps the large-blob budgets untouched', () => {
    assert.equal(transcribeBudget({ sizeBytes: LARGE, attempts: 0 }).responseMs, 60_000);
    assert.equal(
      transcribeBudget({ sizeBytes: LARGE, chunkedCandidate: true, attempts: 0 }).responseMs,
      120_000,
    );
  });

  it('honours a caller-supplied base (the per-chunk budget + its test seam)', () => {
    assert.equal(transcribeBudget({ sizeBytes: LARGE, baseResponseMsOverride: 60_000 }).responseMs, 60_000);
    assert.equal(transcribeBudget({ sizeBytes: LARGE, baseResponseMsOverride: 700 }).responseMs, 700);
  });
});

describe('transcribeBudget — escalation across retries', () => {
  it('grows MATERIALLY on every retry, not by a rounding error', () => {
    const ladder = [0, 1, 2, 3].map((attempts) =>
      transcribeBudget({ sizeBytes: SMALL, attempts }));
    assert.deepEqual(ladder.map((b) => b.stallMs), [20_000, 40_000, 80_000, 120_000]);
    assert.deepEqual(ladder.map((b) => b.responseMs), [15_000, 30_000, 60_000, 120_000]);
    for (let i = 1; i < ladder.length; i++) {
      assert.ok(ladder[i].stallMs >= ladder[i - 1].stallMs * 1.5,
        `attempt ${i} must be materially more generous than attempt ${i - 1}`);
    }
  });

  it('a link 10x slower than the flat ceiling allowed still fits inside an escalated budget', () => {
    // 400KB at 2.5 KB/s = 160s of continuous uploading. No wall clock in
    // the pre-fix ladder came close; the escalated stall window bounds
    // idle time, so this completes as long as bytes keep moving.
    const b = transcribeBudget({ sizeBytes: SMALL, attempts: 3 });
    assert.ok(b.ceilingMs > 160_000, 'the absolute ceiling must not cut off a live trickle');
  });

  it('is capped so a genuinely broken upload still fails in bounded time', () => {
    const b = transcribeBudget({ sizeBytes: SMALL, attempts: 50 });
    assert.equal(b.stallMs, MAX_STALL_MS);
    assert.ok(b.responseMs <= MAX_RESPONSE_MS);
    assert.equal(b.ceilingMs, CEILING_MS);
  });

  it('caps the long-clip response budget too', () => {
    const b = transcribeBudget({ sizeBytes: LARGE, chunkedCandidate: true, attempts: 9 });
    assert.equal(b.responseMs, MAX_RESPONSE_MS);
  });
});
