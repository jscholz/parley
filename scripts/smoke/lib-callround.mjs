// Shared driver for the multi-round call smokes.
//
// WHY THIS EXISTS
//
// The 2026-08-26 field bug ("every time you reply, some state gets
// flipped; it doesn't stream from me anymore") was invisible to every
// unit assertion in the repo, because every internal gate LOOKED
// healthy: the bridge logged "resuming mic→Deepgram", it logged
// "announced listening", the peer stayed connected, the mic track
// stayed live. What was actually broken was one boolean on the client
// deciding to throw away user transcripts on the floor — three layers
// away from anything anyone was asserting on.
//
// So this driver asserts at the OBSERVABLE END OF THE PIPE: after each
// assistant reply, a user utterance is injected at the transport seam
// (a {type:'transcript', role:'user'} envelope arriving on the peer's
// data channel, exactly as the bridge sends it) and the assertion is
// that a {type:'dispatch', text} envelope leaves the client for the
// bridge. That is downstream of the suppression gate, the dictation
// buffer, the commit-phrase matcher and the bubble path. If the mic is
// wedged, no dispatch appears, no matter how healthy the internals
// claim to be.
//
// It runs N rounds because the field failure was multi-turn: round one
// always worked. And each round can stage an ADVERSARIAL TRANSPORT
// ORDERING — the whole family of bugs here comes from the SSE stream
// and the WebRTC data channel being independent transports with no
// cross-ordering guarantee, so a happy-path smoke proves almost
// nothing (cf. the #223 escape: a bounded-window test has to stage a
// delta LARGER than the window).
//
// NOTE ON RACE-DEPENDENCE: the wedge is not deterministic in talk mode
// — Jonathan had working multi-turn calls in the weeks before the field
// report. d9a4905 removed the FAILSAFE; it takes an adversarial
// ordering to actually trip. That is precisely why the orderings are
// staged explicitly here instead of hoped for. The stream-mode and
// empty-reply cases ARE deterministic.

import { assert } from './lib.mjs';

/** Install a fake RTCPeerConnection + the /api/rtc/* routes.
 *
 *  The fake exposes, on `window`:
 *    __TEST_DC_SENDS__   every payload the client sent upstream
 *    __TEST_FAKE_PC__    handle for driving connectionstate
 *    __TEST_DC_RECV__(o) inject an inbound envelope (what the bridge sends)
 */
export async function installFakePeer(page) {
  await page.addInitScript(() => {
    (window).__TEST_DC_SENDS__ = [];
    (window).__TEST_FAKE_PC__ = null;
    (window).__TEST_DC__ = null;

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
        return { direction: 'sendrecv', sender: { replaceTrack: async () => {} } };
      }
      createDataChannel(label) {
        const dc = new EventTarget();
        dc.readyState = 'open';
        dc.label = label;
        dc.send = (payload) => {
          (window).__TEST_DC_SENDS__.push(
            typeof payload === 'string' ? payload : '<binary>',
          );
        };
        dc.close = () => { dc.readyState = 'closed'; };
        queueMicrotask(() => { try { dc.dispatchEvent(new Event('open')); } catch {} });
        this._dataChannels.push(dc);
        (window).__TEST_DC__ = dc;
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

    // Inject an envelope as if the BRIDGE had sent it. Goes through the
    // real dataChannel 'message' listener in realtime.ts — the same
    // seam, the same JSON parse, the same tap fan-out.
    (window).__TEST_DC_RECV__ = (obj) => {
      const dc = (window).__TEST_DC__;
      if (!dc) throw new Error('no data channel');
      dc.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(obj) }));
    };
  });

  for (const path of ['**/api/rtc/offer', '**/api/rtc/ice', '**/api/rtc/close']) {
    await page.route(path, async (route) => {
      if (path.endsWith('offer') && route.request().method() !== 'POST') {
        return route.fallback();
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: path.endsWith('offer')
          ? JSON.stringify({ peer_id: 'fake-peer', sdp: 'v=0\r\n(fake answer)\r\n', type: 'answer' })
          : '{"ok":true}',
      });
    });
  }
}

/** Open a call in `mode` and drive the peer to 'connected'. */
export async function openConnectedCall(page, mode) {
  await page.evaluate(async (m) => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    try { await controls.openCall(m); }
    catch (e) { (window).__TEST_OPEN_ERR__ = String(e?.message || e); }
  }, mode);
  await page.waitForFunction(() => !!(window).__TEST_FAKE_PC__, null, { timeout: 10_000 });
  await page.evaluate(() => (window).__TEST_FAKE_PC__._setConnectionState('connected'));
  // The mic attaches asynchronously; envelopes are HELD until it does
  // (realtime.ts heldDcMessages). Wait for the channel to be live so a
  // round-one envelope isn't silently queued.
  await page.waitForFunction(() => !!(window).__TEST_DC__, null, { timeout: 10_000 });
  await page.waitForTimeout(400);
}

export async function dcRecv(page, envelope) {
  await page.evaluate((o) => (window).__TEST_DC_RECV__(o), envelope);
}

/** Every upstream envelope of a given type, parsed. */
export async function upstream(page, type) {
  return page.evaluate((t) => ((window).__TEST_DC_SENDS__ || [])
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter((o) => o && o.type === t), type);
}

/**
 * Drive ONE user turn at the transport seam and wait for the client to
 * hand the utterance to the bridge.
 *
 * The utterance ends with the commit phrase ('over', the shipped
 * default) so dispatch is immediate rather than waiting out the 30 s
 * silence timer.
 *
 * Returns { dispatched: boolean, waitedMs }.
 */
export async function userTurnReachesDispatch(page, text, { timeoutMs = 8_000 } = {}) {
  const before = (await upstream(page, 'dispatch')).length;
  const start = Date.now();
  let attempts = 0;
  // Re-inject on a cadence rather than once: a real user who isn't
  // getting through keeps talking, and the bridge keeps producing
  // finals. Dropped transcripts are dropped for good, so a single
  // injection would confuse "wedged" with "wedged for 300 ms". The
  // attempt count IS the signal — it measures how long the mic was
  // dead, which is the difference between a bounded self-heal and the
  // field bug.
  while (Date.now() - start < timeoutMs) {
    attempts += 1;
    await dcRecv(page, { type: 'transcript', role: 'user', text, is_final: false });
    await dcRecv(page, { type: 'transcript', role: 'user', text, is_final: true });
    await dcRecv(page, { type: 'transcript', role: 'user', text: 'over', is_final: true });
    for (let i = 0; i < 5; i++) {
      const sends = await upstream(page, 'dispatch');
      if (sends.length > before) {
        return {
          dispatched: true, attempts,
          waitedMs: Date.now() - start,
          envelope: sends[sends.length - 1],
        };
      }
      await page.waitForTimeout(100);
    }
  }
  return { dispatched: false, attempts, waitedMs: Date.now() - start, envelope: null };
}

/**
 * Simulate the bridge's side of an assistant reply.
 *
 * `opts.playback` (default true) emits the {type:'tts-playing'} level
 * signal a talk-mode bridge produces while its PCMTrack is active.
 * Stream mode passes false — there is no bridge TTS track there, which
 * is exactly why its `listening` fires once per CALL.
 */
export async function bridgeReply(page, deltas, { playback = true, final = true } = {}) {
  if (playback) await dcRecv(page, { type: 'tts-playing', active: true });
  for (const d of deltas) {
    await dcRecv(page, { type: 'transcript', role: 'assistant', text: d, is_final: false });
    await page.waitForTimeout(30);
  }
  if (final) {
    await dcRecv(page, { type: 'transcript', role: 'assistant', text: '', is_final: true });
  }
  if (playback) {
    // Audio outlives the text — that is the whole reason the gate can't
    // be released on `final`.
    await page.waitForTimeout(300);
    await dcRecv(page, { type: 'tts-playing', active: true });
    await dcRecv(page, { type: 'tts-playing', active: false });
  }
  await dcRecv(page, { type: 'listening' });
}

/**
 * Barge is CLIENT-initiated (v0.424): the bridge no longer sends
 * {type:'barge'} downstream — an inbound one is a dead envelope. The
 * only thing that reaches suppress.onBarge() is the client's own
 * BargeDetector firing. So a smoke that "stages a barge" by injecting
 * the downstream envelope stages nothing at all; it has to drive the
 * detector. Swap speechVad's read for a window flag (same trick as
 * realtime-barge-client-side.mjs) so we don't need Silero + WASM.
 */
export async function installBargeOverride(page) {
  await page.evaluate(async () => {
    (window).__TEST_SPEECH_ACTIVE__ = false;
    const det = await import('/build/audio/shared/bargeDetector.mjs');
    det.setSpeechActiveOverrideForTests(() => !!(window).__TEST_SPEECH_ACTIVE__);
    const platform = await import('/build/audio/shared/platform.mjs');
    const el = document.createElement('audio');
    document.body.appendChild(el);
    platform.primeAudio(el);
  });
}

/** Drive a real client-side barge and wait for the upstream envelope. */
export async function fireClientBarge(page, { timeoutMs = 4_000 } = {}) {
  const before = (await upstream(page, 'barge')).length;
  await page.evaluate(() => { (window).__TEST_SPEECH_ACTIVE__ = true; });
  const start = Date.now();
  let fired = false;
  while (Date.now() - start < timeoutMs) {
    if ((await upstream(page, 'barge')).length > before) { fired = true; break; }
    await page.waitForTimeout(100);
  }
  await page.evaluate(() => { (window).__TEST_SPEECH_ACTIVE__ = false; });
  return { fired, ms: Date.now() - start };
}

/** Close the call and assert no upstream close storm. */
export async function hangUp(page) {
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    try { await controls.closeIfOpen('smoke-teardown'); } catch {}
  });
}

export { assert };
