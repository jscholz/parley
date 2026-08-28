// Pin the de5b48f fix: cancelRemotePlayback() MUST NOT detach the
// remote-track <audio>'s srcObject.
//
// Pre-fix it called audio.pause() + audio.srcObject = null, which
// permanently unbound the element from the peer track (ontrack only
// fires once at session setup — nothing rebinds later). One false
// barge therefore silenced TTS for the rest of the call.
//
// 2026-08-28: cancelRemotePlayback() is no longer a no-op. Jonathan
// asked for the cut to be audible — "everything before the barge is
// detected will be discarded, but everything immediately afterwards
// will be captured" — so it now ramps the remote output to silence over
// 25 ms. That makes THIS smoke more important, not less: the whole
// point is that it mutes rather than unbinds. Both halves are asserted
// below, in a real browser against a real <audio> element:
//
//   1. srcObject and paused are untouched (the de5b48f guarantee), and
//   2. the output actually goes silent, and
//   3. it comes BACK — a barge may never cost the user every subsequent
//      reply. The bridge's {type:'tts-playing', active:false} is the
//      restore signal.
//
// The exhaustive lifecycle (watchdog, repeated barges, teardown
// mid-ramp, the iOS gain path) lives in test/realtime-barge-duck.test.ts;
// this smoke is the real-DOM end of it.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'webrtc-barge-keeps-srcobject';
export const DESCRIPTION = 'barge mutes the remote <audio> output (and restores it) WITHOUT unbinding srcObject';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await waitForReady(page);

  const result = await page.evaluate(async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');

    // Build a fake remote-track <audio> element + sentinel stream,
    // mirroring the binding established inside connection.ts ontrack.
    const audio = document.createElement('audio');
    audio.autoplay = true;
    document.body.appendChild(audio);

    // A real MediaStream is the simplest sentinel — the production
    // path stores `ev.streams[0]`, a MediaStream. If audio.srcObject
    // is reassigned to null the identity check below fails.
    const sentinel = new MediaStream();
    audio.srcObject = sentinel;
    // We don't actually call play() — the test is purely about the
    // srcObject binding survival under cancelRemotePlayback().
    const wasPaused = audio.paused;

    // Bind this element as the duck's playback target, standing in for
    // the ontrack <audio>-fallback route.
    conn.setRemotePlaybackTargetsForTests(audio, null);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Fire the function under test.
    let threw = null;
    try { conn.cancelRemotePlayback(); }
    catch (e) { threw = String(e?.message || e); }
    await sleep(120);   // >> DUCK_RAMP_MS (25)

    const mutedState = {
      volume: audio.volume,
      level: conn.getRemotePlaybackLevel(),
      srcObjectStillSentinel: audio.srcObject === sentinel,
      srcObjectIsNull: audio.srcObject === null,
      pausedAfter: audio.paused,
    };

    // The bridge's restore signal for the next reply round.
    conn.handleRemotePlaybackEnvelope({ type: 'tts-playing', active: false });
    await sleep(120);
    const restoredVolume = audio.volume;

    conn.setRemotePlaybackTargetsForTests(null, null);

    return { threw, wasPaused, ...mutedState, restoredVolume };
  });

  log(`cancelRemotePlayback result: ${JSON.stringify(result)}`);

  assert(result.threw === null, `cancelRemotePlayback threw: ${result.threw}`);
  assert(
    !result.srcObjectIsNull,
    'cancelRemotePlayback nulled audio.srcObject — this is the regressed pre-fix behaviour that killed TTS for the rest of the call',
  );
  assert(
    result.srcObjectStillSentinel,
    'cancelRemotePlayback replaced audio.srcObject with a different value (expected: untouched)',
  );
  // The pause-state flip was the OTHER half of the pre-fix logic.
  assert(
    result.pausedAfter === result.wasPaused,
    `cancelRemotePlayback flipped audio.paused (was ${result.wasPaused}, now ${result.pausedAfter})`,
  );
  log('cancelRemotePlayback() leaves the <audio> binding + paused state intact ✓');

  // …and it DOES cut the audio, which is the point of the barge.
  assert(
    result.volume === 0 && result.level === 0,
    `barge did not silence the remote output (volume=${result.volume}, level=${result.level}) — the agent talks through the interruption and keeps feeding the mic`,
  );
  log('barge mutes the remote output ✓');

  assert(
    result.restoredVolume === 1,
    `remote output stayed muted at ${result.restoredVolume} after tts-playing:false — every subsequent reply would be silent for the rest of the call`,
  );
  log('remote output is restored for the next reply round ✓');
}
