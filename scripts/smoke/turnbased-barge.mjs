// Lock in BargeDetector parity between realtime and turnbased modes.
//
// turnbased.ts builds a BargeDetector via startBargeLoop() the moment
// notifyReplyPlayback(true) flips state to 'playing'. The detector
// reads speechVad.isSpeechActive() per tick and invokes opts.onBarge
// on fire. KEEPS the realtime smoke + this turnbased smoke as parallel
// guards: any divergence in the two call sites' detector lifecycle
// (e.g. someone reintroduces a parallel BargeWindow path) trips one
// scenario but not the other.
//
// Test plan (mocked):
//   1. listenSttEngine='silence-only' so we don't drag in Web Speech
//      sendword detection (irrelevant to barge, adds noise).
//   2. Override speechVad.isSpeechActive() via the bargeDetector test
//      seam, gated on a window flag.
//   3. Stub the vad-web library so speechVad.start/stop don't try to
//      load real WASM.
//   4. Call turnbased.start({onBarge: incCounter}) → state='armed'.
//   5. Call turnbased.notifyReplyPlayback(true) → state='playing',
//      BargeDetector running.
//   6. Flip __TEST_SPEECH_ACTIVE__=true; assert opts.onBarge fires
//      within ~1.5s (warmup + a few ticks).
//   7. Call notifyReplyPlayback(false) → cooldown → re-armed; assert
//      bargeDetector torn down (vad destroy fired).
//
// Latency sentinel: <1s for arm, <1.5s for fire (same budget as
// realtime — arch is identical).

import { waitForReady, pollUntil, assert, assertMicGateReleased } from './lib.mjs';

export const NAME = 'turnbased-barge';
export const DESCRIPTION = 'BargeDetector fires in turnbased mode (parity with realtime)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await page.addInitScript(() => {
    (window).__TEST_SPEECH_ACTIVE__ = false;
    (window).__TEST_BARGE_FIRES__ = 0;
    (window).__TEST_FEEDBACK_LOG__ = [];
    (window).__TEST_VAD_STARTS__ = 0;
    (window).__TEST_VAD_DESTROYS__ = 0;
  });

  await page.route('**/api/parley/config/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await waitForReady(page);

  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('bargeIn', true);
    settings.set('listenSttEngine', 'silence-only');  // no sendword
    settings.set('silenceSec', 60);  // long silence so the recorder doesn't auto-commit during the test
  });

  await page.evaluate(async () => {
    const det = await import('/build/audio/shared/bargeDetector.mjs');
    det.setSpeechActiveOverrideForTests(() => !!(window).__TEST_SPEECH_ACTIVE__);
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    vad.setVadLibForTests({
      MicVAD: {
        async new(_opts) {
          (window).__TEST_VAD_STARTS__++;
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

  // ── Start Listen (turnbased) — no UI bar, no sendword ────────────────
  const t0 = Date.now();
  await page.evaluate(async () => {
    const tb = await import('/build/audio/turn-based/turnbased.mjs');
    await tb.start({
      onCommit: async () => {},
      onBarge: () => { (window).__TEST_BARGE_FIRES__++; },
      barContainer: null,
    });
  });
  // Wait for state='armed' (silence loop running, mic + analyser up).
  await pollUntil(page, async () => {
    const tb = await import('/build/audio/turn-based/turnbased.mjs');
    return tb.getState() === 'armed';
  }, null, { timeout: 5_000, polling: 50, label: "turnbased never reached state 'armed'" });
  const armMs = Date.now() - t0;
  log(`arm latency: ${armMs}ms`);

  // ── Drive to playing state — BargeDetector starts here ──────────────
  await page.evaluate(async () => {
    const tb = await import('/build/audio/turn-based/turnbased.mjs');
    tb.notifyReplyPlayback(true);
  });
  await pollUntil(page, async () => {
    const tb = await import('/build/audio/turn-based/turnbased.mjs');
    return tb.getState() === 'playing';
  }, null, { timeout: 2_000, polling: 50, label: "turnbased never reached state 'playing'" });

  // ── Fire ────────────────────────────────────────────────────────────
  await page.evaluate(() => { (window).__TEST_SPEECH_ACTIVE__ = true; });
  const fireStart = Date.now();
  let fired = false;
  while (!fired && Date.now() - fireStart < 3_000) {
    fired = await page.evaluate(() => (window).__TEST_BARGE_FIRES__ > 0);
    if (!fired) await page.waitForTimeout(100);
  }
  const fireMs = Date.now() - fireStart;
  log(`barge fire latency: ${fireMs}ms`);

  // ── Stop playback (barge teardown) ───────────────────────────────────
  await page.evaluate(async () => {
    (window).__TEST_SPEECH_ACTIVE__ = false;
    const tb = await import('/build/audio/turn-based/turnbased.mjs');
    tb.notifyReplyPlayback(false);
  });
  // Allow BargeDetector.stop()'s async speechVad.stop a beat.
  await page.waitForTimeout(150);

  const fires = await page.evaluate(() => (window).__TEST_BARGE_FIRES__);
  const feedback = await page.evaluate(() => (window).__TEST_FEEDBACK_LOG__.slice());
  const vadStarts = await page.evaluate(() => (window).__TEST_VAD_STARTS__);
  const vadDestroys = await page.evaluate(() => (window).__TEST_VAD_DESTROYS__);
  log(`fires=${fires} feedback=${JSON.stringify(feedback)} vad-starts=${vadStarts} vad-destroys=${vadDestroys}`);

  // Teardown.
  await page.evaluate(async () => {
    const tb = await import('/build/audio/turn-based/turnbased.mjs');
    tb.cancel();
    const det = await import('/build/audio/shared/bargeDetector.mjs');
    det.setSpeechActiveOverrideForTests(null);
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    vad.setVadLibForTests(null);
  });

  // ── Assertions ───────────────────────────────────────────────────────
  assert(
    fires >= 1,
    `expected onBarge to fire >= 1 time, got ${fires}. ` +
    'turnbased BargeDetector did not fire. Confirm turnbased.startBargeLoop() ' +
    'is wired in notifyReplyPlayback(true).',
  );
  assert(
    feedback.some((f) => f.type === 'barge'),
    `expected playFeedback('barge') in feedback log; got ${JSON.stringify(feedback)}`,
  );
  assert(
    vadStarts >= 1,
    `expected >= 1 VAD start (BargeDetector starts speechVad on play), got ${vadStarts}`,
  );
  assert(
    vadDestroys >= 1,
    `expected >= 1 VAD destroy after notifyReplyPlayback(false), got ${vadDestroys} — ` +
    'BargeDetector.stop() may not be calling speechVad.stop on tear-down.',
  );
  assert(
    armMs < 1_000,
    `arm ${armMs}ms > 1s sentinel — recorder bring-up should be near-instant`,
  );
  assert(
    fireMs < 1_500,
    `fire ${fireMs}ms > 1.5s — expected ~600ms (500ms warmup + ticks)`,
  );

  // Shared suppression invariant — a barge that halts playback must
  // also release the mic gate (after the 1.5s speaker-drain grace),
  // or the user's post-barge speech goes nowhere.
  const gateMs = await assertMicGateReleased(page, 'turnbased barge + teardown');
  log(`mic gate released (${gateMs}ms)`);

  log(`turnbased barge: arm=${armMs}ms fire=${fireMs}ms fires=${fires} clean teardown`);
}
