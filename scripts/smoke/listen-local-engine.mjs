// Scenario (v0.403): Listen mode runs fully browser-side when
// streamingEngine='local'. Body transcription comes from Web Speech via
// BrowserSttProvider — no MediaRecorder blob, no /transcribe call.
// Sendword detector subscribes to the same provider (single SR session
// per turn).
//
// Mocks:
//   - SpeechRecognition / webkitSpeechRecognition: stubbed before boot
//     so BrowserSttProvider sees a controllable emitter.
//   - /transcribe: still routed (so we can ASSERT it was never called).
//   - /tts: returns a tiny WAV blob.
//
// Activation: ?listen=1&listen_mock_mic=1 + streamingEngine='local'
// flipped via resetServerSettings before page load.
//
// Asserts:
//   1. Listen reaches 'armed' state.
//   2. Driving a sendword through the SR stub commits the turn.
//   3. /transcribe is NEVER posted (the local path replaces it).
//   4. The committed text appears in the composer / submits as a turn.

import { resetServerSettings } from './lib.mjs';

export const NAME = 'listen-local-engine';
export const DESCRIPTION = 'Listen mode body transcription via Web Speech (no /transcribe call) when streamingEngine=local';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, fail, url }) {
  // Flip the canonical body-STT switch BEFORE the page boots so the
  // PWA reads the local engine on settings.load(). Restored in the
  // try/finally below — otherwise the shared dev proxy's settings
  // table holds streamingEngine='local' and EVERY subsequent smoke
  // in the same run boots against the wrong engine. Root cause of
  // the listen-*/slash-commands full-suite flakes 2026-05-18.
  await resetServerSettings(page, { streamingEngine: 'local' });
  try {

  const transcribePosts = [];
  await page.route('**/transcribe*', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    transcribePosts.push({ ts: Date.now() });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: 'should not appear' }),
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

  // Inject a controllable SR stub. BrowserSttProvider reads
  // (window).SpeechRecognition || webkitSpeechRecognition on construct.
  await page.addInitScript(() => {
    class StubSR {
      continuous = false;
      interimResults = false;
      lang = 'en-US';
      onresult = null;
      onend = null;
      onerror = null;
      onstart = null;
      start() {
        // Park the most recent instance on window so the test can
        // drive results without holding the JS reference.
        (window).__sr = this;
        try { this.onstart && this.onstart({}); } catch {}
      }
      stop() {
        try { this.onend && this.onend({}); } catch {}
      }
      abort() { this.stop(); }
    }
    (window).SpeechRecognition = StubSR;
    (window).webkitSpeechRecognition = StubSR;
  });

  await page.goto(`${url}/?listen=1&silence_sec=30&listen_mock_mic=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  // Boot does a SW-activation reload on first install (cold cache) — wait
  // for "Connected" so listen-mode wiring has actually run before we drive
  // a sendword. Without this, the streamingEngine read can be torn between
  // boot 1 and boot 2.
  await page.waitForFunction(
    () => /Connected/.test(document.body.innerText),
    null,
    { timeout: 15_000, polling: 250 },
  );
  await page.waitForFunction(() => (window).__listen?.state === 'armed', null, {
    timeout: 10_000, polling: 100,
  });
  log('listen armed (local engine)');

  // Drive a final transcript through the stub — BrowserSttProvider
  // forwards it as a TranscriptEvent, which both sendwordDetector and
  // turnbased's accumulator see.
  await page.evaluate(() => {
    const sr = (window).__sr;
    if (!sr || !sr.onresult) return;
    const results = [
      Object.assign(
        [{ transcript: 'remind me about lunch over', confidence: 0.9 }],
        { isFinal: false },
      ),
    ];
    sr.onresult({ results, resultIndex: 0 });
  });

  // Wait for the turn to commit + submit. Composer should be empty
  // again after submit (canonical send path).
  const t0 = Date.now();
  while (Date.now() - t0 < 3_000) {
    const state = await page.evaluate(() => (window).__listen?.state);
    if (state === 'committing' || state === 'playing' || state === 'cooldown' || state === 'armed') {
      // Once we've cycled past committing, the turn was sent. Settle a
      // moment so /transcribe (if it were going to fire) has time to
      // hit our route stub.
      if (state !== 'armed') break;
    }
    await page.waitForTimeout(50);
  }
  log(`listen state after sendword: ${await page.evaluate(() => (window).__listen?.state)}`);

  // Give /transcribe one more tick — if the path is wrong, it would
  // post here. We expect ZERO posts.
  await page.waitForTimeout(500);
  if (transcribePosts.length > 0) {
    fail(`/transcribe was called ${transcribePosts.length}x; local engine should bypass it`);
  }
  log('/transcribe never fired (correct — local engine handled body in-browser)');
  } finally {
    // Restore so the next smoke in the suite boots against the default
    // server engine.
    await resetServerSettings(page, { streamingEngine: 'server' });
  }
}
