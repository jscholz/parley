// Lock in the v0.422→v0.424 lifecycle fix: barge must fire on EVERY
// connect cycle, not just the first.
//
// The bug: speechVad's old refcount path reused a single MicVAD across
// callers, but each WebRTC call lifecycle creates a NEW micStream. After
// the first call closed, the refcount didn't drop to zero (BargeDetector
// awaited speechVad.start before flipping its "started" flag, so a
// hangup-during-warmup left the inner activeVad bound to the killed
// stream). The second call's `start()` saw a positive refcount → reused
// the dead activeVad → MicVAD read silent frames forever → vad=silent.
//
// Fix shape (see bargeDetector.ts vadStartCalled docstring):
//   - BargeDetector flips vadStartCalled the moment it INVOKES
//     speechVad.start, not when it resolves. stop() always calls
//     speechVad.stop() if vadStartCalled was ever true.
//   - speechVad.start now compares micStream identity and tears down a
//     stale activeVad before constructing a new one (belt-and-braces).
//
// Test plan (mocked):
//   1. Stub RTCPeerConnection (FakePC) + the speech-active override.
//   2. Stub the vad-web library so speechVad.start/stop mutate a counter.
//   3. Run THREE open→fire→close cycles back-to-back. Each cycle:
//      - openCall('talk'); drive PC to 'connected'.
//      - flip __TEST_SPEECH_ACTIVE__=true; assert upstream {type:'barge'}
//        appears for THIS cycle (count rises by exactly 1).
//      - flip false; closeIfOpen.
//      - assert speechVad-stub destroy count incremented (proves stop()
//        actually called speechVad.stop, not just the BargeDetector loop).
//   4. After 3 cycles: 3 barge sends, 3 destroy calls, no leaked state.

import { assert, DEFAULT_URL } from './lib.mjs';

export const NAME = 'realtime-barge-multi-connect';
export const DESCRIPTION = 'BargeDetector fires on every cycle of open/fire/close (guards v0.422 stale-stream bug)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CYCLES = 3;

export default async function run({ page, log }) {
  await page.addInitScript(() => {
    (window).__TEST_DC_SENDS__ = [];
    (window).__TEST_SPEECH_ACTIVE__ = false;
    (window).__TEST_FEEDBACK_LOG__ = [];
    (window).__TEST_FAKE_PC__ = null;
    (window).__TEST_VAD_STARTS__ = 0;
    (window).__TEST_VAD_DESTROYS__ = 0;

    class FakePC extends EventTarget {
      constructor() {
        super();
        this.localDescription = null;
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this._dataChannels = [];
        (window).__TEST_FAKE_PC__ = this;
      }
      addTrack() {}
      // realtime.ts uses addTransceiver (not addTrack) so the mic can be
      // attached later via sender.replaceTrack (#197 parallel warmup).
      addTransceiver() {
        return { direction: 'sendrecv', sender: { replaceTrack: async () => {} } };
      }
      createDataChannel(_label) {
        const dc = new EventTarget();
        dc.readyState = 'open';
        dc.label = _label;
        dc.send = (payload) => {
          (window).__TEST_DC_SENDS__.push(
            typeof payload === 'string' ? payload : '<binary>',
          );
        };
        dc.close = () => { dc.readyState = 'closed'; };
        queueMicrotask(() => {
          try { dc.dispatchEvent(new Event('open')); } catch {}
        });
        this._dataChannels.push(dc);
        return dc;
      }
      async createOffer() { return { sdp: 'v=0\r\n(fake offer)\r\n', type: 'offer' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription() {}
      close() { this.connectionState = 'closed'; }
      _setConnectionState(s) {
        this.connectionState = s;
        this.dispatchEvent(new Event('connectionstatechange'));
      }
    }
    (window).RTCPeerConnection = FakePC;
  });

  await page.route('**/api/rtc/offer', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        peer_id: 'fake-peer-id',
        sdp: 'v=0\r\n(fake answer)\r\n',
        type: 'answer',
      }),
    });
  });
  await page.route('**/api/rtc/ice', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/rtc/close', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/parley/config/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  // Force the client-side VAD strategy so the speechVad stub below is on
  // the active code path. Default routing is per-device — non-iOS goes to
  // BridgeVadSource, which subscribes to data-channel envelopes and never
  // touches speechVad/MicVAD. The v0.422 bug this test pins is specific
  // to ClientSideVadSource's refcount/teardown path, so pin it here.
  await page.goto(`${DEFAULT_URL}/?vad=client&debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(
    () => /Connected/.test(document.body.innerText),
    null,
    { timeout: 15_000, polling: 250 },
  );

  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('bargeIn', true);
    settings.set('tts', true);
  });

  // Install both test seams: speech-active override on bargeDetector,
  // vad-web stub on speechVad. The vad-stub exposes start/destroy
  // counters so we can assert speechVad.stop() actually fires per close.
  await page.evaluate(async () => {
    const det = await import('/build/audio/shared/bargeDetector.mjs');
    det.setSpeechActiveOverrideForTests(() => !!(window).__TEST_SPEECH_ACTIVE__);
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    const stubLib = {
      MicVAD: {
        async new(_opts) {
          (window).__TEST_VAD_STARTS__++;
          // Return an instance whose destroy increments the counter.
          // No need to wire onSpeechStart — the BargeDetector reads from
          // our override, not the stub's events.
          return {
            destroy: async () => { (window).__TEST_VAD_DESTROYS__++; },
            pause: () => {},
            start: () => {},
          };
        },
      },
    };
    vad.setVadLibForTests(stubLib);
    // speechVad.start() requires a shared AudioContext; primeAudio does
    // that. We also pass an explicit ctx override to insulate against
    // platform.getSharedAudioCtx returning null in headless.
    const platform = await import('/build/audio/shared/platform.mjs');
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    platform.primeAudio(audio);
  });

  for (let i = 1; i <= CYCLES; i++) {
    const sendsBefore = await page.evaluate(() => (window).__TEST_DC_SENDS__.length);
    const destroysBefore = await page.evaluate(() => (window).__TEST_VAD_DESTROYS__);

    // ── Open ─────────────────────────────────────────────────────────
    const t0 = Date.now();
    await page.evaluate(async () => {
      const controls = await import('/build/audio/realtime/controls.mjs');
      try { await controls.openCall('talk'); }
      catch (e) { (window).__TEST_OPEN_ERR__ = String(e?.message || e); }
    });
    await page.waitForFunction(() => !!((window)).__TEST_FAKE_PC__, null, { timeout: 5_000 });
    await page.evaluate(() => {
      const pc = (window).__TEST_FAKE_PC__;
      pc._setConnectionState('connected');
    });
    const connectMs = Date.now() - t0;

    // Mark TTS playing for this cycle.
    await page.evaluate(async () => {
      const suppress = await import('/build/audio/realtime/suppress.mjs');
      suppress.onAssistantDelta({ viaDataChannel: true });
    });

    // ── Fire ─────────────────────────────────────────────────────────
    await page.evaluate(() => { (window).__TEST_SPEECH_ACTIVE__ = true; });
    const fireStart = Date.now();
    let bargeAppeared = false;
    while (!bargeAppeared && Date.now() - fireStart < 3_000) {
      bargeAppeared = await page.evaluate((before) => {
        const sends = ((window)).__TEST_DC_SENDS__;
        return sends.length > before
          && sends.slice(before).some((s) => {
            try { return JSON.parse(s)?.type === 'barge'; } catch { return false; }
          });
      }, sendsBefore);
      if (!bargeAppeared) await page.waitForTimeout(100);
    }
    const fireMs = Date.now() - fireStart;
    await page.evaluate(() => { (window).__TEST_SPEECH_ACTIVE__ = false; });

    // ── Close ────────────────────────────────────────────────────────
    const t2 = Date.now();
    await page.evaluate(async () => {
      const controls = await import('/build/audio/realtime/controls.mjs');
      // Reset the FakePC handle so the next iteration's openCall sees a
      // fresh target instead of the stale closed one.
      (window).__TEST_FAKE_PC__ = null;
      // Reset suppress so isTtsPlaying() returns false on the next cycle.
      const suppress = await import('/build/audio/realtime/suppress.mjs');
      suppress.reset();
      await controls.closeIfOpen();
    });
    const disconnectMs = Date.now() - t2;

    // Give BargeDetector.stop()'s async speechVad.stop a beat to land —
    // it's fire-and-forget from controls.ts's state listener.
    await page.waitForTimeout(100);

    const sendsAfter = await page.evaluate(() => (window).__TEST_DC_SENDS__.length);
    const destroysAfter = await page.evaluate(() => (window).__TEST_VAD_DESTROYS__);
    const cycleSends = sendsAfter - sendsBefore;
    const cycleDestroys = destroysAfter - destroysBefore;

    log(
      `cycle ${i}: connect=${connectMs}ms fire=${fireMs}ms ` +
      `disconnect=${disconnectMs}ms sends+=${cycleSends} destroys+=${cycleDestroys}`,
    );

    assert(
      bargeAppeared,
      `cycle ${i}: barge did not fire — guards the v0.422 stale-micStream ` +
      `bug. sends this cycle: ${cycleSends}`,
    );
    assert(
      cycleDestroys >= 1,
      `cycle ${i}: speechVad MicVAD destroy was not called on close ` +
      `(got +${cycleDestroys}). BargeDetector.stop() may not be awaiting ` +
      `vadStartCalled correctly.`,
    );
    assert(
      connectMs < 1_000,
      `cycle ${i}: connect ${connectMs}ms > 1s sentinel — investigate before device test`,
    );
    assert(
      disconnectMs < 1_000,
      `cycle ${i}: disconnect ${disconnectMs}ms > 1s sentinel`,
    );
    assert(
      fireMs < 1_500,
      `cycle ${i}: fire ${fireMs}ms > 1.5s — barge loop slowed down`,
    );
  }

  // Cleanup test seams.
  await page.evaluate(async () => {
    const det = await import('/build/audio/shared/bargeDetector.mjs');
    det.setSpeechActiveOverrideForTests(null);
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    vad.setVadLibForTests(null);
  });

  const totalStarts = await page.evaluate(() => (window).__TEST_VAD_STARTS__);
  const totalDestroys = await page.evaluate(() => (window).__TEST_VAD_DESTROYS__);
  log(`total: vad-starts=${totalStarts} vad-destroys=${totalDestroys}`);

  // VAD start count >= cycles (one per cycle); destroys >= cycles too.
  // Strict equality is brittle (a future double-stop is benign) but
  // both must be at least CYCLES.
  assert(
    totalStarts >= CYCLES,
    `expected >= ${CYCLES} VAD starts, got ${totalStarts}`,
  );
  assert(
    totalDestroys >= CYCLES,
    `expected >= ${CYCLES} VAD destroys, got ${totalDestroys} — ` +
    `stale activeVad would leak into the next call (the v0.422 bug shape)`,
  );

  log(`multi-connect: ${CYCLES} cycles, all fired barge, all teardown clean`);
}
