// Regression guard: typed in chat A, agent started replying, switched
// to chat B, switched back to A — the user bubble + the agent's
// in-flight reply were GONE until a manual refresh.
//
// Root cause: sessionDrawer.resume() cache-render path called
// onResumeCb(id, cached.messages, cached.pagination, []) passing []
// for inflight. replaySessionMessages did transcriptStore.setInflight(id, [])
// which CLOBBERED the live inflight envelopes that the SSE handlers had
// appended while chat B was viewed. The cache-match optimization (same
// durable length → skip re-render, replayInflight only) didn't always
// re-paint cleanly under virt.
//
// Fix: cache-render path passes undefined for inflight;
// replaySessionMessages only calls setInflight when an explicit array
// is passed (so undefined → preserve existing).
//
// Reproduces the field bug with a mocked chat: seed chat A's
// transcriptStore.inflight with a fake reply_delta envelope, switch to
// B, switch back, assert the in-flight bubble still in DOM.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'inflight-survives-switch-back';
export const DESCRIPTION = 'in-flight reply bubbles in chat A survive a switch to B + back to A';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-inflight-survive-a';
const CHAT_B = 'mock-inflight-survive-b';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat A — has in-flight reply',
    source: 'parley',
    messages: [
      { role: 'user', content: 'durable msg 1', message_id: 'a-dur-1', parley_id: 'a-dur-1',
        timestamp: Date.now() / 1000 - 120 },
      { role: 'assistant', content: 'durable reply 1', message_id: 'a-dur-2', parley_id: 'a-dur-2',
        timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B — sibling',
    source: 'parley',
    messages: [
      { role: 'user', content: 'b durable 1', message_id: 'b-dur-1', parley_id: 'b-dur-1',
        timestamp: Date.now() / 1000 - 30 },
    ],
    lastActiveAt: Date.now() - 30_000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. Open chat A. Cache populates with the 2 durable rows.
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => /durable reply 1/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 3_000, polling: 50 },
  );
  log('chat A opened, 2 durable rows rendered');
  await page.waitForTimeout(300);  // let scheduleSnapshotPersist debounce flush

  // 2. Inject in-flight envelopes into transcriptStore directly. Mirrors
  //    what live SSE handlers would do: user_message echo + reply_delta
  //    while the chat is viewed. Both bubbles must appear in DOM.
  await page.evaluate(async ({ chatId }) => {
    const mod = await import('/build/transcript/store.mjs');
    mod.appendInflight(chatId, {
      type: 'user_message',
      message_id: 'a-inflight-user',
      parley_id: 'a-inflight-user',
      text: 'IN-FLIGHT USER MARKER',
      conversation: chatId,
      timestamp: Date.now() / 1000,
    });
    mod.appendInflight(chatId, {
      type: 'reply_delta',
      message_id: 'a-inflight-reply',
      parley_id: 'a-inflight-reply',
      conversation: chatId,
      text: 'IN-FLIGHT AGENT MARKER (streaming…)',
      edit: true,
      timestamp: Date.now() / 1000,
    });
  }, { chatId: CHAT_A });
  await page.waitForFunction(
    () => /IN-FLIGHT USER MARKER/.test(document.getElementById('transcript')?.textContent || '')
       && /IN-FLIGHT AGENT MARKER/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 2_000, polling: 50 },
  );
  log('in-flight envelopes appended; both markers visible in DOM');

  // 3. Switch to chat B.
  await clickRow(page, CHAT_B);
  await page.waitForFunction(
    () => /b durable 1/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 3_000, polling: 50 },
  );
  log('switched to chat B');

  // 4. Switch back to chat A. Cache-render path runs (cached.messages
  //    has the 2 durable rows). Pre-fix: setInflight(A, []) clobbered
  //    the markers, server fetch's cache-match skip-or-replay didn't
  //    re-paint them. Post-fix: undefined inflight preserves them.
  await clickRow(page, CHAT_A);
  // Wait long enough for cache-render + server-fetch reconcile.
  await page.waitForTimeout(1500);

  const finalText = await page.evaluate(
    () => document.getElementById('transcript')?.textContent || '',
  );
  assert(/durable reply 1/.test(finalText),
    `post-switchback: durable rows should still be in DOM`);
  assert(/IN-FLIGHT USER MARKER/.test(finalText),
    `BUG: in-flight user bubble missing after switch-away-and-back. ` +
    `Pre-fix this was clobbered by setInflight(id, []) in the cache-render path.`);
  assert(/IN-FLIGHT AGENT MARKER/.test(finalText),
    `BUG: in-flight agent reply missing after switch-away-and-back.`);
  log('switch-back: in-flight bubbles survived ✓');
}
