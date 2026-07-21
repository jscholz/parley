// Offline-first #2 (field 2026-07-21): a send while the SSE channel is
// down must NOT hard-fail (the old isConnected() gate swallowed the tap;
// after gate removal, an unqueued POST rejection flipped the bubble
// straight to `.failed`). Contract:
//
//   1. SSE down → send → optimistic user bubble renders `.pending`,
//      composer clears (the interaction commits), and the bubble STAYS
//      pending — no premature `.failed` flip for a connectivity failure.
//   2. Reconnect → the queued send flushes automatically → mock echo
//      reply arrives, the bubble finalizes (neither pending nor failed),
//      and the server holds exactly ONE copy (no double-post).
//   3. Same treatment for the DRAFT flush path (voice draft → send while
//      offline queues instead of blocking).
//
// A genuinely-refused send (answered HTTP error) keeps the existing
// `.failed` Retry affordance — covered by atomic-bubble-pending-failed.

import { waitForReady, openSidebar, clickRow, send, waitForDrawerQuiet, assert, SEL } from './lib.mjs';

export const NAME = 'send-while-offline-queues';
export const DESCRIPTION = 'SSE down: send renders a queued .pending bubble; reconnect flushes it and the reply arrives (draft flush too)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_B = 'mock-offline-send-b';
const SEED = 'OFFLINE-SEND-SEED';
const MSG1 = 'offline-queued-msg-1';
const DRAFT_MSG = 'offline-draft-msg';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_B, {
    source: 'sidekick',
    title: 'Offline send seed',
    messages: [
      { role: 'user', content: SEED, timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'ack', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

async function waitConnected(page, want) {
  await page.waitForFunction(
    (w) => window.__backend && window.__backend.isConnected() === w,
    want, { timeout: 10_000, polling: 100 },
  );
}

async function goOffline(page, mock, log) {
  mock.setStreamOutage(true);
  await waitConnected(page, false);
  log('stream outage active — isConnected()=false');
}

async function goOnline(page, mock, log) {
  mock.setStreamOutage(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitConnected(page, true);
  log('reconnected');
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_B);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    SEED, { timeout: 5_000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
  await page.evaluate(() => import('/build/backend.mjs').then((m) => { window.__backend = m; }));

  // ── Phase 1: composer send while offline ──
  await goOffline(page, mock, log);
  await send(page, MSG1);

  // Optimistic bubble renders `.pending` — the send was not swallowed.
  await page.waitForFunction(
    (m) => Array.from(document.querySelectorAll('#transcript .line.s0.pending'))
      .some((el) => (el.textContent || '').includes(m)),
    MSG1, { timeout: 4_000, polling: 50 },
  );
  log('optimistic bubble rendered .pending while offline ✓');

  // The interaction committed: composer cleared.
  const composerValue = await page.locator(SEL.composer).inputValue();
  assert(composerValue === '', `composer should clear on an offline send (queued), got ${JSON.stringify(composerValue)}`);

  // It must STAY pending — a connectivity failure is queued, not failed.
  await new Promise((r) => setTimeout(r, 1500));
  const flippedFailed = await page.evaluate(
    (m) => Array.from(document.querySelectorAll('#transcript .line.s0.failed'))
      .some((el) => (el.textContent || '').includes(m)),
    MSG1,
  );
  assert(!flippedFailed, 'offline send flipped straight to .failed — connectivity failures must queue as .pending and flush on reconnect');
  log('bubble held .pending through the outage (no premature .failed) ✓');

  // ── Reconnect: the queued send flushes, reply arrives ──
  await goOnline(page, mock, log);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(`[mock] echo: ${m}`),
    MSG1, { timeout: 8_000, polling: 100 },
  );
  log('queued send flushed on reconnect — reply arrived ✓');

  const bubbleState = await page.evaluate((m) => {
    const has = (sel) => Array.from(document.querySelectorAll(sel))
      .some((el) => (el.textContent || '').includes(m));
    return { pending: has('#transcript .line.s0.pending'), failed: has('#transcript .line.s0.failed') };
  }, MSG1);
  assert(!bubbleState.pending && !bubbleState.failed,
    `bubble should finalize after the flush, got ${JSON.stringify(bubbleState)}`);

  // Exactly one server-side copy — the flush must not double-post.
  const copies = mock.getChat(CHAT_B).messages
    .filter((m) => m.role === 'user' && m.content === MSG1).length;
  assert(copies === 1, `expected exactly 1 server copy of the queued send, got ${copies}`);
  log('exactly one server-side copy (no double-post) ✓');

  // ── Phase 2: DRAFT flush while offline queues too ──
  await goOffline(page, mock, log);
  // Seed the voice-draft block directly (module is the import-map
  // singleton main.ts initialized) and trigger the composer send path
  // with an empty composer → sendTypedMessage's draft.flush() branch.
  await page.evaluate(async (text) => {
    const d = await import('/build/draft.mjs');
    d.appendRaw(text);
  }, DRAFT_MSG);
  await page.evaluate(() => document.getElementById('composer-send')?.click());
  await page.waitForFunction(
    (m) => Array.from(document.querySelectorAll('#transcript .line.s0.pending'))
      .some((el) => (el.textContent || '').includes(m)),
    DRAFT_MSG, { timeout: 4_000, polling: 50 },
  );
  log('draft flush while offline rendered a queued .pending bubble ✓');

  await goOnline(page, mock, log);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(`[mock] echo: ${m}`),
    DRAFT_MSG, { timeout: 8_000, polling: 100 },
  );
  log('queued draft send flushed on reconnect — reply arrived ✓');
}
