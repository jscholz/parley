// Bug B' (#236, sibling of Bug B / #235): the OUTBOUND user message — the
// words you typed — must survive a switch-away-and-back, not just the
// agent's reply.
//
// WHY THIS IS A DISTINCT CASE FROM reply-survives-switch-after-final:
// when a reply_final lands and the post-final durable refresh promotes the
// turn, it calls clearInflightThroughReplyFinal(chatId, replyId), which
// slices the inflight array from the reply_final's index + 1. The user_message
// echo arrives BEFORE the reply_final (user_message → reply_delta →
// reply_final order), so it sits at a LOWER index and is dropped from
// inflight by that same slice. After the promotion the user bubble exists
// ONLY in the in-memory durable store + the messages cache — its inflight
// backup is gone, exactly like the reply's.
//
// So if the post-final promotion writes the grown durable through to the
// messages cache (#235's persistGrownTranscript), the cache carries BOTH
// the user message and the reply, and a switch-away-and-back cache-paints
// both. If that write-through ever regresses (or is scoped to the reply
// only), the cache stays at the pre-turn rows: the reply AND the user
// message vanish on switch-back until the slow server reconcile heals them.
//
// This smoke stalls the switch-back server reconcile so the cache-paint
// window is the only thing that can put the rows back, and asserts the
// USER message specifically is still on screen during that window.
// Bidirectional: reverting persistGrownTranscript makes the user bubble
// vanish here (and in reply-survives), proving the guard has teeth.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'user-message-survives-switch-after-reply';
export const DESCRIPTION = 'the outbound user message (not just the reply) survives a switch-away-and-back after the post-final promotion clears it from inflight — cache write-through carries it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-usermsgsurvive-a';
const CHAT_B = 'mock-usermsgsurvive-b';
const USER_ID = 'umsg_a_live_user';
const USER_TEXT = 'LIVE-USER-MESSAGE — my own words must survive the switch';
const REPLY_ID = 'msg_a_live_reply';
const REPLY_TEXT = 'agent reply to the live user message';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(CHAT_A, {
    title: 'A — user message survives switch',
    messages: [
      { role: 'user', content: 'first message in A', parley_id: 'umsg_a_prev', timestamp: t0 },
      { role: 'assistant', content: 'first reply in A', parley_id: 'msg_a_prev', timestamp: t0 + 1 },
    ],
    lastActiveAt: Date.now(),
  });
  mock.addChat(CHAT_B, {
    title: 'B — switch target',
    messages: [
      { role: 'user', content: 'hi B', parley_id: 'umsg_b', timestamp: t0 + 200 },
      { role: 'assistant', content: 'B-REPLY', parley_id: 'msg_b', timestamp: t0 + 201 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  // We drive the user_message + reply envelopes by hand.
  mock.setAutoReplyEnabled(false);
}

const transcriptHas = (page, marker, timeout = 4000) =>
  page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    marker,
    { timeout },
  );

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. Open A. The messages cache is written with the prior two rows
  //    (no live turn yet).
  await clickRow(page, CHAT_A);
  await transcriptHas(page, 'first reply in A');
  await page.waitForTimeout(900); // let the open's reconcile fully settle
  log('A opened; messages cache holds the prior turn ✓');

  // 2. A live turn happens while A is viewed: the user's own message
  //    echoes back (handleUserMessage → appendInflight), then the agent
  //    replies. Mirror hermes: append_to_transcript persists BOTH rows
  //    server-side post-turn, so the post-final refresh's fetch returns
  //    them as durable and promotes the turn.
  mock.pushEnvelope({ type: 'user_message', chat_id: CHAT_A, message_id: USER_ID, text: USER_TEXT });
  await transcriptHas(page, USER_TEXT);
  log('live user message rendered in A ✓');

  mock.pushEnvelope({ type: 'reply_delta', chat_id: CHAT_A, message_id: REPLY_ID, text: REPLY_TEXT });
  const chatA = mock.getChat(CHAT_A);
  chatA.messages.push(
    { role: 'user', content: USER_TEXT, parley_id: USER_ID, timestamp: Date.now() / 1000 },
    { role: 'assistant', content: REPLY_TEXT, parley_id: REPLY_ID, timestamp: Date.now() / 1000 },
  );
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT_A, message_id: REPLY_ID, text: REPLY_TEXT });
  await transcriptHas(page, REPLY_TEXT);
  log('live reply rendered in A ✓');

  // 3. Let the post-final durable refresh fire (900ms timer + fetch). It
  //    promotes the turn into in-memory durable and clears inflight THROUGH
  //    the reply_final — which also drops the EARLIER user_message echo.
  //    Post-fix: persistGrownTranscript writes the grown durable (user +
  //    reply) through to the cache. Pre-fix: the cache stays at the prior
  //    two rows.
  await page.waitForTimeout(1400);
  log('post-final refresh window elapsed ✓');

  // 4. Stall A's NEXT server fetch (5s) so the switch-back cache-paint
  //    window is the ONLY thing that can put the turn back on screen.
  mock.setMessageDelay(CHAT_A, 5000);

  // 5. Switch away to B, then back to A.
  await clickRow(page, CHAT_B);
  await transcriptHas(page, 'B-REPLY');
  log('switched to B ✓');

  await clickRow(page, CHAT_A);
  await transcriptHas(page, 'first reply in A'); // prior turn paints from cache

  // 6. THE GATE: poll for ~2s — strictly SHORTER than the 5s server stall,
  //    so the switch-back reconcile CANNOT heal the transcript inside this
  //    window. The user message (inflight cleared by the post-final
  //    promotion) can only be on screen if the cache paint carried it.
  let userPresent = false;
  let replyPresent = false;
  for (let i = 0; i < 10 && !(userPresent && replyPresent); i++) {
    [userPresent, replyPresent] = await page.evaluate((markers) => {
      const txt = document.getElementById('transcript')?.textContent || '';
      return markers.map((m) => txt.includes(m));
    }, [USER_TEXT, REPLY_TEXT]);
    if (!(userPresent && replyPresent)) await page.waitForTimeout(200);
  }
  assert(userPresent,
    'USER MESSAGE vanished on switch-back during the stalled reconcile — ' +
    'the post-final promotion cleared it from inflight (it precedes the ' +
    'reply_final) but the cache write-through did not carry it, so the ' +
    'cache paint repainted from a stale pre-turn cache (#236 regression)');
  assert(replyPresent,
    'reply vanished on switch-back during the stalled reconcile (#235 regression)');
  log('user message + reply both survived the switch-back during the stalled reconcile ✓');
}
