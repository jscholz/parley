// Regression gate for the 2026-05-17 session-switch tool-history bug.
//
// Repro:
//   1. Open a chat with a completed turn containing multiple tool
//      calls. On fresh load, the transcript shows the activity row
//      with N entries — this is the SSOT-rebuild path proven by
//      tool-row-history-rebuild.mjs.
//   2. Click another session (switch AWAY).
//   3. Click the first session again (switch BACK).
//   4. Bug: the activity row is GONE. Only the user prompt + final
//      reply remain.
//
// Companion to tool-row-history-rebuild.mjs which proves history
// rebuild works on FRESH page load. This smoke covers the
// switch-away-and-back code path specifically, which goes through
// `replaySessionMessages` with the same chat_id pattern but a
// different clear-and-repaint code branch (see src/sessionResume.ts
// `sameSession === false` path: clears `renderedMessages` AND calls
// `activityRow.clearAll()` then re-renders from the same items
// response). If the history-replay activity-row reconstruction is
// only triggered by the boot/restoreSnapshot path (not by the
// switch-away-and-back replay), the rebuild is lost on switch.
//
// Asserts (mirroring tool-row-history-rebuild but across a switch):
//   1. Click chat A → activity row exists with N tool entries.
//   2. Click chat B → chat B's transcript loads (no activity row).
//   3. Click chat A again → activity row STILL exists with N entries.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'session-switch-preserves-tool-history';
export const DESCRIPTION = 'switching away from + back to a chat preserves the activity row rebuilt from state.db';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-switch-tool-history-a';
const CHAT_B = 'mock-switch-tool-history-b';

function makeAssistantToolCall(callId, toolName, args) {
  // JSON shape matching hermes' state.db.messages.tool_calls column
  // (array of OpenAI-shape function-call entries, stored as a STRING).
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

  // Chat A: a finished turn with 5 tool calls + a final reply.
  // Mirrors the production state.db shape after a multi-tool turn.
  const aMessages = [
    {
      role: 'user',
      content: 'survey the project',
      parley_id: 'umsg_switch_user_a',
      timestamp: t0,
    },
  ];
  for (let i = 0; i < 5; i++) {
    const callId = `call_switch_${i}`;
    aMessages.push({
      role: 'assistant',
      content: '',
      tool_calls: makeAssistantToolCall(callId, 'list_files', { path: `/dir/${i}` }),
      timestamp: t0 + 1 + i * 2,
    });
    aMessages.push({
      role: 'tool',
      content: JSON.stringify({ output: `result-${i}`, exit_code: 0 }),
      tool_call_id: callId,
      timestamp: t0 + 1 + i * 2 + 1,
    });
  }
  aMessages.push({
    role: 'assistant',
    content: 'A-DONE — surveyed 5 dirs.',
    parley_id: 'msg_switch_final_a',
    timestamp: t0 + 100,
  });
  mock.addChat(CHAT_A, {
    title: 'A — tool history chat',
    messages: aMessages,
    lastActiveAt: Date.now(),
  });

  // Chat B: simple chat with no tools — just somewhere to switch to.
  mock.addChat(CHAT_B, {
    title: 'B — no tools',
    messages: [
      { role: 'user', content: 'hi B', parley_id: 'umsg_b', timestamp: t0 + 200 },
      { role: 'assistant', content: 'B-REPLY', parley_id: 'msg_b', timestamp: t0 + 201 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

async function activityRowState(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('#transcript .activity-row');
    const entries = document.querySelectorAll('#transcript .activity-row [data-call-id]');
    return { rows: rows.length, entries: entries.length };
  });
}

async function transcriptIncludes(page, marker, timeout = 4000) {
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    marker,
    { timeout },
  );
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Step 1: Open chat A. Expect activity row with 5 tool entries
  // (the SSOT-rebuild path is the same as tool-row-history-rebuild,
  // included here as a baseline so the test fails fast if the
  // rebuild is itself broken).
  await clickRow(page, CHAT_A);
  await transcriptIncludes(page, 'A-DONE — surveyed 5 dirs');
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .activity-row').length === 1,
    null, { timeout: 4_000 },
  );
  let st = await activityRowState(page);
  assert(st.rows === 1, `[A initial] expected 1 activity row, got ${st.rows}`);
  assert(st.entries === 5, `[A initial] expected 5 tool entries, got ${st.entries}`);
  log(`A initial: ${st.rows} row with ${st.entries} entries ✓`);

  // Step 2: Switch AWAY to chat B. Chat B has no tools — its
  // activity row count is 0.
  await clickRow(page, CHAT_B);
  await transcriptIncludes(page, 'B-REPLY');
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('#transcript .activity-row');
      // B has no tool history — must be zero.
      return rows.length === 0
        && (document.getElementById('transcript')?.textContent || '').includes('B-REPLY');
    },
    null, { timeout: 4_000 },
  );
  log('switched to B — its transcript loaded, 0 activity rows ✓');

  // Step 3: Switch BACK to chat A. This is the regression gate.
  // After the clear-and-repaint, activityRow.clearAll() runs and
  // re-render must reconstruct the row from state.db items.
  await clickRow(page, CHAT_A);
  await transcriptIncludes(page, 'A-DONE — surveyed 5 dirs');
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .activity-row').length === 1,
    null, { timeout: 4_000 },
  );
  st = await activityRowState(page);
  assert(
    st.rows === 1,
    `[A switch-back] activity row vanished after switch-away/back: rows=${st.rows}`,
  );
  assert(
    st.entries === 5,
    `[A switch-back] expected 5 tool entries after switch, got ${st.entries}`,
  );
  log(`A switch-back: ${st.rows} row with ${st.entries} entries ✓`);

  // Step 4 (defense in depth): one more A→B→A round-trip. Catches a
  // class of bug where the FIRST switch happens to work but
  // subsequent ones don't (e.g. a stale clearAll cached state).
  await clickRow(page, CHAT_B);
  await transcriptIncludes(page, 'B-REPLY');
  await clickRow(page, CHAT_A);
  await transcriptIncludes(page, 'A-DONE — surveyed 5 dirs');
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .activity-row').length === 1,
    null, { timeout: 4_000 },
  );
  st = await activityRowState(page);
  assert(st.rows === 1, `[A 2nd switch-back] expected 1 activity row, got ${st.rows}`);
  assert(st.entries === 5, `[A 2nd switch-back] expected 5 tool entries, got ${st.entries}`);
  log(`A 2nd switch-back: ${st.rows} row with ${st.entries} entries ✓`);
}
