// Scenario: BT headset + lock-screen MediaSession actions navigate
// per-reply playback within the active chat (the "I missed what the
// agent said, lemme go back" UX).
//
// Wiring (src/main.ts audioSession.init):
//   - nexttrack → replyNavigator.playNext (skip-fwd to next agent reply)
//   - previoustrack → replyNavigator.playPrev (skip-back to previous)
//   - pause → pauseReplyTts when a reply is playing (truck driving by)
//   - play → resumeReplyTts when a reply is paused (mid-stream resume)
//
// Asserts:
//   1. previoustrack moves the activeReplyId backwards through agent
//      bubbles (last → second → first).
//   2. nexttrack moves it forward.
//   3. pause flips player.paused = true (via the real pauseReplyTts
//      → player.pause() chain).
//   4. play resumes via resumeReplyTts → player.play().
//
// Test asserts on activeReplyId + player.paused — the source of truth
// for the navigation contract — rather than on bubble CSS classes
// (those are presentation details driven by audio events that get
// fragile to stub in headless Chromium).

export const NAME = 'mediasession-skip';
export const DESCRIPTION = 'MediaSession nexttrack/previoustrack/pause/play drive per-reply TTS playback';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, fail, url, mock }) {
  // Pre-seed a chat with three agent replies so playNext / playPrev
  // have something to navigate over. The mock backend's history
  // endpoint serves these on session resume; main.ts:renderHistoryMessage
  // sets data-reply-id = message_id so replyNavigator can find each.
  mock.addChat('chat-with-replies', {
    title: 'Three replies',
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first reply', message_id: 'm-r1' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second reply', message_id: 'm-r2' },
      { role: 'user', content: 'third question' },
      { role: 'assistant', content: 'third reply', message_id: 'm-r3' },
    ],
  });

  // Intercept POST /tts so the test doesn't hit Deepgram. Returns a
  // tiny audio blob each call so playReplyTts' fetch+blob path
  // succeeds and reaches audio.play().
  await page.route('**/tts', async (route) => {
    if (new URL(route.request().url()).pathname !== '/tts') return route.fallback();
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'audio/mpeg',
      body: Buffer.from([0xFF, 0xFB, 0x90, 0x00]),
    });
  });

  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => /Connected/.test(document.body.innerText), null, {
    timeout: 15_000, polling: 250,
  });

  const { openSidebar, pollUntil } = await import('./lib.mjs');
  await openSidebar(page);
  await page.waitForSelector('#sessions-list li[data-chat-id="chat-with-replies"]', { timeout: 5_000 });
  await page.click('#sessions-list li[data-chat-id="chat-with-replies"] .sess-body');
  // Wait for all three agent bubbles + their replyId stamps to land.
  await page.waitForFunction(() => {
    const bubbles = document.querySelectorAll('#transcript .line.agent[data-reply-id]');
    return bubbles.length >= 3;
  }, null, { timeout: 5_000, polling: 100 });
  log('three agent bubbles rendered with data-reply-id');

  // Stub player.play / pause so the audio element doesn't try to
  // decode our 4-byte fake mp3. Track .paused via a closure flag
  // since the native paused getter is read-only and won't reflect
  // our state otherwise.
  await page.evaluate(() => {
    const player = document.getElementById('player');
    if (!player) return;
    let paused = true;
    Object.defineProperty(player, 'paused', { get: () => paused, configurable: true });
    player.play = function() {
      paused = false;
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    player.pause = function() {
      paused = true;
      this.dispatchEvent(new Event('pause'));
    };
  });

  // Verify the test hook is exposed.
  const hookOk = await page.evaluate(() =>
    typeof (window).__audioSessionTest?.fireAction === 'function');
  if (!hookOk) fail('test hook __audioSessionTest.fireAction missing');

  // Helper: read activeReplyId from the live tts module.
  async function getActiveReplyId() {
    return page.evaluate(async () => {
      const tts = await import('/build/audio/turn-based/tts.mjs');
      return tts.getActiveReplyId();
    });
  }

  // ── 1. previoustrack moves activeReplyId backwards ──────────────
  // The pointer starts at the most-recent bubble (m-r3) per
  // replyNavigator's currentBubble default. previoustrack walks BACK
  // to m-r2.
  await page.evaluate(() => (window).__audioSessionTest.fireAction('previoustrack'));
  await pollUntil(page, async () => {
    const tts = await import('/build/audio/turn-based/tts.mjs');
    return tts.getActiveReplyId() === 'm-r2';
  }, null, { timeout: 5_000, polling: 100, label: 'previoustrack never moved activeReplyId to m-r2' });
  log('previoustrack → activeReplyId = m-r2');

  // ── 2. previoustrack again → m-r1 ───────────────────────────────
  await page.evaluate(() => (window).__audioSessionTest.fireAction('previoustrack'));
  await pollUntil(page, async () => {
    const tts = await import('/build/audio/turn-based/tts.mjs');
    return tts.getActiveReplyId() === 'm-r1';
  }, null, { timeout: 5_000, polling: 100, label: 'second previoustrack never moved activeReplyId to m-r1' });
  log('previoustrack again → activeReplyId = m-r1');

  // ── 3. nexttrack → m-r2 (forward) ───────────────────────────────
  await page.evaluate(() => (window).__audioSessionTest.fireAction('nexttrack'));
  await pollUntil(page, async () => {
    const tts = await import('/build/audio/turn-based/tts.mjs');
    return tts.getActiveReplyId() === 'm-r2';
  }, null, { timeout: 5_000, polling: 100, label: 'nexttrack never moved activeReplyId to m-r2' });
  log('nexttrack → activeReplyId = m-r2');

  // nexttrack kicks off playNext → playReplyTts, which fetches /tts
  // (async) BEFORE calling player.play(). Wait for playback to actually
  // start (paused → false via the stub) so the pause action below has a
  // live reply to pause — otherwise pause/resume race the startup fetch
  // and flake intermittently.
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player && player.paused === false;
  }, null, { timeout: 5_000, polling: 100 });
  log('m-r2 playback started (player.paused = false)');

  // ── 4. pause flips player.paused = true ─────────────────────────
  await page.evaluate(() => (window).__audioSessionTest.fireAction('pause'));
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player && player.paused === true;
  }, null, { timeout: 3_000, polling: 100 });
  log('pause → player.paused = true');

  // Confirm tts.isPaused() agrees (covers the resume() path's check).
  const isPausedNow = await page.evaluate(async () => {
    const tts = await import('/build/audio/turn-based/tts.mjs');
    return tts.isPaused();
  });
  if (!isPausedNow) fail(`expected tts.isPaused() === true after pause action, got ${isPausedNow}`);

  // ── 5. play resumes via resumeReplyTts → player.play() ──────────
  await page.evaluate(() => (window).__audioSessionTest.fireAction('play'));
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player && player.paused === false;
  }, null, { timeout: 3_000, polling: 100 });
  log('play → player.paused = false (resumed)');
}
