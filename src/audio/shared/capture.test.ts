import { it } from 'node:test';
import assert from 'node:assert/strict';
import { withPreferredMic, isMissingDeviceError } from './capture.ts';

// Field bug 2026-08-03: the Settings "Input" picker saved micDevice but
// no capture path ever consumed it — getUserMedia always ran on the OS
// default input. These pin the constraint-merge + fallback classifier
// that route the selection through capture.acquire().

it('withPreferredMic merges an exact deviceId into caller constraints', () => {
  const dsp = { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
  const merged = withPreferredMic(dsp, 'abc123');
  assert.deepEqual(merged, { ...dsp, deviceId: { exact: 'abc123' } });
  // Caller's object must not be mutated — modes reuse their constraint
  // literals across acquisitions.
  assert.equal('deviceId' in dsp, false);
});

it('withPreferredMic is a no-op for the empty ("Default") selection', () => {
  const dsp = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
  assert.equal(withPreferredMic(dsp, ''), dsp);
});

it('isMissingDeviceError accepts only the vanished-device shapes', () => {
  assert.equal(isMissingDeviceError({ name: 'OverconstrainedError' }), true);
  assert.equal(isMissingDeviceError({ name: 'NotFoundError' }), true);
  // Permission denials and everything else must surface to the caller,
  // never silently retry on the default device.
  assert.equal(isMissingDeviceError({ name: 'NotAllowedError' }), false);
  assert.equal(isMissingDeviceError({ name: 'TypeError' }), false);
  assert.equal(isMissingDeviceError(undefined), false);
});
