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

describe('dictation — sendword commitDelaySec grace window (2026-08-04 audit fix)', () => {
  let bubbles: string[];
  const DELAY_SEC = 0.05;  // 50 ms — fast enough for test timeouts

  beforeEach(() => {
    bubbles = [];
    settings.set('silenceSec', 30);       // silence must not be the trigger
    settings.set('commitPhrase', 'over');
    settings.set('commitDelaySec', DELAY_SEC);
    dictation.reset();
    dictation.setUserBubbleHandler((text: string) => { bubbles.push(text); });
  });

  afterEach(() => {
    dictation.reset();
    dictation.setUserBubbleHandler(() => {});
    settings.set('silenceSec', 30);
    settings.set('commitPhrase', 'over');
    settings.set('commitDelaySec', 0);
  });

  it('delay=0 dispatches on the sendword immediately (pre-fix behavior preserved)', () => {
    settings.set('commitDelaySec', 0);
    dictation.handleUserFinal('hello there over');
    assert.deepEqual(bubbles, ['hello there']);
    assert.equal(dictation.__hasCommitTimerForTests(), false);
  });

  it('delay>0 arms the grace timer instead of dispatching, then dispatches', async () => {
    dictation.handleUserFinal('hello there over');
    assert.deepEqual(bubbles, [], 'must NOT dispatch inside the grace window');
    assert.equal(dictation.__hasCommitTimerForTests(), true);
    await new Promise((r) => setTimeout(r, DELAY_SEC * 1000 + 30));
    assert.deepEqual(bubbles, ['hello there'], 'grace expiry must dispatch the cleaned utterance');
    assert.equal(dictation.__hasCommitTimerForTests(), false);
  });

  it('a final landing inside the window rides the same dispatch', async () => {
    dictation.handleUserFinal('hello over');
    assert.deepEqual(bubbles, []);
    dictation.handleUserFinal('wait also this');
    await new Promise((r) => setTimeout(r, DELAY_SEC * 1000 + 30));
    assert.deepEqual(bubbles, ['hello wait also this'],
      'correction spoken during the grace window must land in the same turn');
  });

  it('pause during the window holds the commit; resume fires it immediately', async () => {
    dictation.handleUserFinal('hello over');
    assert.equal(dictation.__hasCommitTimerForTests(), true);
    dictation.pauseSilenceTimer();  // 'reconnecting' — channel dead
    assert.equal(dictation.__hasCommitTimerForTests(), false, 'pause must clear the pending timer');
    await new Promise((r) => setTimeout(r, DELAY_SEC * 1000 + 30));
    assert.deepEqual(bubbles, [], 'held commit must not dispatch into a dead channel');
    dictation.resumeSilenceTimer();
    assert.deepEqual(bubbles, ['hello'], 'resume must fire the held commit immediately');
  });

  it('reset() during the window drops the pending commit', async () => {
    dictation.handleUserFinal('hello over');
    dictation.reset();  // call closed
    await new Promise((r) => setTimeout(r, DELAY_SEC * 1000 + 30));
    assert.deepEqual(bubbles, [], 'a closed call must not dispatch a stale pending commit');
  });
});

describe('dictation — takeBufferedText rescue drain (Jonathan bug 2026-08-30)', () => {
  beforeEach(() => {
    settings.set('silenceSec', 30);
    settings.set('commitPhrase', '');
    settings.set('commitDelaySec', 0);
    dictation.reset();
    dictation.setUserBubbleHandler(() => {});
  });

  afterEach(() => {
    dictation.reset();
    dictation.setUserBubbleHandler(() => {});
    settings.set('commitPhrase', 'over');
  });

  it('drains the buffered utterance as one string and empties the machine', () => {
    dictation.handleUserFinal('so the plan for the quarter');
    dictation.handleUserFinal('is to ship the recovery work');
    assert.equal(
      dictation.takeBufferedText(),
      'so the plan for the quarter is to ship the recovery work',
    );
    assert.deepEqual(dictation.__getBufferForTests(), [],
      'the drain must leave the machine empty so a following reset() is a no-op');
    assert.equal(dictation.__hasSilenceTimerForTests(), false,
      'the drain must clear the silence timer — the call is over');
  });

  it('is idempotent: a second drain yields nothing (no double-rescue)', () => {
    dictation.handleUserFinal('only once please');
    assert.equal(dictation.takeBufferedText(), 'only once please');
    assert.equal(dictation.takeBufferedText(), '',
      'controls.ts fires the rescue on BOTH closing and idle; the second must be empty');
  });

  it('yields nothing after a normal dispatch (no double-send)', async () => {
    settings.set('silenceSec', 0.05);
    dictation.handleUserFinal('this one goes out properly');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(
      dictation.takeBufferedText(),
      '',
      'a dispatched utterance is already spent — rescuing it would send it twice',
    );
    settings.set('silenceSec', 30);
  });

  it('drops a pending sendword commit rather than firing it after the drain', async () => {
    settings.set('commitPhrase', 'over');
    settings.set('commitDelaySec', 0.05);
    const bubbles: string[] = [];
    dictation.setUserBubbleHandler((t: string) => { bubbles.push(t); });
    dictation.handleUserFinal('half a thought over');
    assert.equal(dictation.__hasCommitTimerForTests(), true);
    assert.equal(dictation.takeBufferedText(), 'half a thought');
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(bubbles, [],
      'the drained text must not ALSO dispatch when the grace window expires');
    settings.set('commitDelaySec', 0);
  });
});

// Restore fetch when the test process exits — defensive in case other
// suites in the same node:test run expected the real one.
process.on('exit', () => {
  (globalThis as any).fetch = realFetch;
});
