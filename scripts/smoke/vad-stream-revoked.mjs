// Lock in the VAD lifecycle invariant: when the mic stream's audio
// track ends mid-MicVAD-init, speechVad aborts fast (via track.onended
// → bumps startGen → resolved inst self-destructs). Without this, the
// 5s watchdog is the only safety net and we waste seconds dragging a
// dead-stream init to its timeout.
//
// Test plan (mocked):
//   1. Stub vad-web with a MicVAD.new that resolves after a 250ms
//      delay, simulating a slow cold-start.
//   2. Build a synthetic mic stream + audio track we can `.stop()`
//      programmatically. (Playwright Chromium's --use-fake-device
//      gives us getUserMedia; we stop the track to simulate hangup.)
//   3. Call speechVad.start(stream, ...).
//   4. After 50ms (well before MicVAD.new resolves), stop the audio
//      track. The stream-revoked path should fire onTrackEnded →
//      bump startGen → orphan the inst when it finally resolves.
//   5. Assert: vad-destroys count incremented (orphan was destroyed),
//      vad-active is null (no leaked activeVad), abort-to-cleanup
//      latency < 300ms (NOT the 5s watchdog).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'vad-stream-revoked';
export const DESCRIPTION = 'speechVad aborts fast when mic track ends mid-init (no watchdog, no leak)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await page.addInitScript(() => {
    (window).__TEST_VAD_STARTS__ = 0;
    (window).__TEST_VAD_DESTROYS__ = 0;
    (window).__TEST_VAD_RESOLVED_AT__ = 0;
  });

  await page.route('**/api/parley/config/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await waitForReady(page);

  // ── Install slow-resolve vad-web stub + prime AudioContext ──────────
  await page.evaluate(async () => {
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    vad.setVadLibForTests({
      MicVAD: {
        async new(_opts) {
          (window).__TEST_VAD_STARTS__++;
          // 250ms slow init — mirrors a cold-cache iPhone path. Long
          // enough that the test can stop() the track BEFORE this
          // resolves.
          await new Promise((r) => setTimeout(r, 250));
          (window).__TEST_VAD_RESOLVED_AT__ = performance.now();
          return {
            destroy: async () => { (window).__TEST_VAD_DESTROYS__++; },
            pause: () => {},
            start: () => {},
          };
        },
      },
    });
    const platform = await import('/build/audio/shared/platform.mjs');
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    platform.primeAudio(audio);
  });

  // ── Open a real mic stream, fire speechVad.start, then stop the track ─
  const result = await page.evaluate(async () => {
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    // --use-fake-device-for-media-stream provides a synthetic mic.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const t0 = performance.now();
    const startPromise = vad.start(stream, {});

    // Wait 50ms — well before the 250ms slow stub resolves — then end
    // the track. If our track-ended handler is wired correctly, this
    // bumps startGen and the resolved inst will destroy itself.
    await new Promise((r) => setTimeout(r, 50));
    const trackEndedAt = performance.now();
    stream.getAudioTracks()[0].stop();
    // Manually fire ended event — Chromium synthesizes one when track
    // is stopped programmatically, but timing isn't deterministic; this
    // makes the test robust.
    stream.getAudioTracks()[0].dispatchEvent(new Event('ended'));

    const startResult = await startPromise;
    const startReturnedAt = performance.now();

    // Tiny grace for the orphan-destroy to complete (the destroy is
    // awaited inside speechVad.start so it should be done by now).
    await new Promise((r) => setTimeout(r, 50));

    return {
      startResult,
      vadStarts: (window).__TEST_VAD_STARTS__,
      vadDestroys: (window).__TEST_VAD_DESTROYS__,
      micVadResolvedAt: (window).__TEST_VAD_RESOLVED_AT__,
      trackEndedAt,
      startReturnedAt,
      msFromTrackEndToStartReturn: Math.round(startReturnedAt - trackEndedAt),
      msFromCallStartToStartReturn: Math.round(startReturnedAt - t0),
    };
  });

  log(`speechVad.start returned: ${JSON.stringify(result, null, 2)}`);

  // ── Assertions ───────────────────────────────────────────────────────

  // (1) start() returned false (orphan path).
  assert(
    result.startResult === false,
    `expected speechVad.start to return false (orphan path), got ${result.startResult}`,
  );

  // (2) MicVAD.new fired exactly once (the slow-stub).
  assert(
    result.vadStarts === 1,
    `expected 1 MicVAD.new invocation, got ${result.vadStarts}`,
  );

  // (3) The resolved orphan inst was destroyed.
  assert(
    result.vadDestroys === 1,
    `expected 1 destroy call (orphan cleanup), got ${result.vadDestroys}`,
  );

  // (4) Total time from track-end to start() returning is bounded by
  // the slow-stub's resolve time (250ms remaining after the 50ms wait,
  // so ~200ms) — NOT the 5s watchdog. We accept up to 500ms total
  // (the await chain + microtask scheduling). Anything > 1s means
  // the watchdog fired, which means our track-ended handler didn't
  // wire correctly.
  assert(
    result.msFromTrackEndToStartReturn < 500,
    `track-end-to-start-return latency ${result.msFromTrackEndToStartReturn}ms exceeds 500ms — ` +
    'track.onended handler probably didn\'t fire. Check audioTrack.addEventListener("ended", …) ' +
    'in src/audio/shared/speechVad/index.ts.',
  );

  // (5) Total budget — start should complete in well under the 5s
  // watchdog (combining the 50ms hangup-delay + ~200ms remaining slow-
  // stub + cleanup).
  assert(
    result.msFromCallStartToStartReturn < 1_000,
    `total latency ${result.msFromCallStartToStartReturn}ms > 1s. Watchdog probably fired. ` +
    'Track-ended path is supposed to short-circuit the warmup.',
  );

  // Cleanup test seam.
  await page.evaluate(async () => {
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    vad.setVadLibForTests(null);
    vad.resetForTests();
  });

  log(
    `vad-stream-revoked: starts=${result.vadStarts} destroys=${result.vadDestroys} ` +
    `track-end→return=${result.msFromTrackEndToStartReturn}ms (clean teardown, no watchdog)`,
  );
}
