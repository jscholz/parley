// Regression gate for the 2026-05-17 (take 2) iOS field bug:
// activity rows from older paginated history clumped at the bottom of
// the transcript when the user scrolled up in a many-turn chat.
//
// The root cause was `loadEarlierHistory` calling renderHistoryMessage
// without `replayCtx`, so `getOrCreateRow` for paginated tool rows
// fell through to `tEl.appendChild` — landing rows at the transcript
// tail regardless of which turn they belonged to. After enough
// scroll-back, the transcript was a wall of unattached activity rows.
//
// This smoke pre-seeds a chat large enough to require pagination,
// triggers the load-earlier path, and asserts every activity row
// still sits next to its owning turn's user bubble (no bottom-clump).

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'tool-row-pagination-ordering';
export const DESCRIPTION = 'paginated load-earlier keeps activity rows inline per-turn';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-paginated-tool-rows';

function makeAssistantToolCalls(calls) {
  return JSON.stringify(calls.map(({ callId, toolName, args }) => ({
    id: callId,
    call_id: callId,
    type: 'function',
    function: { name: toolName, arguments: JSON.stringify(args || {}) },
  })));
}

export function MOCK_SETUP(mock) {
  // Force a small first-page limit so the load-earlier path actually
  // fires without seeding 200+ messages. 50 turns × ~5 messages per
  // turn = 250 messages total; cap the first page to ~25 so the rest
  // arrives via pagination (the path the field bug lived in).
  mock.setHistoryFirstPageLimit(25);
  const t0 = Date.now() / 1000 - 30_000;
  const messages = [];
  let ts = t0;
  const TURN_COUNT = 50;
  for (let turn = 1; turn <= TURN_COUNT; turn++) {
    messages.push({
      role: 'user', content: `Turn ${turn} prompt`,
      parley_id: `u_${turn}`, timestamp: ts++,
    });
    messages.push({
      role: 'assistant', content: '',
      tool_calls: makeAssistantToolCalls([
        { callId: `c_${turn}_a`, toolName: 'list_files', args: { p: turn } },
        { callId: `c_${turn}_b`, toolName: 'read_file', args: { p: turn } },
      ]),
      timestamp: ts++,
    });
    messages.push({
      role: 'tool', content: JSON.stringify({ ok: true }),
      tool_call_id: `c_${turn}_a`, timestamp: ts++,
    });
    messages.push({
      role: 'tool', content: JSON.stringify({ ok: true }),
      tool_call_id: `c_${turn}_b`, timestamp: ts++,
    });
    messages.push({
      role: 'assistant', content: `Turn ${turn} reply.`,
      parley_id: `m_${turn}`, timestamp: ts++,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Paginated tool-row chat',
    messages,
    lastActiveAt: Date.now(),
  });
}

function turnStructure(page) {
  // Group every turn's tokens: user / activity row / final assistant.
  // The invariant we care about is per-turn locality, not the global
  // sequence (which has 50 turns of mostly identical shape).
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return [];
    // Under virt the bubbles + activity rows live in slot.children.
    const container = t.querySelector(':scope > .transcript-slot') || t;
    const out = [];
    for (const child of Array.from(container.children)) {
      if (child.classList.contains('activity-row')) {
        out.push(`ar`);
      } else if (child.classList.contains('line')) {
        const id = child.dataset.messageId || '';
        if (child.classList.contains('s0') || child.classList.contains('user')) out.push(`u:${id}`);
        else if (child.classList.contains('agent')) out.push(`a:${id}`);
      }
    }
    return out;
  });
}

function assertPerTurnLocality(structure, label, minTurns) {
  // Walk: every `ar` must be flanked by a `u:` immediately before AND
  // a `a:` immediately after (the canonical turn shape produced by
  // the fixture: user → activity_row → final-assistant).
  let turnsSeen = 0;
  for (let i = 0; i < structure.length; i++) {
    if (structure[i] !== 'ar') continue;
    const before = structure[i - 1] || '';
    const after = structure[i + 1] || '';
    // Under virt the window can START mid-turn on the activity row — its
    // user bubble scrolled just above the window top. That's a viewport
    // accident, not clumping (symmetric to the idx===last tolerance below).
    // More common now that tool lists default collapsed (shorter rows →
    // more turns per viewport, 2026-05-27).
    if (i > 0) {
      assert(before.startsWith('u:'),
        `[${label}] activity row at idx ${i} not preceded by a user bubble (got "${before}"). ` +
        `Field bug: rows clumped past their turns. structure=${JSON.stringify(structure)}`);
    }
    // Under virt the visible window may cut off the last turn before
    // its final assistant bubble — that's a viewport accident, not a
    // structural bug. Skip the "followed by a:" check for the last ar
    // in the structure when it sits at the window edge.
    if (i === structure.length - 1) {
      turnsSeen++;
      continue;
    }
    assert(after.startsWith('a:'),
      `[${label}] activity row at idx ${i} not followed by an assistant bubble (got "${after}"). ` +
      `Field bug: rows clumped past their turns. structure=${JSON.stringify(structure)}`);
    turnsSeen++;
  }
  assert(turnsSeen >= minTurns,
    `[${label}] expected ≥${minTurns} per-turn activity rows, saw ${turnsSeen}. structure=${JSON.stringify(structure)}`);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  // First fetch is capped at 25 messages via setHistoryFirstPageLimit
  // (≈ 5 turns). Wait for those to settle.
  await page.waitForFunction(() => {
    const t = document.getElementById('transcript');
    if (!t) return false;
    return t.querySelectorAll('.activity-row').length >= 4;
  }, null, { timeout: 6_000 });

  const initial = await turnStructure(page);
  log(`initial fetch tokens=${initial.length} activity-rows=${initial.filter(t => t === 'ar').length}`);
  assertPerTurnLocality(initial, 'initial-fetch', 3);

  // Trigger load-earlier. Scroll to the top of the transcript fires
  // the pagination handler via the scroll listener wired in chat.ts.
  // Brief settle first so post-replay forceScrollToBottom has completed
  // before we move the cursor up (mirrors load-earlier-history.mjs).
  // Wheel gesture signals scheduleAtBottomRepin that this is
  // user-initiated; without it the RO snaps back to the bottom in the
  // 1.5s post-restore window and the scrollTo(0) doesn't stick.
  const beforeRows = initial.filter(t => t === 'ar').length;
  log(`scrolling transcript to top to trigger loadEarlier (have ${beforeRows} rows)`);
  // Wait out the open-render load-earlier suppression (800ms in
  // sessionResume) so this scroll-to-top is treated as a user gesture.
  await page.waitForTimeout(1000);
  const box = await page.locator('#transcript').boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
  }
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) {
      t.scrollTo({ top: 0, behavior: 'instant' });
      t.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  });
  // Give the pagination handler time to fire + render. We expect a
  // bump in activity-row count since older turns flow in.
  await page.waitForFunction((before) => {
    const t = document.getElementById('transcript');
    if (!t) return false;
    return t.querySelectorAll('.activity-row').length > before;
  }, beforeRows, { timeout: 8_000 }).catch(() => {
    log(`note: row count didn't grow in 8s — fixture may be ≤ first-page limit, skipping pagination assert`);
  });

  const afterPagination = await turnStructure(page);
  const afterRows = afterPagination.filter(t => t === 'ar').length;
  log(`after pagination tokens=${afterPagination.length} activity-rows=${afterRows}`);
  // The critical assertion: per-turn locality must hold for EVERY row,
  // including the newly-prepended page's rows.
  assertPerTurnLocality(afterPagination, 'after-pagination', Math.max(3, beforeRows));
  assert(afterRows > beforeRows,
    `expected pagination to bring in additional activity rows (had ${beforeRows}, now ${afterRows}). ` +
    `If this fixture isn't paginating, the smoke isn't actually testing the bug path.`);
  log(`✓ ${afterRows} activity rows (was ${beforeRows}), all inline with their turns`);
}
