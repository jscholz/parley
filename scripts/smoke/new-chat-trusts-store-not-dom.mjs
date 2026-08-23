// Field bug (Jonathan, 2026-06-23): clicking New chat sometimes opens
// an existing chat instead of a fresh one. The 2026-06-22 fix
// (commit 5a3a812) + four prior new-chat smokes ship green; this is
// a NEW failure mode the existing smokes don't cover.
//
// Root cause: the no-op guard in main.ts #sb-new-chat read content
// presence from the DOM:
//
//     const hasContent = transcriptEl
//       ? transcriptEl.querySelectorAll('.line.s0, .line.agent').length > 0
//       : false;
//     if (hasActiveChat && !hasContent && !switchInFlight) return;
//
// That misses several "chat is genuinely populated but DOM has no
// user/agent rows" shapes:
//   • tool-call-only chats (agent ran a search; final reply was
//     deleted / retried / never finalized)
//   • mid-render transients (reconciler hasn't applied yet)
//   • projection re-classifications (cron / notification rows that
//     don't get .line.s0/.line.agent classes)
// In each case ``hasContent`` reads false, the guard fires, the click
// no-ops, and the user is left on the existing populated chat.
// Subjective experience: "New chat opened an existing chat."
//
// Fix: swap the DOM-row count for a store-side check across all
// three buckets:
//   `(durable.length + inflight.length + pendingSends.length) > 0`
// The projection store is the source of truth and is shape-agnostic.
// Counting only durable misses the user-send-to-reply-final window,
// where the user message lives in inflight (caught by sidebar-
// immediate-title and slash-commands).
//
// Repro: render a chat with normal content, then synthetically remove
// the `.line.s0/.line.agent` rows from the DOM (any of the real-world
// shapes above produces this same end state). Click New chat. Pre-fix
// guard swallows the click; post-fix guard reads store and proceeds.

import {
  waitForReady, openSidebar, clickRow, clickNewChat,
  captureNextChatId, assert, dumpLines, waitForDrawerQuiet,
} from './lib.mjs';

export const NAME = 'new-chat-trusts-store-not-dom';
export const DESCRIPTION = 'New-chat no-op guard must read transcriptStore.durable not the DOM; chats with content invisible to the DOM-row check still rotate to a fresh chat';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-newchat-store-not-dom';
const MARKER = 'CONTENT-IN-STORE-MARKER';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Chat with content the DOM check misses',
    source: 'parley',
    messages: [
      { role: 'user', content: MARKER, message_id: 'm-1', parley_id: 'm-1',
        timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: MARKER + ' reply', message_id: 'm-2', parley_id: 'm-2',
        timestamp: Date.now() / 1000 - 30 },
    ],
    lastActiveAt: Date.now() - 10_000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. View the seeded chat — content rendered, store populated.
  //    Crucially: wait for the resume to FULLY settle (drawer goes quiet
  //    → server fetch done → resume's finally clears optimistic). Without
  //    this, switchCtl.optimisticId() is still set at new-chat click time,
  //    the guard's `switchInFlight=true` branch bypasses the no-op check,
  //    and the bug doesn't reproduce (real users hit it AFTER the switch
  //    has settled — they're calmly viewing a chat, then click New chat).
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    (m) => new RegExp(m).test(document.getElementById('transcript')?.textContent || ''),
    MARKER, { timeout: 8_000, polling: 50 });
  await waitForDrawerQuiet(page, 400, 8_000);
  log('viewing chat (content rendered, switch settled)');

  // 2 + 3 fused into one synchronous task: scrub the user/agent DOM
  //    rows and dispatch the click in the SAME microtask so the
  //    reconciler can't re-paint the rows back from the still-
  //    populated store between scrub and click. (A two-call sequence
  //    via separate page.evaluate calls leaks a Node↔browser
  //    round-trip in the middle; the reconciler ticks on every
  //    microtask boundary and restores the rows, which would mask
  //    the bug under test.) Any of the real-world shapes — tool-
  //    only chats, mid-render transients, projection reclassifications
  //    — produces this same end state at the moment the user clicks.
  const newChatP = captureNextChatId(page, { timeoutMs: 5000 });
  const domCountAtClick = await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return -1;
    t.querySelectorAll('.line.s0, .line.agent').forEach((el) => el.remove());
    const afterScrubCount = t.querySelectorAll('.line.s0, .line.agent').length;
    const btn = document.getElementById('sb-new-chat');
    if (!btn) throw new Error('#sb-new-chat not found');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return afterScrubCount;
  });
  log(`DOM .line.s0/.agent count at click: ${domCountAtClick} (must be 0 for repro)`);
  assert(domCountAtClick === 0,
    `repro setup failed — DOM had ${domCountAtClick} user/agent rows at click time`);

  // 4. Pre-fix: guard sees hasContent=false (DOM check), no-ops the
  //    click → captureNextChatId rejects on timeout. Post-fix: guard
  //    reads transcriptStore (durable + inflight + pendingSends) > 0
  //    → proceeds → new chat minted.
  let newChatId;
  try {
    newChatId = await newChatP;
  } catch (e) {
    throw new Error(
      'BUG: New chat click was swallowed by the no-op guard. The guard ' +
      'must trust transcriptStore (durable + inflight + pendingSends), not ' +
      'the DOM row count — chats with content that doesn\'t render as ' +
      '.line.s0/.line.agent (tool-only, mid-render, notifications) get ' +
      'mistakenly classified as empty.\n' + await dumpLines(page),
    );
  }
  log(`new chat minted: ${newChatId}`);

  // 5. Verify the transcript actually rotated — "New chat started"
  //    appears and the old MARKER is gone.
  await page.waitForFunction(
    () => /New chat started/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 8_000, polling: 50 });
  const text = await page.evaluate(() =>
    document.getElementById('transcript')?.textContent || '');
  assert(!new RegExp(MARKER).test(text),
    `BUG: the prior chat's content survived the new-chat rotation. text=${JSON.stringify(text.slice(0, 200))}`);
  log('new chat painted blank ✓');
}
