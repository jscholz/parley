// Failure-path armor for chunked transcribe (companion to
// dictate-chunked-long, which pins the happy path). The 2026-06-09 device
// wedge showed what an untested failure path costs: a fast-failing chunk
// upload looped silently forever behind a "Stalled" pill. These scenarios
// pin every branch of the flush error handling:
//
//   A. TRANSIENT mid-stream chunk failure → blob stays queued, retry
//      redoes the clip from chunk 0 and lands the stitch exactly once.
//   B. PERMANENT failure (Deepgram 400 / corrupt) → blob DROPS from the
//      queue after one attempt — no infinite retry loop.
//   C. Undecodable long blob → single-shot fallback with the escalated
//      120s budget (pinned via the attempt log line).
//   D. Reload mid-failure → blob survives in IndexedDB; flush after
//      reload completes the dictation.
//   E. Per-chunk TIMEOUT (shrunk via the setChunkTimeoutMsForTest seam)
//      → "queued, will retry" narration, retry succeeds.

import { waitForReady, resetServerSettings, assert } from './lib.mjs';

export const NAME = 'dictate-chunked-failures';
export const DESCRIPTION = 'chunked transcribe failure paths: transient retry, permanent drop, decode fallback, reload durability, chunk timeout';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-dictate-chunked-fail';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Dictate chunked failures',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_chunkfail_seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 1000,
  });
}

const PARTS = [
  'alpha bravo charlie delta echo',
  'charlie delta echo foxtrot golf',
  'echo foxtrot golf hotel india',
];
const STITCHED = 'alpha bravo charlie delta echo foxtrot golf hotel india';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(150);
  }
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', micAutoSend: false });

  // Mutable per-call plan; entry i drives call i, last entry repeats.
  //   { transcript } → ok; { error } → ok:false; { delayMs } → hold first.
  let plan = [];
  const calls = [];
  await page.route(/\/transcribe(\?|$)/, async (route) => {
    const i = calls.length;
    calls.push({ contentType: route.request().headers()['content-type'] || '' });
    const b = plan[Math.min(i, plan.length - 1)] || { transcript: 'x' };
    if (b.delayMs) await sleep(b.delayMs);
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(b.error ? { ok: false, error: b.error } : { ok: true, transcript: b.transcript ?? 'x' }),
      });
    } catch { /* request aborted client-side (timeout scenario) */ }
  });

  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));

  const clearComposer = () => page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  const composerValue = () =>
    page.evaluate(() => document.getElementById('composer-input')?.value ?? '');
  const queuePending = () =>
    page.evaluate(async () => (await import('/build/queue.mjs')).pending());
  const flushOnce = () =>
    page.evaluate(async () => (await import('/build/memoOutbox.mjs')).flushOutbox());
  // 200s valid WAV → decodable → 3 chunks (0 / 77.5 / 155 at 80s/2.5s overlap).
  const dictateLongWav = () => page.evaluate(async () => {
    const ct = await import('/build/audio/shared/chunkedTranscribe.mjs');
    const mod = await import('/build/memoOutbox.mjs');
    const rate = 8000;
    const blob = ct.encodeWav(new Float32Array(200 * rate), rate);
    await mod.transcribeToComposer(blob, 200_000);
  });

  // ── A: transient chunk failure → queued, retry idempotent ─────────────
  await clearComposer();
  plan = [{ transcript: PARTS[0] }, { error: 'HTTP 502 bad gateway' }];
  await dictateLongWav();
  await until(() => calls.length >= 2, 'A: 2 transcribe attempts (ok + 502)');
  await until(async () => (await queuePending()) === 1, 'A: blob stays queued after transient failure');
  assert(!(await composerValue()).includes(PARTS[0]),
    'A: no partial transcript may leak into the composer on a failed pass');

  plan = PARTS.map((t) => ({ transcript: t }));
  calls.length = 0;
  await until(async () => {
    await flushOnce();
    return (await composerValue()).includes(STITCHED);
  }, 'A: retry lands the stitched transcript');
  assert(calls.length === 3, `A: retry redoes the clip from chunk 0 (3 calls), got ${calls.length}`);
  const valA = await composerValue();
  assert(valA.trim() === STITCHED, `A: composer must hold the stitch exactly once, got "${valA.trim()}"`);
  assert((await queuePending()) === 0, 'A: queue drained after retry success');
  log('A ✓ transient chunk failure keeps the blob queued; retry stitches exactly once');

  // ── B: permanent failure → drop, no loop ──────────────────────────────
  await clearComposer();
  plan = [{ error: 'deepgram 400 corrupt or unsupported data' }];
  calls.length = 0;
  await dictateLongWav();
  await until(async () => (await queuePending()) === 0, 'B: permanent failure drops the blob');
  const callsAtDrop = calls.length;
  assert(callsAtDrop === 1, `B: permanent failure should stop after 1 attempt, got ${callsAtDrop}`);
  await sleep(1500); // a retry loop would issue more calls in this window
  assert(calls.length === callsAtDrop, 'B: no further attempts after the drop (no infinite loop)');
  assert((await composerValue()).trim() === '', 'B: nothing lands in the composer');
  log('B ✓ permanent failure drops the blob after one attempt');

  // ── C: undecodable long blob → single-shot fallback @120s budget ──────
  await clearComposer();
  plan = [{ transcript: 'fallback text' }];
  calls.length = 0;
  consoleLines.length = 0;
  await page.evaluate(async () => {
    const mod = await import('/build/memoOutbox.mjs');
    // 3MB of zeros: needsChunking by size+duration, but undecodable.
    const blob = new Blob([new Uint8Array(3 * 1024 * 1024)], { type: 'audio/webm' });
    await mod.transcribeToComposer(blob, 200_000);
  });
  await until(async () => (await composerValue()).includes('fallback text'),
    'C: fallback transcript lands in the composer');
  assert(calls.length === 1, `C: fallback is a single round-trip, got ${calls.length}`);
  assert(calls[0].contentType === 'audio/webm', 'C: fallback keeps the recorded mime');
  assert(consoleLines.some((l) => /single-shot .*timeout=120000ms/.test(l)),
    'C: undecodable long blob must get the escalated 120s budget');
  assert((await queuePending()) === 0, 'C: queue drained');
  log('C ✓ undecodable long blob falls back to single-shot with the 120s budget');

  // ── D: reload mid-failure → blob survives, flush completes ────────────
  await clearComposer();
  plan = [{ error: 'HTTP 503 unavailable' }];
  calls.length = 0;
  await dictateLongWav();
  await until(() => calls.length >= 1, 'D: first attempt fired');
  await until(async () => (await queuePending()) === 1, 'D: blob queued after failure');
  await page.reload();
  await waitForReady(page);
  assert((await queuePending()) === 1, 'D: blob must survive the reload in IndexedDB');
  plan = PARTS.map((t) => ({ transcript: t }));
  calls.length = 0;
  await until(async () => {
    await flushOnce();
    return (await composerValue()).includes(STITCHED);
  }, 'D: post-reload flush lands the stitched transcript');
  assert((await queuePending()) === 0, 'D: queue drained after reload + retry');
  log('D ✓ blob survives reload; post-reload flush completes the dictation');

  // ── E: per-chunk timeout (shrunk budget) → queued, retry succeeds ─────
  await clearComposer();
  plan = [{ transcript: PARTS[0] }, { delayMs: 4_000, transcript: PARTS[1] }];
  calls.length = 0;
  await page.evaluate(async () => {
    (await import('/build/memoOutbox.mjs')).setChunkTimeoutMsForTest(700);
  });
  await dictateLongWav();
  await until(() => calls.length >= 2, 'E: chunk 2 attempt fired');
  await until(async () => (await queuePending()) === 1, 'E: blob stays queued after chunk timeout');
  assert(!(await composerValue()).includes(PARTS[0]), 'E: no partial transcript after timeout');

  plan = PARTS.map((t) => ({ transcript: t }));
  calls.length = 0;
  await page.evaluate(async () => {
    (await import('/build/memoOutbox.mjs')).setChunkTimeoutMsForTest(60_000);
  });
  await until(async () => {
    await flushOnce();
    return (await composerValue()).includes(STITCHED);
  }, 'E: retry after timeout lands the stitched transcript');
  assert((await queuePending()) === 0, 'E: queue drained');
  log('E ✓ per-chunk timeout keeps the blob queued; retry completes');

  log('PASS: all five chunked-transcribe failure paths behave (transient, permanent, fallback, reload, timeout)');
}
