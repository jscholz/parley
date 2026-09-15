// Contract (2026-09-15 — his report: "i keep reopening old sessions and
// that thinking thing is still there … these signals need to be
// correlated with real agent state"): the in-flight indicator follows the
// SERVER's word on whether a turn is running (items `turnActive`), never
// history alone.
//
//   1. A chat whose history replays a user message with no reply (the
//      phantom a dead turn used to leave in the turn buffer) but whose
//      server says turnActive=false shows NO dots and NO "Thinking" line.
//   2. The same chat with turnActive=true shows the indicator.
//   3. A live reply_final flips it off in place without a refetch.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'stale-inflight-no-dots';
export const DESCRIPTION = 'in-flight indicators follow the server turnActive flag: a dead turn replayed as inflight shows nothing; a live one shows dots; reply_final clears in place';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:mock-stale-inflight';
const OTHER = 'parley:mock-stale-inflight-other';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 7200;
  mock.addChat(CHAT, {
    title: 'Ghost turn',
    messages: [
      { role: 'user', content: 'first question', parley_id: 'umsg_g0', timestamp: t0 },
      { role: 'assistant', content: 'first answer', parley_id: 'msg_g0', timestamp: t0 + 1 },
    ],
    lastActiveAt: Date.now() - 3600_000,
  });
  mock.addChat(OTHER, {
    title: 'Elsewhere',
    messages: [{ role: 'user', content: 'other seed', parley_id: 'umsg_o0', timestamp: t0 }],
    lastActiveAt: Date.now(),
  });
  // The phantom: a user message with no reply, replayed as inflight — but
  // the server knows no turn is running.
  mock.setInflight(CHAT, [
    { type: 'user_message', chat_id: CHAT, message_id: 'umsg_ghost', text: 'a question that never got answered', timestamp: t0 + 3600 },
  ]);
  mock.setTurnActive(CHAT, false);
  mock.setAutoReplyEnabled(false);
}

const indicators = (page) => page.evaluate(() => ({
  placeholder: document.querySelectorAll('#transcript .line.agent.streaming').length,
  statusLine: document.querySelectorAll('#transcript .line.turn-status').length,
  ghostShown: !!Array.from(document.querySelectorAll('#transcript .line.s0')).find((el) => (el.textContent || '').includes('never got answered')),
}));

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. Dead turn → the message is there, the indicator is not.
  await clickRow(page, CHAT);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('never got answered'),
    null, { timeout: 5_000, polling: 50 },
  );
  await page.waitForTimeout(600);   // past any debounce that could add dots late
  let ind = await indicators(page);
  assert(ind.ghostShown, 'the unanswered user message still renders (history is not hidden)');
  assert(ind.placeholder === 0, `no streaming placeholder for a dead turn (got ${ind.placeholder})`);
  assert(ind.statusLine === 0, `no "Thinking" line for a dead turn (got ${ind.statusLine})`);
  log('dead turn: message shown, no indicator ✓');

  // 2. Same history, server says a turn IS running → indicator shows.
  mock.setTurnActive(CHAT, true);
  await clickRow(page, OTHER);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('other seed'),
    null, { timeout: 5_000, polling: 50 },
  );
  await clickRow(page, CHAT);
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line.agent.streaming, #transcript .line.turn-status').length > 0,
    null, { timeout: 5_000, polling: 50 },
  );
  log('live turn: indicator shows ✓');

  // 3. A live reply_final ends it in place.
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT, message_id: 'msg_ghost_final', text: 'here is the answer at last', replyId: 'msg_ghost_final' });
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line.agent.streaming, #transcript .line.turn-status').length === 0,
    null, { timeout: 5_000, polling: 50 },
  );
  log('reply_final cleared the indicator in place ✓');
  mock.setTurnActive(CHAT, null);
}
