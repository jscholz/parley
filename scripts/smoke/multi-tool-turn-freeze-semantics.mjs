// Regression gate for the activity-row "freeze on user message"
// invariant during history replay.
//
// Intent (src/activityRow.ts::freezeOnUserMessage docstring):
//   When a new user message lands, the currently-in-progress activity
//   row is frozen, and the NEXT tool call after that user message
//   starts a FRESH activity row. End result: a chat with multiple
//   tool-using turns shows ONE activity row PER turn, segmented by
//   user messages.
//
// What this smoke proves:
//   Pre-seed state.db with TWO turns of tool-calls separated by an
//   interleaved user message. After clicking into the chat (which
//   runs renderHistoryMessage over the message list), the transcript
//   should show TWO distinct .activity-row DOM elements:
//     - row 1: 2 entries (the first turn's tool calls)
//     - row 2: 1 entry  (the second turn's tool call)
//   And the DOM order must be:
//     user_1 → activity_row[2 entries] → assistant_final_1
//          → user_2 → activity_row[1 entry] → assistant_final_2
//
// If the smoke fails because freezeOnUserMessage is NOT triggered by
// renderHistoryMessage iterating user-role rows (it currently isn't —
// only the live onSend path calls it), the bug manifests as ONE merged
// activity row holding all 3 entries, anchored in the wrong DOM
// position relative to the second turn.
//
// Companion smoke: tool-row-history-rebuild.mjs proves the single-turn
// reconstruction. This smoke covers the harder multi-turn invariant.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'multi-tool-turn-freeze-semantics';
export const DESCRIPTION = 'history replay segments activity rows by user-message boundaries';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-multi-tool-turn-freeze';

function makeAssistantToolCall(callId, toolName, args) {
  // JSON shape that matches hermes' state.db.messages.tool_calls
  // column — array of OpenAI-shape function-call entries stored as
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
    // ── Turn 1 ──────────────────────────────────────────────────────
    {
      role: 'user',
      content: 'first user prompt — please run two tools',
      parley_id: 'umsg_turn1_user',
      timestamp: t0,
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: makeAssistantToolCall('call_1', 'list_files', { path: '/dir/a' }),
      timestamp: t0 + 1,
    },
    {
      role: 'tool',
      content: JSON.stringify({ output: 'result-1', exit_code: 0 }),
      tool_call_id: 'call_1',
      timestamp: t0 + 2,
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: makeAssistantToolCall('call_2', 'read_file', { path: '/dir/a/x' }),
      timestamp: t0 + 3,
    },
    {
      role: 'tool',
      content: JSON.stringify({ output: 'result-2', exit_code: 0 }),
      tool_call_id: 'call_2',
      timestamp: t0 + 4,
    },
    {
      role: 'assistant',
      content: 'Turn 1 reply — surveyed two files.',
      parley_id: 'msg_turn1_final',
      timestamp: t0 + 5,
    },
    // ── Turn 2 (separated by interleaved user message) ──────────────
    {
      role: 'user',
      content: 'second user prompt — now do one more',
      parley_id: 'umsg_turn2_user',
      timestamp: t0 + 10,
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: makeAssistantToolCall('call_3', 'list_files', { path: '/dir/b' }),
      timestamp: t0 + 11,
    },
    {
      role: 'tool',
      content: JSON.stringify({ output: 'result-3', exit_code: 0 }),
      tool_call_id: 'call_3',
      timestamp: t0 + 12,
    },
    {
      role: 'assistant',
      content: 'Turn 2 reply — surveyed one more dir.',
      parley_id: 'msg_turn2_final',
      timestamp: t0 + 13,
    },
  ];
  mock.addChat(CHAT_ID, {
    title: 'Multi-turn freeze chat',
    messages,
    lastActiveAt: Date.now(),
  });
}

function activityRowCount(page) {
  return page.evaluate(() => document.querySelectorAll('#transcript .activity-row').length);
}

function activityRowEntryCounts(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('#transcript .activity-row');
    return Array.from(rows).map(r => r.querySelectorAll('[data-call-id]').length);
  });
}

/** Walk the transcript and emit an ordered list of structural tokens
 *  describing every meaningful child node. Used to assert the DOM
 *  sequence user_1 → activity_row → assistant_final_1 → user_2 →
 *  activity_row → assistant_final_2.
 *
 *  Returns an array of strings like:
 *    'user:umsg_turn1_user'
 *    'activity_row[2]'
 *    'assistant:msg_turn1_final'
 *    'user:umsg_turn2_user'
 *    'activity_row[1]'
 *    'assistant:msg_turn2_final'
 */
function transcriptStructure(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return [];
    // Under virt the bubbles + activity rows live in slot.children.
    const container = t.querySelector(':scope > .transcript-slot') || t;
    const out = [];
    for (const child of Array.from(container.children)) {
      if (child.classList.contains('activity-row')) {
        const n = child.querySelectorAll('[data-call-id]').length;
        out.push(`activity_row[${n}]`);
        continue;
      }
      if (child.classList.contains('line')) {
        const id = child.dataset.messageId || '';
        // s0 / user → user bubble; agent → assistant bubble.
        if (child.classList.contains('s0') || child.classList.contains('user')) {
          out.push(`user:${id}`);
        } else if (child.classList.contains('agent')) {
          out.push(`assistant:${id}`);
        } else {
          out.push(`line:${child.className}`);
        }
      }
    }
    return out;
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  // Wait for both final replies to land — guarantees full history has
  // been iterated by renderHistoryMessage.
  await page.waitForFunction(
    () => {
      const t = document.getElementById('transcript')?.textContent || '';
      return /Turn 1 reply/.test(t) && /Turn 2 reply/.test(t);
    },
    null, { timeout: 4_000 },
  );
  log('both final agent bubbles visible');

  // Give the activity-row reconstruction a tick to settle (the loop in
  // replaySessionMessages is synchronous, but renderFullList runs after
  // each appendToolCall and we want a stable snapshot).
  await page.waitForTimeout(100);

  const rowCount = await activityRowCount(page);
  const entryCounts = await activityRowEntryCounts(page);
  const structure = await transcriptStructure(page);

  log(`activity rows: ${rowCount}`);
  log(`entries per row: ${JSON.stringify(entryCounts)}`);
  log(`transcript structure:\n  ${structure.join('\n  ')}`);

  // ── Assertion 1: exactly 2 activity rows (one per turn) ──────────
  assert(
    rowCount === 2,
    `expected exactly 2 activity rows (one per turn, segmented by user message), got ${rowCount}. `
    + `entries=${JSON.stringify(entryCounts)} structure=${JSON.stringify(structure)}`,
  );

  // ── Assertion 2: row 1 has 2 entries, row 2 has 1 entry ──────────
  assert(
    entryCounts.length === 2 && entryCounts[0] === 2 && entryCounts[1] === 1,
    `expected entry counts [2, 1] across the two turns, got ${JSON.stringify(entryCounts)}`,
  );

  // ── Assertion 3: DOM order is the per-turn interleave ───────────
  const expected = [
    'user:umsg_turn1_user',
    'activity_row[2]',
    'assistant:msg_turn1_final',
    'user:umsg_turn2_user',
    'activity_row[1]',
    'assistant:msg_turn2_final',
  ];
  assert(
    JSON.stringify(structure) === JSON.stringify(expected),
    `transcript DOM order mismatch.\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(structure)}`,
  );

  log('two activity rows, correct entry counts, correct DOM interleave ✓');
}
