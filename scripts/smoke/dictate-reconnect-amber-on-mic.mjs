// Field nit (2026-06-12): during realtime dictation a low-network soft
// recovery flashed the CALL button (left of composer) amber while the red
// mic button (right) — the one the user actually tapped — stayed
// untouched. The reconnecting visual must follow the button that owns the
// call: btn-mic for mic-initiated dictation, btn-call for calls.
//
// Fix under test: controls.ts routes the `reconnecting` class via
// opts.isMicOwnedCall() (main.ts passes `() => dictateActive`).
//
// Test plan (mocked, FakePC pattern from webrtc-reconnect-after-failure):
//   1. Stub RTCPeerConnection + /api/rtc/* so we can drive
//      connectionState transitions.
//   2. Dictate-owned: settings dictateRealtime=true + streamingEngine=
//      server, __micDispatch('tap') opens the peer → drive connected →
//      drive failed → assert .reconnecting lands on #btn-mic and NOT on
//      #btn-call → recover → class clears.
//   3. Call-owned (inverse pin): controls.openCall('stream') → drive
//      failed → assert .reconnecting on #btn-call and NOT on #btn-mic.
//
// NOTE: do NOT call conn.setStateListener here — it's a single slot and
// would displace the controls.ts listener that toggles the classes under
// test. All observation is via the buttons' classLists.

import { waitForReady, resetServerSettings, assert, pollUntil } from './lib.mjs';

export const NAME = 'dictate-reconnect-amber-on-mic';
export const DESCRIPTION = 'soft-recovery amber pulse lands on the mic button for dictation-owned calls, on the call button for calls';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  // ── Stub WebRTC BEFORE the page boots ────────────────────────────────
  await page.addInitScript(() => {
    (window).__TEST_FAKE_PCS__ = [];
    class FakePC extends EventTarget {
      constructor() {
        super();
        this.localDescription = null;
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        (window).__TEST_FAKE_PCS__.push(this);
      }
      addTrack() {}
      addTransceiver() {
        return { direction: 'sendrecv', sender: { replaceTrack: async () => {} } };
      }
      createDataChannel(label) {
        const dc = new EventTarget();
        dc.readyState = 'open';
        dc.label = label;
        dc.send = () => {};
        dc.close = () => { dc.readyState = 'closed'; };
        queueMicrotask(() => { try { dc.dispatchEvent(new Event('open')); } catch {} });
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

  let offerCount = 0;
  await page.route('**/api/rtc/offer', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    offerCount++;
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ peer_id: `fake-peer-${offerCount}`, sdp: 'v=0\r\n(fake answer)\r\n', type: 'answer' }),
    });
  });
  await page.route('**/api/rtc/ice', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.route('**/api/rtc/close', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.route('**/api/sidekick/config/*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', tts: false });
  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('dictateRealtime', true);
  });

  const pcCount = () => page.evaluate(() => (window).__TEST_FAKE_PCS__.length);
  const setLastPcState = (s) => page.evaluate((st) => {
    const pcs = (window).__TEST_FAKE_PCS__;
    pcs[pcs.length - 1]._setConnectionState(st);
  }, s);
  const waitForPcCount = async (n, timeout = 5000) => {
    const start = Date.now();
    while (await pcCount() < n) {
      if (Date.now() - start > timeout) return false;
      await page.waitForTimeout(50);
    }
    return true;
  };
  const btnHas = (id, cls) => page.evaluate(
    ({ id: i, cls: c }) => !!document.getElementById(i)?.classList.contains(c),
    { id, cls });
  const waitForBtnClass = (id, cls, timeout = 5000) => page.waitForFunction(
    ({ id: i, cls: c }) => !!document.getElementById(i)?.classList.contains(c),
    { id, cls }, { timeout, polling: 50 },
  ).then(() => true, () => false);

  // ─────────────────────────────────────────────────────────────────────
  // PART 1 — dictation-owned call: amber goes on the MIC button
  // ─────────────────────────────────────────────────────────────────────
  await page.evaluate(() => window.__micDispatch('tap'));
  assert(await waitForPcCount(1), 'dictate tap should open a WebRTC peer');
  await setLastPcState('connected');
  await page.waitForTimeout(200);
  log(`dictation peer connected (pcs=${await pcCount()}, offers=${offerCount})`);

  await setLastPcState('failed');
  assert(await waitForBtnClass('btn-mic', 'reconnecting'),
    'dictation-owned recovery: #btn-mic never got .reconnecting — the amber pulse is not following the owning button');
  assert(!(await btnHas('btn-call', 'reconnecting')),
    'dictation-owned recovery: #btn-call got .reconnecting — the call button must stay untouched during dictation (the field nit)');
  log('dictate drop: amber on mic, call button untouched ✓');

  // Recover — class must clear off the mic.
  assert(await waitForPcCount(2), 'reconnecting should re-open a fresh PC');
  await setLastPcState('connected');
  const cleared = await page.waitForFunction(
    () => !document.getElementById('btn-mic')?.classList.contains('reconnecting'),
    undefined, { timeout: 5000, polling: 50 },
  ).then(() => true, () => false);
  assert(cleared, 'after recovery #btn-mic must drop .reconnecting');
  log('recovery clears the mic amber ✓');

  // Tear down dictation. NOT via __micDispatch('tap') — startMicMode
  // routes a tap straight to startDictate, which no-ops while active
  // (the stop branch lives in the pointerdown handler, not the
  // dispatcher). Stop the dictate module directly, then wait for the
  // peer to actually close and the mic to drop its active state so
  // part 2's openCall can't early-return on the still-open peer.
  await page.evaluate(async () => {
    const dict = await import('/build/audio/realtime/dictate.mjs');
    await dict.stop();
  });
  // pollUntil (NOT waitForFunction): the predicate needs an in-page
  // `await import(...)`, and an async waitForFunction predicate returns
  // a truthy Promise — it "passes" immediately and vacuously. pollUntil
  // evaluates (and awaits) the predicate per tick via page.evaluate.
  const toreDown = await pollUntil(page, async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    return !controls.isOpen()
      && !document.getElementById('btn-mic')?.classList.contains('active');
  }, undefined, { timeout: 5000, polling: 100 }).then(() => true, () => false);
  assert(toreDown, 'dictation teardown: peer should close and mic should deactivate');

  // ─────────────────────────────────────────────────────────────────────
  // PART 2 — call-owned: amber goes on the CALL button (inverse pin)
  // ─────────────────────────────────────────────────────────────────────
  const pcsBefore = await pcCount();
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.openCall('stream');
  });
  assert(await waitForPcCount(pcsBefore + 1), 'openCall should create a PC');
  await setLastPcState('connected');
  await page.waitForTimeout(200);

  await setLastPcState('failed');
  assert(await waitForBtnClass('btn-call', 'reconnecting'),
    'call-owned recovery: #btn-call never got .reconnecting');
  assert(!(await btnHas('btn-mic', 'reconnecting')),
    'call-owned recovery: #btn-mic wrongly got .reconnecting');
  log('call drop: amber on call button, mic untouched ✓');

  // Clean up: hang up (cancels the in-flight reconnect).
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.closeIfOpen();
  });

  log('reconnecting visual follows the owning button (mic for dictate, call for calls) ✓');
}
