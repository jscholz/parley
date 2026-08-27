// Scenario: the REAL Silero VAD detects real speech and fires a barge.
//
// realtime-barge-client-side (the sibling mocked smoke) locks in the
// barge ARCHITECTURE — client-side fire, upstream envelope, no bridge
// initiation — but it swaps speechVad's read for a window-flag override
// (`setSpeechActiveOverrideForTests`), so it NEVER runs the real Silero
// WASM + AudioWorklet stack against real audio. That override is exactly
// what would mask a regression where barge stops working in realtime. If
// the real VAD path is wired wrong — model fails to prefetch, AudioWorklet
// never sees mic frames, isSpeechActive() is stuck false — the
// override-based test stays green while the product is broken.
//
// This is the teeth: NO override. barge-speech.wav (~8s of sustained
// counting) is injected into getUserMedia via the audio browser, the
// REAL speechVad consumes it, and we assert the real BargeDetector loop
// sends an upstream {type:'barge'} on the data channel.
//
// The WebRTC signalling + peer connection are still stubbed (FakePC) —
// we're testing the client-side VAD→barge path, not the bridge/agent,
// so this needs no Deepgram key and runs in the default suite as
// always-green armour. The Silero ONNX model is served from the local
// build (:3001), so no external fetch.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'realtime-barge-real-vad';
export const DESCRIPTION = 'real Silero VAD on injected speech fires client-side barge (upstream envelope) — the path the override-based smoke stubs out';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const AUDIO_FIXTURE = 'barge-speech.wav';

export default async function run({ page, log, mock }) {
  // FakePC + dc-send capture, identical to realtime-barge-client-side —
  // we stub the transport but NOT the detector.
  await page.addInitScript(() => {
    (window).__TEST_DC_SENDS__ = [];
    (window).__TEST_FAKE_PC__ = null;
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
      createDataChannel(label) {
        const dc = new EventTarget();
        dc.readyState = 'open';
        dc.label = label;
        dc.send = (payload) => {
          (window).__TEST_DC_SENDS__.push(typeof payload === 'string' ? payload : '<binary>');
        };
        dc.close = () => { dc.readyState = 'closed'; };
        queueMicrotask(() => { try { dc.dispatchEvent(new Event('open')); } catch {} });
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
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ peer_id: 'fake-peer-id', sdp: 'v=0\r\n(fake answer)\r\n', type: 'answer' }),
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

  // Prime the shared AudioContext (matches the production gesture bind).
  // The real speechVad pulls frames from getUserMedia, which the audio
  // browser has wired to barge-speech.wav.
  await page.evaluate(async () => {
    const platform = await import('/build/audio/shared/platform.mjs');
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    platform.primeAudio(audio);
  });

  // Open a talk-mode call → the controls.ts state listener starts
  // realtimeBarge on connectionstate='connected'.
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    try { await controls.openCall('talk'); }
    catch (e) { (window).__TEST_OPEN_ERR__ = String(e?.message || e); }
  });
  await page.waitForFunction(() => !!(window).__TEST_FAKE_PC__, null, { timeout: 5_000 });
  await page.evaluate(() => { (window).__TEST_FAKE_PC__._setConnectionState('connected'); });
  log('talk call connected (FakePC); real VAD loop running');

  // Mark TTS "playing" so the BargeDetector loop ticks (it only consults
  // the VAD while suppress.isTtsPlaying() is true — the real gate). Keep
  // re-asserting it: a stray reply/ended event could clear the flag, and
  // the looping fixture gives the VAD plenty of runway.
  await page.evaluate(async () => {
    const suppress = await import('/build/audio/realtime/suppress.mjs');
    suppress.onAssistantDelta({ viaDataChannel: true });
  });

  const bargeSent = async () => page.evaluate(() => {
    return (window).__TEST_DC_SENDS__.some((s) => {
      try { return JSON.parse(s)?.type === 'barge'; } catch { return false; }
    });
  });

  // Real VAD: ~500ms warmup + model latency + speech onset. The fixture
  // is ~8s of sustained speech (and loops), so 15s is ample. If this
  // times out, the real VAD path is broken.
  let fired = false;
  const t0 = Date.now();
  while (!fired && Date.now() - t0 < 15_000) {
    await page.evaluate(async () => {
      const suppress = await import('/build/audio/realtime/suppress.mjs');
      suppress.onAssistantDelta({ viaDataChannel: true });
    });
    fired = await bargeSent();
    if (!fired) await page.waitForTimeout(250);
  }
  const fireMs = Date.now() - t0;
  log(`real-VAD barge fire latency: ${fireMs}ms`);

  const sends = await page.evaluate(() => (window).__TEST_DC_SENDS__.slice());

  // Tear down before asserting so a fail doesn't leak the call/VAD into
  // later scenarios in the shared context.
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    try { await controls.closeIfOpen(); } catch {}
  });

  assert(fired,
    'real Silero VAD never fired a barge on ~8s of injected speech within 15s — '
    + 'the client-side VAD→barge path is broken (the "barge didn\'t work in realtime" bug). '
    + `data-channel sends seen: ${JSON.stringify(sends)}`);

  assert(mock.chatCount() === 0,
    `mock backend unexpectedly populated (chatCount=${mock.chatCount()})`);

  log(`PASS: real Silero VAD detected injected speech and fired upstream barge in ${fireMs}ms`);
}
