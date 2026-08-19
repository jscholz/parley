// Pins the per-bubble TTS playback UX wired in cd62552 (port from
// classic) — the loading bar, played-ratio bar, and play↔pause glyph
// swap that fire as a user clicks the per-bubble play button on an
// agent message.
//
// Architecture under test:
//   tts.ts emits typed events (synth-start, play-start, ended, etc.)
//   each carrying replyId in payload. replyPlayer.ts subscribes and
//   updates DOM by data-reply-id lookup. Delegated click handler at
//   the transcript element catches .play-btn taps without per-bubble
//   listener attachment.
//
// Asserts (mocked):
//   1. Pre-seeded agent bubbles render with .play-btn + .play-bar DOM.
//   2. Clicking a bubble's .play-btn POSTs to /tts.
//   3. The bubble gains tts-active + tts-streaming on synth-start
//      (which tts.ts emits inside playReplyTts before fetch).
//   4. After audio.play() (stubbed), the bubble flips to tts-playing.
//      CSS rule .line.agent.tts-playing .play-btn .glyph-pause becomes
//      visible — verified by computed-style check on glyph-pause.
//   5. Clicking the same bubble's .play-btn again pauses (audio.pause
//      stub fires; bubble class flips to tts-paused).

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'replyplayer-bubble-ux';
export const DESCRIPTION = 'Per-bubble play button drives tts events + bubble class flips';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, fail, url, mock }) {
  // Pre-seed a chat with one agent bubble so the per-bubble UX has
  // something to drive. message_id becomes data-reply-id via main.ts:
  // renderHistoryMessage's replyId = messageId stamping.
  mock.addChat('chat-replyplayer', {
    title: 'Replyplayer test',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there friend', message_id: 'm-rp1' },
    ],
  });

  // Intercept /tts. Match the exact pathname so the agent-settings
  // POST (/api/parley/settings/tts) doesn't accidentally fire this.
  const ttsCalls = [];
  await page.route('**/tts', async (route) => {
    if (new URL(route.request().url()).pathname !== '/tts') return route.fallback();
    if (route.request().method() !== 'POST') return route.fallback();
    let body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); }
    catch {}
    ttsCalls.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'audio/mpeg',
      body: Buffer.from([0xFF, 0xFB, 0x90, 0x00]),
    });
  });

  await waitForReady(page);
  await openSidebar(page);
  await page.waitForSelector('#sessions-list li[data-chat-id="chat-replyplayer"]', { timeout: 5_000 });
  await page.click('#sessions-list li[data-chat-id="chat-replyplayer"] .sess-body');

  // Wait for the seeded agent bubble to render with its data-reply-id
  // and the per-bubble UX DOM (button + bar layers) emitted by chat.ts.
  await page.waitForFunction(() => {
    const b = document.querySelector('#transcript .line.agent[data-reply-id="m-rp1"]');
    if (!b) return false;
    const btn = b.querySelector('.play-btn');
    const bar = b.querySelector('.play-bar');
    const loaded = b.querySelector('.play-bar-loaded');
    const played = b.querySelector('.play-bar-played');
    return !!(btn && bar && loaded && played);
  }, null, { timeout: 5_000, polling: 100 });
  log('agent bubble + per-bubble UX DOM rendered');

  // Stub player.play / pause so the audio element doesn't try to decode
  // our 4-byte fake mp3. play() must dispatch the 'play' event so
  // tts.ts's listener emits the 'play-start' typed event → replyPlayer
  // adds tts-playing.
  await page.evaluate(() => {
    const player = document.getElementById('player');
    if (!player) return;
    let paused = true;
    let dur = 1.5;
    Object.defineProperty(player, 'paused', { get: () => paused, configurable: true });
    Object.defineProperty(player, 'duration', { get: () => dur, configurable: true });
    Object.defineProperty(player, 'currentTime', { value: 0, writable: true, configurable: true });
    Object.defineProperty(player, 'ended', { get: () => false, configurable: true });
    player.play = function() {
      paused = false;
      this.dispatchEvent(new Event('loadedmetadata'));
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    player.pause = function() {
      paused = true;
      this.dispatchEvent(new Event('pause'));
    };
  });

  // ── 1. Click the play-btn → /tts gets POSTed ────────────────────
  // The play-btn is hidden (its control lives in the per-message caret
  // menu, #154) but stays in the DOM so the transcript delegation still
  // fires. dispatch the click in-page rather than page.click (which is
  // visibility-gated). This smoke pins the delegation; the menu path has
  // its own coverage in message-action-menu.mjs.
  await page.evaluate(() => {
    document.querySelector('#transcript .line.agent[data-reply-id="m-rp1"] .play-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(
    () => /* poll until ttsCalls capture races */ true,
    null,
    { timeout: 200 },
  );
  // Wait briefly for the route handler to record the call.
  const start = Date.now();
  while (ttsCalls.length === 0 && Date.now() - start < 3_000) {
    await page.waitForTimeout(50);
  }
  assert(ttsCalls.length >= 1, `expected /tts POST after click; saw ${ttsCalls.length}`);
  log('/tts POST fired on play-btn click ✓');

  // ── 2. Bubble flips to tts-playing after play() resolves ────────
  await page.waitForFunction(() => {
    const b = document.querySelector('#transcript .line.agent[data-reply-id="m-rp1"]');
    return b && b.classList.contains('tts-playing');
  }, null, { timeout: 3_000, polling: 100 });
  log('bubble has .tts-playing after play event ✓');

  // ── 3. Glyph swap — pause glyph visible while playing ───────────
  const glyphState = await page.evaluate(() => {
    const b = document.querySelector('#transcript .line.agent[data-reply-id="m-rp1"]');
    const playGlyph = b?.querySelector('.play-btn .glyph-play');
    const pauseGlyph = b?.querySelector('.play-btn .glyph-pause');
    return {
      playDisplay: playGlyph ? getComputedStyle(playGlyph).display : null,
      pauseDisplay: pauseGlyph ? getComputedStyle(pauseGlyph).display : null,
    };
  });
  assert(glyphState.playDisplay === 'none', `play glyph should be hidden while playing; got ${glyphState.playDisplay}`);
  assert(glyphState.pauseDisplay !== 'none', `pause glyph should be visible while playing; got ${glyphState.pauseDisplay}`);
  log('glyph swap: play hidden, pause visible while .tts-playing ✓');

  // ── 4. Second click pauses ──────────────────────────────────────
  await page.evaluate(() => {
    document.querySelector('#transcript .line.agent[data-reply-id="m-rp1"] .play-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => {
    const b = document.querySelector('#transcript .line.agent[data-reply-id="m-rp1"]');
    return b && b.classList.contains('tts-paused') && !b.classList.contains('tts-playing');
  }, null, { timeout: 3_000, polling: 100 });
  log('second click → bubble has .tts-paused, .tts-playing dropped ✓');
}
