/**
 * @fileoverview Tests for the evidence-based reachability model behind
 * opportunistic sends on a weak link. Run with: npm test.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as r from './reachability.ts';

describe('net/reachability', () => {
  beforeEach(() => r._reset());

  it('is not reachable until something answers', () => {
    assert.equal(r.recentlyReachable(1_000), false);
    r.noteAnswered(1_000);
    assert.equal(r.recentlyReachable(1_000), true);
    assert.equal(r.recentlyReachable(1_000 + r.REACHABLE_WINDOW_MS - 1), true);
    assert.equal(r.recentlyReachable(1_000 + r.REACHABLE_WINDOW_MS), false);
  });

  it('a later network failure cancels the evidence', () => {
    r.noteAnswered(1_000);
    r.noteNetworkFailure(2_000);
    assert.equal(r.recentlyReachable(2_500), false);
    // …and an answer after that restores it and clears the streak.
    r.noteNetworkFailure(3_000);
    assert.equal(r.failuresInARow(), 2);
    r.noteAnswered(4_000);
    assert.equal(r.recentlyReachable(4_500), true);
    assert.equal(r.failuresInARow(), 0);
  });

  it('backs off exponentially while the stream is down, sweeps steadily when up', () => {
    assert.equal(r.attemptDelayMs({ streamConnected: true, failures: 5 }), r.CONNECTED_SWEEP_MS);
    assert.deepEqual(
      [0, 1, 2, 3, 4, 9].map((f) => r.attemptDelayMs({ streamConnected: false, failures: f })),
      [10_000, 20_000, 40_000, 80_000, 120_000, 120_000],
    );
    // Uses the recorded streak when none is passed.
    r.noteNetworkFailure(); r.noteNetworkFailure();
    assert.equal(r.attemptDelayMs({ streamConnected: false }), 40_000);
  });

  it('only the OS offline flag stops an attempt', () => {
    assert.equal(r.shouldAttempt({ onLine: false }), false);
    assert.equal(r.shouldAttempt({ onLine: true }), true);
    assert.equal(r.shouldAttempt({ onLine: undefined }), true);
  });

  it('failures burn a retry budget only when the server was reachable', () => {
    assert.equal(r.countsAgainstBudget({ streamConnected: false, now: 1_000 }), false);
    assert.equal(r.countsAgainstBudget({ streamConnected: true, now: 1_000 }), true);
    r.noteAnswered(1_000);
    assert.equal(r.countsAgainstBudget({ streamConnected: false, now: 5_000 }), true);
    assert.equal(r.countsAgainstBudget({ streamConnected: false, now: 1_000 + r.REACHABLE_WINDOW_MS }), false);
  });
});
