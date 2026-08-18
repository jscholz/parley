// Lock in the bubble-identity SSOT contract (v0.424+).
//
// Rule: every path that creates an optimistic user bubble pre-mints a
// userMessageId and registers via renderedMessages.upsert. The id rides
// through to the server. Server's user_message envelope echoes the
// same id. handleUserMessage upserts → idempotent → ONE bubble per
// utterance, ever.
//
// This smoke covers the dictation path (the one that regressed
// 2026-05-04: the typed path was converted to renderedMessages but
// the dictation finalize handler still used raw chat.addLine, so the
// server's user_message echo created a SECOND bubble under a new
// server-minted id).
//
// Test plan (mocked):
//   1. Stub WebRTC (FakePC) so we can mark the call connected.
//   2. Open a talk-mode call.
//   3. Capture data-channel sends — assert the dispatch envelope
//      includes a `user_message_id` field (the plumbing).
//   4. Synthesize a `user_message` SSE envelope from the mock backend
//      with the SAME id we expect the dispatch to have minted.
//   5. Assert the bubble count for the dictated text is EXACTLY ONE.
//   6. Synthesize a SECOND user_message envelope with a DIFFERENT id
//      (cross-device sync — message from another device). Assert
//      that creates a new bubble — proves we're not over-deduplicating.

import { waitForReady, assert, captureNextChatId, clickNewChat } from './lib.mjs';

export const NAME = 'dictate-bubble-uniqueness';
export const DESCRIPTION = 'Dictation finalize → exactly one user bubble after server user_message echo (SSOT contract)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, mock }) {
  await page.addInitScript(() => {
    /** @type {Array<string>} every dataChannel.send() payload */
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
      createDataChannel(_label) {
        const dc = new EventTarget();
        dc.readyState = 'open';
        dc.label = _label;
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
    settings.set('tts', true);
  });
  await page.evaluate(async () => {
    const platform = await import('/build/audio/shared/platform.mjs');
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    platform.primeAudio(audio);
  });

  // Need an active chat — SSE listener filters envelopes by chat_id,
  // and user_message broadcasts only render when chat_id matches the
  // viewed session.
  const chatIdPromise = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await chatIdPromise;
  log(`active chat_id=${chatId}`);

  // ── Open a talk-mode call ────────────────────────────────────────────
  await page.evaluate(async () => {
    const controls = await import('/build/audio/realtime/controls.mjs');
    await controls.openCall('talk');
  });
  await page.waitForFunction(() => !!((window)).__TEST_FAKE_PC__, null, { timeout: 5_000 });
  await page.evaluate(() => {
    const pc = (window).__TEST_FAKE_PC__;
    pc._setConnectionState('connected');
  });

  // ── Drive the dictation finalize path ────────────────────────────────
  // webrtcDictation.handleUserFinal feeds an is_final transcript that
  // ends in the commit phrase ('over' default) → fires dispatchNow.
  // dispatchNow mints userMessageId (via the provider main.ts wired),
  // calls onUserBubble (renders the optimistic bubble), then sends the
  // dispatch envelope on the data channel.
  const utterance = 'count to twenty for me again over';
  await page.evaluate(async (text) => {
    const dictate = await import('/build/audio/realtime/dictation.mjs');
    dictate.handleUserFinal(text);
  }, utterance);

  // Pull the dispatch envelope; assert it carries a user_message_id.
  await page.waitForFunction(
    () => (window).__TEST_DC_SENDS__.some((s) => {
      try { return JSON.parse(s)?.type === 'dispatch'; } catch { return false; }
    }),
    null,
    { timeout: 2_000, polling: 50 },
  );
  const dispatchEnv = await page.evaluate(() => {
    const sends = (window).__TEST_DC_SENDS__;
    for (const s of sends) {
      try { const o = JSON.parse(s); if (o?.type === 'dispatch') return o; } catch {}
    }
    return null;
  });
  log(`dispatch envelope: ${JSON.stringify(dispatchEnv)}`);
  assert(
    dispatchEnv && typeof dispatchEnv.user_message_id === 'string'
      && dispatchEnv.user_message_id.startsWith('umsg_'),
    `dispatch envelope missing user_message_id; saw ${JSON.stringify(dispatchEnv)}`,
  );
  const sentUserMsgId = dispatchEnv.user_message_id;

  // Assert ONE optimistic bubble rendered with the dispatched text
  // (after commit-phrase strip — "over" stripped, "count to twenty for
  // me again" remains).
  const expectedText = 'count to twenty for me again';
  const beforeEcho = await page.evaluate((text) => {
    return Array.from(document.querySelectorAll('#transcript .line.s0'))
      .filter((el) => (el).dataset?.text === text || el.textContent.includes(text))
      .length;
  }, expectedText);
  log(`bubbles before user_message echo: ${beforeEcho}`);
  assert(
    beforeEcho === 1,
    `expected exactly 1 optimistic bubble for dictated text, got ${beforeEcho}`,
  );

  // ── Synthesize the server's user_message echo with SAME id ───────────
  mock.pushEnvelope({
    type: 'user_message',
    chat_id: chatId,
    message_id: sentUserMsgId,
    text: expectedText,
  });
  await page.waitForTimeout(150);

  const afterEcho = await page.evaluate((text) => {
    return Array.from(document.querySelectorAll('#transcript .line.s0'))
      .filter((el) => (el).dataset?.text === text || el.textContent.includes(text))
      .length;
  }, expectedText);
  log(`bubbles after same-id user_message echo: ${afterEcho}`);
  assert(
    afterEcho === 1,
    `same-id echo should be idempotent (no dupe). bubble count after echo: ${afterEcho}`,
  );

  // ── Synthesize a DIFFERENT user_message — cross-device sync ──────────
  // Different id → genuine new message from another device → SHOULD
  // render a fresh bubble. Proves we're not over-dedupping.
  const otherDeviceText = 'message from my phone';
  mock.pushEnvelope({
    type: 'user_message',
    chat_id: chatId,
    message_id: 'umsg_other_device_xyz',
    text: otherDeviceText,
  });
  await page.waitForTimeout(150);

  const afterCrossDev = await page.evaluate((text) => {
    return Array.from(document.querySelectorAll('#transcript .line.s0'))
      .filter((el) => (el).textContent.includes(text))
      .length;
  }, otherDeviceText);
  log(`bubbles for other-device text: ${afterCrossDev}`);
  assert(
    afterCrossDev === 1,
    `cross-device user_message should render exactly 1 fresh bubble; got ${afterCrossDev}`,
  );

  log('dictate-bubble-uniqueness: dispatch carries umsg id ✓ same-id echo idempotent ✓ cross-device renders ✓');
}
