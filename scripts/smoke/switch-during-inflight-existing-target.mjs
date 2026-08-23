// Regression guard:
//
//   1. New chat → send "set a 10 second timer"
//   2. Switch to an EXISTING chat in the drawer (heavier resumeSession
//      path than switching to another fresh empty chat)
//   3. The original chat's sidebar title showed "New chat" (not the user's
//      snippet) for the full in-flight window, then briefly flashed the
//      snippet when the reply landed.
//   4. Switch back to the original chat — user message gone from transcript
//      in some runs, present in others.
//
// Root cause: cleanupAbandonedChat (main.ts) fires on `onBeforeSwitch`.
// Its heuristic for "is this an unsent orphan?" is
// `cached.messageCount === 0`. Real hermes (and now the mocked agent
// with `setPostTurnPersistence(true)`) returns `message_count: 0` for
// the whole in-flight window because `append_to_transcript` fires AFTER
// the turn completes. So cleanup wipes the local IDB row mid-turn,
// undoing the title snippet that proxyClient.sendMessage stamped on send.
//
// Fix (main.ts:cleanupAbandonedChat): also check the local IDB title —
// if it's anything other than the 'New chat' placeholder, the user
// explicitly sent content; never auto-clean.
//
// Test plan (mocked, with hermes-faithful timing):
//   1. Pre-seed chat B (an existing chat with content) so step 3 has
//      something to switch TO.
//   2. mock.setAutoReplyEnabled(false) + mock.setPostTurnPersistence(true)
//      — keep the in-flight window open + hide message_count and
//      first_user_message until reply_final.
//   3. Click new chat → mints chat A.
//   4. send(PROMPT) → handleSessionAnnounced + proxyClient.sendMessage's
//      hydrate(chatA, snippet) writes IDB title=snippet.
//   5. Switch to chat B (click drawer row) → cleanupAbandonedChat for
//      chat A. With the fix, it reads IDB, sees title=snippet (not
//      'New chat'), and skips.
//   6. Assert chat A's IDB row STILL has title=snippet (cleanup was
//      bypassed). This is the precise regression repro.
//   7. Assert chat A's sidebar row STILL shows the snippet.
//
// Note: this smoke pins the IDB-survival half. The transcript-survival
// after switch-back-with-reply needs the inflight cache (already shipped)
// to surface the user_message envelope until state.db catches up.

import { waitForReady, openSidebar, clickNewChat, send, captureNextChatId, assert } from './lib.mjs';

export const NAME = 'switch-during-inflight-existing-target';
export const DESCRIPTION = 'Switching to an existing chat mid-turn must not wipe the in-flight chat\'s IDB row';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_B = 'mock-existing-target';
const PROMPT = 'set a 10 second timer';

export function MOCK_SETUP(mock) {
  // Pre-seeded existing chat so step 3 has a switch target.
  mock.addChat(CHAT_B, {
    title: 'Existing Chat With Content',
    source: 'parley',
    messages: [
      { role: 'user', content: 'hi there', timestamp: Date.now() / 1000 - 120 },
      { role: 'assistant', content: 'hello!', timestamp: Date.now() / 1000 - 119 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  // Real-hermes timing — both flags required to repro the cleanup
  // wipe (see top-of-file docstring).
  mock.setAutoReplyEnabled(false);
  mock.setPostTurnPersistence(true);
}

async function readIDB(page, chatId) {
  return page.evaluate(async (id) => {
    return new Promise((resolve) => {
      const req = indexedDB.open('parley-conversations');
      req.onsuccess = () => {
        const db = req.result;
        const r = db.transaction('conversations', 'readonly').objectStore('conversations').get(id);
        r.onsuccess = () => { resolve(r.result || null); db.close(); };
        r.onerror = () => { resolve('err'); db.close(); };
      };
      req.onerror = () => resolve('open-err');
    });
  }, chatId);
}

async function sidebarText(page, chatId) {
  return page.evaluate((id) => {
    const row = document.querySelector(`#sessions-list li[data-chat-id="${CSS.escape(id)}"]`);
    if (!row) return null;
    return (row.querySelector('.sess-snippet')?.textContent || '').trim();
  }, chatId);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Mint chat A via the PWA new-chat flow.
  const chatAP = captureNextChatId(page);
  await clickNewChat(page);
  const chatA = await chatAP;
  log(`chat A: ${chatA}`);

  // Send the prompt. proxyClient.sendMessage's hydrate stamps IDB
  // title=snippet; handleSessionAnnounced renders the pending row.
  await send(page, PROMPT);
  await page.waitForTimeout(500);

  // Sanity: IDB has the snippet title at this point.
  const idbAfterSend = await readIDB(page, chatA);
  assert(
    idbAfterSend && idbAfterSend.title === PROMPT,
    `after-send: IDB chat A title should be the prompt, got ${JSON.stringify(idbAfterSend)}`,
  );
  log(`sanity: IDB chat A title = ${JSON.stringify(idbAfterSend.title)} ✓`);

  // Switch to the pre-existing chat B. This is what fires
  // cleanupAbandonedChat with leavingId=chatA. Pre-fix: cleanup deletes
  // IDB chat A because the mock-served message_count=0 (postTurnPersistence
  // gate); IDB title=snippet → blank → drawer reverts to 'New chat'.
  // Post-fix: cleanup reads IDB.title, sees it isn't 'New chat', skips.
  await page.locator(`#sessions-list li[data-chat-id="${CHAT_B}"] .sess-body`).first().click();
  // Generous wait — cleanup is async fire-and-forget, drawer refresh is
  // debounced, listSessions is two-stage (cache + server). 1.5s covers all.
  await page.waitForTimeout(1500);

  // Assert IDB chat A's row still exists with title=snippet.
  const idbAfterSwitch = await readIDB(page, chatA);
  assert(
    idbAfterSwitch !== null,
    `IDB chat A row was deleted by cleanupAbandonedChat — title-snippet skip didn't fire`,
  );
  assert(
    idbAfterSwitch.title === PROMPT,
    `IDB chat A title was wiped: ${JSON.stringify(idbAfterSwitch)}`,
  );
  log(`IDB chat A row survived switch-away with title intact ✓`);

  // Drawer-level assertion — the sidebar row for chat A should show
  // the snippet, not 'New chat' / '(processing…)'.
  const aSidebar = await sidebarText(page, chatA);
  assert(
    aSidebar && aSidebar.includes(PROMPT.slice(0, 20)),
    `chat A sidebar should show snippet "${PROMPT}", got ${JSON.stringify(aSidebar)}`,
  );
  log(`chat A sidebar shows snippet (${JSON.stringify(aSidebar)}) ✓`);
}
