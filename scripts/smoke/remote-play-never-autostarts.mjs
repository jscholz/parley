// A system / headset 'play' must never START audio by itself.
//
// iOS routes a 'play' to the last now-playing app for events that are
// not a person pressing play: AirPods connecting, a phone call or Siri
// ending, CarPlay, Control Center "resume". Parley is that app after any
// reply. Field 2026-10-08 ("another auto play of the audio in the CAP —
// I've tried to fix this 3 times"): the native shell forwards those as
// `parley:remote-control` play; the web Media Session handler got the
// same event in the PWA. Both now resume ONLY a reply the user paused
// deliberately and recently (tts.remoteResumeDecision); a barge pause,
// an aged pause, an ended reply, or a cold idle app are all inert — and
// the old "idle play → open a call" branch is gone.
//
// Asserts:
//   1. cold idle: native remote 'play' + Media Session 'play' → no /tts
//      POST, no active reply, no call (mic not listening).
//   2. a reply paused by a BARGE: remote 'play' leaves it paused.
//   3. the same reply paused by the USER (bubble button): remote 'play'
//      resumes it.
//   4. a user pause older than the resume window: remote 'play' ignored.

export const NAME = 'remote-play-never-autostarts';
export const DESCRIPTION = 'System/headset play never starts audio: only a recent, deliberate user pause may resume; barge/aged/ended/idle are inert; no call is opened';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, fail, url, mock }) {
  mock.addChat('chat-remote-play', {
    title: 'Remote play',
    messages: [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'a reply worth hearing twice', message_id: 'm-rp1' },
    ],
  });
  const ttsCalls = [];
  await page.route('**/tts', async (route) => {
    if (new URL(route.request().url()).pathname !== '/tts') return route.fallback();
    if (route.request().method() !== 'POST') return route.fallback();
    ttsCalls.push(route.request().postData());
    await route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from([0xFF, 0xFB, 0x90, 0x00]) });
  });

  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => /Connected/.test(document.body.innerText), null, { timeout: 15_000, polling: 250 });
  const { openSidebar, pollUntil } = await import('./lib.mjs');
  await openSidebar(page);
  await page.waitForSelector('#sessions-list li[data-chat-id="chat-remote-play"]', { timeout: 5_000 });
  await page.click('#sessions-list li[data-chat-id="chat-remote-play"] .sess-body');
  await page.waitForFunction(() => document.querySelectorAll('#transcript .line.agent[data-reply-id]').length >= 1,
    null, { timeout: 5_000, polling: 100 });

  // Fake player (the 4-byte mp3 would never decode): track .paused ourselves.
  await page.evaluate(() => {
    const player = document.getElementById('player');
    let paused = true;
    Object.defineProperty(player, 'paused', { get: () => paused, configurable: true });
    player.play = function() { paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); };
    player.pause = function() { paused = true; this.dispatchEvent(new Event('pause')); };
  });

  const firePlay = async () => page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('parley:remote-control', { detail: { action: 'play' } }));   // CAP native path
    window.__audioSessionTest?.fireAction('play');                                                  // web Media Session path
  });
  const snapshot = async () => page.evaluate(async () => {
    const tts = await import('/build/audio/turn-based/tts.mjs');
    const mic = document.getElementById('btn-mic');
    return {
      state: tts.getState(), active: tts.getActiveReplyId(),
      paused: document.getElementById('player').paused,
      callOpen: !!mic?.classList.contains('listening'),
    };
  });

  // 1. cold idle
  await firePlay();
  await page.waitForTimeout(700);
  let s = await snapshot();
  if (ttsCalls.length !== 0 || s.active || s.state !== 'idle') fail(`cold idle play started something: ${JSON.stringify(s)} tts=${ttsCalls.length}`);
  if (s.callOpen) fail('cold idle play opened a call');
  log('cold idle: remote play inert ✓');

  // Start the reply from its bubble (a deliberate tap) — the same
  // delegated play-btn click path mediasession-skip pins.
  await page.evaluate(() => {
    document.querySelector('#transcript .line.agent[data-reply-id="m-rp1"] .play-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await pollUntil(page, async () => {
    const tts = await import('/build/audio/turn-based/tts.mjs');
    return tts.getState() === 'playing';
  }, undefined, { timeout: 5_000, polling: 100, label: 'bubble play did not reach playing' });
  s = await snapshot();
  if (s.state !== 'playing') fail(`could not establish playback: ${JSON.stringify(s)}`);
  log('bubble tap: playing ✓');

  // 2. barge pause → remote play stays paused
  await page.evaluate(async () => { const tts = await import('/build/audio/turn-based/tts.mjs'); tts.pauseReplyTts('barge'); });
  await firePlay();
  await page.waitForTimeout(400);
  s = await snapshot();
  if (s.state !== 'paused' || !s.paused) fail(`remote play resumed a BARGE pause: ${JSON.stringify(s)}`);
  log('barge pause: remote play ignored ✓');

  // 3. user pause → remote play resumes
  await page.evaluate(async () => { const tts = await import('/build/audio/turn-based/tts.mjs'); await tts.resumeReplyTts(); tts.pauseReplyTts('user'); });
  await firePlay();
  await page.waitForTimeout(400);
  s = await snapshot();
  if (s.state !== 'playing' || s.paused) fail(`remote play did not resume a fresh USER pause: ${JSON.stringify(s)}`);
  log('user pause: remote play resumes ✓');

  // 4. aged user pause → ignored
  await page.evaluate(async () => {
    const tts = await import('/build/audio/turn-based/tts.mjs');
    tts.pauseReplyTts('user');
    tts.__setRemoteResumeWindowForTests(1);
  });
  await page.waitForTimeout(50);
  await firePlay();
  await page.waitForTimeout(400);
  s = await snapshot();
  if (s.state !== 'paused' || !s.paused) fail(`remote play resumed an AGED user pause: ${JSON.stringify(s)}`);
  log('aged user pause: remote play ignored ✓');
}
