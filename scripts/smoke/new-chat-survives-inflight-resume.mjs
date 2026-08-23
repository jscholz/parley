// #251 — clicking New chat while a session-switch resume is still in
// flight must INSTANTLY mint a blank chat, and the in-flight resume's
// late continuation must not repaint the prior session over it.
//
// Field report (2026-06-16, verbatim): "I just did it [New chat], and it
// created a new session but had a spinner in it for about ten seconds.
// When that spinner finished, it showed a session transcript rather than
// just being a blank window. And so I hit new chat again, and then I get
// my new chat without a spinner waiting for input. That middle step
// shouldn't happen."
//
// Two coupled defects in the new-chat handler (main.ts #sb-new-chat):
//
//   1. No-op guard swallow. A cold switch runs showTranscriptLoading()
//      synchronously — the transcript is BLANKED behind a spinner while
//      the server fetch is in flight. The guard `hasActiveChat &&
//      !hasContent` then reads "active chat with no bubbles" and no-ops
//      the click. So the FIRST New-chat press does nothing; the user
//      waits out the spinner, sees the prior transcript, and has to click
//      again. A blanked-for-loading transcript is NOT an empty chat.
//
//   2. Missing invalidate. Even once a chat is minted, the in-flight
//      resume's server-render continuation is gated only by
//      isCurrent(tok). new-chat never bumped the generation, so the
//      continuation stays "current" and repaints the prior session over
//      the fresh blank chat (onResumeCb at sessionDrawer resume() ~1839).
//
// Fix: detect an in-flight switch (switchCtl.optimisticId()) so the guard
// doesn't swallow the click, and switchCtl.invalidate()+setOptimistic(null)
// so the continuation bails (mirrors deleteSessionAtomic).
//
// Repro (mocked): view chat X (content), then switch to chat Y which has
// NO local cache and a 2.5s /messages delay — a cold resume that blanks +
// spins. Inside that window click New chat.
//   Pre-fix: guard swallows the click → no new session is minted →
//            captureNextChatId times out → FAIL (failing-first signal).
//   Post-fix: a fresh blank chat is minted immediately, and Y's delayed
//             reconcile never repaints over it.

import {
  waitForReady, openSidebar, clickRow, clickNewChat, captureNextChatId, assert, dumpLines,
} from './lib.mjs';

export const NAME = 'new-chat-survives-inflight-resume';
export const DESCRIPTION = 'New chat clicked during a cold in-flight resume mints an instant blank chat; the late resume continuation must not repaint the prior session over it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_X = 'mock-newchat-inflight-x';
const CHAT_Y = 'mock-newchat-inflight-y';
const MARKER_X = 'XRAY current marker';
const MARKER_Y = 'YANKEE cold marker';

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
    lastActiveAt: Date.now() - 10_000,  // most-recent → boot lands here
  });
  mock.addChat(CHAT_Y, {
    title: 'Chat Y — cold + slow',
    source: 'parley',
    messages: [
      { role: 'user', content: MARKER_Y, message_id: 'y-1', parley_id: 'y-1',
        timestamp: Date.now() / 1000 - 300 },
      { role: 'assistant', content: MARKER_Y + ' reply', message_id: 'y-2', parley_id: 'y-2',
        timestamp: Date.now() / 1000 - 240 },
    ],
    lastActiveAt: Date.now() - 600_000,
  });
  // Cold resume into Y blanks + spins behind this delay (no local cache,
  // never visited this app-session). This is the window the user clicks
  // New chat inside.
  mock.setMessageDelay(CHAT_Y, 2500);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. View chat X — gives us an active chat with rendered bubbles.
  await clickRow(page, CHAT_X);
  await page.waitForFunction(
    (m) => new RegExp(m).test(document.getElementById('transcript')?.textContent || ''),
    MARKER_X, { timeout: 8_000, polling: 50 });
  log('viewing chat X (content rendered)');

  // 2. Start a COLD switch to Y. resume(Y) synchronously blanks the
  //    transcript + arms the spinner; the server fetch is in flight behind
  //    the 2.5s delay. Do NOT await the content — we want the in-flight
  //    window.
  await clickRow(page, CHAT_Y);
  // Let resume(Y) run its synchronous prologue (showTranscriptLoading +
  // begin() → optimistic=Y) before we click New chat. Well inside 2.5s.
  await page.waitForTimeout(300);

  // 3. Click New chat INSIDE the cold-resume window. Pre-fix: the no-op
  //    guard sees the blanked transcript and swallows this → no session is
  //    minted → captureNextChatId rejects on timeout (the failing-first
  //    signal). Post-fix: a fresh blank chat is minted immediately.
  const newChatP = captureNextChatId(page, { timeoutMs: 5000 });
  await clickNewChat(page);
  const newChatId = await newChatP;  // throws (test FAILS) pre-fix
  log(`new chat minted mid-resume: ${newChatId}`);

  await page.waitForFunction(
    () => /New chat started/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 8_000, polling: 50 });
  log('new chat painted blank with "New chat started" ✓');

  // 4. Let Y's delayed (2.5s) cold reconcile land + run its continuation.
  await page.waitForTimeout(3000);

  const { text, activeId } = await page.evaluate(() => ({
    text: document.getElementById('transcript')?.textContent || '',
    activeId: document.querySelector('#sessions-list li.active')?.dataset?.chatId || null,
  }));

  assert(/New chat started/.test(text),
    `BUG: the "New chat started" marker was lost — the in-flight resume repainted over the new chat.\n${await dumpLines(page)}`);
  assert(!new RegExp(MARKER_Y).test(text),
    'BUG: chat Y\'s transcript repainted over the fresh new chat. The new-chat handler must ' +
    'switchCtl.invalidate() so the in-flight resume continuation bails (mirrors deleteSessionAtomic).\n'
    + `transcript text: ${JSON.stringify(text.slice(0, 200))}`);
  assert(activeId !== CHAT_Y,
    `BUG: drawer re-highlighted chat Y (${activeId}) — the in-flight resume re-committed viewed over the new chat`);
  log('new chat minted instantly + survived the cold resume continuation ✓');
}
