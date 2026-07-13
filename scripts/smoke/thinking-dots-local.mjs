// Latency audit B1a (2026-07-13): the agent thinking dots appear
// LOCALLY at send-commit — not a server round-trip later. Every turn
// used to open with dead air: bubble painted, then nothing until the
// server's typing/first-delta envelope arrived. Now the projection
// derives a streaming placeholder from the open turn's local state.
//
// Pins, in order:
//   1. Dots at send-commit with the server FULLY silent — no auto-reply
//      AND no user_message echo. (The first cut of this smoke called
//      mock.setAutoReply?.(false), a `?.`-swallowed no-op — the real API
//      is setAutoReplyEnabled — so the mock kept replying at ~50ms and
//      the smoke passed without any local placeholder. Silence both
//      paths explicitly.)
//   2. Dots SURVIVE the user_message echo: the echo clears the
//      optimistic pendingSend long before the model's first delta; the
//      placeholder must ride the inflight echo or B1a only covers the
//      POST→echo hop instead of the dead-air window.
//   3. The real reply replaces the placeholder (no double bubble).
//   4. First-turn gate: a chat where the agent has never spoken gets NO
//      placeholder. The placeholder is DOM-indistinguishable from a real
//      reply (`.line.agent[data-message-id]`), so first-reply consumers
//      (mark-unread caret flow, "wait for first agent line" predicates)
//      would bind to the impostor — field: message-mark-unread wrote an
//      activity row keyed pending:turn:*.
//
// Also pins the new-chat pagination reset (same deploy): a fresh chat
// must NOT arm the top edge loader with the previous chat's stale
// hasMore/cursor (field nit: "why is there spinning when making a new
// chat?" — it was a bogus load-earlier for the chat just left).

import { waitForReady, openSidebar, clickRow, captureNextChatId, clickNewChat, waitForDrawerQuiet } from './lib.mjs';

export const NAME = 'thinking-dots-local';
export const DESCRIPTION = 'Thinking dots appear at send-commit (no server round-trip), survive the user_message echo, yield to the real reply; fresh chats gate the placeholder and never arm the stale edge loader';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-dots-chat';

export function MOCK_SETUP(mock) {
  // Enough history that the chat carries hasMore=true pagination —
  // the stale-edge-loader phase needs a real "previous chat had more
  // pages" state to leak. (Assistant rows also satisfy the placeholder's
  // first-turn gate: the agent has spoken in this chat.)
  const t0 = Date.now() / 1000 - 3600;
  const msgs = [];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'user', content: `DOTS turn ${i}`, sidekick_id: `u_d${i}`, timestamp: t0 + i * 60 });
    msgs.push({ role: 'assistant', content: `DOTS reply ${i}`, sidekick_id: `a_d${i}`, timestamp: t0 + i * 60 + 5 });
  }
  mock.addChat(CHAT, { title: 'Dots', messages: msgs, lastActiveAt: Date.now() - 1000 });
  mock.setHistoryFirstPageLimit(10);   // forces hasMore=true on first page
}

/** Click send and poll for `.line.agent.streaming`, returning the delay
 *  in ms (or -1 on timeout). */
async function sendAndTimeDots(page, text, timeoutMs = 4000) {
  return page.evaluate(async ({ msg, timeoutMs }) => {
    const input = document.getElementById('composer-input');
    input.value = msg;
    input.dispatchEvent(new Event('input'));
    const t0 = performance.now();
    document.getElementById('composer-send').click();
    for (;;) {
      const streaming = document.querySelector('#transcript .line.agent.streaming');
      if (streaming) return performance.now() - t0;
      if (performance.now() - t0 > timeoutMs) return -1;
      await new Promise((r) => setTimeout(r, 10));
    }
  }, { msg: text, timeoutMs });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('DOTS reply 29'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);

  // ── 1. Hold the mock FULLY silent: no auto-reply, no user_message
  // echo — the dots must come from LOCAL state alone.
  mock.setAutoReplyEnabled(false);
  mock.setSuppressUserMessageBroadcast(true);

  const dotsMs = await sendAndTimeDots(page, 'are you thinking?');
  if (dotsMs < 0) throw new Error('thinking dots never appeared after send (no server envelope was sent — they must be local)');
  log(`thinking dots at +${dotsMs.toFixed(0)}ms after send (server silent)`);
  if (dotsMs > 200) throw new Error(`dots took ${dotsMs.toFixed(0)}ms — should be synchronous with send-commit`);

  // ── 2. Dots survive the user_message echo (which clears the
  // optimistic pendingSend). Re-enable the echo path, keep replies off.
  mock.setSuppressUserMessageBroadcast(false);
  await page.evaluate(() => {
    const input = document.getElementById('composer-input');
    input.value = 'still thinking?';
    input.dispatchEvent(new Event('input'));
    document.getElementById('composer-send').click();
  });
  // Echo broadcasts ~0ms after the POST; give it time to land, then the
  // dots must STILL be up (no reply has streamed).
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('still thinking?'),
    null, { timeout: 3000, polling: 25 },
  );
  await new Promise((r) => setTimeout(r, 400));
  const dotsAfterEcho = await page.evaluate(
    () => !!document.querySelector('#transcript .line.agent.streaming'));
  if (!dotsAfterEcho) throw new Error('dots vanished when the user_message echo cleared the pendingSend — placeholder must ride the inflight echo until the reply streams');
  log('dots survived the user_message echo (pendingSend cleared, reply not yet streaming)');

  // ── 3. Real reply replaces the placeholder (no double bubble).
  mock.pushReply(CHAT, 'yes — here is the real reply');
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('here is the real reply'),
    null, { timeout: 5000, polling: 50 },
  );
  const agents = await page.evaluate(() =>
    [...document.querySelectorAll('#transcript .line.agent')].filter((el) =>
      el.classList.contains('streaming') || (el.textContent || '').includes('real reply')).length);
  if (agents !== 1) throw new Error(`expected exactly 1 live agent bubble after the real reply, got ${agents} (placeholder didn't yield)`);
  log('real reply replaced the placeholder cleanly');

  // ── Fresh chat never arms the stale edge loader ────────────────────
  // This chat has hasMore=true (paged history). New-chat must reset
  // pagination — poll for any edge loader over the fresh shell.
  await page.evaluate(() => { window.__edgeSeen = false; });
  await page.evaluate(() => {
    const obs = new MutationObserver(() => {
      if (document.querySelector('.transcript-edge-loader:not([hidden])')) window.__edgeSeen = true;
    });
    obs.observe(document.getElementById('transcript')?.parentElement || document.body, { childList: true, subtree: true, attributes: true });
  });
  const idP = captureNextChatId(page);
  await clickNewChat(page);
  await idP;
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('New chat started'),
    null, { timeout: 5000, polling: 50 },
  );
  await new Promise((r) => setTimeout(r, 1200));
  const edgeSeen = await page.evaluate(() => window.__edgeSeen);
  if (edgeSeen) throw new Error('fresh chat armed the top edge loader — stale pagination leaked across the rotation (field nit)');
  log('fresh chat: no stale edge loader');

  // ── 4. First-turn gate: the agent has never spoken in this fresh
  // chat, so a send shows NO placeholder (server still silent — the
  // suppressed echo doesn't matter here; the gate fires first).
  mock.setSuppressUserMessageBroadcast(true);
  const gateDots = await sendAndTimeDots(page, 'first message of a fresh chat', 800);
  if (gateDots >= 0) throw new Error(`placeholder appeared ${gateDots.toFixed(0)}ms after the FIRST send of a fresh chat — the first-turn gate must suppress it (mark-unread/first-reply consumers bind to the impostor)`);
  log('first-turn gate: no placeholder before the agent has spoken');
}
