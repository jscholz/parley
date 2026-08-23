// Pins the Listen-turn durability contract (src/memoOutbox.ts
// transcribeListenTurn + the listenTurn flush branch). Regression guard
// for the 2026-06-10 field bug: a committed turn-based call utterance was
// POSTed to /transcribe with a bare fetch (no timeout, no persistence) —
// the connection died, the request hung, and ending the call evaporated
// the turn entirely. The fix routes committed listen turns through the
// same durable IndexedDB outbox as memos/dictation, tagged
// listenTurn:true + commitReason + chatId.
//
// Behaviors:
//
//   A. online success, sendword commit → sendword STRIPPED, message
//      auto-SENT (user bubble), queue drained.
//   B. upload FAILS (dead connection) → blob RETAINED in the queue, no
//      send; a later successful flush auto-sends it. THIS is the fix.
//   C. chat switched between commit and flush → transcript lands in the
//      COMPOSER for review (never auto-sends into the wrong chat).
//   D. empty transcript → dropped quietly, nothing sent, queue drained.
//   E. TEXT lane (local Web Speech engine, memoOutbox.sendListenText):
//      committed while gateway is down → text RETAINED in the queue
//      (composer.submit silently no-ops offline, so the flush handler
//      must throw to keep the item); reconnect flush auto-sends it.

import { waitForReady, resetServerSettings, pollUntil, assert } from './lib.mjs';

export const NAME = 'listen-turn-durable-retry';
export const DESCRIPTION = 'transcribeListenTurn + sendListenText: committed call turns (audio + local-engine text) ride the durable outbox — retained on dead connection, auto-sent on retry, composer review cross-chat';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-listen-turn-retry';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Listen turn retry chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_listen_seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 1000,
  });
}

async function fireListenTurn(page, { bytes, reason = 'silence', chatId = null }) {
  await page.evaluate(async (args) => {
    const mod = await import('/build/memoOutbox.mjs');
    const blob = new Blob([new Uint8Array(args.bytes)], { type: 'audio/webm' });
    await mod.transcribeListenTurn(blob, args.reason, args.chatId);
  }, { bytes, reason, chatId });
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

const userBubbleCount = (page, text) =>
  page.evaluate((t) =>
    Array.from(document.querySelectorAll('#transcript .line.s0'))
      .filter((el) => el.dataset?.text === t || el.textContent.includes(t)).length,
    text);

const currentChatId = (page) =>
  page.evaluate(async () => {
    const b = await import('/build/backend.mjs');
    return b.getCurrentSessionId?.() ?? null;
  });

export default async function run({ page, log }) {
  await waitForReady(page);
  // commitPhrase default is 'over' — pin it so the sendword-strip
  // assertion in A can't drift with a changed default.
  await resetServerSettings(page, { streamingEngine: 'server', commitPhrase: 'over' });

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

  // ── A: online sendword commit → stripped + auto-sent, queue drained ──
  await clearComposer(page);
  mode = 'ok';
  currentTranscript = 'lima mike november over';
  const liveChat = await currentChatId(page);
  await fireListenTurn(page, { bytes: 2048, reason: 'sendword', chatId: liveChat });
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#transcript .line.s0'))
      .some((el) => el.textContent.includes('lima mike november')),
    null, { timeout: 8_000 },
  );
  assert((await userBubbleCount(page, 'lima mike november')) >= 1,
    'A: committed turn should auto-send as a user message');
  const bubbleHasSendword = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line.s0'))
      .some((el) => /lima mike november over/.test(el.textContent)));
  assert(!bubbleHasSendword, 'A: trailing sendword must be stripped from the sent message');
  assert((await queuePending(page)) === 0, 'A: successful turn should drain the queue');
  log('A ✓ online turn auto-sent with sendword stripped, queue drained');

  // ── B: dead connection → blob retained; reconnect flush auto-sends ───
  // The crux: old inline fetch lost the turn. New path keeps it queued.
  mode = 'fail';
  currentTranscript = 'papa quebec romeo';
  await fireListenTurn(page, { bytes: 2048, reason: 'silence', chatId: liveChat });
  assert((await queuePending(page)) === 1,
    'B: a failed turn upload must RETAIN the blob in the queue (not evaporate)');
  assert((await userBubbleCount(page, 'papa quebec romeo')) === 0,
    'B: failed turn must not send anything yet');
  log('B(fail) ✓ dead-connection turn retained in the durable queue');

  mode = 'ok';
  await flush(page);
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#transcript .line.s0'))
      .some((el) => el.textContent.includes('papa quebec romeo')),
    null, { timeout: 8_000 },
  );
  assert((await queuePending(page)) === 0, 'B: queue should drain after successful retry');
  log('B(retry) ✓ reconnect flush auto-sent the retained turn');

  // ── C: chat switched before flush → composer review, NOT sent ────────
  await clearComposer(page);
  mode = 'fail';
  currentTranscript = 'sierra tango uniform';
  await fireListenTurn(page, { bytes: 2048, reason: 'silence', chatId: 'some-other-chat-id' });
  assert((await queuePending(page)) === 1, 'C: failed turn queued');
  mode = 'ok';
  await flush(page);
  await page.waitForFunction(
    (t) => (document.getElementById('composer-input')?.value ?? '').includes(t),
    currentTranscript, { timeout: 8_000 },
  );
  assert((await composerValue(page)).includes('sierra tango uniform'),
    'C: cross-chat late flush should land in the composer for review');
  assert((await userBubbleCount(page, 'sierra tango uniform')) === 0,
    'C: cross-chat late flush must NOT auto-send');
  assert((await queuePending(page)) === 0, 'C: queue drained after composer routing');
  log('C ✓ cross-chat recovery routed to composer, not auto-sent');

  // ── D: empty transcript → dropped quietly ─────────────────────────────
  await clearComposer(page);
  mode = 'ok';
  currentTranscript = '';
  await fireListenTurn(page, { bytes: 2048, reason: 'silence', chatId: liveChat });
  // Give the flush a beat to settle, then confirm drop with no send.
  await pollUntil(page, async () => {
    const q = await import('/build/queue.mjs');
    return (await q.pending()) === 0;
  }, null, { timeout: 8_000, label: 'D: queue never drained after empty-transcript flush' });
  assert((await composerValue(page)) === '', 'D: empty transcript must not populate the composer');
  log('D ✓ empty transcript dropped, queue drained, nothing sent');

  // ── E: TEXT lane (local engine) — offline retain, reconnect auto-send ─
  await clearComposer(page);
  mode = 'ok';
  await page.evaluate(async (chatId) => {
    const b = await import('/build/backend.mjs');
    b.disconnect();
    const mod = await import('/build/memoOutbox.mjs');
    await mod.sendListenText('victor whiskey xray', chatId);
  }, liveChat);
  assert((await queuePending(page)) === 1,
    'E: text turn committed while offline must be RETAINED in the queue');
  assert((await userBubbleCount(page, 'victor whiskey xray')) === 0,
    'E: offline text turn must not send anything yet');
  log('E(offline) ✓ local-engine text turn retained in the durable queue');

  await page.evaluate(async () => {
    const b = await import('/build/backend.mjs');
    b.reconnect();
  });
  await pollUntil(page, async () => {
    const b = await import('/build/backend.mjs');
    return b.isConnected();
  }, null, { timeout: 8_000, label: 'E: backend never reported connected after reconnect()' });
  await flush(page);
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#transcript .line.s0'))
      .some((el) => el.textContent.includes('victor whiskey xray')),
    null, { timeout: 8_000 },
  );
  assert((await queuePending(page)) === 0, 'E: queue should drain after reconnect flush');
  log('E(retry) ✓ reconnect flush auto-sent the retained text turn');

  log('PASS: listen-turn durable retry (sendword-strip send / fail-retain-retry / cross-chat review / empty-drop / text-lane offline retain)');
}
