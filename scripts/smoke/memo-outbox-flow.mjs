// Pins the memo transcription outbox (src/memoOutbox.ts) state machine —
// the subsystem extracted from main.ts in the decomp (commit f36291e).
// That commit was pure behavior-preserving code-motion, but the outbox
// is the largest chunk that moved and had NO mocked coverage: the only
// pre-existing audio smoke (audio-transcribe-roundtrip) is BACKEND='real'
// and exercises the raw /transcribe STT pipe, not the queue → flush →
// compose routing this module owns.
//
// Drives memoOutbox directly (import of /build/memoOutbox.mjs) with a
// stubbed /transcribe so no real Deepgram quota / WebRTC is needed,
// mirroring the dictate-cursor-injection pattern. Four behaviors:
//
//   A. online + autoSend=false → transcript lands in the composer,
//      NOT submitted (user reviews before sending).
//   B. online + autoSend=true  → transcript appended AND submitted
//      (a user bubble appears; composer clears).
//   C. offline → blob is QUEUED (not transcribed); going online +
//      flushOutbox() drains it to the composer. This is the
//      record-on-a-plane → lands-on-reconnect contract.
//   D. oversized (>24MB) → DROPPED at the 24MB ceiling: never enqueued,
//      composer untouched (a too-big blob must not block the queue).
//
// Assertions key off deterministic state (composer value, #transcript
// bubbles, queue.pending()) rather than the transient #status-text
// string, which the 2s network-status poller can overwrite.

import { waitForReady, resetServerSettings, assert } from './lib.mjs';

export const NAME = 'memo-outbox-flow';
export const DESCRIPTION = 'memoOutbox: memo→composer, autoSend submits, offline queues + flushes on reconnect, >24MB dropped';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-memo-outbox';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Memo outbox chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_memo_seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 1000,
  });
}

// Drive memoOutbox.handleMemoResult with a synthetic blob of `bytes`.
// `offline` flips navigator.onLine before the call (memoOutbox reads it
// to decide queue-only vs immediate flush).
async function fireMemo(page, { bytes, autoSend = false, offline = false, durationMs = 1500 }) {
  await page.evaluate(async (args) => {
    if (args.offline) {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    }
    const mod = await import('/build/memoOutbox.mjs');
    const blob = new Blob([new Uint8Array(args.bytes)], { type: 'audio/webm' });
    await mod.handleMemoResult(blob, args.durationMs, args.autoSend, 'smoke');
  }, { bytes, autoSend, offline, durationMs });
}

async function setOnline(page, online) {
  await page.evaluate((v) => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v });
  }, online);
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

const bubbleCount = (page, text) =>
  page.evaluate((t) =>
    Array.from(document.querySelectorAll('#transcript .line.s0'))
      .filter((el) => el.dataset?.text === t || el.textContent.includes(t)).length,
    text);

export default async function run({ page, log }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', micAutoSend: false });

  // Stub /transcribe — return whatever transcript the current sub-case
  // expects. fetchWithTimeout in memoOutbox posts to a relative
  // '/transcribe' (optionally '?keyterms=…'), so match both.
  let currentTranscript = '';
  await page.route(/\/transcribe(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: currentTranscript }),
    }),
  );

  // ── A: online, autoSend=false → composer gets text, NOT submitted ──
  await clearComposer(page);
  currentTranscript = 'alpha bravo charlie';
  await fireMemo(page, { bytes: 2048, autoSend: false });
  await page.waitForFunction(
    (t) => (document.getElementById('composer-input')?.value ?? '').includes(t),
    currentTranscript, { timeout: 8_000 },
  );
  assert((await composerValue(page)).includes('alpha bravo charlie'),
    'A: transcript should land in the composer');
  assert((await bubbleCount(page, 'alpha bravo charlie')) === 0,
    'A: autoSend=false must NOT submit — no user bubble expected');
  assert((await queuePending(page)) === 0, 'A: successful transcribe should drain the queue');
  log('A ✓ online autoSend=false → composer populated, not sent');

  // ── B: online, autoSend=true → submitted (bubble appears) ──────────
  await clearComposer(page);
  currentTranscript = 'delta echo foxtrot';
  await fireMemo(page, { bytes: 2048, autoSend: true });
  await page.waitForFunction(
    (t) => Array.from(document.querySelectorAll('#transcript .line.s0'))
      .some((el) => el.dataset?.text === t || el.textContent.includes(t)),
    currentTranscript, { timeout: 8_000 },
  );
  assert((await bubbleCount(page, 'delta echo foxtrot')) >= 1,
    'B: autoSend=true must submit — a user bubble should render');
  assert((await composerValue(page)) === '',
    'B: composer should be cleared after submit');
  log('B ✓ online autoSend=true → submitted, composer cleared');

  // ── C: offline queues; online + flush drains to composer ───────────
  await clearComposer(page);
  currentTranscript = 'golf hotel india';
  await fireMemo(page, { bytes: 2048, autoSend: false, offline: true });
  assert((await queuePending(page)) === 1,
    'C: offline memo must be QUEUED (1 pending), not transcribed');
  assert((await composerValue(page)) === '',
    'C: offline memo must not populate the composer until flushed');
  log('C(offline) ✓ blob queued, composer untouched');

  await setOnline(page, true);
  await page.evaluate(async () => {
    const mod = await import('/build/memoOutbox.mjs');
    await mod.flushOutbox();
  });
  await page.waitForFunction(
    (t) => (document.getElementById('composer-input')?.value ?? '').includes(t),
    currentTranscript, { timeout: 8_000 },
  );
  assert((await composerValue(page)).includes('golf hotel india'),
    'C: reconnect flush should drain the queued memo to the composer');
  assert((await queuePending(page)) === 0, 'C: queue should be empty after flush');
  log('C(reconnect) ✓ flushOutbox drained queued memo to composer');

  // ── D: oversized (>24MB) dropped — never enqueued ──────────────────
  await clearComposer(page);
  currentTranscript = 'should never appear';
  const before = await queuePending(page);
  await fireMemo(page, { bytes: 25 * 1024 * 1024, autoSend: false, durationMs: 15 * 60_000 });
  assert((await queuePending(page)) === before,
    'D: oversized memo must NOT be enqueued (would block the queue forever)');
  assert((await composerValue(page)) === '',
    'D: oversized memo must not populate the composer');
  assert((await bubbleCount(page, 'should never appear')) === 0,
    'D: oversized memo must not be sent');
  log('D ✓ >24MB memo dropped at ceiling, queue + composer untouched');

  log('PASS: memo outbox flow (compose / autoSend / offline-queue-flush / oversize-drop)');
}
