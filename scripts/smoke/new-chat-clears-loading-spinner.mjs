// Symptom 3 of the new-chat glitch (field report 2026-06-16): clicking
// New chat WHILE a cold session-switch resume is still in flight leaves
// the `.transcript-loading` spinner armed forever — the fresh blank chat
// shows "New chat started" with a spinner overlaying it that never goes
// away (the user's "spinner in it for about ten seconds" that then needed
// a SECOND New-chat press to clear).
//
// Root cause: a cold switch runs showTranscriptLoading() — it blanks
// #transcript and adds `.transcript-loading` (the CSS spinner is
// `.transcript.transcript-loading::after`, app.css). The new-chat handler
// (main.ts #sb-new-chat) then:
//   - switchCtl.invalidate()s the in-flight resume so its continuation
//     bails (correct — that's the #251 fix) — but that continuation is the
//     ONLY thing that would have reached sessionResume.ts:230's
//     `classList.remove('transcript-loading')`. Killed mid-flight, it
//     never clears the class.
//   - paints the blank chat with chat.addSystemLine('New chat started') —
//     a direct DOM append that BYPASSES the projection, so rerenderInto()
//     (which clears `.transcript-loading`, but only when specs.length > 0)
//     never runs for the empty new chat.
// Net: the class is armed by the cold switch and nothing in the new-chat
// path removes it. Spinner-forever.
//
// This is the gap #251's smoke (new-chat-survives-inflight-resume) leaves
// uncovered: it asserts "New chat started" paints + the prior session
// doesn't repaint, but never checks the loading class.
//
// Repro (mocked): mirrors #251 — view chat X (content), start a COLD
// switch to chat Y (no local cache, 2.5s /messages delay → blanks + arms
// the spinner), then click New chat inside that window.
//   Pre-fix: #transcript keeps `.transcript-loading` after the new chat
//            settles → FAIL (failing-first signal).
//   Post-fix: the new-chat handler clears `.transcript-loading` so the
//            fresh blank chat shows no spinner.

import {
  waitForReady, openSidebar, clickRow, clickNewChat, captureNextChatId, assert, dumpLines,
} from './lib.mjs';

export const NAME = 'new-chat-clears-loading-spinner';
export const DESCRIPTION = 'New chat clicked during a cold in-flight resume must clear the .transcript-loading spinner, not leave it armed forever (symptom 3)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_X = 'mock-newchat-spinner-x';
const CHAT_Y = 'mock-newchat-spinner-y';
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
  // Cold resume into Y blanks + arms `.transcript-loading` behind this
  // delay (no local cache, never visited this app-session). This is the
  // window the user clicks New chat inside.
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
  //    transcript + arms `.transcript-loading`; the server fetch is in
  //    flight behind the 2.5s delay.
  await clickRow(page, CHAT_Y);
  await page.waitForFunction(
    () => document.getElementById('transcript')?.classList.contains('transcript-loading'),
    null, { timeout: 4_000, polling: 25 });
  log('cold switch to Y armed .transcript-loading (spinner showing)');

  // 3. Click New chat INSIDE the cold-resume window.
  const newChatP = captureNextChatId(page, { timeoutMs: 5000 });
  await clickNewChat(page);
  const newChatId = await newChatP;
  log(`new chat minted mid-resume: ${newChatId}`);

  await page.waitForFunction(
    () => /New chat started/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 8_000, polling: 50 });
  log('new chat painted blank with "New chat started"');

  // 4. Let Y's delayed (2.5s) cold reconcile land. Its continuation is
  //    invalidated and bails — so it can NOT be the thing that clears the
  //    spinner. The new-chat handler must have cleared it itself.
  await page.waitForTimeout(3000);

  const { spinnerArmed, text } = await page.evaluate(() => ({
    spinnerArmed: !!document.getElementById('transcript')?.classList.contains('transcript-loading'),
    text: document.getElementById('transcript')?.textContent || '',
  }));

  // Sanity: we're actually on the fresh blank chat (not Y repainted).
  assert(/New chat started/.test(text),
    `BUG: lost the new chat — "New chat started" missing.\n${await dumpLines(page)}`);
  assert(!new RegExp(MARKER_Y).test(text),
    `BUG: chat Y repainted over the new chat.\ntranscript: ${JSON.stringify(text.slice(0, 200))}`);

  // The cardinal assertion: the spinner must be gone.
  assert(!spinnerArmed,
    'BUG: `.transcript-loading` spinner stayed armed on the fresh new chat. The new-chat ' +
    'handler invalidated the in-flight resume (so its continuation can no longer clear the ' +
    'class) and painted the blank chat via addSystemLine (which bypasses rerenderInto), so ' +
    'nothing removes `.transcript-loading` — spinner-forever. The handler must clear it ' +
    `explicitly.\n${await dumpLines(page)}`);
  log('new chat cleared the loading spinner ✓');
}
