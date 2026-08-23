// Batch dictation (dictateRealtime=OFF → memoOutbox.transcribeToComposer)
// — two legs of the Jonathan field bug 2026-07-21:
//
//   1. ANCHOR: the transcript must land at the composer position captured
//      when the utterance STARTED (recording start), not wherever the
//      caret sits when the flush finally completes seconds/minutes later —
//      and the insertion must not yank the user's caret from wherever
//      they moved it. (Old behavior: composer.appendText inserted at the
//      LIVE selection via focus()+execCommand.)
//
//   2. RESURRECTION: "I'll delete it, and then it'll come back." A queue
//      item whose transcript was already inserted once can be re-delivered
//      (queue.flush deletes the IDB row AFTER the handler — a failed
//      delete / crash in between leaves the row 'pending' and the 30s
//      poller re-runs it). The re-delivery must NOT re-insert: if the user
//      deleted the text, that's their edit — it stays deleted. The stale
//      row must still drain (not retry forever).

import { waitForReady, resetServerSettings, assert } from './lib.mjs';

export const NAME = 'dictate-batch-anchor-retry';
export const DESCRIPTION = 'Batch dictation lands at the recording-start anchor without caret theft; re-delivered items never re-insert deleted text';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-dictate-anchor';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Dictate anchor chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_dictate_anchor_seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 1000,
  });
}

const composerState = (page) => page.evaluate(() => {
  const ta = document.getElementById('composer-input');
  return { value: ta?.value ?? '', selStart: ta?.selectionStart ?? -1 };
});

const clearComposer = (page) => page.evaluate(() => {
  const ta = document.getElementById('composer-input');
  if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
});

const queuePending = (page) => page.evaluate(async () => {
  const q = await import('/build/queue.mjs');
  return q.pending();
});

const flush = (page) => page.evaluate(async () => {
  const mod = await import('/build/memoOutbox.mjs');
  await mod.flushOutbox();
});

export default async function run({ page, log }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', micAutoSend: false });

  let currentTranscript = '';
  await page.route(/\/transcribe(\?|$)/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, transcript: currentTranscript }),
  }));

  // ── 1: transcript lands at the recording-start anchor, caret preserved ──
  // Pre-fill "head  tail", capture the anchor at offset 5 (recording
  // start), then the user moves the caret to 0 before the flush lands.
  currentTranscript = 'INSERTED';
  await page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    ta.focus();
    ta.value = 'head  tail';
    ta.setSelectionRange(5, 5);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const anchorId = await page.evaluate(async () => {
    const composer = await import('/build/composer.mjs');
    // Anchor captured at utterance start (mic gesture site passes the
    // captured cursor here). Pre-fix builds have no createAnchor — fall
    // through to null so the smoke demonstrates the caret-chasing bug.
    return typeof composer.createAnchor === 'function' ? composer.createAnchor(5) : null;
  });
  // User moves the caret to 0 while the transcription is in flight.
  await page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    ta.focus();
    ta.setSelectionRange(0, 0);
  });
  await page.waitForTimeout(100);
  await page.evaluate(async (aid) => {
    const mod = await import('/build/memoOutbox.mjs');
    const blob = new Blob([new Uint8Array(2048)], { type: 'audio/webm' });
    await mod.transcribeToComposer(blob, 1500, aid);
  }, anchorId);
  await page.waitForFunction(
    () => (document.getElementById('composer-input')?.value ?? '').includes('INSERTED'),
    null, { timeout: 8_000 },
  );
  let s = await composerState(page);
  log(`1 after flush: value=${JSON.stringify(s.value)} caret=${s.selStart}`);
  assert(
    s.value === 'head INSERTED  tail',
    `1: transcript must land at the recording-start anchor (5), not the live caret; got ${JSON.stringify(s.value)}`,
  );
  assert(s.selStart === 0,
    `1: user caret must stay at 0 (not yanked to the inserted text); was ${s.selStart}`);
  assert((await queuePending(page)) === 0, '1: successful flush should drain the queue');
  log('1 ✓ batch transcript landed at the anchor; caret untouched');

  // ── 2: re-delivered item must not resurrect manually-deleted text ──────
  await clearComposer(page);
  currentTranscript = 'resurrect me not';
  const enqueueDup = () => page.evaluate(async () => {
    const q = await import('/build/queue.mjs');
    const blob = new Blob([new Uint8Array(1024)], { type: 'audio/webm' });
    await q.enqueue({
      id: 'dup-item-1', type: 'audio', blob, mimeType: 'audio/webm',
      durationMs: 1200, toComposer: true,
    });
  });
  await enqueueDup();
  await flush(page);
  await page.waitForFunction(
    () => (document.getElementById('composer-input')?.value ?? '').includes('resurrect me not'),
    null, { timeout: 8_000 },
  );
  log('2 first delivery ✓ transcript inserted once');

  // Re-delivery: the same queue row comes back (models queue.flush's
  // post-handler IDB delete failing / a crash between insert and delete).
  await enqueueDup();
  // The user deletes the dictated text — their edit must be final.
  await clearComposer(page);
  await flush(page);
  s = await composerState(page);
  log(`2 after re-delivery flush: value=${JSON.stringify(s.value)}`);
  assert(s.value === '',
    `2: re-delivered item must NOT re-insert text the user deleted; got ${JSON.stringify(s.value)}`);
  assert((await queuePending(page)) === 0,
    '2: the stale re-delivered row must still drain from the queue');
  log('2 ✓ re-delivery was idempotent — deleted text stayed deleted, queue drained');

  log('PASS: batch dictation anchoring + idempotent re-delivery');
}
