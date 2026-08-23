// Pins the batch-dictation durability contract (src/memoOutbox.ts
// transcribeToComposer + queue.ts toComposer routing). Regression guard
// for the data-loss bug: a long dictation recorded on a bad connection
// timed out on upload and EVAPORATED — the whole transcript was lost
// because the old transcribeToComposer was fire-and-forget (no queue, no
// retry). The fix routes dictation through the same durable IndexedDB
// outbox as memos, tagged toComposer:true so every flush branch lands the
// transcript in the composer with NO chat bubble / memo card / submit.
//
// Four behaviors:
//
//   A. online success → transcript lands in the composer, NO bubble,
//      queue drained.
//   B. upload FAILS (simulated bad connection) → blob is RETAINED in the
//      queue (NOT lost), composer untouched; a later successful flush
//      drains it to the composer. THIS is the data-loss fix.
//   C. offline → blob QUEUED immediately (persisted before any network),
//      composer untouched; reconnect + flush drains it to the composer.
//   D. oversized (>24MB) → DROPPED at the ceiling: never enqueued.
//
// Dictation must NEVER create a chat bubble (it's ephemeral INPUT, not a
// message) — asserted on every populated case.

import { waitForReady, resetServerSettings, assert } from './lib.mjs';

export const NAME = 'dictate-durable-retry';
export const DESCRIPTION = 'transcribeToComposer: durable queue — failed/offline dictation is retained + retried into composer, never a bubble';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-dictate-retry';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Dictate retry chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_dictate_seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 1000,
  });
}

// Drive transcribeToComposer with a synthetic blob. `offline` flips
// navigator.onLine before the call (the module reads it to decide
// queue-only vs immediate flush).
async function fireDictate(page, { bytes, offline = false, durationMs = 1500 }) {
  await page.evaluate(async (args) => {
    if (args.offline) {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    }
    const mod = await import('/build/memoOutbox.mjs');
    const blob = new Blob([new Uint8Array(args.bytes)], { type: 'audio/webm' });
    await mod.transcribeToComposer(blob, args.durationMs);
  }, { bytes, offline, durationMs });
}

async function setOnline(page, online) {
  await page.evaluate((v) => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v });
  }, online);
}

async function flush(page) {
  await page.evaluate(async () => {
    const mod = await import('/build/memoOutbox.mjs');
    await mod.flushOutbox();
  });
}

async function clearComposer(page) {
  await page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
  });
}

const composerValue = (page) =>
  page.evaluate(() => document.getElementById('composer-input')?.value ?? '');

const queuePending = (page) =>
  page.evaluate(async () => {
    const q = await import('/build/queue.mjs');
    return q.pending();
  });

const anyBubble = (page, text) =>
  page.evaluate((t) =>
    Array.from(document.querySelectorAll('#transcript .line.s0'))
      .filter((el) => el.dataset?.text === t || el.textContent.includes(t)).length,
    text);

export default async function run({ page, log }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', micAutoSend: false });

  // /transcribe stub with a switchable mode: 'ok' returns a transcript,
  // 'fail' aborts the request (simulates a bad-connection upload failure,
  // the trigger for the original data-loss bug).
  let mode = 'ok';
  let currentTranscript = '';
  await page.route(/\/transcribe(\?|$)/, (route) => {
    if (mode === 'fail') return route.abort('connectionfailed');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: currentTranscript }),
    });
  });

  // ── A: online success → composer gets text, NO bubble, queue drained ──
  await clearComposer(page);
  mode = 'ok';
  currentTranscript = 'alpha bravo charlie';
  await fireDictate(page, { bytes: 2048 });
  await page.waitForFunction(
    (t) => (document.getElementById('composer-input')?.value ?? '').includes(t),
    currentTranscript, { timeout: 8_000 },
  );
  assert((await composerValue(page)).includes('alpha bravo charlie'),
    'A: dictation should land in the composer');
  assert((await anyBubble(page, 'alpha bravo charlie')) === 0,
    'A: dictation must NEVER create a chat bubble');
  assert((await queuePending(page)) === 0, 'A: successful dictation should drain the queue');
  log('A ✓ online dictation → composer populated, no bubble, queue drained');

  // ── B: upload fails → blob RETAINED, then a good flush drains it ──────
  // The crux of the fix. Old behavior: transcript lost. New: queued.
  await clearComposer(page);
  mode = 'fail';
  currentTranscript = 'delta echo foxtrot';
  await fireDictate(page, { bytes: 2048 });
  // transcribeToComposer enqueues BEFORE the network attempt, so even
  // though the upload aborts the blob survives.
  assert((await queuePending(page)) === 1,
    'B: a failed dictation upload must RETAIN the blob in the queue (not evaporate)');
  assert((await composerValue(page)) === '',
    'B: failed dictation must not populate the composer yet');
  assert((await anyBubble(page, 'delta echo foxtrot')) === 0,
    'B: failed dictation must not create a bubble');
  log('B(fail) ✓ bad-connection upload retained the blob — no data loss');

  // Connection returns → retry drains the SAME blob to the composer.
  mode = 'ok';
  await flush(page);
  await page.waitForFunction(
    (t) => (document.getElementById('composer-input')?.value ?? '').includes(t),
    currentTranscript, { timeout: 8_000 },
  );
  assert((await composerValue(page)).includes('delta echo foxtrot'),
    'B: retry should drain the retained dictation to the composer');
  assert((await anyBubble(page, 'delta echo foxtrot')) === 0,
    'B: retried dictation must still be composer-only, no bubble');
  assert((await queuePending(page)) === 0, 'B: queue should be empty after successful retry');
  log('B(retry) ✓ reconnect retry drained the retained blob to composer');

  // ── C: offline queues immediately; reconnect + flush drains ──────────
  await clearComposer(page);
  mode = 'ok';
  currentTranscript = 'golf hotel india';
  await fireDictate(page, { bytes: 2048, offline: true });
  assert((await queuePending(page)) === 1,
    'C: offline dictation must be QUEUED (persisted before network)');
  assert((await composerValue(page)) === '',
    'C: offline dictation must not populate the composer until flushed');
  log('C(offline) ✓ blob queued, composer untouched');

  await setOnline(page, true);
  await flush(page);
  await page.waitForFunction(
    (t) => (document.getElementById('composer-input')?.value ?? '').includes(t),
    currentTranscript, { timeout: 8_000 },
  );
  assert((await composerValue(page)).includes('golf hotel india'),
    'C: reconnect flush should drain the queued dictation to the composer');
  assert((await anyBubble(page, 'golf hotel india')) === 0,
    'C: reconnected dictation must still be composer-only, no bubble');
  assert((await queuePending(page)) === 0, 'C: queue should be empty after flush');
  log('C(reconnect) ✓ flushOutbox drained queued dictation to composer');

  // ── D: oversized (>24MB) dropped — never enqueued ────────────────────
  await clearComposer(page);
  currentTranscript = 'should never appear';
  const before = await queuePending(page);
  await fireDictate(page, { bytes: 25 * 1024 * 1024, durationMs: 15 * 60_000 });
  assert((await queuePending(page)) === before,
    'D: oversized dictation must NOT be enqueued (would block the queue forever)');
  assert((await composerValue(page)) === '',
    'D: oversized dictation must not populate the composer');
  log('D ✓ >24MB dictation dropped at ceiling, queue + composer untouched');

  log('PASS: dictation durable retry (online / fail-retain-retry / offline-queue-flush / oversize-drop)');
}
