// Regression guard: user message bubbles disappear when switching
// between two sessions during in-flight turns.
//
// Repro pattern: multi-send juggle — two chats, two sends per chat,
// switch back and forth firing replies in interleaved order.
//
//   1. Two pre-existing chats A and B with prior content.
//   2. Send A1 → switch to B → send B1 → switch to A.
//      ↳ Both A1 and B1 in-flight. A1 user bubble must survive switch.
//   3. Send A2 (second send on A) → switch to B → send B2.
//      ↳ A1, A2, B1, B2 all in-flight.
//   4. Switch back to A. A1 + A2 user bubbles must BOTH be present.
//   5. Fire A's two replies (A1-reply, A2-reply).
//   6. Switch to B. B1 + B2 user bubbles must both be present.
//   7. Fire B's two replies.
//   8. Multi-switch A↔B verifying full transcript each time.
//
// Each step asserts bubbles by content marker (user) or messageId
// (assistant). The assertion is "exactly N visible" — too many or
// too few both fail.

import { waitForReady, openSidebar, send, clickRow, assert } from './lib.mjs';

export const NAME = 'multi-session-bubble-survival';
export const DESCRIPTION = 'User + assistant bubbles survive multi-session in-flight juggling between two chats';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-juggle-chat-a';
const CHAT_B = 'mock-juggle-chat-b';
const PROMPT_A1 = 'A1-marker hello from A first';
const PROMPT_A2 = 'A2-marker hello from A second';
const PROMPT_B1 = 'B1-marker hello from B first';
const PROMPT_B2 = 'B2-marker hello from B second';
const REPLY_A1_TEXT = 'agent reply to A1';
const REPLY_A2_TEXT = 'agent reply to A2';
const REPLY_B1_TEXT = 'agent reply to B1';
const REPLY_B2_TEXT = 'agent reply to B2';
const REPLY_A1_MSGID = 'mock-reply-a1';
const REPLY_A2_MSGID = 'mock-reply-a2';
const REPLY_B1_MSGID = 'mock-reply-b1';
const REPLY_B2_MSGID = 'mock-reply-b2';

export function MOCK_SETUP(mock) {
  // Pre-existing content so switching INTO each chat takes the
  // heavier resumeSession path (not a fresh empty chat which uses a
  // lighter render path that hides the bug).
  mock.addChat(CHAT_A, {
    title: 'Chat A — multi-session juggle',
    source: 'parley',
    messages: [
      { role: 'user', content: 'A: old user message #1', timestamp: Date.now() / 1000 - 3600 },
      { role: 'assistant', content: 'A: old agent reply #1', timestamp: Date.now() / 1000 - 3599 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B — multi-session juggle',
    source: 'parley',
    messages: [
      { role: 'user', content: 'B: old user message #1', timestamp: Date.now() / 1000 - 3600 },
      { role: 'assistant', content: 'B: old agent reply #1', timestamp: Date.now() / 1000 - 3599 },
    ],
    lastActiveAt: Date.now() - 30_000,
  });
  // Drive replies manually — keeps each turn in-flight indefinitely
  // until the test explicitly fires pushReply().
  mock.setAutoReplyEnabled(false);
  // Mirror real hermes' post-turn persistence so message_count +
  // first_user_message stay at 0 until reply_final lands.
  mock.setPostTurnPersistence(true);
}

async function userBubblesByPrefix(page, prefix) {
  return page.evaluate((p) => {
    return Array.from(document.querySelectorAll('#transcript .line.s0, #transcript .line.user'))
      .map(el => (el.querySelector('.text')?.textContent || '').trim())
      .filter(t => t.includes(p));
  }, prefix);
}

async function agentBubblesByMsgId(page, msgId) {
  return page.evaluate((id) => {
    return Array.from(document.querySelectorAll(`#transcript .line.agent[data-message-id="${CSS.escape(id)}"]`))
      .map(el => ({
        msgId: el.getAttribute('data-message-id') || '',
        streaming: el.classList.contains('streaming'),
        pending: el.classList.contains('pending'),
        text: (el.querySelector('.text')?.textContent || '').trim().slice(0, 60),
      }));
  }, msgId);
}

async function allTranscriptLines(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('#transcript .line'))
      .map(el => ({
        cls: el.className,
        msgId: el.getAttribute('data-message-id') || '',
        text: (el.querySelector('.text')?.textContent || '').trim().slice(0, 60),
      }));
  });
}

async function checkUserBubbles(page, label, expectations) {
  // expectations: { marker: expectedCount }
  for (const [marker, expected] of Object.entries(expectations)) {
    const found = (await userBubblesByPrefix(page, marker)).length;
    if (found !== expected) {
      const allLines = await allTranscriptLines(page);
      throw new Error(
        `[${label}] BUG: expected ${expected} user bubble(s) with marker "${marker}", got ${found}. ` +
        `All lines: ${JSON.stringify(allLines)}`,
      );
    }
  }
}

async function checkReplyBubble(page, label, msgId, expected) {
  const replies = await agentBubblesByMsgId(page, msgId);
  if (replies.length !== expected) {
    throw new Error(
      `[${label}] BUG: expected ${expected} reply bubble(s) with msgId "${msgId}", got ${replies.length}: ${JSON.stringify(replies)}`,
    );
  }
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Step 1: switch to A, send A1.
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(700);
  await send(page, PROMPT_A1);
  await page.waitForTimeout(400);
  await checkUserBubbles(page, 'after-A1-send', { 'A1-marker': 1 });
  log(`✓ A1 sent`);

  // Step 2: switch to B, send B1.
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(700);
  await send(page, PROMPT_B1);
  await page.waitForTimeout(400);
  await checkUserBubbles(page, 'after-B1-send', { 'B1-marker': 1 });
  log(`✓ B1 sent (A1 still in-flight in background)`);

  // Step 3: switch back to A, send A2 (second message in A).
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1200);
  await checkUserBubbles(page, 'A-after-roundtrip', { 'A1-marker': 1 });
  log(`✓ A1 survived A→B→A roundtrip`);

  await send(page, PROMPT_A2);
  await page.waitForTimeout(400);
  await checkUserBubbles(page, 'after-A2-send', { 'A1-marker': 1, 'A2-marker': 1 });
  log(`✓ A2 sent (A1, A2 both in-flight)`);

  // Step 4: switch to B, send B2.
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(1200);
  await checkUserBubbles(page, 'B-after-roundtrip', { 'B1-marker': 1 });
  log(`✓ B1 survived B→A→B roundtrip`);

  await send(page, PROMPT_B2);
  await page.waitForTimeout(400);
  await checkUserBubbles(page, 'after-B2-send', { 'B1-marker': 1, 'B2-marker': 1 });
  log(`✓ B2 sent — 4 messages in-flight (A1,A2,B1,B2)`);

  // Step 5: switch back to A. Both A1 and A2 must survive.
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1200);
  await checkUserBubbles(page, 'A-after-second-roundtrip', { 'A1-marker': 1, 'A2-marker': 1 });
  log(`✓ A1 + A2 both survived second A→B→A roundtrip`);

  // Step 6: fire A's replies (in order).
  mock.pushReply(CHAT_A, REPLY_A1_TEXT, REPLY_A1_MSGID);
  await page.waitForTimeout(400);
  await checkReplyBubble(page, 'A1-reply', REPLY_A1_MSGID, 1);
  mock.pushReply(CHAT_A, REPLY_A2_TEXT, REPLY_A2_MSGID);
  await page.waitForTimeout(400);
  await checkReplyBubble(page, 'A2-reply', REPLY_A2_MSGID, 1);
  await checkUserBubbles(page, 'A-after-replies', { 'A1-marker': 1, 'A2-marker': 1 });
  log(`✓ both A replies rendered + user bubbles intact`);

  // Step 7: switch to B. Both B sends + replies pending.
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(1200);
  await checkUserBubbles(page, 'B-after-third-roundtrip', { 'B1-marker': 1, 'B2-marker': 1 });
  log(`✓ B1 + B2 survived A reply window`);

  mock.pushReply(CHAT_B, REPLY_B1_TEXT, REPLY_B1_MSGID);
  await page.waitForTimeout(400);
  mock.pushReply(CHAT_B, REPLY_B2_TEXT, REPLY_B2_MSGID);
  await page.waitForTimeout(400);
  await checkReplyBubble(page, 'B1-reply', REPLY_B1_MSGID, 1);
  await checkReplyBubble(page, 'B2-reply', REPLY_B2_MSGID, 1);
  log(`✓ both B replies rendered`);

  // Step 8: multi-switch verification — A → B → A → B verifying
  // full transcripts at each stop. This is where a stale cache or
  // a divergence-heal that misjudges the bubble count could wipe
  // bubbles.
  for (let i = 0; i < 2; i++) {
    await clickRow(page, CHAT_A);
    await page.waitForTimeout(1000);
    await checkUserBubbles(page, `final-A-iter-${i}`, { 'A1-marker': 1, 'A2-marker': 1 });
    await checkReplyBubble(page, `final-A-iter-${i}-r1`, REPLY_A1_MSGID, 1);
    await checkReplyBubble(page, `final-A-iter-${i}-r2`, REPLY_A2_MSGID, 1);

    await clickRow(page, CHAT_B);
    await page.waitForTimeout(1000);
    await checkUserBubbles(page, `final-B-iter-${i}`, { 'B1-marker': 1, 'B2-marker': 1 });
    await checkReplyBubble(page, `final-B-iter-${i}-r1`, REPLY_B1_MSGID, 1);
    await checkReplyBubble(page, `final-B-iter-${i}-r2`, REPLY_B2_MSGID, 1);
    log(`✓ iter ${i}: full A + B transcripts preserved`);
  }
}
