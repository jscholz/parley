/**
 * @fileoverview The audible cut at barge — src/audio/realtime/realtime.ts
 * `cancelRemotePlayback()` / `restoreRemotePlayback()`.
 *
 * Jonathan's rule (2026-08-28): "It might be better from a user
 * standpoint if the audio was clipped to synchronize with the barge time
 * that the user hears. So the user understands that everything before
 * the barge is detected will be discarded, but everything immediately
 * afterwards will be captured."
 *
 * For that to be honest the cut has to be AUDIBLE. Pre-fix
 * `cancelRemotePlayback()` was a deliberate no-op, so 100-300 ms of
 * already-buffered TTS kept coming out of the speaker after every barge
 * — and the bridge had to hold its mic gate shut for all of it, which is
 * what made the (now removed) replay machinery look necessary.
 *
 * The dangerous way to implement it is the way it was implemented once
 * before (de5b48f): pause the <audio> element and null its srcObject.
 * ontrack fires once per session and nothing rebinds, so ONE false barge
 * silenced TTS for the rest of the call. scripts/smoke/
 * webrtc-barge-keeps-srcobject.mjs pins that srcObject and paused are
 * never touched; this suite pins the property that replaces it —
 *
 *     THE OUTPUT CAN NEVER BE LEFT MUTED.
 *
 * Three independent restores, each tested here: the bridge's
 * {type:'tts-playing', active:false} envelope, a watchdog for when that
 * envelope never arrives, and the hard reset on call teardown.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as conn from '../src/audio/realtime/realtime.ts';

const RAMP_SETTLE_MS = 80;   // > DUCK_RAMP_MS (25) with slack for the timer
// Compressed from the production 3 s, but kept comfortably above
// 2 × RAMP_SETTLE_MS so a test that ramps twice can't be rescued (or
// broken) by the watchdog firing underneath it.
const WATCHDOG_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal stand-in for the <audio> fallback playback path. */
function fakeAudioEl(): any {
  return { volume: 1, srcObject: {}, paused: false };
}

/** Minimal stand-in for the iOS Web Audio path's GainNode. */
function fakeGainNode(): any {
  const calls: string[] = [];
  const param: any = {
    value: 1,
    cancelScheduledValues(t: number) { calls.push(`cancel@${t}`); },
    setValueAtTime(v: number, t: number) { calls.push(`set(${v})@${t}`); param.value = v; },
    linearRampToValueAtTime(v: number, t: number) {
      calls.push(`ramp(${v})@${t}`);
      // Real AudioParam interpolates over wall time; for the test we
      // land on the target, which is what every assertion cares about.
      param.value = v;
    },
  };
  return { gain: param, context: { currentTime: 0 }, calls, disconnect() { calls.push('disconnect'); } };
}

describe('realtime: remote playback duck (the audible cut at barge)', () => {
  afterEach(() => {
    // Never leak a ducked/bound target into the next test.
    conn.setRemotePlaybackTargetsForTests(null, null);
  });

  describe('<audio> element path', () => {
    let el: any;
    beforeEach(() => {
      el = fakeAudioEl();
      conn.setRemotePlaybackTargetsForTests(el, null, WATCHDOG_MS);
    });

    it('mutes the remote output at barge', async () => {
      conn.cancelRemotePlayback();
      await sleep(RAMP_SETTLE_MS);
      assert.equal(
        el.volume, 0,
        'the agent kept talking through the barge — the user hears no cut, ' +
        'and the speaker keeps feeding the mic',
      );
      assert.equal(conn.getRemotePlaybackLevel(), 0);
    });

    it('ramps rather than stepping (no click on a live stream)', async () => {
      const seen: number[] = [];
      Object.defineProperty(el, 'volume', {
        get() { return seen.length ? seen[seen.length - 1] : 1; },
        set(v: number) { seen.push(v); },
      });
      conn.cancelRemotePlayback();
      await sleep(RAMP_SETTLE_MS);
      assert.ok(
        seen.length >= 3,
        `expected a multi-step ramp to zero, saw ${seen.length} write(s): ${seen}`,
      );
      assert.equal(seen[seen.length - 1], 0);
      assert.ok(
        seen.every((v) => v >= 0 && v <= 1),
        `volume left the legal range: ${seen}`,
      );
    });

    it('NEVER touches srcObject or paused (the de5b48f regression)', async () => {
      const src = el.srcObject;
      conn.cancelRemotePlayback();
      await sleep(RAMP_SETTLE_MS);
      assert.equal(el.srcObject, src, 'srcObject was reassigned — playback is now permanently unbound');
      assert.equal(el.paused, false, 'the element was paused');
    });

    it("restores on the bridge's {type:'tts-playing', active:false}", async () => {
      conn.cancelRemotePlayback();
      await sleep(RAMP_SETTLE_MS);
      assert.equal(el.volume, 0);

      conn.handleRemotePlaybackEnvelope({ type: 'tts-playing', active: false });
      await sleep(RAMP_SETTLE_MS);
      assert.equal(
        el.volume, 1,
        'the output stayed muted into the next reply round — every ' +
        'subsequent reply would be silent for the rest of the call',
      );
    });

    it('does NOT unmute on an active:true heartbeat during the halt tail', async () => {
      // The bridge keeps publishing tts-playing:true for
      // HALT_TAIL_GRACE_S after the halt. Unmuting there would put the
      // drained tail back into the room — and back into the mic.
      conn.cancelRemotePlayback();
      await sleep(RAMP_SETTLE_MS);
      conn.handleRemotePlaybackEnvelope({ type: 'tts-playing', active: true });
      await sleep(RAMP_SETTLE_MS);
      assert.equal(el.volume, 0, 'the halt tail was made audible again');
    });

    it('ignores unrelated envelopes', async () => {
      conn.cancelRemotePlayback();
      await sleep(RAMP_SETTLE_MS);
      conn.handleRemotePlaybackEnvelope({ type: 'listening' });
      conn.handleRemotePlaybackEnvelope({ type: 'transcript', text: 'hi' });
      conn.handleRemotePlaybackEnvelope(null);
      await sleep(RAMP_SETTLE_MS);
      assert.equal(el.volume, 0);
    });

    it('WATCHDOG: restores even if the envelope never arrives', async () => {
      // Old bridge, dropped data channel, teardown race — whatever the
      // reason, a muted output must heal itself.
      conn.cancelRemotePlayback();
      await sleep(RAMP_SETTLE_MS);
      assert.equal(el.volume, 0);
      await sleep(WATCHDOG_MS + RAMP_SETTLE_MS);
      assert.equal(
        el.volume, 1,
        'stuck muted with no restore envelope — this is the "one false ' +
        'barge kills TTS for the rest of the call" failure, reborn',
      );
    });

    it('repeated barges are idempotent and cannot postpone the watchdog', async () => {
      conn.cancelRemotePlayback();
      const t0 = Date.now();
      while (Date.now() - t0 < WATCHDOG_MS / 2) {
        await sleep(20);
        conn.cancelRemotePlayback();   // hammer it through half the window
      }
      assert.equal(el.volume, 0, 'still muted mid-window, as expected');
      // Now at t≈W/2. The watchdog armed at t=0 fires at t=W; a watchdog
      // re-armed by the LAST barge would not fire until t≈1.5W. Check in
      // between.
      await sleep(WATCHDOG_MS / 2 + RAMP_SETTLE_MS);
      assert.equal(
        el.volume, 1,
        'repeated barges kept pushing the watchdog out — the guard can be ' +
        'starved by exactly the event it guards against',
      );
    });

    it('a restore with no barge outstanding is a no-op, not an un-mute', async () => {
      conn.handleRemotePlaybackEnvelope({ type: 'tts-playing', active: false });
      await sleep(RAMP_SETTLE_MS);
      assert.equal(el.volume, 1);
    });

    it('teardown mid-ramp leaves the level restored, not stuck', async () => {
      conn.cancelRemotePlayback();
      // Interrupt while the ramp interval is still running.
      await sleep(5);
      conn.resetRemotePlaybackForTeardown();
      await sleep(RAMP_SETTLE_MS);
      assert.equal(
        el.volume, 1,
        'a call torn down mid-barge left its element ducked — a reconnect ' +
        'that reuses it comes back silent',
      );
    });
  });

  describe('Web Audio (iOS) gain path', () => {
    let gain: any;
    let el: any;
    beforeEach(() => {
      gain = fakeGainNode();
      el = fakeAudioEl();
      // Both bound: the gain node must win, and the element must be
      // left completely alone.
      conn.setRemotePlaybackTargetsForTests(el, gain, WATCHDOG_MS);
    });

    it('ducks via a scheduled AudioParam ramp, not the element', async () => {
      conn.cancelRemotePlayback();
      await sleep(RAMP_SETTLE_MS);
      assert.equal(gain.gain.value, 0);
      assert.ok(
        gain.calls.some((c: string) => c.startsWith('ramp(0)')),
        `expected a scheduled linear ramp to 0, got: ${gain.calls}`,
      );
      assert.equal(el.volume, 1, 'the <audio> element must not be touched on the Web Audio path');
    });

    it('restores the gain for the next reply', async () => {
      conn.cancelRemotePlayback();
      await sleep(RAMP_SETTLE_MS);
      conn.handleRemotePlaybackEnvelope({ type: 'tts-playing', active: false });
      await sleep(RAMP_SETTLE_MS);
      assert.equal(gain.gain.value, 1);
      assert.equal(conn.getRemotePlaybackLevel(), 1);
    });

    it('WATCHDOG covers the gain path too', async () => {
      conn.cancelRemotePlayback();
      await sleep(RAMP_SETTLE_MS);
      assert.equal(gain.gain.value, 0);
      await sleep(WATCHDOG_MS + RAMP_SETTLE_MS);
      assert.equal(gain.gain.value, 1);
    });
  });

  describe('no call up', () => {
    it('is a silent no-op with nothing bound', async () => {
      conn.setRemotePlaybackTargetsForTests(null, null, WATCHDOG_MS);
      conn.cancelRemotePlayback();       // must not throw
      conn.handleRemotePlaybackEnvelope({ type: 'tts-playing', active: false });
      conn.resetRemotePlaybackForTeardown();
      assert.equal(conn.getRemotePlaybackLevel(), 1);
    });
  });
});
