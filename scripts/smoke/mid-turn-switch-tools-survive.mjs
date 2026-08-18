// Regression gate for the mid-turn switch-away-and-back code path
// where live tool envelopes have been pushed but reply_final has NOT
// yet arrived. The plugin's TurnBuffer + proxy's inflight cache claim
// to bridge this — this smoke proves it on the PWA surface.
//
// Companion to:
//   - tool-row-history-rebuild.mjs (post-final rebuild from state.db)
//   - session-switch-preserves-tool-history.mjs (post-final switch-back
//     for a finished turn, all via state.db rows)
//   - inflight-thinking-survives-switch.mjs (mid-turn switch-back
//     pattern for the thinking indicator, no tool envelopes)
//
// This one covers the GAP: live tool_call envelopes arriving DURING an
// in-flight turn, user switches AWAY (no reply_final yet), user
// switches BACK. The activity row built from those live envelopes must
// survive the switch — proving the inflight bridge re-replays the
// tool_call envelopes via `replayInflight` when the session resumes.
//
// Flow:
//   1. Open chat A. Fire 3 live tool_call envelopes. Assert row exists
//      with 3 entries.
//   2. Switch to chat B WITHOUT firing reply_final for A. Chat B's
//      transcript loads, no activity row.
//   3. Switch back to chat A. Activity row must STILL have 3 entries
//      (mid-turn inflight bridge in action).
//   4. Fire tool_result envelopes for each call_id, then reply_final.
//      Activity row finalizes (state='complete').
//   5. Reload the page. State.db now has the persisted tool history
//      (we seed it post-final to mirror real hermes' append_to_transcript
//      semantics) and the row rebuilds from there.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'mid-turn-switch-tools-survive';
export const DESCRIPTION = 'live tool envelopes survive mid-turn switch-away-and-back via the inflight bridge';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-midturn-a';
const CHAT_B = 'mock-midturn-b';
const N_TOOLS = 3;

function makeAssistantToolCall(callId, toolName, args) {
  // JSON shape matching hermes' state.db.messages.tool_calls column —
  // array of OpenAI-shape function-call entries, stored as a STRING.
  // Used only for the post-final reload step where state.db is the
  // source of truth.
  return JSON.stringify([{
    id: callId,
    call_id: callId,
    type: 'function',
    function: {
      name: toolName,
      arguments: JSON.stringify(args || {}),
    },
  }]);
}

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;

  // Chat A: pre-existing user + assistant exchange so the transcript
  // has some content before the live in-flight turn starts.
  mock.addChat(CHAT_A, {
    title: 'A — mid-turn tools',
    messages: [
      { role: 'user', content: 'first message in A',
        sidekick_id: 'umsg_a_prev', timestamp: t0 },
      { role: 'assistant', content: 'first reply in A',
        sidekick_id: 'msg_a_prev', timestamp: t0 + 1 },
    ],
    lastActiveAt: Date.now(),
  });

  // Chat B: simple chat to switch TO.
  mock.addChat(CHAT_B, {
    title: 'B — switch target',
    messages: [
      { role: 'user', content: 'hi B', sidekick_id: 'umsg_b', timestamp: t0 + 200 },
      { role: 'assistant', content: 'B-REPLY', sidekick_id: 'msg_b', timestamp: t0 + 201 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });

  // Mirror real hermes: post-turn persistence semantics. While A's
  // turn is in flight, message_count + first_user_message stay as-is
  // (we already have prior turns persisted). The new tool envelopes
  // we fire are NOT yet in state.db — they live in the inflight cache
  // until reply_final lands. We seed inflight separately below.
  mock.setAutoReplyEnabled(false);
}

async function activityRowState(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('#transcript .activity-row');
    const entries = document.querySelectorAll('#transcript .activity-row [data-call-id]');
    const states = Array.from(rows).map(r => r.dataset.state || '');
    return { rows: rows.length, entries: entries.length, states };
  });
}

async function transcriptIncludes(page, marker, timeout = 4000) {
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    marker,
    { timeout },
  );
}

function buildInflightEnvelopes(chatId, n) {
  // Same shape the proxy emits live + caches in its inflight ring
  // (proxy/parley/inflight.ts). Order matches the live broadcast
  // order so replayInflight reconstructs the row identically.
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      type: 'tool_call',
      chat_id: chatId,
      call_id: `call_midturn_${i}`,
      tool_name: 'mock_tool',
      args: { idx: i },
      started_at: new Date().toISOString(),
    });
  }
  return out;
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Step 1: open chat A. Prior turn renders, no activity row yet.
  await clickRow(page, CHAT_A);
  await transcriptIncludes(page, 'first reply in A');
  let st = await activityRowState(page);
  assert(st.rows === 0,
    `[A initial] expected 0 activity rows pre-tool-envelopes, got ${st.rows}`);
  log(`A initial: prior turn rendered, ${st.rows} activity rows ✓`);

  // Step 2: fire N live tool_call envelopes for chat A. These create
  // a single activity row with N entries — the LIVE path (handleEnv
  // → onToolCall → activityRow.appendToolCall).
  const liveEnvelopes = buildInflightEnvelopes(CHAT_A, N_TOOLS);
  for (const env of liveEnvelopes) mock.pushEnvelope(env);
  await page.waitForFunction(
    (n) => document.querySelectorAll('#transcript .activity-row [data-call-id]').length === n,
    N_TOOLS, { timeout: 4_000 },
  );
  st = await activityRowState(page);
  assert(st.rows === 1,
    `[A live] expected 1 activity row after ${N_TOOLS} live tool_calls, got ${st.rows}`);
  assert(st.entries === N_TOOLS,
    `[A live] expected ${N_TOOLS} tool entries, got ${st.entries}`);
  log(`A live: ${st.rows} row with ${st.entries} entries (state=${st.states[0]}) ✓`);

  // Step 3: seed the inflight cache for chat A. This is the proxy
  // side of the bridge — when the PWA fetches /messages for A on
  // switch-back, the inflight envelopes ride the response and
  // replayInflight() re-emits them into the live envelope handlers,
  // reconstructing the activity row from scratch. Without this step,
  // a switch-away-and-back would lose the row even with the fix in
  // place — because the mock's clear-and-replay path has no cache
  // to draw from. The real proxy populates inflightByChat in
  // proxy/parley/inflight.ts as envelopes broadcast.
  mock.setInflight(CHAT_A, liveEnvelopes);
  log(`staged inflight cache for A: ${liveEnvelopes.length} envelopes ✓`);

  // Step 4: switch AWAY to chat B (NO reply_final fired for A — the
  // turn is in flight). B has no tools, so its activity-row count is 0.
  await clickRow(page, CHAT_B);
  await transcriptIncludes(page, 'B-REPLY');
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('#transcript .activity-row');
      return rows.length === 0
        && (document.getElementById('transcript')?.textContent || '').includes('B-REPLY');
    },
    null, { timeout: 4_000 },
  );
  log(`switched to B mid-turn: B transcript loaded, 0 activity rows ✓`);

  // Step 5: switch BACK to chat A. The regression gate: replaySession
  // clears A's transcript DOM, fetches /messages (returns prior turn
  // + the inflight envelopes), and replayInflight reconstructs the
  // activity row from those envelopes. If the bridge is broken the
  // row vanishes — that's exactly the bug class this smoke pins.
  await clickRow(page, CHAT_A);
  await transcriptIncludes(page, 'first reply in A');
  await page.waitForFunction(
    (n) => {
      const rows = document.querySelectorAll('#transcript .activity-row');
      const entries = document.querySelectorAll('#transcript .activity-row [data-call-id]');
      return rows.length === 1 && entries.length === n;
    },
    N_TOOLS, { timeout: 4_000 },
  );
  st = await activityRowState(page);
  assert(st.rows === 1,
    `[A switch-back] mid-turn activity row vanished after switch-away/back: rows=${st.rows}`);
  assert(st.entries === N_TOOLS,
    `[A switch-back] expected ${N_TOOLS} tool entries after switch, got ${st.entries}`);
  log(`A switch-back: ${st.rows} row with ${st.entries} entries (state=${st.states[0]}) ✓`);

  // Step 6: now finalize the turn. Fire tool_result envelopes for
  // each call_id, then reply_final. The activity row's pendingCount
  // drops to zero → state flips to 'complete'.
  for (let i = 0; i < N_TOOLS; i++) {
    mock.pushEnvelope({
      type: 'tool_result',
      chat_id: CHAT_A,
      call_id: `call_midturn_${i}`,
      result: `result-${i}`,
      duration_ms: 100,
    });
  }
  // Persist the final assistant message + the tool history to the
  // mock's chat state — mirrors hermes' append_to_transcript firing
  // post-turn. The reload step below relies on these rows being in
  // state.db (the SSOT-rebuild path).
  const chat = mock.getChat(CHAT_A);
  const t1 = Date.now() / 1000;
  for (let i = 0; i < N_TOOLS; i++) {
    chat.messages.push({
      role: 'assistant',
      content: '',
      tool_calls: makeAssistantToolCall(`call_midturn_${i}`, 'mock_tool', { idx: i }),
      timestamp: t1 + i * 2,
    });
    chat.messages.push({
      role: 'tool',
      content: JSON.stringify({ output: `result-${i}` }),
      tool_call_id: `call_midturn_${i}`,
      timestamp: t1 + i * 2 + 1,
    });
  }
  chat.messages.push({
    role: 'assistant',
    content: 'A-DONE — used 3 tools.',
    sidekick_id: 'msg_a_final',
    timestamp: t1 + 100,
  });
  // reply_final closes the turn. After this the proxy's inflight
  // cache would be drained — clear ours to mirror that.
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: CHAT_A,
    message_id: 'msg_a_final',
    text: 'A-DONE — used 3 tools.',
  });
  mock.setInflight(CHAT_A, null);

  await transcriptIncludes(page, 'A-DONE — used 3 tools');
  await page.waitForFunction(
    () => {
      const row = document.querySelector('#transcript .activity-row');
      return row && row.dataset.state === 'complete';
    },
    null, { timeout: 4_000 },
  );
  st = await activityRowState(page);
  assert(st.rows === 1,
    `[A finalize] expected 1 activity row after reply_final, got ${st.rows}`);
  assert(st.entries === N_TOOLS,
    `[A finalize] expected ${N_TOOLS} tool entries after reply_final, got ${st.entries}`);
  assert(st.states[0] === 'complete',
    `[A finalize] expected activity row state='complete', got '${st.states[0]}'`);
  log(`A finalize: ${st.rows} row, ${st.entries} entries, state=${st.states[0]} ✓`);

  // Step 7: defense — reload. State.db now has the tool rows; the
  // SSOT-rebuild path (tool-row-history-rebuild covers it standalone)
  // must reconstruct the same single row with N entries. Catches a
  // class of bug where mid-turn live + post-final history paths
  // collide (e.g. dupe rows after reload, missing entries, etc.).
  await page.waitForTimeout(400);  // snapshot persist debounce
  await page.reload();
  await waitForReady(page);
  await transcriptIncludes(page, 'A-DONE — used 3 tools');
  await page.waitForFunction(
    (n) => {
      const rows = document.querySelectorAll('#transcript .activity-row');
      const entries = document.querySelectorAll('#transcript .activity-row [data-call-id]');
      return rows.length === 1 && entries.length === n;
    },
    N_TOOLS, { timeout: 4_000 },
  );
  st = await activityRowState(page);
  assert(st.rows === 1,
    `[A reload] expected 1 activity row after reload, got ${st.rows}`);
  assert(st.entries === N_TOOLS,
    `[A reload] expected ${N_TOOLS} tool entries after reload, got ${st.entries}`);
  log(`A reload: ${st.rows} row with ${st.entries} entries ✓`);
}
