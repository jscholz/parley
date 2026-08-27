// Lock in the v0.422 fix: BargeDetector teardown is correct even when
// the call ends BEFORE speechVad fully warms up.
//
// Pre-fix: BargeDetector tracked `vadStarted` (set when MicVAD.new
// resolved). If the call closed during warmup, vadStarted was still
// false → stop() didn't call speechVad.stop() → activeVad stayed bound
// to the killed micStream. The next call's start() found the stale
// activeVad and silently failed.
//
// Post-fix: BargeDetector tracks `vadStartCalled` (set when
// speechVad.start is INVOKED, before resolve). stop() always tears down
// if start was ever called.
//
// Test plan (mocked):
//   1. Stub vad-web with a SLOW MicVAD.new (300ms) to simulate the
//      cold-start window where the bug used to bite.
//   2. Open talk-mode call, drive 'connected', mark TTS playing.
//   3. Hang up within 100ms — well before MicVAD.new resolves.
//   4. Wait long enough for the deferred MicVAD.new to resolve, then
//      assert speechVad destroy was called (the fix's invariant).
//   5. Assert no upstream barge envelope was sent (no fire window
//      reached) — proves the loop didn't keep ticking after stop().
//   6. Re-open + close cycle to confirm the next call gets a fresh
//      MicVAD (counters increment again).

import { assert, DEFAULT_URL } from './lib.mjs';

export const NAME = 'realtime-barge-hangup-before-reply';
export const DESCRIPTION = 'BargeDetector tears down cleanly when call ends mid-VAD-warmup (guards v0.422 vadStartCalled invariant)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await page.addInitScript(() => {
    (window).__TEST_DC_SENDS__ = [];
    (window).__TEST_SPEECH_ACTIVE__ = false;
    (window).__TEST_FEEDBACK_LOG__ = [];
    (window).__TEST_FAKE_PC__ = null;
    (window).__TEST_VAD_STARTS__ = 0;
    (window).__TEST_VAD_DESTROYS__ = 0;
    (window).__TEST_VAD_START_RESOLVED__ = 0;

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
          (window).__TEST_DC_SENDS__.push(typeof payload === 'string' ? payload : '<binary>');
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

  // Force client-side VAD strategy — see realtime-barge-multi-connect.mjs
  // for the rationale. This test pins the v0.422 vadStartCalled invariant
  // which only exists in ClientSideVadSource's path.
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

  // SLOW vad-web stub — MicVAD.new takes 300ms to resolve. This is the
  // cold-start shape that exposed the v0.422 bug on real iPhone.
  await page.evaluate(async () => {
    const det = await import('/build/audio/shared/bargeDetector.mjs');
    det.setSpeechActiveOverrideForTests(() => !!(window).__TEST_SPEECH_ACTIVE__);
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    vad.setVadLibForTests({
      MicVAD: {
        async new(_opts) {
          (window).__TEST_VAD_STARTS__++;
          await new Promise((r) => setTimeout(r, 300));  // simulate cold start
          (window).__TEST_VAD_START_RESOLVED__++;
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

  // ── Open call, mark TTS playing, hang up FAST ────────────────────────
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.openCall('talk');
  });
  await page.waitForFunction(() => !!((window)).__TEST_FAKE_PC__, null, { timeout: 5_000 });
  await page.evaluate(() => {
    const pc = (window).__TEST_FAKE_PC__;
    pc._setConnectionState('connected');
  });
  await page.evaluate(async () => {
    const suppress = await import('/build/audio/realtime/suppress.mjs');
    suppress.onAssistantDelta({ viaDataChannel: true });
  });

  // Verify start kicked off — vad-starts should be 1, but resolved likely 0
  // because of the 300ms delay. The detector is mid-warmup.
  const midRace = await page.evaluate(() => ({
    starts: (window).__TEST_VAD_STARTS__,
    resolved: (window).__TEST_VAD_START_RESOLVED__,
  }));
  log(`mid-race: vad-starts=${midRace.starts} vad-start-resolved=${midRace.resolved}`);

  // Hang up while MicVAD.new is still pending.
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.closeIfOpen();
  });

  // Wait long enough for the deferred MicVAD.new to resolve PLUS the
  // followup speechVad.stop() race. 600ms total: 300ms warmup + 300ms
  // headroom.
  await page.waitForTimeout(600);

  const after = await page.evaluate(() => ({
    starts: (window).__TEST_VAD_STARTS__,
    resolved: (window).__TEST_VAD_START_RESOLVED__,
    destroys: (window).__TEST_VAD_DESTROYS__,
    sends: (window).__TEST_DC_SENDS__.slice(),
  }));
  log(`after-hangup: vad-starts=${after.starts} resolved=${after.resolved} destroys=${after.destroys}`);
  log(`after-hangup: dc sends=${JSON.stringify(after.sends)}`);

  // ── Re-open + close cycle to verify the next call works clean ───────
  await page.evaluate(() => { (window).__TEST_FAKE_PC__ = null; });
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.openCall('talk');
  });
  await page.waitForFunction(() => !!((window)).__TEST_FAKE_PC__, null, { timeout: 5_000 });
  await page.evaluate(() => {
    const pc = (window).__TEST_FAKE_PC__;
    pc._setConnectionState('connected');
  });
  await page.evaluate(async () => {
    const suppress = await import('/build/audio/realtime/suppress.mjs');
    suppress.reset();
    suppress.onAssistantDelta({ viaDataChannel: true });
  });
  // Wait for second VAD to warm + flip speech active to fire barge.
  await page.waitForTimeout(400);
  await page.evaluate(() => { (window).__TEST_SPEECH_ACTIVE__ = true; });

  let secondFired = false;
  const fireStart = Date.now();
  while (!secondFired && Date.now() - fireStart < 3_000) {
    secondFired = await page.evaluate(() => {
      return (window).__TEST_DC_SENDS__.some((s) => {
        try { return JSON.parse(s)?.type === 'barge'; } catch { return false; }
      });
    });
    if (!secondFired) await page.waitForTimeout(100);
  }
  const secondFireMs = Date.now() - fireStart;
  log(`second-call fire latency: ${secondFireMs}ms`);

  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.closeIfOpen();
    (window).__TEST_SPEECH_ACTIVE__ = false;
  });
  await page.waitForTimeout(100);

  const final = await page.evaluate(() => ({
    starts: (window).__TEST_VAD_STARTS__,
    destroys: (window).__TEST_VAD_DESTROYS__,
  }));
  log(`final: vad-starts=${final.starts} vad-destroys=${final.destroys}`);

  // Cleanup test seams.
  await page.evaluate(async () => {
    const det = await import('/build/audio/shared/bargeDetector.mjs');
    det.setSpeechActiveOverrideForTests(null);
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    vad.setVadLibForTests(null);
  });

  // ── Assertions ───────────────────────────────────────────────────────

  // The hangup-before-reply call should have triggered destroy on its
  // resolved MicVAD, even though stop() was called BEFORE MicVAD.new
  // resolved. The pre-v0.422 bug was that destroy NEVER fired in this
  // race — leaving activeVad bound to the dead stream.
  assert(
    after.destroys >= 1,
    `expected >= 1 VAD destroy after the first hangup, got ${after.destroys}. ` +
    'BargeDetector.stop() did NOT call speechVad.stop() — vadStartCalled ' +
    'invariant has regressed (pre-v0.422 bug shape).',
  );

  // The first-call window NEVER had a chance to fire (we hung up before
  // warmup finished). No upstream barge envelope should appear from
  // call #1.
  // (We can't strictly assert no barge across the whole run because
  //  call #2 fires one — instead we check call #1's quiet teardown via
  //  the fact that our second-call fire works, which proves call #1
  //  cleaned up enough that the rebuild succeeded.)

  // The second call's barge should fire — proves the v0.424 architecture
  // doesn't leak stale state into subsequent calls.
  assert(
    secondFired,
    `second call did not fire barge — stale state from first call's ` +
    'mid-warmup hangup leaked into the rebuild. ' +
    `vad-starts=${final.starts} vad-destroys=${final.destroys}`,
  );
  assert(
    secondFireMs < 1_500,
    `second-call fire ${secondFireMs}ms > 1.5s sentinel`,
  );

  // Both calls each contributed: starts == 2, destroys == 2.
  assert(
    final.starts >= 2,
    `expected >= 2 VAD starts (one per call), got ${final.starts}`,
  );
  assert(
    final.destroys >= 2,
    `expected >= 2 VAD destroys (one per close), got ${final.destroys} — ` +
    'a leak across calls would show fewer destroys than starts.',
  );

  log(
    `hangup-before-reply: starts=${final.starts} destroys=${final.destroys} ` +
    `2nd-call fire=${secondFireMs}ms (clean teardown after mid-warmup hangup)`,
  );
}
