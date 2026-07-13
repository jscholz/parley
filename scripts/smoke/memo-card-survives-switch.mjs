// Memo-card writer migration (2026-07-13): pending voice-memo cards
// are memo DECORATIONS in the transcript model — addressed to the chat
// they were recorded in, rendered by the reconciler, preserved by
// keyed identity.
//
// The capability this buys (impossible before the migration, when
// cards were keyless DOM appends the reconciler wiped as stale):
// switch away from a chat with a pending memo and come back — the
// card is still there, in ITS chat, and it did NOT leak into the
// other chat.

import { waitForReady, openSidebar, clickRow, waitForDrawerQuiet } from './lib.mjs';

export const NAME = 'memo-card-survives-switch';
export const DESCRIPTION = 'Pending memo card (decoration) survives switch-away-and-back in its recorded chat; no leak into other chats';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-memo-chat-a';
const CHAT_B = 'mock-memo-chat-b';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 120;
  mock.addChat(CHAT_A, {
    title: 'Memo A',
    messages: [{ role: 'user', content: 'MEMO-A-SEED', sidekick_id: 'umsg_mm_a', timestamp: t0 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addChat(CHAT_B, {
    title: 'Memo B',
    messages: [{ role: 'user', content: 'MEMO-B-SEED', sidekick_id: 'umsg_mm_b', timestamp: t0 + 10 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('MEMO-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);

  // Stage a pending memo in chat A through the real model path:
  // registry + decoration, exactly what saveMemoAndQueue does (the
  // audio blob itself is irrelevant to the survival semantics).
  const staged = await page.evaluate(async () => {
    const memoCard = await import('/build/memoCard.mjs').catch(() => null);
    const store = await import('/build/transcript/store.mjs').catch(() => null);
    const switchCtl = await import('/build/switchController.mjs').catch(() => null);
    if (!memoCard || !store || !switchCtl) return { err: 'modules not importable' };
    const chatId = switchCtl.focusedId();
    if (!chatId) return { err: 'no focused chat' };
    const rec = {
      id: 'memo-smoke-1',
      blob: new Blob([new Uint8Array(64)], { type: 'audio/mp4' }),
      mimeType: 'audio/mp4', durationMs: 3200,
      waveform: Array.from({ length: 40 }, () => 0.4),
      transcript: null, status: 'pending', timestamp: Date.now(), chatId,
    };
    memoCard.registerRec(rec, chatId);
    store.addDecoration(chatId, { key: 'memo:memo-smoke-1', kind: 'memo', memoId: 'memo-smoke-1', timestamp: rec.timestamp });
    const el = document.querySelector('#transcript .memo-card[data-memo-id="memo-smoke-1"]');
    return { ok: !!el, chatId };
  });
  if (staged.err) throw new Error(`staging: ${staged.err}`);
  if (!staged.ok) throw new Error('memo decoration did not render a card in the recorded chat');
  log(`pending memo card rendered in ${staged.chatId}`);

  // Switch away: card must NOT appear in chat B.
  await clickRow(page, CHAT_B);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('MEMO-B-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
  const inB = await page.evaluate(() => !!document.querySelector('#transcript .memo-card'));
  if (inB) throw new Error('memo card leaked into a different chat — cards must be addressed to their recorded chat');
  log('no leak into chat B');

  // Switch back: the card must be there again (pre-migration it was
  // wiped as a stale keyless child and never re-rendered until reload).
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('MEMO-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
  const back = await page.evaluate(() => ({
    card: !!document.querySelector('#transcript .memo-card[data-memo-id="memo-smoke-1"]'),
    keyed: document.querySelector('#transcript .memo-card')?.hasAttribute('data-key') ?? false,
  }));
  if (!back.card) throw new Error('memo card GONE after switch-away-and-back — the pre-migration wipe behavior');
  if (!back.keyed) throw new Error('memo card rendered without data-key — not reconciler-owned');
  log('memo card survived switch-away-and-back, reconciler-owned');

  // Model removal: dropping the decoration removes the card.
  await page.evaluate(async (chatId) => {
    const store = await import('/build/transcript/store.mjs');
    store.removeDecoration(chatId, 'memo:memo-smoke-1');
  }, CHAT_A);
  await page.waitForFunction(
    () => !document.querySelector('#transcript .memo-card'),
    null, { timeout: 3000, polling: 50 },
  );
  log('decoration removal took the card with it');
}
