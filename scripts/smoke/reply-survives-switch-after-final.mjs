// Bug B (field 2026-06-14, desktop): the agent's full reply lands after
// the tool calls and renders in the chat. The user switches away to a
// different chat and back — and the just-arrived reply is GONE for
// 10-15s before it reappears.
//
// ROOT CAUSE (proven by this repro): when a reply_final lands while the
// chat is viewed, schedulePostFinalDurableRefresh (backendEventHandlers.ts)
// fetches the freshly-mirrored server rows and PROMOTES the reply from the
// inflight buffer into the in-memory durable store, then clears the inflight
// reply_final (its only backup). But that path does NOT refresh the
// structured messages cache (sessionCache) — only loadEarlier/loadLater/
// drill write it. So the messages cache still holds the PRE-reply rows.
// On switch-back, sessionDrawer.resume paints CACHE-FIRST from that stale
// cache: setDurable(stale) clobbers the in-memory durable that held the
// reply, and the inflight backup is already gone. The reply vanishes until
// the (slow) server reconcile lands — exactly the 10-15s gap.
//
// This smoke stalls the switch-back server reconcile so the cache-paint
// window is observable, and asserts the reply is STILL on screen during
// that window. Failing-first on current code (reply absent during the
// stall); passes once the post-final promotion writes through to the cache.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'reply-survives-switch-after-final';
export const DESCRIPTION = 'a reply_final promoted to durable while viewed survives a switch-away-and-back without a stale-cache vanish';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-replysurvive-a';
const CHAT_B = 'mock-replysurvive-b';
const REPLY_ID = 'msg_a_live_reply';
const REPLY_TEXT = 'LIVE-REPLY-AFTER-TOOLS — this must survive the switch';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(CHAT_A, {
    title: 'A — reply survives switch',
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
  // No auto-reply: we drive the live reply envelopes by hand.
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

  // 1. Open A. The structured messages cache is written with the PRIOR
  //    two rows (no live reply yet).
  await clickRow(page, CHAT_A);
  await transcriptHas(page, 'first reply in A');
  // Let the open's resume server reconcile FULLY settle so the messages
  // cache is written with exactly the prior two rows. This is the field
  // ordering: you open a chat (cache written), THEN a reply streams in.
  await page.waitForTimeout(900);
  log('A opened; messages cache holds the prior turn ✓');

  // 2. A live reply lands while A is viewed: stream a delta then final.
  //    handleReplyFinal appends the reply_final to inflight (renders the
  //    bubble) AND schedules the post-final durable refresh (900ms).
  mock.pushEnvelope({ type: 'reply_delta', chat_id: CHAT_A, message_id: REPLY_ID, text: REPLY_TEXT });
  // Mirror hermes: the reply is now persisted server-side (state.db row),
  // so the post-final refresh's fetch returns it as a durable row and
  // promotes it (and clears the inflight backup).
  const chatA = mock.getChat(CHAT_A);
  chatA.messages.push({
    role: 'assistant', content: REPLY_TEXT, parley_id: REPLY_ID, timestamp: Date.now() / 1000,
  });
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT_A, message_id: REPLY_ID, text: REPLY_TEXT });
  await transcriptHas(page, REPLY_TEXT);
  log('live reply rendered in A ✓');

  // 3. Let the post-final durable refresh fire (900ms timer + fetch). It
  //    promotes the reply into in-memory durable and clears the inflight
  //    reply_final. Pre-fix: the messages cache is NOT rewritten — stale.
  await page.waitForTimeout(1400);
  log('post-final refresh window elapsed ✓');

  // 4. Stall A's NEXT server fetch (5s) so the switch-back cache-paint
  //    window — before the server reconcile would heal it — is the only
  //    thing that can put the reply back on screen for the assertion.
  mock.setMessageDelay(CHAT_A, 5000);

  // 5. Switch away to B, then back to A.
  await clickRow(page, CHAT_B);
  await transcriptHas(page, 'B-REPLY');
  log('switched to B ✓');

  await clickRow(page, CHAT_A);
  // Prior turn paints instantly from cache; the reply must be there too.
  await transcriptHas(page, 'first reply in A');

  // 6. THE GATE: poll the transcript for ~2.5s — well inside the 5s stall,
  //    so the server reconcile CANNOT be the source. The reply can only be
  //    on screen if the cache paint carried it. Pre-fix the cache is stale
  //    (post-final never wrote it through) → reply absent the whole window
  //    → FAIL. Post-fix the cache holds the promoted reply → cache paint
  //    shows it immediately → PASS.
  // Self-controlled bounded poll: check for ~2s — strictly SHORTER than the
  // 5s server stall above, so the switch-back reconcile CANNOT heal the
  // transcript inside this window. The reply can only be on screen if the
  // cache paint carried it. Don't use page.waitForFunction's own timeout —
  // it does not honor a sub-default per-call timeout here.
  let present = false;
  for (let i = 0; i < 10 && !present; i++) {
    present = await page.evaluate(
      (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
      REPLY_TEXT,
    );
    if (!present) await page.waitForTimeout(200);
  }
  assert(present,
    'reply VANISHED on switch-back during the stalled server reconcile — ' +
    'cache paint repainted from a stale messages cache that lacked the promoted reply');
  log('reply survived the switch-back during the stalled reconcile ✓');
}
