/**
 * @fileoverview Tests for primeFeedback() — the iOS in-gesture chime
 * unlock. iOS gates HTMLAudioElement.play() per-element behind user
 * activation; the call-start 'listening' cue fires async (from the
 * bridge envelope) after the activation window may have closed, so the
 * chime element's first-ever play() is blocked. primeFeedback() plays
 * every cached chime element muted inside the opening gesture to mark
 * them user-activated up front.
 *
 * Strategy: inject fake HTMLAudioElement-shaped stubs via the test hooks
 * (OfflineAudioContext/Audio are unavailable under node:test) and assert
 * primeFeedback() plays each one and is idempotent once the full set is
 * cached.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  primeFeedback,
  __setPlayerForTests,
  __resetFeedbackForTests,
} from '../src/audio/shared/feedback.ts';

const ALL_CHIMES = [
  'send', 'receive', 'error', 'start',
  'commit', 'connect', 'listening', 'barge',
  'call-dropped', 'reconnect-tick',
] as const;

function fakeEl() {
  const calls = { play: 0 };
  const el = {
    muted: false,
    currentTime: 0,
    play() { calls.play++; return Promise.resolve(); },
    pause() { /* noop */ },
  };
  return { el: el as unknown as HTMLAudioElement, calls };
}

describe('primeFeedback', () => {
  beforeEach(() => __resetFeedbackForTests());

  it('plays every cached chime element once', () => {
    const fakes = ALL_CHIMES.map((name) => {
      const f = fakeEl();
      __setPlayerForTests(name, f.el);
      return f;
    });
    primeFeedback();
    for (const f of fakes) {
      assert.equal(f.calls.play, 1, 'each cached chime element should be played once');
    }
  });

  it('is idempotent once the full set is unlocked', () => {
    const fakes = ALL_CHIMES.map((name) => {
      const f = fakeEl();
      __setPlayerForTests(name, f.el);
      return f;
    });
    primeFeedback();
    primeFeedback();
    primeFeedback();
    for (const f of fakes) {
      assert.equal(f.calls.play, 1, 'play() must not re-fire after the set is primed');
    }
  });

  it('does not latch primed when the set is incomplete, then primes once complete', () => {
    // Only a partial set cached — primeFeedback must NOT mark itself done,
    // so a later gesture (after the rest render) still unlocks them.
    const first = fakeEl();
    __setPlayerForTests('listening', first.el);
    primeFeedback();
    assert.equal(first.calls.play, 1);

    // Remaining chimes arrive; the next gesture unlocks the full set.
    const rest = ALL_CHIMES.filter((n) => n !== 'listening').map((name) => {
      const f = fakeEl();
      __setPlayerForTests(name, f.el);
      return f;
    });
    primeFeedback();
    for (const f of rest) {
      assert.equal(f.calls.play, 1, 'newly-cached chimes unlock on the next gesture');
    }
  });
});
