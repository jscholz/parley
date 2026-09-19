// Capture player unit tests — the pure helpers behind the strip.
// Strip-only TS.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  bufferedSegments, bufferedCoverage, isBuffered, loadedLabel, fmtClock, playbackFailureMessage,
} from './capturePlayer.ts';

const ranges = (...pairs: Array<[number, number]>) => ({
  length: pairs.length,
  start: (i: number) => pairs[i][0],
  end: (i: number) => pairs[i][1],
});

// ── Buffered → bar segments (the YouTube-style loaded bar) ────────────
test('bufferedSegments: percent segments, clamped to the duration', () => {
  assert.deepEqual(bufferedSegments(ranges([0, 30], [60, 100]), 120), [
    { left: 0, width: 25 }, { left: 50, width: (40 / 120) * 100 },
  ]);
  // Past-the-end and inverted ranges are clamped / dropped.
  assert.deepEqual(bufferedSegments(ranges([100, 200], [50, 40]), 120), [{ left: (100 / 120) * 100, width: (20 / 120) * 100 }]);
  assert.deepEqual(bufferedSegments(ranges([0, 10]), 0), []);
  assert.deepEqual(bufferedSegments(null, 100), []);
  assert.deepEqual(bufferedSegments(ranges([0, 10]), NaN), []);
});

test('bufferedCoverage + isBuffered', () => {
  assert.equal(bufferedCoverage(ranges([0, 30], [60, 90]), 120), 0.5);
  assert.equal(bufferedCoverage(ranges([0, 500]), 120), 1);
  assert.equal(bufferedCoverage(null, 120), 0);
  assert.equal(isBuffered(ranges([10, 20]), 15), true);
  assert.equal(isBuffered(ranges([10, 20]), 20.2), true);      // slack
  assert.equal(isBuffered(ranges([10, 20]), 25), false);
  assert.equal(isBuffered(null, 0), false);
});

test('loadedLabel: words for none / partial / full, active vs idle', () => {
  assert.deepEqual(loadedLabel(0, false), { level: 'none', text: 'Not loaded' });
  assert.deepEqual(loadedLabel(0, true), { level: 'none', text: 'Loading…' });
  assert.deepEqual(loadedLabel(0.42, true), { level: 'partial', text: 'Loading 42%' });
  assert.deepEqual(loadedLabel(0.42, false), { level: 'partial', text: '42% loaded' });
  assert.deepEqual(loadedLabel(0.004, false), { level: 'partial', text: '1% loaded' });
  assert.deepEqual(loadedLabel(0.999, true), { level: 'full', text: 'Loaded' });
});

test('fmtClock', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(65), '1:05');
  assert.equal(fmtClock(3723), '1:02:03');
  assert.equal(fmtClock(NaN), '–:––');
});

// ── playbackFailureMessage (player strip honesty, field 2026-09-19:
//    "play button does nothing" — every failure was swallowed). ──
test('playbackFailureMessage: the server\'s reason wins when the probe has one', () => {
  assert.equal(
    playbackFailureMessage({ name: 'NotSupportedError' }, { status: 409, error: 'capture is transcribing; playback is available once it completes' }),
    'Audio unavailable (409): capture is transcribing; playback is available once it completes',
  );
  assert.equal(playbackFailureMessage({ name: 'MEDIA_ERR_SRC_NOT_SUPPORTED' }, { status: 500 }), 'Audio unavailable (500)');
  assert.equal(playbackFailureMessage(null, { status: 410, error: ' audio was purged ' }), 'Audio unavailable (410): audio was purged');
});

test('playbackFailureMessage: gesture rejection asks for another tap regardless of probe', () => {
  assert.equal(playbackFailureMessage({ name: 'NotAllowedError' }, { status: 200 }), 'Tap play again to start playback.');
  assert.equal(playbackFailureMessage({ name: 'NotAllowedError' }, null), 'Tap play again to start playback.');
});

test('playbackFailureMessage: server fine → blame the browser; unreachable → say so', () => {
  assert.equal(playbackFailureMessage({ name: 'MEDIA_ERR_DECODE' }, { status: 206 }), 'This browser couldn\u2019t play the audio (MEDIA_ERR_DECODE).');
  assert.equal(playbackFailureMessage(null, { status: 200 }), 'This browser couldn\u2019t play the audio.');
  assert.equal(playbackFailureMessage({ name: 'AbortError' }, null), 'Couldn\u2019t reach the server to load the audio.');
});
