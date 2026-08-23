// Symptom 2 of the new-chat glitch (field report 2026-06-16): repeated
// New-chat presses (with a message sent in between) stack multiple
// "New chat started" system lines in the transcript.
//
// Root cause: chat.addSystemLine('New chat started') appends a KEYLESS
// `.line.system` div straight to #transcript — it bypasses the projection
// model. The reconciler deliberately PRESERVES keyless system rows across
// reconciles (they're orthogonal markers, not bubbles — reconciler.ts).
// The new-chat handler (main.ts #sb-new-chat) clears the OUTGOING chat
// with transcriptStore.clearAll(prevViewed) — a STORE clear that makes the
// reconciler drop the projection bubbles but LEAVE the system line behind —
// rather than chat.clear() (innerHTML='', the only thing that wipes system
// lines). So the prior "New chat started" survives and the handler appends
// a fresh one on top of it.
//
// Repro (mocked):
//   1. Boot onto a seeded chat.
//   2. New chat → "New chat started" #1 in the fresh blank chat.
//   3. Send a message → the chat now carries BOTH a content bubble AND the
//      preserved system line #1 (the guard also needs content so the next
//      press isn't no-op'd).
//   4. New chat again → clearAll drops the content bubble but preserves
//      system line #1; the handler appends "New chat started" #2.
//   Pre-fix: TWO "New chat started" lines in #transcript → FAIL.
//   Post-fix: the handler clears the transcript (chat.clear) so exactly one
//            "New chat started" line remains.

import {
  waitForReady, openSidebar, clickNewChat, send, assert, dumpLines,
} from './lib.mjs';

export const NAME = 'new-chat-no-duplicate-system-line';
export const DESCRIPTION = 'repeated New-chat presses (with a message between) must not stack multiple "New chat started" system lines (symptom 2)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-newchat-dupsys-a';
const MARKER_A = 'ALPHA seeded marker';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat A — seeded',
    source: 'parley',
    messages: [
      { role: 'user', content: MARKER_A, message_id: 'a-1', parley_id: 'a-1',
        timestamp: Date.now() / 1000 - 120 },
      { role: 'assistant', content: MARKER_A + ' reply', message_id: 'a-2', parley_id: 'a-2',
        timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 5_000,
  });
}

function countNewChatLines(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return 0;
    return Array.from(t.querySelectorAll('.line.system'))
      .filter(el => /New chat started/.test(el.textContent || ''))
      .length;
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. First New chat → fresh blank chat with "New chat started" #1.
  await clickNewChat(page);
  await page.waitForFunction(
    () => /New chat started/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 8_000, polling: 50 });
  log('first New chat → "New chat started" #1');

  // 2. Send a message so the chat carries content (a bubble) alongside the
  //    preserved system line — also flips the no-op guard's hasContent so
  //    the next New-chat press actually runs.
  await send(page, 'first thing I want to say');
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line.s0, #transcript .line.user').length > 0,
    null, { timeout: 8_000, polling: 50 });
  log('sent a message — chat now has a content bubble + the system line');

  // 3. Second New chat. clearAll(prevViewed) drops the content bubble but
  //    the keyless system line survives; the handler appends a second one.
  await clickNewChat(page);
  await page.waitForFunction(
    () => /New chat started/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 8_000, polling: 50 });
  // Let the reconcile + addSystemLine settle.
  await page.waitForTimeout(300);

  const n = await countNewChatLines(page);
  log(`"New chat started" system lines after second New chat: ${n}`);

  assert(n === 1,
    `BUG: ${n} "New chat started" system lines stacked in the transcript (expected exactly 1). ` +
    'addSystemLine appends a keyless .line.system the reconciler preserves; the new-chat handler ' +
    'clears the outgoing chat with transcriptStore.clearAll (store-only) instead of chat.clear ' +
    `(innerHTML=''), so the prior system line survives and a new one is stacked on top.\n` +
    `${await dumpLines(page)}`);
  log('exactly one "New chat started" line ✓');
}
