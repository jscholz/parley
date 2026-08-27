// Lock in the unified barge architecture (v0.424):
//
//   1. Realtime barge fires from the CLIENT side (PWA), via the shared
//      BargeDetector + speechVad.isSpeechActive() in bargeDetector.ts.
//   2. The bridge no longer initiates barges — it only RECEIVES the
//      upstream {type:'barge'} envelope and halts the TTS track.
//   3. BargeDetector replaced the BargeWindow + AnalyserNode peak-detect
//      path; Silero VAD is the sole discriminator. The setInterval loop
//      reads speechVad.isSpeechActive() per tick.
//
// Why a smoke for this: prevents future regression to the bridge-side
// VAD path. The architecture is intentionally one detector, one tuning,
// one set of bugs (see bargeDetector.ts module docstring) — a silent
// revert to the dual-detector world would be a real-bug magnet.
//
// Test plan (mocked):
//   1. Stub RTCPeerConnection so we can drive connectionstate
//      transitions manually and capture every data-channel send.
//   2. Use bargeDetector's `setSpeechActiveOverrideForTests` to swap
//      speechVad's read with a window-flag-driven function. Avoids
//      needing the real WebAssembly + AudioWorklet stack.
//   3. Open a talk-mode call via controls.openCall('talk'). The state-
//      listener in controls.ts wires realtimeBarge.start() on
//      connectionstate='connected'.
//   4. Drive connectionstate='connected' on the FakePC so the state
//      listener fires.
//   5. Mark TTS as playing by calling webrtcSuppress.onAssistantDelta()
//      — the barge loop only ticks while suppress.isTtsPlaying() is
//      true (mirrors real "TTS is producing audio" gate).
//   6. Flip __TEST_SPEECH_ACTIVE__=true; wait through warmup (500ms) +
//      a couple of frame ticks (~100ms).
//   7. Assert:
//      - data channel saw an UPSTREAM JSON.stringify({type:'barge'}) send.
//      - playFeedback was invoked with type='barge'.
//      - the mock backend NEVER pushed a downstream {type:'barge'}.
//      - openCall→connected took <1s (sentinel for accidental waits).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'realtime-barge-client-side';
export const DESCRIPTION = 'BargeDetector fires from speechVad signal; sends upstream {type:\'barge\'}; bridge does not initiate; <1s connect';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, mock }) {
  // ── Stub WebRTC + instrumentation hooks BEFORE the page boots ────────
  let bridgeInitiatedSeen = false;
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('server-side barge fired')) bridgeInitiatedSeen = true;
  });
  await page.addInitScript(() => {
    /** @type {string[]} Every dataChannel.send() payload (upstream). */
    (window).__TEST_DC_SENDS__ = [];
    /** Toggle: when true, the bargeDetector speech-active override returns true. */
    (window).__TEST_SPEECH_ACTIVE__ = false;
    /** Opt-in to feedback.ts's chime spy. */
    (window).__TEST_FEEDBACK_LOG__ = [];
    /** Per-FakePC handle so the test can flip state to 'connected'. */
    (window).__TEST_FAKE_PC__ = null;

    // FakePC — minimal stand-in for RTCPeerConnection.
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
      createDataChannel(_label, _opts) {
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

  // ── Mock the WebRTC signalling endpoints ─────────────────────────────
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

  await waitForReady(page);

  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('bargeIn', true);
    settings.set('tts', true);
  });

  // Install the speech-active override AFTER the page is ready (so the
  // module is loaded). The override swaps speechVad's read with a flag
  // pull, sidestepping the real Silero+WASM stack.
  await page.evaluate(async () => {
    const det = await import('/build/audio/shared/bargeDetector.mjs');
    det.setSpeechActiveOverrideForTests(() => !!(window).__TEST_SPEECH_ACTIVE__);
  });

  // Prime audio so the bargeDetector internals (which await speechVad's
  // shared AudioContext) don't bail. We're not exercising the worklet —
  // the override short-circuits before the VAD path is consulted — but
  // primeAudio is cheap and matches the production gesture-binding step.
  await page.evaluate(async () => {
    const platform = await import('/build/audio/shared/platform.mjs');
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    platform.primeAudio(audio);
  });

  // ── Open a talk-mode call + measure connect latency ──────────────────
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
  log(`connect latency (mocked): ${connectMs}ms`);

  // Mark TTS as "playing" so the BargeDetector's isPlayingCb returns true.
  // viaDataChannel: during a connected talk call the data channel owns
  // suppression arming (2026-08-26 post-reply wedge fix) — this simulates
  // the bridge's DC assistant envelope; bare SSE-style arming is ignored.
  await page.evaluate(async () => {
    const suppress = await import('/build/audio/realtime/suppress.mjs');
    suppress.onAssistantDelta({ viaDataChannel: true });
  });

  const before = await page.evaluate(() => ({
    sends: ((window)).__TEST_DC_SENDS__.slice(),
    feedback: ((window)).__TEST_FEEDBACK_LOG__.slice(),
  }));
  log(`pre-fire dc sends: ${JSON.stringify(before.sends)}`);
  log(`pre-fire feedback: ${JSON.stringify(before.feedback)}`);

  // ── Drive a synthetic speech-active signal ───────────────────────────
  // 500ms warmup + a couple of 50ms ticks. Wait ~1s for fire.
  await page.evaluate(() => { (window).__TEST_SPEECH_ACTIVE__ = true; });

  const dcSendCheck = async () => page.evaluate(() => {
    const sends = ((window)).__TEST_DC_SENDS__;
    return sends.find((s) => {
      try {
        const o = JSON.parse(s);
        return o && o.type === 'barge';
      } catch { return false; }
    }) || null;
  });

  let bargeSend = null;
  const fireStart = Date.now();
  while (!bargeSend && Date.now() - fireStart < 3_000) {
    bargeSend = await dcSendCheck();
    if (!bargeSend) await page.waitForTimeout(100);
  }
  const fireMs = Date.now() - fireStart;
  log(`barge fire latency from speech-active flip: ${fireMs}ms`);

  const after = await page.evaluate(() => ({
    sends: ((window)).__TEST_DC_SENDS__.slice(),
    feedback: ((window)).__TEST_FEEDBACK_LOG__.slice(),
  }));
  log(`post-fire dc sends: ${JSON.stringify(after.sends)}`);
  log(`post-fire feedback: ${JSON.stringify(after.feedback)}`);

  // ── Measure disconnect latency ───────────────────────────────────────
  const t2 = Date.now();
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.closeIfOpen();
  });
  const disconnectMs = Date.now() - t2;
  log(`disconnect latency (mocked): ${disconnectMs}ms`);

  // Clean up the test override so subsequent scenarios in the same browser
  // context don't see stale state.
  await page.evaluate(async () => {
    const det = await import('/build/audio/shared/bargeDetector.mjs');
    det.setSpeechActiveOverrideForTests(null);
  });

  // ── Assertions ───────────────────────────────────────────────────────

  assert(
    bargeSend !== null,
    'expected upstream {type:\'barge\'} on data channel within 3s — ' +
    `got sends: ${JSON.stringify(after.sends)}`,
  );

  const bargeChime = after.feedback.find((f) => f.type === 'barge');
  assert(
    !!bargeChime,
    'expected playFeedback(\'barge\') to fire in __TEST_FEEDBACK_LOG__; ' +
    `got: ${JSON.stringify(after.feedback)}`,
  );

  assert(
    !bridgeInitiatedSeen,
    'bridge-side barge fired — the downstream {type:\'barge\'} path should ' +
    'be retired post-unification. If this assertion regresses, the bridge ' +
    'VAD path has been revived.',
  );

  // Timing sentinels: local headless should be <1s; >1s indicates an
  // accidental sleep/wait, network call gone unmocked, or aioice-style
  // ICE stall in a future stub. NOT a real-hardware latency budget —
  // those are measured on device.
  assert(
    connectMs < 1_000,
    `connect latency ${connectMs}ms > 1s — locally-mocked open should be near-instant. ` +
    'Investigate before relying on this number on device.',
  );
  assert(
    disconnectMs < 1_000,
    `disconnect latency ${disconnectMs}ms > 1s — locally-mocked close should be near-instant.`,
  );
  assert(
    fireMs < 1_500,
    `barge fire latency ${fireMs}ms > 1.5s — expected ~600ms (500ms warmup + a few ticks). ` +
    'Investigate the BargeDetector loop cadence or warmup window.',
  );

  assert(
    mock.chatCount() === 0,
    `mock backend was unexpectedly populated (chatCount=${mock.chatCount()})`,
  );

  log(
    `realtime barge: client-side fire OK | upstream envelope OK | chime OK | ` +
    `bridge-initiated path NOT triggered OK | connect=${connectMs}ms ` +
    `disconnect=${disconnectMs}ms fire=${fireMs}ms`,
  );
}
