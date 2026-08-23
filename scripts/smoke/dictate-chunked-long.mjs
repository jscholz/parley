// Pins the chunked-transcribe path for long dictations (src/audio/shared/
// chunkedTranscribe.ts + memoOutbox flush integration). Regression guard
// for the 2026-06-09 incident: a 5-minute dictation looped forever at
// "Transcribing…" because the single-shot /transcribe round-trip kept
// blowing its 60s budget — queued → timeout → retry → timeout, no
// escalation, no chunking.
//
// The fix slices long clips at FLUSH time (decode → 16kHz mono PCM → ~80s
// WAV chunks with 2.5s overlap), transcribes each chunk in its own bounded
// round-trip, and stitches the per-chunk transcripts by deduplicating the
// words the audio overlap produced twice. Flush-time chunking also means
// blobs already sitting in the durable outbox (recorded before the fix)
// get the new path on their next flush.
//
// Behaviors pinned:
//   A. >150s clip → MULTIPLE /transcribe calls, each Content-Type audio/wav,
//      stitched transcript in the composer with NO duplicated seam words,
//      no chat bubble, queue drained.
//   B. short clip → exactly ONE /transcribe call (single-shot path intact).

import { waitForReady, resetServerSettings, assert } from './lib.mjs';

export const NAME = 'dictate-chunked-long';
export const DESCRIPTION = 'long dictation: flush-time chunked transcribe — multiple bounded round-trips, seam-deduped stitch into composer';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-dictate-chunked';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Dictate chunked chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_chunk_seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 1000,
  });
}

// Per-chunk transcripts whose ends/starts share a ≥3-word overlap — the
// stitcher must emit each shared run exactly once.
const PARTS = [
  'alpha bravo charlie delta echo',
  'charlie delta echo foxtrot golf',
  'echo foxtrot golf hotel india',
];
const STITCHED = 'alpha bravo charlie delta echo foxtrot golf hotel india';

export default async function run({ page, log }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', micAutoSend: false });

  const calls = [];
  await page.route(/\/transcribe(\?|$)/, (route) => {
    const req = route.request();
    const i = calls.length;
    calls.push({ contentType: req.headers()['content-type'] || '' });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: PARTS[Math.min(i, PARTS.length - 1)] }),
    });
  });

  const clearComposer = () => page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  const composerValue = () =>
    page.evaluate(() => document.getElementById('composer-input')?.value ?? '');
  const queuePending = () =>
    page.evaluate(async () => (await import('/build/queue.mjs')).pending());

  // ── A: 200s clip → 3 chunked WAV round-trips, stitched composer text ──
  // Synthesize the "recording" with the app's own WAV encoder (8kHz mono
  // silence — decodeToMono16k only needs a decodable container). 200s at
  // 80s chunks / 2.5s overlap slices at 0 / 77.5 / 155 → exactly 3 chunks.
  await clearComposer();
  await page.evaluate(async () => {
    const ct = await import('/build/audio/shared/chunkedTranscribe.mjs');
    const mod = await import('/build/memoOutbox.mjs');
    const rate = 8000;
    const blob = ct.encodeWav(new Float32Array(200 * rate), rate);
    await mod.transcribeToComposer(blob, 200_000);
  });
  await page.waitForFunction(
    (t) => (document.getElementById('composer-input')?.value ?? '').includes(t),
    STITCHED, { timeout: 20_000 },
  );
  assert(calls.length === 3, `A: 200s clip should make exactly 3 /transcribe calls, got ${calls.length}`);
  for (const c of calls) {
    assert(c.contentType === 'audio/wav', `A: chunk uploads must be audio/wav, got "${c.contentType}"`);
  }
  const val = await composerValue();
  assert(val.trim() === STITCHED,
    `A: composer must hold the seam-deduped stitch, got "${val.trim()}"`);
  assert(!/echo foxtrot golf.*echo foxtrot golf/.test(val),
    'A: seam words must not be duplicated');
  const bubbles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line.s0'))
      .filter((el) => el.textContent.includes('alpha bravo')).length);
  assert(bubbles === 0, 'A: dictation must never create a chat bubble');
  assert((await queuePending()) === 0, 'A: queue should drain after chunked success');
  log(`A ✓ 200s dictation → 3 WAV chunks → stitched composer text, queue drained`);

  // ── B: short clip stays single-shot ───────────────────────────────────
  await clearComposer();
  calls.length = 0;
  await page.evaluate(async () => {
    const mod = await import('/build/memoOutbox.mjs');
    const blob = new Blob([new Uint8Array(2048)], { type: 'audio/webm' });
    await mod.transcribeToComposer(blob, 1500);
  });
  await page.waitForFunction(
    () => (document.getElementById('composer-input')?.value ?? '').length > 0,
    undefined, { timeout: 8_000 },
  );
  assert(calls.length === 1, `B: short clip should make exactly 1 /transcribe call, got ${calls.length}`);
  assert(calls[0].contentType === 'audio/webm', 'B: single-shot keeps the recorded mime');
  assert((await queuePending()) === 0, 'B: queue drained');
  log('B ✓ short dictation stays single-shot with recorded mime');

  log('PASS: chunked long dictation (multi-round-trip + stitch) and single-shot short path');
}
