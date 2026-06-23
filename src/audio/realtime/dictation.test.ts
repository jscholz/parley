/**
 * @fileoverview Pause/resume the dictation silence timer across a
 * 'reconnecting' window. Regression test for Jonathan field bug
 * 2026-06-23 — bike ride, realtime CALL mode, two green→yellow network
 * wobbles each wiped the in-flight utterance buffer and forced the user
 * to start the message over. Fix preserves the buffer through the gap
 * and holds the silence countdown so the half-utterance doesn't
 * dispatch mid-yellow.
 *
 * Stripped-only TS constraints (see hosts/.../feedback_strip_only_ts.md):
 *   - no parameter properties
 *   - no enums
 *   - no decorators
 * Whole test file silently aborts at load if violated.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch so settings.set('silenceSec', ...) doesn't try to hit a
// proxy endpoint during tests — putServerSetting fires fetch
// fire-and-forget; under node:test an unhandled rejection from a real
// fetch on an unreachable origin can leak past the test boundary.
const realFetch = (globalThis as any).fetch;
(globalThis as any).fetch = (async () => ({
  ok: true,
  json: async () => ({}),
  text: async () => '',
})) as unknown as typeof fetch;

import * as dictation from './dictation.ts';
import * as settings from '../../settings.ts';

// Use a tiny silenceSec so timer-based tests don't take 30s. The
// production default is 30s — we override before each test.
const FAST_SILENCE_SEC = 0.05;  // 50 ms

describe('dictation — reconnect buffer preservation (Jonathan bug 2026-06-23)', () => {
  let bubbles: string[];

  beforeEach(() => {
    bubbles = [];
    // Settings tweak: very short silence window so the timer fires
    // within test timeout. Direct setting via `set` — fetch is stubbed
    // above so the putServerSetting side-effect is harmless.
    settings.set('silenceSec', FAST_SILENCE_SEC);
    // Clear commit phrase so silence-timeout is the ONLY dispatch
    // trigger in these tests (otherwise "over" matching could fire
    // unexpectedly on input text). Restored in afterEach.
    settings.set('commitPhrase', '');
    dictation.reset();
    dictation.setUserBubbleHandler((text: string) => { bubbles.push(text); });
  });

  afterEach(() => {
    dictation.reset();
    dictation.setUserBubbleHandler(() => {});
    // Restore production defaults so cross-test bleed doesn't surprise
    // adjacent suites that share the same singleton.
    settings.set('silenceSec', 30);
    settings.set('commitPhrase', 'over');
  });

  it('handleUserFinal appends to buffer and arms the silence timer', () => {
    dictation.handleUserFinal('hello');
    assert.deepEqual(dictation.__getBufferForTests(), ['hello']);
    assert.equal(dictation.__hasSilenceTimerForTests(), true);
  });

  it('pauseSilenceTimer holds the countdown but preserves the buffer', async () => {
    dictation.handleUserFinal('hello');
    assert.deepEqual(dictation.__getBufferForTests(), ['hello']);
    assert.equal(dictation.__hasSilenceTimerForTests(), true);

    // Enter 'reconnecting' — controls.ts calls pauseSilenceTimer.
    dictation.pauseSilenceTimer();
    assert.deepEqual(
      dictation.__getBufferForTests(),
      ['hello'],
      'buffer must survive the pause',
    );
    assert.equal(
      dictation.__hasSilenceTimerForTests(),
      false,
      'silence timer must be cleared on pause',
    );

    // Wait WELL past silenceSec — no dispatch should fire.
    await new Promise((r) => setTimeout(r, FAST_SILENCE_SEC * 1000 * 3));
    assert.deepEqual(
      bubbles,
      [],
      'no dispatch should fire while paused',
    );
    assert.deepEqual(
      dictation.__getBufferForTests(),
      ['hello'],
      'buffer still preserved after silence window would have elapsed',
    );
  });

  it('handleUserFinal while paused appends to buffer without re-arming the timer', async () => {
    dictation.handleUserFinal('hello');
    dictation.pauseSilenceTimer();

    // Defensive case from the spec: a late is_final lands during the
    // 'reconnecting' gap (shouldn't normally happen — bridge is dead —
    // but make it robust). Append, do not dispatch, do not arm timer.
    dictation.handleUserFinal('world');
    assert.deepEqual(
      dictation.__getBufferForTests(),
      ['hello', 'world'],
      'late is_final during pause should still append',
    );
    assert.equal(
      dictation.__hasSilenceTimerForTests(),
      false,
      'silence timer must NOT re-arm while paused',
    );

    await new Promise((r) => setTimeout(r, FAST_SILENCE_SEC * 1000 * 3));
    assert.deepEqual(bubbles, [], 'no dispatch while paused');
  });

  it('resumeSilenceTimer re-arms and the silence-timeout dispatches the merged utterance', async () => {
    dictation.handleUserFinal('hello');
    dictation.pauseSilenceTimer();
    dictation.handleUserFinal('world');

    // Exit 'reconnecting' (state → 'connected'). Timer re-arms and
    // silence elapses → dispatch fires with the joined utterance.
    dictation.resumeSilenceTimer();
    assert.equal(
      dictation.__hasSilenceTimerForTests(),
      true,
      'silence timer should re-arm on resume when buffer is non-empty',
    );

    // Wait past the silence window so the timer fires.
    await new Promise((r) => setTimeout(r, FAST_SILENCE_SEC * 1000 * 2));
    assert.deepEqual(
      bubbles,
      ['hello world'],
      'dispatched utterance must be the merged buffer, as one continuous sentence',
    );
    assert.deepEqual(
      dictation.__getBufferForTests(),
      [],
      'buffer cleared after dispatch',
    );
  });

  it('resumeSilenceTimer on an empty buffer is a no-op (no spurious timer)', () => {
    // Edge case: 'reconnecting' fired before any is_final arrived
    // (network wobbled the instant the call opened). On resume there's
    // nothing to dispatch — don't arm a timer that would fire on an
    // empty buffer.
    dictation.pauseSilenceTimer();
    dictation.resumeSilenceTimer();
    assert.equal(dictation.__hasSilenceTimerForTests(), false);
    assert.deepEqual(dictation.__getBufferForTests(), []);
  });

  it('reset() clears the paused flag (next call starts fresh)', () => {
    dictation.handleUserFinal('orphaned');
    dictation.pauseSilenceTimer();
    dictation.reset();  // simulate call close + fresh open

    // Fresh handleUserFinal must arm the timer normally — if reset
    // left silencePaused=true it would silently swallow the silence
    // countdown on the NEXT call.
    dictation.handleUserFinal('fresh');
    assert.equal(
      dictation.__hasSilenceTimerForTests(),
      true,
      'reset() must clear the silencePaused flag',
    );
    assert.deepEqual(dictation.__getBufferForTests(), ['fresh']);
  });
});

// Restore fetch when the test process exits — defensive in case other
// suites in the same node:test run expected the real one.
process.on('exit', () => {
  (globalThis as any).fetch = realFetch;
});
