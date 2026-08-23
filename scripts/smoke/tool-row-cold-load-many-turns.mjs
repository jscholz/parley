// Aggressive cold-load tool-row ordering smoke — many turns, mixed
// shapes, simulates a real chat after a PWA reload.
//
// Why a second smoke: `tool-row-cold-load-ordering` proves the cold-
// load fix on a 2-turn fixture and passes. But activity rows were
// still observed clumped at the end of long chats on iOS post-reload
// (an 11-row clump of "8 tools · done / 5 tools · done / 27 tools ·
// done / …" at the bottom). The 2-turn fixture clearly doesn't
// exercise whatever shape breaks in production. This smoke increases
// the surface:
//
//   - 6 turns, varied tool counts (1, 3, 1, 5, 2, 4) — matches the
//     spread visible in the field screenshot.
//   - Some turns have an assistant final-text reply, some don't (the
//     agent might tool-call then yield without speaking).
//   - Some turns have a single tool with no result yet, mimicking the
//     state.db row patterns that show up under the proxy's items merge.
//
// Assertion: after click + reload, EVERY activity row sits between a
// user message and the next user message (or end-of-transcript), and
// no two activity rows are adjacent in DOM. Both invariants together
// catch the field bug — they fail if any row jumps to the tail.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'tool-row-cold-load-many-turns';
export const DESCRIPTION = 'many-turn cold-load: activity rows stay inline per-turn (Jonathan field repro)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-cold-load-many-turns';

function makeAssistantToolCall(callId, toolName, args) {
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

function makeAssistantToolCalls(calls) {
  return JSON.stringify(calls.map(({ callId, toolName, args }) => ({
    id: callId,
    call_id: callId,
    type: 'function',
    function: { name: toolName, arguments: JSON.stringify(args || {}) },
  })));
}

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 6000;
  const messages = [];
  // 6 turns. Tool counts: 1, 3, 1, 5, 2, 4. Some turns include a final
  // assistant text reply; some don't (the agent yielded after tools).
  const turns = [
    { idx: 1, toolCount: 1, withFinal: true },
    { idx: 2, toolCount: 3, withFinal: false },
    { idx: 3, toolCount: 1, withFinal: true },
    { idx: 4, toolCount: 5, withFinal: false },
    { idx: 5, toolCount: 2, withFinal: true },
    { idx: 6, toolCount: 4, withFinal: true },
  ];

  let ts = t0;
  for (const turn of turns) {
    // User msg.
    messages.push({
      role: 'user',
      content: `Turn ${turn.idx} prompt`,
      parley_id: `u_t${turn.idx}`,
      timestamp: ts++,
    });
    // Assistant with N tool_calls (single row, all calls on it).
    const calls = [];
    for (let i = 0; i < turn.toolCount; i++) {
      calls.push({
        callId: `c_t${turn.idx}_${i}`,
        toolName: i === 0 ? 'list_files' : 'read_file',
        args: { path: `/dir/${turn.idx}/${i}` },
      });
    }
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: makeAssistantToolCalls(calls),
      timestamp: ts++,
    });
    // Tool results, one per call.
    for (let i = 0; i < turn.toolCount; i++) {
      messages.push({
        role: 'tool',
        content: JSON.stringify({ ok: true, idx: i }),
        tool_call_id: `c_t${turn.idx}_${i}`,
        timestamp: ts++,
      });
    }
    // Final assistant text (sometimes).
    if (turn.withFinal) {
      messages.push({
        role: 'assistant',
        content: `Turn ${turn.idx} reply — used ${turn.toolCount} tools.`,
        parley_id: `m_t${turn.idx}`,
        timestamp: ts++,
      });
    }
  }

  mock.addChat(CHAT_ID, {
    title: 'Many-turn cold-load chat',
    messages,
    lastActiveAt: Date.now(),
  });
}

function transcriptStructure(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return [];
    // Under virt the bubbles + activity rows live in slot.children, not
    // transcript.children directly. Walk the slot when present.
    const container = t.querySelector(':scope > .transcript-slot') || t;
    const out = [];
    for (const child of Array.from(container.children)) {
      if (child.classList.contains('activity-row')) {
        const n = child.querySelectorAll('[data-call-id]').length;
        out.push(`ar[${n}]`);
        continue;
      }
      if (child.classList.contains('line')) {
        const id = child.dataset.messageId || '';
        if (child.classList.contains('s0') || child.classList.contains('user')) {
          out.push(`u:${id}`);
        } else if (child.classList.contains('agent')) {
          out.push(`a:${id}`);
        }
      }
    }
    return out;
  });
}

function assertNotClumped(structure, label) {
  const arIdxs = [];
  const uIdxs = [];
  structure.forEach((tok, i) => {
    if (tok.startsWith('ar[')) arIdxs.push(i);
    if (tok.startsWith('u:')) uIdxs.push(i);
  });
  // Under virt only the visible window (~10 specs) is in DOM; expect
  // ≥2 activity rows + ≥3 user bubbles in that slice. The clumped-rows
  // regression still shows up in the bottom window because the visible
  // turns near the bottom would all have ar's at their end.
  assert(arIdxs.length >= 2,
    `[${label}] expected ≥2 activity rows, got ${arIdxs.length}: ${JSON.stringify(structure)}`);
  assert(uIdxs.length >= 3,
    `[${label}] expected ≥3 user bubbles, got ${uIdxs.length}: ${JSON.stringify(structure)}`);

  // Invariant 1: no two activity rows adjacent. (Each turn has at most
  // one row; two adjacent rows would mean turn N+1's row landed before
  // turn N+1's user bubble — wrong.)
  for (let i = 1; i < arIdxs.length; i++) {
    assert(arIdxs[i] !== arIdxs[i - 1] + 1,
      `[${label}] BUG: adjacent activity rows at positions ${arIdxs[i - 1]}, ${arIdxs[i]}. ` +
      `structure=${JSON.stringify(structure)}`);
  }
  // Invariant 2: every activity row sits AFTER a user bubble in DOM
  // order (its owning turn's prompt). Walk pairs: for each row, the
  // most recently-seen user bubble must precede it.
  for (const arIdx of arIdxs) {
    const prevUser = uIdxs.filter(i => i < arIdx).pop();
    assert(prevUser !== undefined,
      `[${label}] BUG: activity row at index ${arIdx} has NO user bubble before it. ` +
      `structure=${JSON.stringify(structure)}`);
  }
  // Invariant 3: no activity row comes AFTER the last user bubble's
  // last text-bubble follower. In other words, activity rows can't
  // appear at the tail beyond the final assistant text. (This is the
  // clumped-rows failure shape: all rows appear after every text
  // bubble.)
  const lastUser = uIdxs[uIdxs.length - 1];
  for (const arIdx of arIdxs) {
    // If a row is past the last user bubble, the bubble before it
    // had better be a user from the same turn, not text from prior turns.
    // Cheaper structural check: the gap from the last preceding user
    // bubble to this row should be ≤ 2 tokens (no intervening text from
    // a different turn).
    const prevUser = uIdxs.filter(i => i < arIdx).pop();
    assert((arIdx - prevUser) <= 2,
      `[${label}] BUG: activity row at index ${arIdx} is ${arIdx - prevUser} steps past its turn's ` +
      `user bubble at ${prevUser} — content from later turns sneaked between. ` +
      `structure=${JSON.stringify(structure)}`);
  }
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  // Wait for everything to settle. We expect 6 user msgs, 6 activity
  // rows (one per turn), and 4 final assistant text bubbles in the
  // STORE. Under virt only the visible window is in DOM (~10 specs);
  // expect ≥2 activity rows interleaved with their turns at the bottom
  // of the chat. The structural assertion below catches the clumped-
  // rows regression even with only a partial window.
  await page.waitForFunction(() => {
    const t = document.getElementById('transcript');
    if (!t) return false;
    const container = t.querySelector(':scope > .transcript-slot') || t;
    return (
      container.querySelectorAll('.activity-row').length >= 2 &&
      container.querySelectorAll('.line[data-message-id]').length >= 4
    );
  }, null, { timeout: 6_000 });

  const preReload = await transcriptStructure(page);
  log(`pre-reload: ${JSON.stringify(preReload)}`);
  assertNotClumped(preReload, 'pre-reload');

  await page.waitForTimeout(200);  // let snapshot persist debounce land
  log('reloading...');
  await page.reload();
  await waitForReady(page);

  await page.waitForFunction(() => {
    const t = document.getElementById('transcript');
    if (!t) return false;
    const container = t.querySelector(':scope > .transcript-slot') || t;
    return (
      container.querySelectorAll('.activity-row').length >= 2 &&
      container.querySelectorAll('.line[data-message-id]').length >= 4
    );
  }, null, { timeout: 6_000 });

  const postReload = await transcriptStructure(page);
  log(`post-reload: ${JSON.stringify(postReload)}`);
  assertNotClumped(postReload, 'post-reload');
}
