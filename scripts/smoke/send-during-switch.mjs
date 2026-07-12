// Invariant #3 of the hardening proposal: "sends are addressed, not
// pointed" — a send committed while a switch is still in flight must
// land in the chat the user is LOOKING AT (the clicked target), never
// the chat they just left. This is the /approve-into-wrong-session
// class (field bug 2026-06-12): sendMessage historically read a
// module-global pointer that a racing continuation could leave stale.
//
// Cell shape: viewing A → click B (history held open via
// setMessageDelay) → type + send while the fetch is pending. Assert
// server-side (mock chat store) that the message landed in B, not A,
// and that the user bubble renders in B once its history lands.

import { waitForReady, openSidebar, clickRow, send, waitForDrawerQuiet } from './lib.mjs';

export const NAME = 'send-during-switch';
export const DESCRIPTION = 'Send committed mid-switch routes to the clicked/on-screen chat, never the one just left';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-sds-chat-a';
const CHAT_B = 'mock-sds-chat-b';
const MARKER = 'SDS-MIDFLIGHT-SEND';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT_A, {
    title: 'SDS A',
    messages: [{ role: 'user', content: 'SDS-A-SEED', sidekick_id: 'umsg_sds_a', timestamp: t0 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addChat(CHAT_B, {
    title: 'SDS B',
    messages: [{ role: 'user', content: 'SDS-B-SEED', sidekick_id: 'umsg_sds_b', timestamp: t0 + 10 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('SDS-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
  log('viewing A');

  // Hold B's history open, click B, and send while the fetch is
  // pending. The user is looking at B (optimistic switch) — the send
  // is addressed to B.
  mock.setMessageDelay(CHAT_B, 2500);
  await clickRow(page, CHAT_B);
  await new Promise((r) => setTimeout(r, 250));   // switch armed, fetch pending
  await send(page, MARKER);
  log('send committed while B history fetch still in flight');

  // Server-side routing assert — the authoritative check.
  await page.waitForFunction(() => true, null, { timeout: 100 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const inA = mock.getChat(CHAT_A)?.messages.some((m) => (m.content || '').includes(MARKER)) ?? false;
  const inB = mock.getChat(CHAT_B)?.messages.some((m) => (m.content || '').includes(MARKER)) ?? false;
  if (inA) throw new Error('mid-switch send landed in the chat the user LEFT (module-global pointer stale) — the /approve-class bug');
  if (!inB) throw new Error('mid-switch send never reached the clicked chat server-side');
  log('server received the send addressed to B');

  // Let B's delayed history land; the sent bubble must be visible in
  // the final B transcript (optimistic bubble survives the replay).
  await new Promise((r) => setTimeout(r, 3200));
  await waitForDrawerQuiet(page);
  const final = await page.evaluate(() => ({
    text: document.getElementById('transcript')?.textContent || '',
    loading: document.getElementById('transcript')?.classList.contains('transcript-loading') ?? false,
  }));
  if (!final.text.includes('SDS-B-SEED')) throw new Error('B history never painted after the delayed fetch landed');
  if (!final.text.includes(MARKER)) throw new Error('sent bubble missing from B after history replay — optimistic bubble lost to the late paint');
  if (final.text.includes('SDS-A-SEED')) throw new Error('foreign content: A\'s transcript painted into B');
  if (final.loading) throw new Error('spinner left armed after everything settled');
  log('bubble visible in B after the delayed history landed — send routed and survived');
}
