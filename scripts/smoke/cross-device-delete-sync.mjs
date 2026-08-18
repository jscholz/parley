// Regression gate for the 2026-05-16 cross-device delete bug.
//
// What broke: deleting a session on device A (phone) didn't propagate
// to device B (desktop). B's sidebar kept the row as a straggler;
// only manual refresh dropped the transcript, never the row. Plugin
// didn't emit any envelope on DELETE /v1/conversations/{id}.
//
// Fix (commit 5b9c713): plugin emits `conversation_deleted` envelope
// after the cascade. proxy added it to FANOUT_TYPES. proxyClient
// removes the IDB row + dispatches parley:server-conversation-
// deleted. sessionDrawer listens and schedules a refresh.
//
// What this test does:
//   1. Two chats in the mock + drawer.
//   2. Push `conversation_deleted` envelope for chat B.
//   3. Verify chat B's IDB row is gone + drawer row drops from DOM.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'cross-device-delete-sync';
export const DESCRIPTION = 'conversation_deleted envelope from "another device" → PWA drops the IDB row + sidebar entry';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_KEEP = 'mock-delete-keep';
const CHAT_REMOTE_DELETED = 'mock-delete-remote';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_KEEP, {
    title: 'Keep me',
    messages: [
      { role: 'user', content: 'keep-seed',
        sidekick_id: 'umsg_delete_keep', timestamp: Date.now() / 1000 - 60 },
    ],
  });
  mock.addChat(CHAT_REMOTE_DELETED, {
    title: 'Remote-delete me',
    messages: [
      { role: 'user', content: 'remote-delete-seed',
        sidekick_id: 'umsg_delete_remote', timestamp: Date.now() / 1000 - 120 },
    ],
  });
}

async function drawerChatIds(page) {
  return page.evaluate(() => Array.from(
    document.querySelectorAll('#sessions-list li[data-chat-id]'),
  ).map((li) => (li.getAttribute('data-chat-id') || '')));
}

async function idbConversations(page) {
  // Open the conversations DB and return all chat_ids. Schema: see
  // src/conversations.ts — store 'conversations' in 'parley-
  // conversations' db.
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('sidekick-conversations');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('conversations', 'readonly');
      const r = tx.objectStore('conversations').getAll();
      r.onsuccess = () => {
        const ids = (r.result || []).map((c) => c.chat_id);
        db.close();
        resolve(ids);
      };
      r.onerror = () => { db.close(); resolve([]); };
    };
    req.onerror = () => resolve([]);
  }));
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Diagnostic: list what's in the drawer.
  await page.waitForTimeout(800);
  const initial = await page.evaluate(() => Array.from(
    document.querySelectorAll('#sessions-list li[data-chat-id]'),
  ).map((li) => li.getAttribute('data-chat-id')));
  log(`drawer ids after boot: ${JSON.stringify(initial)}`);

  // Wait for both rows to populate the drawer (initial sessions
  // fetch).
  await page.waitForFunction(
    (args) => {
      const [a, b] = args;
      const ids = Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'))
        .map((li) => li.getAttribute('data-chat-id'));
      return ids.includes(a) && ids.includes(b);
    },
    [CHAT_KEEP, CHAT_REMOTE_DELETED],
    { timeout: 4_000 },
  );
  const preIds = await drawerChatIds(page);
  assert(preIds.includes(CHAT_KEEP) && preIds.includes(CHAT_REMOTE_DELETED),
    `both chats should be in drawer; got ${JSON.stringify(preIds)}`);
  log(`initial drawer: ${JSON.stringify(preIds)} ✓`);

  // Click the remote chat to hydrate its IDB row.
  await page.click(`#sessions-list li[data-chat-id="${CHAT_REMOTE_DELETED}"]`);
  await page.waitForFunction(
    () => /remote-delete-seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000 },
  );
  await page.waitForTimeout(200);  // let conversations.hydrate land
  const preIdb = await idbConversations(page);
  assert(preIdb.includes(CHAT_REMOTE_DELETED),
    `IDB should have ${CHAT_REMOTE_DELETED}; got ${JSON.stringify(preIdb)}`);
  log(`IDB has remote chat row before envelope ✓`);

  // Click back to the keep chat so we're not viewing the soon-to-be-
  // deleted one (avoids races between active-row clean-up and the
  // envelope handler).
  await page.click(`#sessions-list li[data-chat-id="${CHAT_KEEP}"]`);
  await page.waitForFunction(
    () => /keep-seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000 },
  );

  // Simulate another device deleting CHAT_REMOTE_DELETED.
  mock.pushEnvelope({
    type: 'conversation_deleted',
    chat_id: CHAT_REMOTE_DELETED,
    source: 'sidekick',
  });
  log('pushed conversation_deleted envelope simulating remote DELETE');

  // Wait for both the IDB row to be removed AND the sidebar to drop
  // the row. scheduleRefresh has its own debounce (50ms) so 1s is
  // plenty.
  await page.waitForFunction(
    (id) => {
      const ids = Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'))
        .map((li) => li.getAttribute('data-chat-id'));
      return !ids.includes(id);
    },
    CHAT_REMOTE_DELETED,
    { timeout: 3_000 },
  );

  const postIds = await drawerChatIds(page);
  assert(!postIds.includes(CHAT_REMOTE_DELETED),
    `drawer should no longer have ${CHAT_REMOTE_DELETED}; got ${JSON.stringify(postIds)}`);
  assert(postIds.includes(CHAT_KEEP),
    `keep chat should still be in drawer; got ${JSON.stringify(postIds)}`);
  log(`drawer row dropped after conversation_deleted ✓`);

  await page.waitForTimeout(300);  // IDB delete is async fire-and-forget
  const postIdb = await idbConversations(page);
  assert(!postIdb.includes(CHAT_REMOTE_DELETED),
    `IDB row should be removed; got ${JSON.stringify(postIdb)}`);
  log(`IDB row removed after conversation_deleted ✓`);
}
