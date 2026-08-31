/**
 * @fileoverview The in-call "your audio link is weak / it's back" signal
 * — src/audio/realtime/linkQuality.ts.
 *
 * Jonathan, 2026-08-27, after losing minutes of speech on a bike ride:
 *
 *   "If it was a real phone call ... I would have gotten feedback after
 *    a minute ... that the audio was weak. And second, it will
 *    eventually come back, and I get a chime to that effect. We
 *    engineered the system to be like that, and it definitely didn't
 *    behave that way today."
 *
 * The bridge had detected every stall and told nobody. This suite pins
 * the client half, and in particular the two properties that make the
 * difference between a signal he trusts and one he learns to tune out:
 *
 *     THE CUE FIRES ONCE PER EPISODE, NEVER WHILE IT PERSISTS.
 *     THE INDICATOR CAN NEVER BE LEFT STUCK ON.
 *
 * The second has three independent guarantors, mirroring the duck in
 * realtime.ts (see test/realtime-barge-duck.test.ts): the bridge's `ok`
 * envelope, an evidence deadline for when that envelope never comes,
 * and a hard reset on call teardown. One test each.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as linkQuality from '../src/audio/realtime/linkQuality.ts';

/** Compressed from the production 3 s so the suite doesn't sleep. */
const DEADLINE_MS = 120;

let painted: boolean[];
let cues: string[];
let ttsPlaying: boolean;

function setup(opts: { deadlineMs?: number } = {}) {
  painted = [];
  cues = [];
  ttsPlaying = false;
  linkQuality.init({
    setIndicator: (d) => painted.push(d),
    playCue: (n) => cues.push(n),
    isTtsPlaying: () => ttsPlaying,
    deadlineMs: opts.deadlineMs ?? DEADLINE_MS,
  });
}

const degraded = (stalled = 3.2) => ({ type: 'link-quality', state: 'degraded', stalled_s: stalled });
const ok = () => ({ type: 'link-quality', state: 'ok' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('link quality — the user-facing signal', () => {
  beforeEach(() => setup());
  afterEach(() => linkQuality.__resetForTests());

  it('raises the indicator and chimes once when the uplink stalls', () => {
    linkQuality.onEnvelope(degraded());
    assert.equal(linkQuality.isDegraded(), true);
    assert.deepEqual(painted, [true], 'the indicator must go up on the first degraded envelope');
    assert.deepEqual(cues, ['link-degraded']);
  });

  it('does not chime again while the degradation persists', () => {
    // The bridge republishes ~1/s for as long as the stall lasts. A
    // ten-second dead zone must cost him one chime, not ten.
    for (let i = 0; i < 10; i++) linkQuality.onEnvelope(degraded());
    assert.deepEqual(cues, ['link-degraded'], `cue repeated: ${JSON.stringify(cues)}`);
    assert.deepEqual(painted, [true], 'the indicator was repainted per envelope');
  });

  it('clears the indicator and chimes recovery when the link comes back', () => {
    linkQuality.onEnvelope(degraded());
    linkQuality.onEnvelope(ok());
    assert.equal(linkQuality.isDegraded(), false);
    assert.deepEqual(painted, [true, false]);
    assert.deepEqual(cues, ['link-degraded', 'link-restored']);
  });

  it('ignores a recovery for a degradation that never happened', () => {
    linkQuality.onEnvelope(ok());
    assert.deepEqual(painted, [], 'a bare ok must not repaint');
    assert.deepEqual(cues, [], 'a bare ok must not chime');
  });

  it('does not paint at init — the paint hook is not safe to call at boot', () => {
    // setIndicator reaches main.ts's `isMicOwnedCall`, a lazy closure
    // over a `let` declared ~1400 lines BELOW the controls.init() call
    // site. Calling it at boot is a TDZ ReferenceError that the paint's
    // own catch would swallow into a silent no-op.
    assert.deepEqual(painted, [], 'init() painted; it must only bind hooks');
  });

  it('is inert for a bridge that never sends the envelope', () => {
    // Guarantee for an older bridge: the client behaves exactly as it
    // did before this feature existed.
    linkQuality.onEnvelope({ type: 'transcript', text: 'hi', is_final: true, role: 'user' });
    linkQuality.onEnvelope({ type: 'listening' });
    linkQuality.onEnvelope(null);
    assert.deepEqual(painted, []);
    assert.deepEqual(cues, []);
    assert.equal(linkQuality.isDegraded(), false);
  });

  // ── Guarantor 1: the bridge's `ok` envelope — covered above.

  it('guarantor 2: self-clears when the bridge goes silent, and does so WITHOUT chiming', async () => {
    // Dropped data channel / dead bridge: the degraded republishes just
    // stop. The indicator must not burn forever — but we did not
    // observe a recovery, so claiming one out loud would be a lie in
    // the one direction that costs him a dictation.
    linkQuality.onEnvelope(degraded());
    await sleep(DEADLINE_MS + 60);
    assert.equal(linkQuality.isDegraded(), false, 'the indicator stuck on after the evidence stopped');
    assert.deepEqual(painted, [true, false]);
    assert.deepEqual(cues, ['link-degraded'], `a silent clear chimed "restored": ${JSON.stringify(cues)}`);
  });

  it('guarantor 2 does not fire while the bridge keeps republishing', async () => {
    linkQuality.onEnvelope(degraded());
    for (let i = 0; i < 4; i++) {
      await sleep(DEADLINE_MS / 2);
      linkQuality.onEnvelope(degraded());
    }
    assert.equal(linkQuality.isDegraded(), true, 'the deadline expired despite live evidence — it must renew');
    assert.deepEqual(cues, ['link-degraded']);
  });

  it('guarantor 3: a call that ends while degraded does not leave the indicator stuck', () => {
    linkQuality.onEnvelope(degraded());
    assert.equal(linkQuality.isDegraded(), true);
    linkQuality.reset('idle');
    assert.equal(linkQuality.isDegraded(), false);
    assert.deepEqual(painted, [true, false], 'teardown must paint the indicator down');
    assert.deepEqual(cues, ['link-degraded'], 'teardown must be silent — the call ended, the link did not recover');
  });

  it('a fresh call cannot inherit the previous call\'s amber', () => {
    linkQuality.onEnvelope(degraded());
    linkQuality.reset('idle');            // call ends mid-stall
    painted = []; cues = [];
    linkQuality.reset('requesting-mic');  // next call opens
    assert.equal(linkQuality.isDegraded(), false);
    assert.deepEqual(cues, []);
    // And a late `ok` from the dead call must not chime into the new one.
    linkQuality.onEnvelope(ok());
    assert.deepEqual(cues, [], 'a straggler ok from the previous call chimed');
  });

  it('re-arms cleanly: a second episode gets its own pair of cues', () => {
    linkQuality.onEnvelope(degraded());
    linkQuality.onEnvelope(ok());
    linkQuality.onEnvelope(degraded());
    linkQuality.onEnvelope(ok());
    assert.deepEqual(cues, [
      'link-degraded', 'link-restored', 'link-degraded', 'link-restored',
    ]);
  });
});

describe('link quality — not chiming over the agent', () => {
  beforeEach(() => setup());
  afterEach(() => linkQuality.__resetForTests());

  it('holds the cue back while TTS is audible, and fires it the moment TTS ends', () => {
    ttsPlaying = true;
    linkQuality.onEnvelope(degraded());
    assert.deepEqual(painted, [true], 'the VISUAL is instant regardless — only the sound waits');
    assert.deepEqual(cues, [], 'an alert chime landing mid-reply reads as a playback glitch');

    ttsPlaying = false;
    linkQuality.onEnvelope({ type: 'tts-playing', active: false });
    assert.deepEqual(cues, ['link-degraded'], 'the held cue never landed after the agent stopped');
  });

  it('does not announce recovery for a degradation he never heard', () => {
    // Held cue + the link recovers before the agent stops talking. A
    // lone "all clear" for a problem that was never raised is noise:
    // cues are always paired, or absent.
    ttsPlaying = true;
    linkQuality.onEnvelope(degraded());
    linkQuality.onEnvelope(ok());
    assert.deepEqual(cues, []);
    assert.deepEqual(painted, [true, false], 'the indicator still tracked the episode');
  });

  it('still fires the cue if the reply runs longer than the defer budget', async () => {
    // The wait is bounded (CUE_DEFER_MAX_MS): a long reply must not
    // swallow the warning entirely, or he answers it into a dead uplink.
    let t = 0;
    painted = []; cues = []; ttsPlaying = true;
    linkQuality.init({
      setIndicator: (d) => painted.push(d),
      playCue: (n) => cues.push(n),
      isTtsPlaying: () => ttsPlaying,
      now: () => t,
      deadlineMs: 10_000,
    });
    painted = [];
    linkQuality.onEnvelope(degraded());
    assert.deepEqual(cues, [], 'deferred while the agent speaks');
    t += linkQuality.CUE_DEFER_MAX_MS + 1;
    linkQuality.onEnvelope(degraded());   // the bridge's ~1 Hz republish is the retry clock
    assert.deepEqual(cues, ['link-degraded'], 'the defer budget never expired — the warning was swallowed');
  });
});
