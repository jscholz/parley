// Symptom 4 of the new-chat glitch (field report 2026-06-16): the feared
// split-brain — clicking New chat during a WARM in-memory switch leaving
// the OLD chat's content on screen while the drawer highlight flips to the
// fresh new chat.
//
// REGRESSION GUARD (passes on current code — NOT a failing-first repro).
// Investigation 2026-06-22 found symptom 4 does NOT reproduce: the warm
// switch-back fast paint (sessionDrawer.ts:1722) calls onResumeCb →
// replaySessionMessages → setViewed SYNCHRONOUSLY, so switchCtl.viewedId()
// has already COMMITTED to the warm target by the time New chat runs.
// new-chat's transcriptStore.clearAll(prevViewed=viewedId()) therefore
// targets the right (warm) chat and clears it — no leak. Combined with #251
// (cold path: blank behind spinner, no content to leak) and #255 (the
// focusedId render gate), the split-brain window is already closed.
//
// This smoke nails that down so the upcoming new-chat refactor (#274 —
// routing the handler through switchCtl.begin(newId) + chat.clear() instead
// of bare invalidate()+clearAll) can't silently REOPEN the warm-path leak.
//
// Setup (mocked):
//   1. Seed X (boot-viewed) + Y (content). Warm Y by visiting it then
//      returning to X — now Y's durable is resident in the in-memory store.
//   2. Slow Y's SERVER reconcile (setMessageDelay) so the warm switch's
//      reconcile stays in flight after the synchronous mem-paint.
//   3. Click Y (warm) → MARKER_Y paints instantly from memory.
//   4. Click New chat inside that window.
//   Expected (now + after #274): the new-chat handler clears the on-screen
//   transcript so it shows the blank new chat, not Y. No split-brain.

import {
  waitForReady, openSidebar, clickRow, clickNewChat, captureNextChatId, assert, dumpLines,
} from './lib.mjs';

export const NAME = 'new-chat-no-split-brain-warm-switch';
export const DESCRIPTION = 'New chat clicked during a warm in-memory switch must clear the old chat content, not leave it split-brain under the new highlight (symptom 4)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_X = 'mock-newchat-splitbrain-x';
const CHAT_Y = 'mock-newchat-splitbrain-y';
const MARKER_X = 'XRAY current marker';
const MARKER_Y = 'YANKEE warm marker';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_X, {
    title: 'Chat X — currently viewed',
    source: 'parley',
    messages: [
      { role: 'user', content: MARKER_X, message_id: 'x-1', parley_id: 'x-1',
        timestamp: Date.now() / 1000 - 120 },
      { role: 'assistant', content: MARKER_X + ' reply', message_id: 'x-2', parley_id: 'x-2',
        timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 5_000,  // most-recent → boot lands here
  });
  mock.addChat(CHAT_Y, {
    title: 'Chat Y — warm',
    source: 'parley',
    messages: [
      { role: 'user', content: MARKER_Y, message_id: 'y-1', parley_id: 'y-1',
        timestamp: Date.now() / 1000 - 300 },
      { role: 'assistant', content: MARKER_Y + ' reply', message_id: 'y-2', parley_id: 'y-2',
        timestamp: Date.now() / 1000 - 240 },
    ],
    lastActiveAt: Date.now() - 200_000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // 0. Confirm boot landed on X.
  await page.waitForFunction(
    (m) => new RegExp(m).test(document.getElementById('transcript')?.textContent || ''),
    MARKER_X, { timeout: 8_000, polling: 50 });
  log('boot viewing chat X');

  // 1. Warm Y: visit it (loads its durable into the in-memory store), then
  //    return to X. Y is now resident for a synchronous mem-paint.
  await clickRow(page, CHAT_Y);
  await page.waitForFunction(
    (m) => new RegExp(m).test(document.getElementById('transcript')?.textContent || ''),
    MARKER_Y, { timeout: 8_000, polling: 50 });
  await clickRow(page, CHAT_X);
  await page.waitForFunction(
    (m) => new RegExp(m).test(document.getElementById('transcript')?.textContent || ''),
    MARKER_X, { timeout: 8_000, polling: 50 });
  log('warmed Y, back on X');

  // 2. Slow Y's server reconcile so the warm switch's commit stays in
  //    flight behind the synchronous mem-paint.
  mock.setMessageDelay(CHAT_Y, 2500);

  // 3. Warm switch to Y — mem-paint shows MARKER_Y instantly.
  await clickRow(page, CHAT_Y);
  await page.waitForFunction(
    (m) => new RegExp(m).test(document.getElementById('transcript')?.textContent || ''),
    MARKER_Y, { timeout: 4_000, polling: 25 });
  log('warm switch to Y mem-painted MARKER_Y');

  // 4. Click New chat inside the warm-switch in-flight window.
  const newChatP = captureNextChatId(page, { timeoutMs: 5000 });
  await clickNewChat(page);
  const newChatId = await newChatP;
  log(`new chat minted mid-warm-switch: ${newChatId}`);

  await page.waitForFunction(
    () => /New chat started/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 8_000, polling: 50 });

  // Let Y's delayed reconcile land + any continuation run.
  await page.waitForTimeout(3000);

  const { text, activeId } = await page.evaluate(() => ({
    text: document.getElementById('transcript')?.textContent || '',
    activeId: document.querySelector('#sessions-list li.active')?.dataset?.chatId || null,
  }));

  assert(/New chat started/.test(text),
    `BUG: lost the new chat — "New chat started" missing.\n${await dumpLines(page)}`);

  // Cardinal assertion: no split-brain. The mem-painted Y content must not
  // survive under the new-chat highlight.
  assert(!new RegExp(MARKER_Y).test(text),
    'BUG: chat Y\'s warm mem-painted content survived in the transcript while the highlight ' +
    'moved to the new chat — split-brain. The new-chat handler cleared transcriptStore.clearAll' +
    '(viewedId()) which lagged the mem-painted target, leaving Y on screen.\n' +
    `transcript: ${JSON.stringify(text.slice(0, 200))}`);
  assert(activeId !== CHAT_Y && activeId !== CHAT_X,
    `BUG: drawer highlight is on an old chat (${activeId}), not the fresh new chat`);
  log('warm-switch New chat cleared the old transcript — no split-brain ✓');
}
