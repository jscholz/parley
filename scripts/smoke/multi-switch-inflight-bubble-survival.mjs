// Regression guard: an inflight user bubble disappeared after a second
// switch away and back to a session during a mid-tool-call turn; a
// dev-refresh recovered it.
//
// The existing inflight-thinking-survives-switch.mjs pins the
// SINGLE switch-away-and-back path. This smoke pins the DOUBLE
// round-trip: away → back → away → back → bubble must still be
// there.
//
// Currently passes against the mocked rig with the realistic
// mid-tool-call inflight set (user_message + tool_call + tool_result
// + reply_delta). Keeping this as a regression guard for the simpler
// "two switch round-trips during a tool call" invariant.
//
// Setup is the same shape as inflight-thinking-survives-switch:
// pre-seed an inflight user_message envelope so /messages returns
// 0 server rows + 1 inflight envelope — that's the mid-tool-call
// state where state.db hasn't yet persisted but the proxy cache
// has the envelope.

import {
  waitForReady, openSidebar, send, captureNextChatId,
  clickNewChat, clickRow, assert,
} from './lib.mjs';

export const NAME = 'multi-switch-inflight-bubble-survival';
export const DESCRIPTION = 'User bubble in inflight cache survives TWO away-and-back round-trips (the field-bug shape)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_B = 'mock-multi-switch-target';
const PROMPT = 'check the calendar for me';

export function MOCK_SETUP(mock) {
  // Chat B — somewhere to switch TO. Some prior content so the switch
  // exercises the heavy resumeSession path (not a fresh empty chat).
  mock.addChat(CHAT_B, {
    title: 'Other chat',
    source: 'parley',
    messages: [
      { role: 'user', content: 'hi', timestamp: Date.now() / 1000 - 200 },
      { role: 'assistant', content: 'hello!', timestamp: Date.now() / 1000 - 199 },
    ],
    lastActiveAt: Date.now() - 80_000,
  });
  // Hold the in-flight window open: no auto-reply, no post-turn
  // persistence to state.db. The /messages fetch for chat A keeps
  // returning 0 server rows + inflight envelopes the entire time.
  mock.setAutoReplyEnabled(false);
  mock.setPostTurnPersistence(true);
}

async function getUserBubbles(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line.s0, #transcript .line.user'))
      .map(el => ({
        msgId: el.getAttribute('data-message-id') || '',
        text: (el.textContent || '').trim().slice(0, 80),
        classes: el.className,
      }))
  );
}

async function dumpTranscript(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line'))
      .map(el => ({
        msgId: el.getAttribute('data-message-id') || '',
        cls: el.className,
        text: (el.textContent || '').trim().slice(0, 60),
      }))
  );
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // ── Mint chat A + send the user message ──────────────────────────
  const chatAP = captureNextChatId(page);
  await clickNewChat(page);
  const chatA = await chatAP;
  log(`chat A: ${chatA}`);

  await send(page, PROMPT);
  await page.waitForTimeout(500);

  // Capture the optimistic user bubble's msgId so the staged inflight
  // envelope can use the same one (PWA dedups by id).
  const beforeSwitch = await getUserBubbles(page);
  assert(beforeSwitch.length === 1,
    `pre-switch: expected 1 user bubble, got ${beforeSwitch.length}: ${JSON.stringify(beforeSwitch)}`);
  const umsgId = beforeSwitch[0].msgId;
  assert(umsgId, `pre-switch: user bubble must have msgId, got ${JSON.stringify(beforeSwitch[0])}`);
  log(`pre-switch: user bubble present (msgId=${umsgId}) ✓`);

  // Stage inflight envelope set: mid-tool-call shape, so the inflight
  // cache holds user_message PLUS one or more tool envelopes.
  // The proxyClient reads env.text not env.content for user_message.
  // Inflight contains user_message + tool_call + tool_result + partial
  // reply_delta — the full mid-turn shape where the agent has started
  // streaming a reply but reply_final hasn't fired.
  const replyId = 'reply-inflight-1';
  mock.setInflight(chatA, [
    {
      type: 'user_message',
      chat_id: chatA,
      message_id: umsgId,
      text: PROMPT,
      timestamp: Date.now() / 1000,
    },
    {
      type: 'tool_call',
      chat_id: chatA,
      tool_call_id: 'tc_calendar_lookup',
      name: 'calendar_list_events',
      arguments: JSON.stringify({ days_ahead: 7 }),
      timestamp: Date.now() / 1000 + 1,
    },
    {
      type: 'tool_result',
      chat_id: chatA,
      tool_call_id: 'tc_calendar_lookup',
      output: '[{"event":"Sample","when":"tomorrow"}]',
      timestamp: Date.now() / 1000 + 2,
    },
    {
      type: 'reply_delta',
      chat_id: chatA,
      reply_id: replyId,
      message_id: 'msg_partial_reply',
      text: 'Let me check that for you...',
      timestamp: Date.now() / 1000 + 3,
    },
  ]);
  log(`staged inflight: user_message + tool_call + tool_result + reply_delta`);

  // ── First round-trip: A → B → A ──────────────────────────────────
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);
  log(`switched A → B`);

  await clickRow(page, chatA);
  await page.waitForTimeout(1200);

  const afterFirstBack = await getUserBubbles(page);
  const haveAfterFirst = afterFirstBack.some(b => b.text.includes(PROMPT.slice(0, 15)));
  assert(
    haveAfterFirst,
    `1st switch-back: user bubble should survive. Got: ${JSON.stringify(afterFirstBack)}\n` +
    `Full transcript: ${JSON.stringify(await dumpTranscript(page))}`,
  );
  log(`1st switch-back: user bubble preserved ✓`);

  // ── Second round-trip: A → B → A (the field-bug case) ─────────────
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);
  log(`switched A → B (2nd time)`);

  await clickRow(page, chatA);
  await page.waitForTimeout(1500);

  const afterSecondBack = await getUserBubbles(page);
  const haveAfterSecond = afterSecondBack.some(b => b.text.includes(PROMPT.slice(0, 15)));
  assert(
    haveAfterSecond,
    `BUG (field bug 2026-05-12): 2nd switch-back lost the user bubble. ` +
    `User bubbles after 2nd round-trip: ${JSON.stringify(afterSecondBack)}\n` +
    `Full transcript: ${JSON.stringify(await dumpTranscript(page))}`,
  );
  log(`2nd switch-back: user bubble preserved ✓`);
}
