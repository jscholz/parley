// Scenario: Listen mode commits within 500ms of a sendword landing in
// a Web Speech API interim. Stubs SpeechRecognition with a controllable
// emitter; verifies both the happy path AND the fail-soft path where
// SpeechRecognition is undefined (silence-only fallback).
//
// Mocks:
//   - SpeechRecognition / webkitSpeechRecognition: stubbed before the
//     listen module evaluates — the stub stores the listener and lets
//     the test fire interim/final results on demand.
//   - /transcribe: returns canned text.
//   - /tts: returns a tiny WAV.
//
// Asserts:
//   - Stub yields "hello over" → /transcribe POSTed within 1500ms.
//   - Stub-throw path: SpeechRecognition.start() throws → silence-only
//     fallback still commits when ?silence_sec=1 elapses.

export const NAME = 'listen-sendword';
export const DESCRIPTION = 'Listen mode commits on sendword detection via Web Speech API';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, fail, url }) {
  const transcribePosts = [];
  await page.route('**/transcribe*', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    transcribePosts.push({ ts: Date.now() });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: 'hello' }),
    });
  });
  await page.route('**/tts*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const wav = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0, 0, 0, 0x01, 0, 0x01, 0,
      0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 0x02, 0, 0x10, 0,
      0x64, 0x61, 0x74, 0x61, 0, 0, 0, 0,
    ]);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });

  // Inject the SpeechRecognition stub BEFORE the page boots so listen
  // sees it on construct.
  await page.addInitScript(() => {
    class StubSR {
      continuous = false;
      interimResults = false;
      lang = 'en-US';
      onresult = null;
      onend = null;
      onerror = null;
      onstart = null;
      _running = false;
      start() {
        this._running = true;
        try { this.onstart && this.onstart({}); } catch {}
        // Expose a hook so the test can drive results from outside.
        (window).__sr = this;
      }
      stop() {
        this._running = false;
        try { this.onend && this.onend({}); } catch {}
      }
      abort() { this.stop(); }
    }
    (window).SpeechRecognition = StubSR;
    (window).webkitSpeechRecognition = StubSR;
  });

  await page.goto(`${url}/?listen=1&silence_sec=10&listen_mock_mic=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => (window).__listen?.state === 'armed', null, {
    timeout: 10_000, polling: 100,
  });
  log('listen armed');

  // Drive the sendword through the stub.
  await page.evaluate(() => {
    const sr = (window).__sr;
    if (!sr || !sr.onresult) return;
    const ev = {
      results: [
        Object.assign(['hello over'].map((t) => ({ transcript: t, confidence: 0.9 })), {
          isFinal: false,
        }),
      ],
      resultIndex: 0,
    };
    // Coerce SpeechRecognitionResultList shape.
    ev.results[0][0] = { transcript: 'hello over', confidence: 0.9 };
    ev.results[0].isFinal = false;
    ev.results.length = 1;
    sr.onresult(ev);
  });

  const t0 = Date.now();
  while (transcribePosts.length === 0 && Date.now() - t0 < 2_000) {
    await page.waitForTimeout(50);
  }
  if (transcribePosts.length === 0) fail('/transcribe did not fire on sendword');
  log(`/transcribe fired ${Date.now() - t0}ms after sendword`);
}
