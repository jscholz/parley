// Pin the Phase B soft-recovery state machine (call-resilience-plan.md):
// a CONNECTED call whose PC drops must NOT tear down — it enters
// `reconnecting`, re-opens a fresh peer (same chat) within an escalation
// window, and only gives up (with the call-dropped cue) once retries are
// exhausted. Covers BOTH the recovery-succeeds and recovery-exhausted paths.
//
// Why a smoke: the recovery path is invisible until the network drops, so
// it's exactly the kind of thing that rots silently. The bike-commute
// repro that motivated this can't be reproduced on CI, so we drive a
// stubbed RTCPeerConnection's connectionState transitions directly.
//
// Test plan (mocked):
//   1. Stub RTCPeerConnection (FakePC) so we can flip connectionState and
//      so each re-open creates a fresh, observable PC. Mock /api/rtc/*.
//   2. Observe state transitions via conn.setStateListener and the drop
//      signal via conn.setDroppedListener; chimes via __TEST_FEEDBACK_LOG__.
//   3. Recovery succeeds: connect → drive pc1 'failed' → assert we enter
//      'reconnecting' and a fresh offer/PC is created → drive the new PC
//      'connected' → assert back to 'connected', NO call-dropped chime, no
//      drop signal.
//   4. Recovery exhausted: shrink the attempt budget via
//      setReconnectParamsForTests, connect, then fail every successive PC
//      until the budget is spent → assert call-dropped chime + drop signal
//      + final 'idle'.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'webrtc-reconnect-after-failure';
export const DESCRIPTION = 'dropped connected call enters reconnecting + re-opens; recovers on success, gives up (call-dropped) when retries exhausted';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, mock }) {
  // ── Stub WebRTC BEFORE the page boots ────────────────────────────────
  await page.addInitScript(() => {
    /** Every FakePC created, in order, so the test can grab the latest. */
    (window).__TEST_FAKE_PCS__ = [];
    (window).__TEST_FEEDBACK_LOG__ = [];
    /** State transitions emitted by realtime.setStateListener. */
    (window).__TEST_CALL_STATES__ = [];
    /** Reasons emitted by realtime.setDroppedListener. */
    (window).__TEST_DROPPED__ = [];

    class FakePC extends EventTarget {
      constructor() {
        super();
        this.localDescription = null;
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this._dataChannels = [];
        (window).__TEST_FAKE_PCS__.push(this);
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
        dc.send = () => {};
        dc.close = () => { dc.readyState = 'closed'; };
        queueMicrotask(() => { try { dc.dispatchEvent(new Event('open')); } catch {} });
        this._dataChannels.push(dc);
        return dc;
      }
      async createOffer() { return { sdp: 'v=0\r\n(fake offer)\r\n', type: 'offer' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription() {}
      // NOTE: close() intentionally does NOT dispatch connectionstatechange
      // — mirrors that our own teardown shouldn't re-enter the handler.
      close() { this.connectionState = 'closed'; }
      _setConnectionState(s) {
        this.connectionState = s;
        this.dispatchEvent(new Event('connectionstatechange'));
      }
    }
    (window).RTCPeerConnection = FakePC;
  });

  // ── Mock signalling endpoints + count offers (= re-open attempts) ─────
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
  await page.route('**/api/parley/config/*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  await waitForReady(page);

  // Observe state + drop signals directly off the realtime module.
  await page.evaluate(async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');
    conn.setStateListener((state) => { (window).__TEST_CALL_STATES__.push(state); });
    conn.setDroppedListener((reason) => { (window).__TEST_DROPPED__.push(reason); });
  });

  const states = () => page.evaluate(() => (window).__TEST_CALL_STATES__.slice());
  const feedback = () => page.evaluate(() => (window).__TEST_FEEDBACK_LOG__.slice());
  const dropped = () => page.evaluate(() => (window).__TEST_DROPPED__.slice());
  const pcCount = () => page.evaluate(() => (window).__TEST_FAKE_PCS__.length);
  const setLastPcState = (s) => page.evaluate((st) => {
    const pcs = (window).__TEST_FAKE_PCS__;
    pcs[pcs.length - 1]._setConnectionState(st);
  }, s);
  const waitForPcCount = async (n, timeout = 4000) => {
    const start = Date.now();
    while (await pcCount() < n) {
      if (Date.now() - start > timeout) return false;
      await page.waitForTimeout(50);
    }
    return true;
  };
  const waitForState = async (s, timeout = 4000) => {
    const start = Date.now();
    while (!(await states()).includes(s)) {
      if (Date.now() - start > timeout) return false;
      await page.waitForTimeout(50);
    }
    return true;
  };

  // ─────────────────────────────────────────────────────────────────────
  // PART 1 — recovery SUCCEEDS
  // ─────────────────────────────────────────────────────────────────────
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    try { await controls.openCall('stream'); }
    catch (e) { (window).__TEST_OPEN_ERR__ = String(e?.message || e); }
  });
  assert(await waitForPcCount(1), 'expected a PC to be created on openCall');
  await setLastPcState('connected');
  assert(await waitForState('connected'), 'expected initial state to reach connected');
  const offersAfterConnect = offerCount;
  log(`connected; offers so far=${offersAfterConnect}`);

  // Drop the live call's PC. Expect reconnecting + a fresh re-open.
  await setLastPcState('failed');
  assert(await waitForState('reconnecting'), 'connected call dropped but never entered reconnecting');
  assert(await waitForPcCount(2), 'reconnecting did not re-open a fresh PC');
  assert(offerCount > offersAfterConnect, `expected a re-offer on reconnect (offers ${offersAfterConnect} → ${offerCount})`);
  log(`entered reconnecting + re-opened; offers now=${offerCount}, pcs=${await pcCount()}`);

  // Recover: the new PC connects.
  await setLastPcState('connected');
  // Last emitted state should settle back on connected.
  await page.waitForTimeout(100);
  const s1 = await states();
  assert(s1[s1.length - 1] === 'connected', `expected last state 'connected' after recovery, got '${s1[s1.length - 1]}' (${s1.join('→')})`);
  const fb1 = await feedback();
  assert(!fb1.some((f) => f.type === 'call-dropped'), `call-dropped chime fired on a SUCCESSFUL recovery: ${JSON.stringify(fb1)}`);
  assert((await dropped()).length === 0, 'drop signal fired on a successful recovery');
  log(`recovery-succeeds path OK: states=${s1.join('→')}`);

  // Hang up to reset to idle before part 2.
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.closeIfOpen();
  });
  await page.waitForTimeout(50);

  // ─────────────────────────────────────────────────────────────────────
  // PART 2 — recovery EXHAUSTED → give up with call-dropped
  // ─────────────────────────────────────────────────────────────────────
  // Shrink the attempt budget so we don't wait out the 75s window. Reset
  // the observation arrays so part-2 assertions are clean.
  await page.evaluate(async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');
    conn.setReconnectParamsForTests({ maxAttempts: 2, windowMs: 60_000 });
    (window).__TEST_CALL_STATES__ = [];
    (window).__TEST_FEEDBACK_LOG__ = [];
    (window).__TEST_DROPPED__ = [];
  });

  const pcsBefore2 = await pcCount();
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.openCall('stream');
  });
  assert(await waitForPcCount(pcsBefore2 + 1), 'part2: expected a PC on openCall');
  await setLastPcState('connected');
  assert(await waitForState('connected'), 'part2: expected connected');

  // Fail the live PC, then fail every re-opened PC until the budget is
  // spent. maxAttempts=2 → attempt1 (pc), attempt2 (pc), then give up.
  await setLastPcState('failed');
  assert(await waitForState('reconnecting'), 'part2: never entered reconnecting');

  // Drive successive re-open attempts to failure. Attempt 1 fires with a
  // 0ms backoff, and since #197 (mic acquire parallelized with signaling)
  // its PC is constructed ~1ms into open() — so a count-relative wait
  // sampled AFTER observing 'reconnecting' can already be one PC behind
  // and would idle forever. Fail by identity instead: whenever the newest
  // PC hasn't been driven to failed/closed yet, fail it. (PC construction
  // and the `active` assignment happen in one synchronous task in open(),
  // so an evaluate() can never observe the half-initialized gap.)
  const deadline = Date.now() + 8_000;
  while ((await dropped()).length === 0 && Date.now() < deadline) {
    const didFail = await page.evaluate(() => {
      const pcs = (window).__TEST_FAKE_PCS__;
      const last = pcs[pcs.length - 1];
      if (last && last.connectionState !== 'failed' && last.connectionState !== 'closed') {
        last._setConnectionState('failed');
        return true;
      }
      return false;
    });
    await page.waitForTimeout(didFail ? 50 : 100);
  }

  // Give-up should have fired: call-dropped chime + drop signal + idle.
  const drops2 = await dropped();
  const fb2 = await feedback();
  const s2 = await states();
  log(`part2 states=${s2.join('→')} dropped=${JSON.stringify(drops2)} feedback=${JSON.stringify(fb2)}`);

  assert(drops2.length > 0, 'recovery-exhausted: expected a drop signal (onDropped) after the retry budget was spent');
  assert(fb2.some((f) => f.type === 'call-dropped'), `recovery-exhausted: expected the call-dropped chime; got ${JSON.stringify(fb2)}`);
  assert(s2[s2.length - 1] === 'idle', `recovery-exhausted: expected final state 'idle', got '${s2[s2.length - 1]}' (${s2.join('→')})`);

  // Restore production reconnect params so later scenarios in this browser
  // context aren't affected.
  await page.evaluate(async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');
    conn.setReconnectParamsForTests(null);
  });

  assert(mock.chatCount() === 0, `mock backend was unexpectedly populated (chatCount=${mock.chatCount()})`);

  log('webrtc-reconnect: recovery-succeeds OK | recovery-exhausted → call-dropped OK');
}
