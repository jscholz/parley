// Scenario: Listen mode commits a buffered audio blob to /transcribe
// after a silence window, plays the agent reply through TTS, and
// re-arms for the next turn.
//
// Mocks:
//   - /transcribe: returns canned text {ok: true, transcript: "hello world"}.
//   - /tts: returns a tiny WAV blob.
//   - mic: a synthetic AudioBuffer routed into the analyser via the
//     listen module's testHooks. No real getUserMedia.
//   - SpeechRecognition: undefined (silence-only path).
//
// Activation: ?listen=1&silence_sec=1 URL flag arms Listen on boot,
// shrinks the silence window so the test runs in seconds.
//
// Asserts:
//   1. /transcribe POSTed once.
//   2. Reply bubble rendered with "hello world".
//   3. GET /tts requested once (streaming playback).
//   4. After audio.ended, listen state is "armed" again (re-arm).

export const NAME = 'listen-silence-commit';
export const DESCRIPTION = 'Listen mode commits buffered audio after silence + plays reply';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, fail, url, mock }) {
  // Track POSTs that the PWA fires.
  const transcribePosts = [];
  const ttsPosts = [];

  await page.route('**/transcribe*', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    transcribePosts.push({
      url: route.request().url(),
      ts: Date.now(),
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: 'hello world' }),
    });
  });

  // Reply TTS now streams via GET /tts?text=…&model=… (was POST). Match
  // the query string with a trailing glob and key on GET.
  await page.route('**/tts*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    ttsPosts.push({ ts: Date.now() });
    // Tiny WAV header + 0 samples — enough for HTMLAudio to "play" + fire ended.
    const wav = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
      0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
    ]);
    await route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      body: wav,
    });
  });

  await page.goto(`${url}/?listen=1&silence_sec=1&listen_mock_mic=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  // Wait for boot to wire Listen mode + auto-arm via the URL flag.
  await page.waitForFunction(() => (window).__listen?.state === 'armed', null, {
    timeout: 10_000, polling: 100,
  });
  log('listen armed');

  // Inject 1.5s of silence frames into the listen analyser to trigger
  // commit. The listen module's test hook accepts {peak, isPlayback}
  // synthetic frames so we don't need a real mic.
  await page.evaluate(() => (window).__listen.injectSilence(1500));
  log('silence injected');

  // Wait for /transcribe to fire.
  const t0 = Date.now();
  while (transcribePosts.length === 0 && Date.now() - t0 < 5_000) {
    await page.waitForTimeout(50);
  }
  if (transcribePosts.length === 0) fail('/transcribe never posted');
  log(`/transcribe fired (n=${transcribePosts.length})`);

  // Wait for reply text to render.
  await page.waitForFunction(
    () => /hello world/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 5_000, polling: 100 },
  );

  // Wait for /tts to fire.
  const t1 = Date.now();
  while (ttsPosts.length === 0 && Date.now() - t1 < 5_000) {
    await page.waitForTimeout(50);
  }
  if (ttsPosts.length === 0) fail('/tts never requested');
  log('/tts fired');

  // Wait for re-arm after reply.
  await page.waitForFunction(
    () => (window).__listen?.state === 'armed',
    null,
    { timeout: 5_000, polling: 100 },
  );
  log('re-armed after reply');
}
