// Scenario: a barge during Listen TTS must NOT kill TTS for the NEXT
// reply. Regression guard: a spurious barge paused the agent's TTS;
// on the agent's *subsequent* reply, TTS never fired again — Listen
// stopped speaking for the rest of the call.
//
// Root cause this test locks down:
//   onBarge → ttsModule.pauseReplyTts() PAUSES (not cancels) reply #1,
//   so the tts module's `active` session stays set. The next autoplayed
//   reply calls playReplyTts → cancelReplyTts('superseded'), which emits
//   a 'stopped' event for reply #1. main.ts's TTS→Listen bridge
//   (play-start / paused / ended / stopped handlers) gated on a single
//   `listenReplyTtsOwned` boolean. The superseded-'stopped' for reply #1
//   fires AFTER ownership was claimed for reply #2 → flips the flag
//   false → reply #2's play-start sees ownership=false →
//   notifyReplyPlayback(true) is skipped → Listen never re-enters
//   'playing' and barge never re-arms. The agent is effectively mute
//   for the rest of the call.
//
// We do NOT drive the VAD detector here — turnbased-barge.mjs already
// covers detector→onBarge. We invoke the EXACT action onBarge takes,
// ttsModule.pauseReplyTts(), which is faithful to the real barge and
// fully deterministic (no VAD warmup/tick timing).
//
// Mocks:
//   - /transcribe: canned transcript → drives a Listen commit each turn.
//   - /tts: a ~2s WAV so reply #1 stays in 'playing' long enough to
//     barge before it naturally ends.
//   - backend: the runner's mock auto-replies on POST /messages, which
//     triggers the Listen autoplay path → playReplyTts.
//
// Asserts:
//   1. Turn 1 reply autoplays → Listen state reaches 'playing'.
//   2. Simulated barge → tts state 'paused' → Listen re-arms ('armed').
//   3. Turn 2 reply autoplays → Listen state reaches 'playing' AGAIN.
//      (THE REGRESSION: pre-fix it stayed armed/cooldown, never 'playing'.)

import { pollUntil } from './lib.mjs';

export const NAME = 'listen-barge-then-next-reply-tts';
export const DESCRIPTION = 'Barge-pause of reply #1 must not mute TTS for reply #2 (re-arms to playing)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

/** Build a minimal mono 16-bit PCM WAV of `seconds` of silence so the
 *  HTMLAudioElement actually stays in 'playing' for that long (a
 *  0-sample WAV fires 'ended' immediately and there's no window to
 *  barge). 8 kHz keeps the buffer tiny. */
function silenceWav(seconds = 2) {
  const sampleRate = 8000;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);        // fmt chunk size
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);         // block align
  buf.writeUInt16LE(16, 34);        // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  // samples already zero-filled (silence)
  return buf;
}

export default async function run({ page, log, fail, url, mock }) {
  const ttsPosts = [];
  let committedChatId = null;
  let postCount = 0;

  // Capture the chat_id Listen commits to (same chat across turns) so we
  // can hand-push turn 2's reply onto that conversation. Intercept then
  // fall back to the mock's POST handler (most-recent route wins; fallback
  // defers to the earlier-registered mock route).
  await page.route('**/api/parley/messages', async (route) => {
    if (route.request().method() === 'POST') {
      try {
        const b = JSON.parse(route.request().postData() || '{}');
        if (b.chat_id) committedChatId = b.chat_id;
      } catch { /* non-JSON body — ignore */ }
      postCount++;
    }
    return route.fallback();
  });

  await page.route('**/transcribe*', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: 'tell me something' }),
    });
  });

  const wav = silenceWav(2);
  await page.route('**/tts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    ttsPosts.push({ ts: Date.now() });
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });

  await page.goto(`${url}/?listen=1&silence_sec=1&listen_mock_mic=1&debug=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => (window).__listen?.state === 'armed', null, {
    timeout: 10_000, polling: 100,
  });
  log('listen armed');

  // ── Turn 1: commit → reply → autoplay TTS → Listen 'playing' ───────
  await page.evaluate(() => (window).__listen.injectSilence(1500));
  await page.waitForFunction(() => (window).__listen?.state === 'playing', null, {
    timeout: 8_000, polling: 50,
  });
  if (ttsPosts.length < 1) fail('turn 1: /tts never posted');
  log(`turn 1 reply autoplaying — Listen 'playing' (tts posts=${ttsPosts.length})`);

  // ── Simulated barge: pause TTS exactly as onBarge does ─────────────
  await page.evaluate(async () => {
    const tts = await import('/build/audio/turn-based/tts.mjs');
    tts.pauseReplyTts();
  });
  // TTS should report 'paused' and KEEP its active session (resume-able),
  // which is what leaves the stale `active` that reply #2's superseded
  // cancel later trips over.
  await pollUntil(page, async () => {
    const tts = await import('/build/audio/turn-based/tts.mjs');
    return tts.getState() === 'paused';
  }, null, { timeout: 3_000, polling: 50, label: 'tts never reported paused after simulated barge' });
  log('barge simulated — tts paused');

  // Listen re-arms after the cooldown grace.
  await page.waitForFunction(() => (window).__listen?.state === 'armed', null, {
    timeout: 5_000, polling: 50,
  });
  log('re-armed after barge');

  // ── Turn 2: commit → FINAL-ONLY reply → autoplay TTS → 'playing' AGAIN
  // This is the regression surface. Turn 2 MUST be a final-only reply (no
  // reply_delta): a delta would trigger handleReplyDelta's
  // cancelReplyTts('new-turn'), which clears the stale paused `active`
  // from reply #1 BEFORE autoplay's superseded cancel runs — sidestepping
  // the desync (empirically observed: with the mock's default delta+final
  // auto-reply, the bug does NOT reproduce). Final-only preserves the
  // stale `active`, so reply #2's playReplyTts → cancelReplyTts('superseded')
  // emits a 'stopped' for reply #1's id. Pre-fix the bridge's single
  // `listenReplyTtsOwned` boolean is dropped by that stale-'stopped' AFTER
  // ownership was claimed for reply #2 → reply #2's play-start is ignored →
  // Listen never re-enters 'playing'. Post-fix (replyId-scoped ownership)
  // the stale-'stopped' is ignored and Listen reaches 'playing'.
  //
  // Use DISTINCT reply text so playReplyTts misses the replyCache and
  // actually re-POSTs /tts (identical text would be served from cache,
  // skipping the fetch and muddying the assertion).
  mock.setAutoReplyEnabled(false);
  const ttsBefore = ttsPosts.length;
  const postsBefore = postCount;

  // Drive the turn-2 commit via the deterministic commit() hook
  // (commitNow('sendword')) rather than injectSilence — after the barge
  // re-arm the VAD silence-window timing is no longer reliable enough to
  // fire a commit within the test budget, and 'committing' is too
  // transient to gate on from the page side. commit() runs the exact send
  // path (transcribe → POST → markListenAwaitingReply) deterministically.
  await page.evaluate(() => (window).__listen.commit());

  // Gate on the commit's POST landing (node-side, deterministic) — by then
  // markListenAwaitingReply has pinned this chat and Listen is in
  // 'committing', the state shouldAutoPlayForListen requires.
  for (let waited = 0; postCount <= postsBefore && waited < 8_000; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (postCount <= postsBefore || !committedChatId) fail('turn 2: commit POST never observed');

  // Hand-push a FINAL-ONLY reply (no preceding reply_delta) with distinct
  // text onto the committed chat.
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: committedChatId,
    message_id: 'mock-turn2',
    text: 'here is the second distinct reply',
  });

  // First prove autoplay actually FIRED for reply #2 — distinct text
  // misses the replyCache, so a /tts POST is the proof playReplyTts ran.
  // This separates "autoplay never attempted" (wrong repro) from the real
  // bug ("autoplay ran but Listen was never told it's playing").
  for (let waited = 0; ttsPosts.length <= ttsBefore && waited < 6_000; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (ttsPosts.length <= ttsBefore) fail('turn 2: autoplay never fetched /tts for the second reply');
  log(`turn 2 autoplay fired — /tts posted (posts=${ttsPosts.length})`);

  // THE REGRESSION ASSERTION: autoplay fired, so Listen must re-enter
  // 'playing'. Pre-fix the superseded-'stopped' for reply #1 dropped the
  // single `listenReplyTtsOwned` boolean after ownership was claimed for
  // reply #2, so reply #2's play-start was ignored and Listen idled in
  // committing/cooldown (agent effectively mute for the rest of the call).
  await page.waitForFunction(() => (window).__listen?.state === 'playing', null, {
    timeout: 8_000, polling: 50,
  });
  log(`turn 2 final-only reply autoplaying — Listen 'playing' AGAIN ✓`);
}
