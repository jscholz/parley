// Regression gate for the 2026-05-17 transient tool-row ordering bug
// on cold page load.
//
// Field repro: a chat with multiple tool-using turns rendered correctly
// when reached via session-switch, but after a PWA refresh (cold load)
// ALL activity rows clumped at the END of the transcript. Switching
// away to another chat and back fixed the ordering. IndexedDB was
// cleared before reproducing — not a stale-cache issue, real ordering
// bug.
//
// Root cause:
//   chat.persist() strips `.activity-row` from the snapshot HTML
//   (chat.ts:366) — they're rebuilt from state.db on demand via the
//   activityRow API instead of being serialized. On cold load:
//     1. loadSnapshot() restores text bubbles only.
//     2. replaySessionMessages runs with sameSession=true (the
//        snapshot recorded the viewed session id, matches the URL/
//        adapter id post-reload), so the !sameSession branch that
//        does `transcriptEl.innerHTML=''` is SKIPPED to avoid double
//        rendering of text.
//     3. The for-loop calls appendToolCall / appendToolResult for
//        tool rows. getOrCreateRow's "no existing row" branch did
//        `tEl.appendChild(rowEl)` — which appends at the END of the
//        transcript, AFTER all the text bubbles that the snapshot
//        already restored.
//     4. Net effect: every activity row lands below every text
//        bubble, instead of inline with its originating turn.
//
// Fix: thread an optional `anchorBefore: HTMLElement | null` through
// appendToolCall / appendToolResult to getOrCreateRow. History
// replay computes the anchor (next text bubble in time order, found
// via data-message-id) and the row is `insertBefore`'d at the right
// spot. Live SSE callers pass no anchor and keep append-to-tail
// semantics.
//
// This smoke:
//   1. Pre-seed mock state with a multi-turn chat (mirror of the
//      multi-tool-turn-freeze-semantics fixture).
//   2. Click into it; assert DOM structure is interleaved.
//   3. page.reload() to trigger cold-load snapshot restore.
//   4. After replay, assert the SAME interleaved structure persists —
//      activity rows MUST come between the user bubble and the
//      assistant-final bubble of their turn, NOT after every text
//      bubble.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'tool-row-cold-load-ordering';
export const DESCRIPTION = 'cold-load snapshot replay positions activity rows inline (not at end)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-cold-load-ordering';

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

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  const messages = [
    // ── Turn 1 ──
    { role: 'user', content: 'first prompt — run two tools',
      parley_id: 'cold_t1_user', timestamp: t0 },
    { role: 'assistant', content: '',
      tool_calls: makeAssistantToolCall('cold_call_1', 'list_files', { path: '/a' }),
      timestamp: t0 + 1 },
    { role: 'tool', content: JSON.stringify({ output: 'r1', exit_code: 0 }),
      tool_call_id: 'cold_call_1', timestamp: t0 + 2 },
    { role: 'assistant', content: '',
      tool_calls: makeAssistantToolCall('cold_call_2', 'read_file', { path: '/a/x' }),
      timestamp: t0 + 3 },
    { role: 'tool', content: JSON.stringify({ output: 'r2', exit_code: 0 }),
      tool_call_id: 'cold_call_2', timestamp: t0 + 4 },
    { role: 'assistant', content: 'Turn 1 reply — done two tools.',
      parley_id: 'cold_t1_final', timestamp: t0 + 5 },
    // ── Turn 2 ──
    { role: 'user', content: 'second prompt — one more',
      parley_id: 'cold_t2_user', timestamp: t0 + 10 },
    { role: 'assistant', content: '',
      tool_calls: makeAssistantToolCall('cold_call_3', 'list_files', { path: '/b' }),
      timestamp: t0 + 11 },
    { role: 'tool', content: JSON.stringify({ output: 'r3', exit_code: 0 }),
      tool_call_id: 'cold_call_3', timestamp: t0 + 12 },
    { role: 'assistant', content: 'Turn 2 reply — done.',
      parley_id: 'cold_t2_final', timestamp: t0 + 13 },
  ];
  mock.addChat(CHAT_ID, {
    title: 'Cold-load ordering chat',
    messages,
    lastActiveAt: Date.now(),
  });
}

// Build an ordered structural fingerprint of the transcript. Each child
// becomes one token. Activity rows include their entry count so a smoke
// failure makes it obvious whether the row got DROPPED or just lost its
// position.
function transcriptStructure(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return [];
    // Under virt, transcript children are [topSpacer, slot, bottomSpacer]
    // and bubbles/activity-rows live in slot.children. Walk slot when
    // present; fall back to transcript children for the default path.
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
        if (child.classList.contains('s0') || child.classList.contains('user')) {
          out.push(`user:${id}`);
        } else if (child.classList.contains('agent')) {
          out.push(`assistant:${id}`);
        } else {
          out.push(`line:${child.className.split(' ').slice(0, 3).join('.')}`);
        }
      }
    }
    return out;
  });
}

function assertInterleaved(structure, label) {
  // Required invariant: the FIRST activity_row must appear BEFORE the
  // last text bubble. Bug shape was: every text bubble first, then
  // every activity row clumped at the tail. The exact shape we want is
  //   user:* → activity_row → assistant:* → user:* → activity_row → assistant:*
  // …but the smoke doesn't pin the exact tokens, it pins the property
  // that activity rows are NOT all at the end.
  const lineIdxs = [];
  const arIdxs = [];
  structure.forEach((tok, i) => {
    if (tok.startsWith('activity_row')) arIdxs.push(i);
    else if (tok.startsWith('user:') || tok.startsWith('assistant:')) lineIdxs.push(i);
  });
  assert(arIdxs.length >= 2,
    `[${label}] expected ≥2 activity rows in transcript, got ${arIdxs.length}: ${JSON.stringify(structure)}`);
  assert(lineIdxs.length >= 4,
    `[${label}] expected ≥4 text bubbles in transcript, got ${lineIdxs.length}: ${JSON.stringify(structure)}`);
  const lastLineIdx = lineIdxs[lineIdxs.length - 1];
  const firstArIdx = arIdxs[0];
  assert(
    firstArIdx < lastLineIdx,
    `[${label}] BUG: every activity row sits AFTER every text bubble — they were appended at the end ` +
    `instead of inserted inline. structure=${JSON.stringify(structure)}`,
  );
  // Stronger gate: no two activity rows should be adjacent unless there
  // are no bubbles between them in the source. With two distinct turns
  // separated by a final-assistant + user bubble, the activity rows
  // must NOT be adjacent.
  for (let i = 1; i < arIdxs.length; i++) {
    assert(arIdxs[i] !== arIdxs[i - 1] + 1,
      `[${label}] BUG: activity rows ${arIdxs[i - 1]} and ${arIdxs[i]} are adjacent — turns merged. ` +
      `structure=${JSON.stringify(structure)}`);
  }
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Open the pre-seeded chat. clickRow waits for transcript content.
  await clickRow(page, CHAT_ID);

  // Wait for ≥2 activity rows + ≥4 text bubbles to settle. Without this,
  // we may snapshot mid-render and the cold-load gate becomes
  // meaningless.
  await page.waitForFunction(() => {
    const t = document.getElementById('transcript');
    if (!t) return false;
    return (
      t.querySelectorAll('.activity-row').length >= 2 &&
      t.querySelectorAll('.line[data-message-id]').length >= 4
    );
  }, null, { timeout: 5_000 });

  const preReload = await transcriptStructure(page);
  log(`pre-reload structure: ${JSON.stringify(preReload)}`);
  assertInterleaved(preReload, 'pre-reload');

  // chat.persist() debounces by writing on every addLine + once at
  // flushBatchedRender. By the time the transcript is fully populated,
  // the snapshot is also persisted. Give one more tick to be sure.
  await page.waitForTimeout(150);

  log('reloading page to trigger cold-load snapshot restore...');
  await page.reload();
  await waitForReady(page);

  // Wait for replay to land tool rows. Same gate as before: ≥2
  // activity rows back in the DOM.
  await page.waitForFunction(() => {
    const t = document.getElementById('transcript');
    if (!t) return false;
    return (
      t.querySelectorAll('.activity-row').length >= 2 &&
      t.querySelectorAll('.line[data-message-id]').length >= 4
    );
  }, null, { timeout: 5_000 });

  const postReload = await transcriptStructure(page);
  log(`post-reload structure: ${JSON.stringify(postReload)}`);
  assertInterleaved(postReload, 'post-reload');

  // Stronger: structure should match (or at least the first activity
  // row must come BEFORE the last text bubble in both). We've already
  // asserted that property; log a soft mismatch for diagnosis.
  if (JSON.stringify(preReload) !== JSON.stringify(postReload)) {
    log(`note: pre/post structures differ but both pass interleave check (acceptable; activity rows ` +
        `may re-anchor between adjacent text bubbles of the same turn)`);
  }
}
