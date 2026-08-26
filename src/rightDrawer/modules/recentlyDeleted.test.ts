// Recently Deleted unit tests (B2; 2026-08-18 incident lineage).
// Strip-only TS — no parameter properties / enums.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { discardedCapturesFrom, fmtBytes, fmtDurationMs } from './recentlyDeleted.ts';

test('discardedCapturesFrom: keeps only discarded rows, newest tombstone first', () => {
  const rows = discardedCapturesFrom({
    captures: [
      { id: 'a', title: 'Old', status: 'discarded', discarded_at: 1_000, started_at: 0, ended_at: 60_000, total_bytes: 2048 },
      { id: 'b', title: 'Kept meeting', status: 'complete', started_at: 0, ended_at: 60_000 },
      { id: 'c', title: 'New', status: 'discarded', discarded_at: 9_000, started_at: 0, ended_at: 30_000, total_bytes: 512 },
      { id: 'd', title: 'Recording', status: 'recording', started_at: 0 },
    ],
  });
  assert.deepEqual(rows.map((r) => r.id), ['c', 'a'], 'discarded only, newest first');
  assert.equal(rows[1].durationMs, 60_000);
  assert.equal(rows[1].totalBytes, 2048);
});

test('discardedCapturesFrom: full-manifest rows (mock shape) sum segment bytes', () => {
  const rows = discardedCapturesFrom({
    captures: [{
      id: 'a', title: 'Mocked', status: 'discarded', discarded_at: 5,
      started_at: 10, ended_at: 10, // zero span → no duration claim
      segments: [{ seq: 0, bytes: 100 }, { seq: 1, bytes: 200 }],
    }],
  });
  assert.equal(rows[0].totalBytes, 300);
  assert.equal(rows[0].durationMs, null);
});

test('discardedCapturesFrom: garbage-tolerant (missing fields, wrong shapes)', () => {
  assert.deepEqual(discardedCapturesFrom(null), []);
  assert.deepEqual(discardedCapturesFrom({}), []);
  assert.deepEqual(discardedCapturesFrom({ captures: 'nope' }), []);
  const rows = discardedCapturesFrom({
    captures: [null, { status: 'discarded' }, { id: 'x', status: 'discarded' }],
  });
  assert.equal(rows.length, 1, 'rows without a string id are dropped');
  assert.equal(rows[0].title, 'Meeting', 'missing title falls back');
  assert.equal(rows[0].durationMs, null);
  assert.equal(rows[0].totalBytes, null);
});

test('fmtBytes: human units, null-safe', () => {
  assert.equal(fmtBytes(8.2 * 1024 * 1024), '8.2 MB');
  assert.equal(fmtBytes(412 * 1024), '412 KB');
  assert.equal(fmtBytes(90), '90 B');
  assert.equal(fmtBytes(0), null);
  assert.equal(fmtBytes(null), null);
});

test('fmtDurationMs: player-strip clock format, null-safe', () => {
  assert.equal(fmtDurationMs(12 * 60_000 + 34_000), '12:34');
  assert.equal(fmtDurationMs(3_723_000), '1:02:03');
  assert.equal(fmtDurationMs(5_000), '0:05');
  assert.equal(fmtDurationMs(0), null);
  assert.equal(fmtDurationMs(null), null);
});
