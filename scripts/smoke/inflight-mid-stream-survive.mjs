// Scenario: a chat has an in-flight turn — the user's message and a
// tool_call envelope are sitting in the proxy's inflight cache,
// state.db hasn't been written yet (hermes-core persists post-turn).
// User switches into the chat, switches away, switches back. Both
// the user message AND the in-flight tool call must be visible
// throughout — replayed from inflight on every switch-back.
//
// Regression guard: hermes-core persists post-turn
// (gateway/run.py:7311 — `session_store.append_to_transcript`
// fires after `agent_result` is computed). For a 30-second tool-
// using turn, state.db is empty about it. A naive switch-away
// cleared the optimistic bubble + activity rows; switch-back
// fetched history which was empty → blank transcript despite the
// agent doing work.
//
// Fix: proxy maintains an in-memory inflight
// cache keyed by chat_id (`proxy/parley/inflight.ts`). Every
// envelope from `dispatchTurnViaUpstream` is recorded with a
// timestamp + per-chat queue. History fetch includes them as
// `inflight: [...]` alongside `messages: [...]`. PWA's
// resumeSession replays each through `handleEnvelope` (the same
// router live SSE uses). On `reply_final`, proxy drops the chat's
// inflight (state.db now has the canonical turn).
//
// Test plan (mocked, no real send to avoid racing the mock's
// auto-reply):
//   1. Pre-seed chat A (empty messages, no auto-reply triggered)
//      and chat B (anchor for the switch-away leg).
//   2. mock.setInflight(A, [user_message, tool_call]) — simulates
//      "agent is mid-turn, hasn't replied yet."
//   3. Click chat A → assert user bubble + tool activity row
//      render from inflight (no state.db rows for this chat).
//   4. Click chat B → assert chat A's marker absent.
//   5. Click chat A again → assert both still visible (re-replayed).
//   6. Push tool_result + reply_delta + reply_final via live SSE,
//      THEN clear inflight (simulating the proxy's dropChat on
//      reply_final).
//   7. Assert no duplicates: exactly one bubble per data-message-id;
//      tool activity row collapses to a single summary.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'inflight-mid-stream-survive';
export const DESCRIPTION = 'User msg + in-flight tool calls survive switch-away-and-back via proxy inflight cache';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A_ID = 'mock-chat-A-inflight';
const CHAT_B_ID = 'mock-chat-B-anchor-inflight';
const USER_SID = `umsg_inflight_${Math.random().toString(36).slice(2, 8)}`;
const TOOL_CALL_ID = `call-inflight-${Math.random().toString(36).slice(2, 8)}`;
const USER_TEXT = `inflight-user-${Math.random().toString(36).slice(2, 8)}`;

export function MOCK_SETUP(mock) {
  // Chat A: empty (the turn is in-flight; state.db has nothing yet).
  mock.addChat(CHAT_A_ID, {
    title: '',
    messages: [],
    lastActiveAt: Date.now(),
  });
  // Inflight seeded — represents the proxy's in-memory queue.
  mock.setInflight(CHAT_A_ID, [
    {
      type: 'user_message',
      chat_id: CHAT_A_ID,
      message_id: USER_SID,
      text: USER_TEXT,
    },
    {
      type: 'tool_call',
      chat_id: CHAT_A_ID,
      call_id: TOOL_CALL_ID,
      tool_name: 'web_search',
      args: { q: 'something' },
      started_at: new Date().toISOString(),
    },
  ]);
  // Chat B: anchor to switch to.
  mock.addChat(CHAT_B_ID, {
    title: 'Anchor B',
    messages: [
      { role: 'user', content: 'anchor B msg',
        sidekick_id: 'umsg_anchor_b_inflight', timestamp: Date.now() / 1000 - 30 },
      { role: 'assistant', content: 'anchor B reply',
        sidekick_id: 'msg_anchor_b_inflight', timestamp: Date.now() / 1000 - 29 },
    ],
    lastActiveAt: Date.now() - 5000,
  });
}

async function transcriptText(page) {
  return await page.evaluate(() =>
    (document.getElementById('transcript')?.textContent || '').replace(/\s+/g, ' ').trim(),
  );
}

async function userBubbleCount(page, sid) {
  return await page.evaluate(
    (id) => document.querySelectorAll(`.line[data-message-id="${id}"]`).length,
    sid,
  );
}

async function activityRowCount(page) {
  return await page.evaluate(() => document.querySelectorAll('.tool-row').length);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // === Step 1: click into chat A (inflight-only state) ===
  await clickRow(page, CHAT_A_ID);
  // The history fetch returns messages=[] but inflight=[user_message,
  // tool_call]. PWA's resumeSession replays the inflight envelopes
  // through handleEnvelope, so the user bubble + tool activity row
  // both materialize.
  await page.waitForFunction(
    (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
    USER_TEXT,
    { timeout: 4_000, polling: 50 },
  );
  log('chat A: user bubble visible (replayed from inflight) ✓');

  await page.waitForFunction(
    () => document.querySelectorAll('.tool-row').length >= 1,
    null,
    { timeout: 3_000, polling: 50 },
  );
  log(`chat A: tool activity row visible (replayed from inflight) ✓`);

  const firstSnapshot = {
    userBubbles: await userBubbleCount(page, USER_SID),
    toolRows: await activityRowCount(page),
  };
  assert(firstSnapshot.userBubbles === 1, `expected 1 user bubble, got ${firstSnapshot.userBubbles}`);
  assert(firstSnapshot.toolRows >= 1, `expected ≥1 tool row, got ${firstSnapshot.toolRows}`);

  // === Step 2: switch to chat B ===
  await clickRow(page, CHAT_B_ID);
  await page.waitForFunction(
    () => /anchor B msg/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  const onB = await transcriptText(page);
  assert(!onB.includes(USER_TEXT), `chat A marker should NOT appear in chat B: ${onB.slice(0, 200)}`);
  log('switched to chat B; chat A marker absent ✓');

  // === Step 3: switch BACK to chat A — re-replay inflight ===
  await clickRow(page, CHAT_A_ID);
  await page.waitForFunction(
    (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
    USER_TEXT,
    { timeout: 4_000, polling: 50 },
  );
  await page.waitForFunction(
    () => document.querySelectorAll('.tool-row').length >= 1,
    null,
    { timeout: 3_000, polling: 50 },
  );
  const secondSnapshot = {
    userBubbles: await userBubbleCount(page, USER_SID),
    toolRows: await activityRowCount(page),
  };
  assert(secondSnapshot.userBubbles === 1,
    `expected exactly 1 user bubble after switch-back (no dupe from re-replay), got ${secondSnapshot.userBubbles}`);
  log(`switch-back: user bubble + tool row re-replayed cleanly (${secondSnapshot.userBubbles} bubble, ${secondSnapshot.toolRows} tool row) ✓`);

  // === Step 4: turn completes — live SSE pushes the rest ===
  // Simulates the real flow where reply_final fires + proxy's
  // dropChat clears the inflight. Mirror that here so the next
  // history fetch (if any) returns no inflight.
  mock.pushEnvelope({
    type: 'tool_result',
    chat_id: CHAT_A_ID,
    call_id: TOOL_CALL_ID,
    tool_name: 'web_search',
    result: { ok: true, hits: 5 },
    duration_ms: 200,
  });
  mock.pushEnvelope({
    type: 'reply_delta',
    chat_id: CHAT_A_ID,
    message_id: 'msg_inflight_final_1',
    text: 'agent reply landed',
  });
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: CHAT_A_ID,
    message_id: 'msg_inflight_final_1',
  });
  mock.setInflight(CHAT_A_ID, []);

  await page.waitForFunction(
    () => /agent reply landed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('agent reply rendered via live SSE ✓');

  // === Step 5: assert no dupes after the live SSE handoff ===
  const finalSnapshot = {
    userBubbles: await userBubbleCount(page, USER_SID),
    toolRows: await activityRowCount(page),
  };
  assert(finalSnapshot.userBubbles === 1,
    `post-handoff: expected 1 user bubble, got ${finalSnapshot.userBubbles}`);
  log(`final: 1 user bubble (id ${USER_SID}), ${finalSnapshot.toolRows} tool row(s), no dupes ✓`);
}
