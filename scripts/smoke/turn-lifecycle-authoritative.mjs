// Field 2026-09-23 (his report): "I come back to chats that are finished
// and I see it thinking … it can run for many minutes afterwards." Slack
// stayed crisp because hermes' Slack adapter rides the gateway's
// on_processing_start / on_processing_complete hooks (👀 on, 👀 off). The
// Parley plugin implemented neither, so the PWA inferred turns from
// typing / reply_final / open tool rows — and a straggler `typing` after
// the final flipped the chat back to "active", which with any unfinished
// tool row kept "Thinking" up indefinitely.
//
// The plugin now emits turn_start / turn_end from those hooks. Contract
// with a lifecycle backend:
//   1. Items-page marks paint on load (✓ on an answered message).
//   2. turn_start → 👀 on the message + the indicator, even across a
//      mid-turn reply_final (hermes is still working).
//   3. turn_end → indicator gone, ✓, an unfinished tool row stops running.
//   4. A straggler `typing` after turn_end does NOT resurrect it (the bug).
//   5. A failed turn with no reply → ✗ + inline "no reply" notice.
//   6. Marks survive a reload (items `turnAcks`).

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'turn-lifecycle-authoritative';
export const DESCRIPTION = 'hermes turn_start/turn_end drive the thinking indicator and the 👀/✓/✗ mark; straggler typing after turn_end cannot resurrect "Thinking"; failed silent turns get a notice';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:mock-turn-lifecycle';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.setTurnLifecycle(true);
  mock.setAutoReplyEnabled(false);
  mock.addChat(CHAT, {
    title: 'Lifecycle',
    messages: [
      { role: 'user', content: 'earlier question', parley_id: 'umsg_a', timestamp: t0 },
      { role: 'assistant', content: 'earlier answer', parley_id: 'msg_a', timestamp: t0 + 1 },
    ],
    lastActiveAt: Date.now(),
  });
  mock.setTurnAcks(CHAT, { umsg_a: 'success' });
}

const snap = (page) => page.evaluate(() => {
  const userLine = (id) => document.querySelector(`#transcript .line.s0[data-message-id="${id}"]`);
  const ack = (id) => userLine(id)?.querySelector(':scope > .turn-ack')?.dataset.ack ?? null;
  const notice = (id) => userLine(id)?.querySelector(':scope > .turn-notice')?.textContent ?? null;
  return {
    statusLine: document.querySelectorAll('#transcript .line.turn-status').length,
    placeholder: document.querySelectorAll('#transcript .line.agent.streaming').length,
    runningRows: document.querySelectorAll('#transcript .activity-row[data-state="in-progress"]').length,
    ackA: ack('umsg_a'), ackB: ack('umsg_b'), ackC: ack('umsg_c'),
    noticeC: notice('umsg_c'),
  };
});

const waitSnap = (page, pred, arg, timeout = 3_000) => page.waitForFunction(pred, arg, { timeout, polling: 50 });

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await waitSnap(page, () => (document.getElementById('transcript')?.textContent || '').includes('earlier answer'));

  // 1. Items-page mark paints on load.
  await waitSnap(page, () => document.querySelector('#transcript .line.s0[data-message-id="umsg_a"] > .turn-ack')?.dataset.ack === 'success');
  let s = await snap(page);
  assert(s.statusLine === 0 && s.placeholder === 0, `idle chat must show no indicator: ${JSON.stringify(s)}`);
  log('items-page ✓ painted on load; idle chat shows no indicator ✓');

  // 2. A turn starts (another device's message, so no local pending send
  // can be what carries the indicator).
  mock.pushEnvelope({ type: 'user_message', chat_id: CHAT, message_id: 'umsg_b', text: 'second question' });
  mock.pushEnvelope({ type: 'turn_start', chat_id: CHAT, turn_id: 'turn_b', user_message_id: 'umsg_b' });
  await waitSnap(page, () => document.querySelector('#transcript .line.s0[data-message-id="umsg_b"] > .turn-ack')?.dataset.ack === 'processing');
  await waitSnap(page, () => document.querySelectorAll('#transcript .line.turn-status, #transcript .line.agent.streaming').length === 1);
  log('turn_start → 👀 on the message + indicator ✓');

  // A tool that never reports back, then a mid-turn reply: hermes is
  // still working, so the indicator must stay.
  mock.pushEnvelope({ type: 'tool_call', chat_id: CHAT, call_id: 'call_b1', tool_name: 'terminal', args: { command: 'sleep 999' } });
  mock.pushEnvelope({ type: 'reply_delta', chat_id: CHAT, message_id: 'msg_b1', text: 'first part of the answer' });
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT, message_id: 'msg_b1' });
  await waitSnap(page, () => (document.getElementById('transcript')?.textContent || '').includes('first part of the answer'));
  await page.waitForTimeout(300);
  s = await snap(page);
  assert(s.statusLine + s.placeholder === 1, `indicator must survive a mid-turn reply_final while hermes works: ${JSON.stringify(s)}`);
  assert(s.ackB === 'processing', `mark must stay 👀 mid-turn: ${JSON.stringify(s)}`);
  log('mid-turn reply_final keeps the indicator and 👀 ✓');

  // 3. hermes finishes.
  mock.pushEnvelope({ type: 'turn_end', chat_id: CHAT, turn_id: 'turn_b', user_message_id: 'umsg_b', outcome: 'success', replied: true, active_turns: 0 });
  await waitSnap(page, () => document.querySelectorAll('#transcript .line.turn-status, #transcript .line.agent.streaming').length === 0);
  s = await snap(page);
  assert(s.ackB === 'success', `turn_end success → ✓: ${JSON.stringify(s)}`);
  assert(s.runningRows === 0, `an unanswered tool row must stop "running" once the turn ended: ${JSON.stringify(s)}`);
  log('turn_end → indicator gone, ✓, tool row settled ✓');

  // 4. THE BUG: a straggler typing (and a stale heartbeat) after the end.
  mock.pushEnvelope({ type: 'typing', chat_id: CHAT });
  mock.pushEnvelope({ type: 'status', chat_id: CHAT, text: '⏳ Working — 3 min — iteration 4/60, terminal', state: 'working' });
  mock.pushEnvelope({ type: 'typing', chat_id: CHAT });
  await page.waitForTimeout(1_000);
  s = await snap(page);
  assert(s.statusLine === 0 && s.placeholder === 0, `straggler typing/status after turn_end must not resurrect "Thinking": ${JSON.stringify(s)}`);
  log('straggler typing + heartbeat after turn_end ignored ✓');

  // 5. A turn that fails without replying.
  mock.pushEnvelope({ type: 'user_message', chat_id: CHAT, message_id: 'umsg_c', text: 'third question' });
  mock.pushEnvelope({ type: 'turn_start', chat_id: CHAT, turn_id: 'turn_c', user_message_id: 'umsg_c' });
  await waitSnap(page, () => document.querySelector('#transcript .line.s0[data-message-id="umsg_c"] > .turn-ack')?.dataset.ack === 'processing');
  mock.pushEnvelope({ type: 'turn_end', chat_id: CHAT, turn_id: 'turn_c', user_message_id: 'umsg_c', outcome: 'failure', replied: false, active_turns: 0 });
  await waitSnap(page, () => !!document.querySelector('#transcript .line.s0[data-message-id="umsg_c"] > .turn-notice'));
  s = await snap(page);
  assert(s.ackC === 'failure', `failed turn → ✗: ${JSON.stringify(s)}`);
  assert(/failed/i.test(s.noticeC || ''), `failed silent turn → notice: ${JSON.stringify(s)}`);
  assert(s.statusLine === 0 && s.placeholder === 0, `failed turn leaves no indicator: ${JSON.stringify(s)}`);
  log('failed silent turn → ✗ + "no reply" notice ✓');

  // 6. Reload: marks come back from the items page. Persist the live
  // turn's rows first, as hermes would have.
  const now = Date.now() / 1000;
  mock.getChat(CHAT).messages.push(
    { role: 'user', content: 'second question', parley_id: 'umsg_b', timestamp: now - 5 },
    { role: 'assistant', content: 'first part of the answer', parley_id: 'msg_b1', timestamp: now - 4 },
    { role: 'user', content: 'third question', parley_id: 'umsg_c', timestamp: now - 2 },
  );
  await page.reload();
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await waitSnap(page, () => document.querySelector('#transcript .line.s0[data-message-id="umsg_c"] > .turn-ack')?.dataset.ack === 'failure', null, 5_000);
  s = await snap(page);
  assert(s.ackA === 'success', `✓ on the earlier message survives reload: ${JSON.stringify(s)}`);
  assert(s.statusLine === 0 && s.placeholder === 0, `reloaded idle chat shows no indicator: ${JSON.stringify(s)}`);
  log('marks survive reload; no indicator ✓');
}
