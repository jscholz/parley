// Regression gate for the 2026-05-17 dupe-tool-rows bug.
//
// Repro: open a chat with N tool calls, dev-reload three times. Each
// reload adds another stacked "N tools · done" activity row. Three
// reloads = three rows.
//
// Cause: chatSnapshot.saveSnapshot() persisted the full transcript
// outerHTML including activity-row nodes. They have no
// `data-message-id` and so are invisible to renderedMessages.upsert's
// dedup-by-id path. On reload the IDB-restored DOM kept the stale row
// AND a fresh inflight replay (or another live envelope) created a
// new one. The snapshot then captured both. Cascading dupes.
//
// Fix (commit pending): saveSnapshot clones the transcript, strips
// `.activity-row` from the clone, then serializes. restoreSnapshot
// also strips any activity rows from older snapshots so existing IDB
// state doesn't keep the bug alive.
//
// Trade-off: past-turn activity rows disappear on reload. Acceptable;
// the principled fix is to reconstruct them from state.db history,
// follow-up. This smoke covers the dupe path, not the history-replay
// path.

import { waitForReady, openSidebar, clickRow, send, assert } from './lib.mjs';

export const NAME = 'tool-row-reload-dedup';
export const DESCRIPTION = 'page reload does not stack duplicate activity rows for past tool turns';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-tool-dedup';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Tool reload chat',
    messages: [
      { role: 'user', content: 'do the thing',
        parley_id: 'umsg_tool_dedup_user', timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'done!',
        parley_id: 'msg_tool_dedup_agent', timestamp: Date.now() / 1000 - 30 },
    ],
    lastActiveAt: Date.now() - 30_000,
  });
}

function rowCount(page) {
  return page.evaluate(() => document.querySelectorAll('#transcript .activity-row').length);
}

export default async function run({ page, log, mock, ctx }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /done!/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000 },
  );
  log('chat loaded with seed messages');

  // Fire 3 tool envelopes + 3 tool_results live (simulates a tool turn
  // that just completed). The PWA renders these into ONE activity row.
  for (let i = 0; i < 3; i++) {
    mock.pushEnvelope({
      type: 'tool_call',
      chat_id: CHAT_ID,
      call_id: `call_${i}`,
      tool_name: 'mock_tool',
      args: { idx: i },
    });
    mock.pushEnvelope({
      type: 'tool_result',
      chat_id: CHAT_ID,
      call_id: `call_${i}`,
      result: `r${i}`,
    });
  }
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .activity-row').length === 1,
    null, { timeout: 4_000 },
  );
  const liveCount = await rowCount(page);
  assert(liveCount === 1, `expected exactly 1 activity row after live envelopes, got ${liveCount}`);
  log(`live: 1 activity row ✓`);

  // Reload three times. Each reload should leave exactly ONE activity
  // row on screen (or zero, since we strip on persist+restore; the
  // important invariant is "never grows").
  for (let reload = 1; reload <= 3; reload++) {
    // Wait for the persist debounce so the snapshot reflects the
    // current DOM (which already contains the activity row from the
    // live envelopes — that's the pre-fix repro state).
    await page.waitForTimeout(400);
    await page.reload();
    await waitForReady(page);
    await page.waitForFunction(
      () => /done!/.test(document.getElementById('transcript')?.textContent || ''),
      null, { timeout: 4_000 },
    );
    await page.waitForTimeout(300);
    const after = await rowCount(page);
    assert(after <= 1, `reload ${reload}: expected at most 1 activity row, got ${after} (dupes regressed)`);
    log(`reload ${reload}: ${after} activity row(s) ✓`);
  }
}
