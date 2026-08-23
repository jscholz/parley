// Regression gate for the 2026-05-17 SSOT-rebuild of activity rows
// from state.db history.
//
// Companion to tool-row-reload-dedup.mjs (which proved the dupe path
// no longer fires after stripping `.activity-row` from the snapshot).
// This smoke proves the harder invariant: an activity row that
// belonged to a past completed turn SHOULD reappear on reload — not
// vanish — because history-replay reconstructs it from state.db's
// `role='tool'` + `role='assistant' (tool_calls JSON)` rows.
//
// Setup mirrors what the hermes plugin's /items endpoint emits after
// the 2026-05-17 SQL extension:
//   - role='user' content row (user prompt)
//   - role='assistant' rows with `tool_calls` JSON (function calls)
//   - role='tool' rows with `tool_call_id` (results, paired by id)
//   - role='assistant' content row (final user-visible reply)
//
// Asserts:
//   1. After history replay, the transcript shows exactly ONE
//      activity row with N entries (one per tool call).
//   2. The final agent bubble is visible too.
//   3. Reloading the page keeps both — neither vanishes nor dupes.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'tool-row-history-rebuild';
export const DESCRIPTION = 'activity row reconstructs from state.db tool history on page load';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-tool-history';

function makeAssistantToolCall(callId, toolName, args) {
  // JSON shape that matches hermes' state.db.messages.tool_calls
  // column — array of OpenAI-shape function-call entries. Stored as
  // a STRING (hermes' on-disk representation).
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
  const messages = [
    {
      role: 'user',
      content: 'walk me through the project',
      parley_id: 'umsg_th_user',
      timestamp: t0,
    },
  ];
  // 4 tool calls, each as an assistant row (empty content, tool_calls
  // JSON populated) + matching role='tool' result row.
  for (let i = 0; i < 4; i++) {
    const callId = `call_history_${i}`;
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: makeAssistantToolCall(callId, 'list_files', { path: `/dir/${i}` }),
      timestamp: t0 + 1 + i * 2,
    });
    messages.push({
      role: 'tool',
      content: JSON.stringify({ output: `result-${i}`, exit_code: 0 }),
      tool_call_id: callId,
      timestamp: t0 + 1 + i * 2 + 1,
    });
  }
  // Final user-visible reply.
  messages.push({
    role: 'assistant',
    content: 'Done — surveyed 4 dirs.',
    parley_id: 'msg_th_final',
    timestamp: t0 + 100,
  });
  mock.addChat(CHAT_ID, {
    title: 'Tool history chat',
    messages,
    lastActiveAt: Date.now(),
  });
}

function rowCount(page) {
  return page.evaluate(() => document.querySelectorAll('#transcript .activity-row').length);
}

function toolEntryCount(page) {
  return page.evaluate(
    () => document.querySelectorAll('#transcript .activity-row [data-call-id]').length,
  );
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  await page.waitForFunction(
    () => /Done — surveyed 4 dirs/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000 },
  );
  log('chat loaded — final agent bubble visible');

  // Initial render — activity row must reconstruct from history.
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .activity-row').length === 1,
    null, { timeout: 4_000 },
  );
  const initialRows = await rowCount(page);
  const initialEntries = await toolEntryCount(page);
  assert(initialRows === 1, `expected 1 activity row from history, got ${initialRows}`);
  assert(initialEntries === 4, `expected 4 tool entries in the row, got ${initialEntries}`);
  log(`initial: ${initialRows} row with ${initialEntries} entries ✓`);

  // Reload three times. State.db is the source of truth — every
  // reload should reconstruct the SAME single activity row.
  for (let reload = 1; reload <= 3; reload++) {
    await page.waitForTimeout(400);  // snapshot persist debounce
    await page.reload();
    await waitForReady(page);
    await page.waitForFunction(
      () => /Done — surveyed 4 dirs/.test(document.getElementById('transcript')?.textContent || ''),
      null, { timeout: 4_000 },
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#transcript .activity-row').length === 1,
      null, { timeout: 4_000 },
    );
    const after = await rowCount(page);
    const afterEntries = await toolEntryCount(page);
    assert(after === 1, `reload ${reload}: expected 1 activity row, got ${after}`);
    assert(afterEntries === 4, `reload ${reload}: expected 4 tool entries, got ${afterEntries}`);
    log(`reload ${reload}: ${after} row with ${afterEntries} entries ✓`);
  }
}
