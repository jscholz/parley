// #197 realtime warmup: mic acquisition runs in PARALLEL with
// signaling/ICE instead of serially before it.
//
//   - open() kicks off getUserMedia un-awaited, creates the
//     RTCPeerConnection immediately with addTransceiver('audio',
//     sendrecv) (no track yet), and lets the offer POST + ICE proceed
//     while the mic prompt is still up.
//   - When the mic resolves it attaches via sender.replaceTrack().
//   - Data-channel envelope delivery is HELD until the mic attaches —
//     otherwise an ICE-wins race would chime "listening" while the
//     user is still staring at a permission prompt, silently eating
//     whatever they say.
//   - If ICE won the race, 'connected' is re-emitted after mic attach
//     so controls starts the barge loop with the real stream.
//   - Mic rejection tears down cleanly ('failed' + setup-failed close)
//     and a torn-down call releases a late-resolving mic (no leak that
//     would wedge the NEXT call's acquire).
//
// Test plan (mocked): gate navigator.mediaDevices.getUserMedia behind a
// test-controlled deferred so the mic "prompt" stays pending while we
// assert on the signaling side; FakePC stands in for RTCPeerConnection.
//
//   Phase 1 — parallel happy path (ICE wins the race):
//     open → assert offer POSTed while mic still pending → drive
//     connected → inject downstream {type:'listening'} → assert HELD
//     (no chime) → release mic → assert replaceTrack(track), envelope
//     flushed (chime fires), and the barge loop works (re-emitted
//     'connected' handed controls the mic stream).
//   Phase 2 — mic rejection: open with getUserMedia rejecting →
//     assert state walks to 'failed' and the call closes.
//   Phase 3 — teardown while mic pending: open, hang up with the mic
//     still pending, then resolve it → late stream must be released.
//   Phase 4 — leak probe: a fresh open with an instant mic must
//     acquire + attach cleanly (would fail with "mic busy" if phase
//     2/3 leaked the capture mutex).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'realtime-parallel-mic-warmup';
export const DESCRIPTION = 'getUserMedia runs parallel to signaling: offer POSTs before mic resolves; dc envelopes held until replaceTrack; barge gets the late mic; rejection + teardown release cleanly';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));

  await page.addInitScript(() => {
    /** Ordered event trace — single array so cross-source ordering is comparable. */
    (window).__TEST_EVENTS__ = [];
    (window).__TEST_FEEDBACK_LOG__ = [];
    (window).__TEST_FAKE_PC__ = null;
    /** 'gate' = hold until __TEST_RELEASE_MIC__(); 'reject' = NotAllowedError; 'pass' = resolve immediately. */
    (window).__TEST_MIC_MODE__ = 'gate';
    (window).__TEST_RELEASE_MIC__ = null;

    const ev = (e) => (window).__TEST_EVENTS__.push(e);

    const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      const mode = (window).__TEST_MIC_MODE__;
      ev(`mic-requested:${mode}`);
      if (mode === 'reject') {
        const err = new Error('Permission denied (test)');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      if (mode === 'pass') {
        return realGUM(constraints).then((s) => { ev('mic-resolved'); return s; });
      }
      return new Promise((resolve, reject) => {
        (window).__TEST_RELEASE_MIC__ = () => {
          (window).__TEST_RELEASE_MIC__ = null;
          realGUM(constraints).then((s) => { ev('mic-resolved'); resolve(s); }, reject);
        };
      });
    };

    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/rtc/offer')) ev('offer-posted');
      } catch { /* trace is best-effort */ }
      return realFetch(input, init);
    };

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
      addTransceiver() {
        return {
          direction: 'sendrecv',
          sender: {
            replaceTrack: async (t) => { ev(`replaceTrack:${t ? 'track' : 'null'}`); },
          },
        };
      }
      createDataChannel(label) {
        const dc = new EventTarget();
        dc.readyState = 'open';
        dc.label = label;
        dc.send = () => {};
        dc.close = () => { dc.readyState = 'closed'; };
        queueMicrotask(() => {
          try { dc.dispatchEvent(new Event('open')); } catch { /* ignore */ }
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
  await page.evaluate(async () => {
    const det = await import('/build/audio/shared/bargeDetector.mjs');
    det.setSpeechActiveOverrideForTests(() => !!(window).__TEST_SPEECH_ACTIVE__);
  });
  await page.evaluate(async () => {
    const platform = await import('/build/audio/shared/platform.mjs');
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    platform.primeAudio(audio);
  });

  const events = async () => page.evaluate(() => ((window)).__TEST_EVENTS__.slice());
  const feedback = async () => page.evaluate(() => ((window)).__TEST_FEEDBACK_LOG__.slice());
  const openCall = async () => page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.openCall('talk');
  });
  const closeCall = async () => page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.closeIfOpen();
  });
  const waitForEvent = async (name, timeout = 5_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const evs = await events();
      if (evs.includes(name)) return evs;
      await page.waitForTimeout(50);
    }
    throw new Error(`timed out waiting for event "${name}" — trace: ${JSON.stringify(await events())}`);
  };

  // ── Phase 1: parallel happy path, ICE wins the mic race ─────────────
  await openCall();

  let evs = await events();
  log(`phase1 post-open trace: ${JSON.stringify(evs)}`);
  assert(evs.some((e) => e.startsWith('mic-requested')), 'getUserMedia was never called');
  assert(evs.includes('offer-posted'),
    'offer never POSTed — open() should complete signaling while the mic is pending');
  assert(!evs.includes('mic-resolved'),
    'mic resolved before we released it — the gate is broken, parallelism unproven');
  assert(evs.indexOf('offer-posted') > evs.findIndex((e) => e.startsWith('mic-requested')),
    'getUserMedia should be kicked off before the offer POST');

  // ICE wins: drive connected while the mic is still pending.
  await page.evaluate(() => { (window).__TEST_FAKE_PC__._setConnectionState('connected'); });
  await page.waitForTimeout(100);

  // Bridge sends 'listening' while the mic is still ungranted → must be HELD.
  await page.evaluate(() => {
    const dc = (window).__TEST_FAKE_PC__._dataChannels[0];
    dc.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'listening' }) }));
  });
  await page.waitForTimeout(200);
  let fb = await feedback();
  assert(!fb.some((f) => f.type === 'listening'),
    `'listening' chime fired while the mic was still pending — envelope hold is broken: ${JSON.stringify(fb)}`);

  // Mic grant lands late.
  await page.evaluate(() => { (window).__TEST_RELEASE_MIC__(); });
  evs = await waitForEvent('replaceTrack:track');
  log(`phase1 post-attach trace: ${JSON.stringify(evs)}`);
  assert(evs.indexOf('replaceTrack:track') > evs.indexOf('mic-resolved'),
    'replaceTrack should follow mic resolution');

  // Held envelope flushed → chime now fires.
  const fbT0 = Date.now();
  let flushed = false;
  while (!flushed && Date.now() - fbT0 < 3_000) {
    fb = await feedback();
    flushed = fb.some((f) => f.type === 'listening');
    if (!flushed) await page.waitForTimeout(100);
  }
  assert(flushed, `held 'listening' envelope never flushed after mic attach: ${JSON.stringify(fb)}`);

  // Barge loop must have the late mic (re-emitted 'connected' path):
  // mark TTS playing AFTER the flush ('listening' clears ttsPlaying),
  // then drive speech-active and expect the barge chime.
  await page.evaluate(async () => {
    const suppress = await import('/build/audio/realtime/suppress.mjs');
    suppress.onAssistantDelta({ viaDataChannel: true });
    (window).__TEST_SPEECH_ACTIVE__ = true;
  });
  const bargeT0 = Date.now();
  let barged = false;
  while (!barged && Date.now() - bargeT0 < 3_000) {
    fb = await feedback();
    barged = fb.some((f) => f.type === 'barge');
    if (!barged) await page.waitForTimeout(100);
  }
  assert(barged,
    'barge never fired after the late mic attach — the re-emitted \'connected\' did not hand ' +
    `the stream to the barge loop: ${JSON.stringify(fb)}`);
  await page.evaluate(() => { (window).__TEST_SPEECH_ACTIVE__ = false; });
  await closeCall();
  log('phase 1 OK: offer ∥ mic, envelope hold + flush, late barge attach');

  // ── Phase 2: mic rejection tears down cleanly ────────────────────────
  consoleLines.length = 0;
  await page.evaluate(() => { (window).__TEST_MIC_MODE__ = 'reject'; });
  await openCall();
  const failT0 = Date.now();
  let sawFailed = false;
  while (!sawFailed && Date.now() - failT0 < 5_000) {
    sawFailed = consoleLines.some((l) => l.includes('state=') && l.includes('failed'));
    if (!sawFailed) await page.waitForTimeout(100);
  }
  assert(sawFailed, 'mic rejection did not walk the call to state=failed');
  const open = await page.evaluate(async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');
    return conn.isOpen();
  });
  assert(!open, 'call still open after mic rejection — setup-failed close did not run');
  log('phase 2 OK: rejection → failed + closed');

  // ── Phase 3: hang up while the mic is still pending ──────────────────
  await page.evaluate(() => { (window).__TEST_MIC_MODE__ = 'gate'; });
  await openCall();
  await closeCall();
  await page.evaluate(() => { (window).__TEST_RELEASE_MIC__(); });
  await waitForEvent('mic-resolved');
  await page.waitForTimeout(200);
  log('phase 3 OK: teardown with pending mic, late stream resolved post-close');

  // ── Phase 4: leak probe — fresh call must acquire instantly ──────────
  await page.evaluate(() => {
    (window).__TEST_MIC_MODE__ = 'pass';
    (window).__TEST_EVENTS__.length = 0;
  });
  await openCall();
  await page.evaluate(() => { (window).__TEST_FAKE_PC__._setConnectionState('connected'); });
  evs = await waitForEvent('replaceTrack:track');
  log(`phase4 trace: ${JSON.stringify(evs)}`);
  await closeCall();
  await page.evaluate(async () => {
    const det = await import('/build/audio/shared/bargeDetector.mjs');
    det.setSpeechActiveOverrideForTests(null);
  });
  log('phase 4 OK: no capture-mutex leak from rejection/teardown phases');
}
