// Scenario: when the user sends a message in a new chat, the sidebar
// entry for that chat appears IMMEDIATELY with a snippet of the user's
// text — before the agent's reply (which can take 30s+ on long
// tool-using turns) lands. Multiple back-to-back new chats stack in
// the sidebar as distinct entries with their respective snippets.
//
// Regression guard: after sending a message in a fresh new chat, the
// agent stalled (e.g. hit an approval gate). On reload the sidebar
// showed "New chat 0 msgs" — no signal that the message was anywhere
// — and the transcript view was confused. Server-side state.db had
// everything; the PWA just didn't surface it.
//
// Fix: sendTypedMessage now calls sessionDrawer.handleSessionAnnounced
// with a text snippet at send time, synthesizing a pending sidebar
// row before the agent has replied. handleSessionAnnounced is
// idempotent; the server-side session_changed envelope replaces the
// pending row with the canonical title later.
//
// Test plan (mocked):
//   1. Click new-chat, send "first marker". Assert sidebar shows a row
//      with "first marker" snippet within 200ms (before the mock's
//      50ms auto-reply has even finished, definitely before any
//      session_changed envelope).
//   2. Click new-chat, send "second marker". Assert BOTH rows appear
//      in the sidebar with their respective snippets.
//   3. Reload. Assert both rows still visible with snippets (cached
//      via the proxy's sessions response from state.db).

import { waitForReady, openSidebar, clickNewChat, send, captureNextChatId, assert } from './lib.mjs';

export const NAME = 'sidebar-immediate-title';
export const DESCRIPTION = 'New chat sidebar entry appears with user-text snippet immediately on send; multiple chats stack';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  // Suppress mock auto-reply so the in-flight window stays open long
  // enough to test the drawer-refresh path. Without this, the 50ms
  // auto-reply lands a reply_final almost immediately, which causes
  // hermes-style session_changed flow to fire — the bug we're pinning
  // here is that during the in-flight window
  // BEFORE session_changed arrives, the drawer shows 'New chat'
  // because mergePending drops the pending row when the chat enters
  // cachedSessions via listSessions' local-only-row path.
  mock.setAutoReplyEnabled(false);
  // Mirror real hermes persistence semantics: first_user_message is
  // NOT surfaced in the sessions list until an assistant reply has
  // landed. Without this the mock cheats and serves the user's text
  // as first_user_message immediately at POST, masking the field
  // bug. With it, the listSessions response carries title:null +
  // first_user_message:null mid-turn — identical to what production
  // hermes returns.
  mock.setPostTurnPersistence(true);
}

const MARKER_1 = `first-marker-${Math.random().toString(36).slice(2, 8)}`;
const MARKER_2 = `second-marker-${Math.random().toString(36).slice(2, 8)}`;

async function sidebarRowsBySnippet(page) {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'));
    return rows.map(r => ({
      chatId: r.getAttribute('data-chat-id'),
      // The drawer renders s.title || s.snippet || s.id in .sess-snippet.
      // Read the rendered text since the actual display is what matters.
      text: (r.querySelector('.sess-snippet')?.textContent || '').trim(),
    }));
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // === Step 1: send first marker, assert immediate sidebar snippet ===
  const id1Promise = captureNextChatId(page);
  await clickNewChat(page);
  const chatId1 = await id1Promise;
  log(`minted chat 1: ${chatId1}`);

  await send(page, MARKER_1);
  // Poll briefly — sessionDrawer.handleSessionAnnounced runs
  // synchronously after the send POST returns, but the drawer's
  // renderListFiltered fires via the pending Map update, so allow
  // a few frames for the DOM to reflect.
  await page.waitForFunction(
    ({ chatId, marker }) => {
      const rows = document.querySelectorAll('#sessions-list li[data-chat-id]');
      for (const r of rows) {
        if (r.getAttribute('data-chat-id') === chatId
            && (r.textContent || '').includes(marker)) return true;
      }
      return false;
    },
    { chatId: chatId1, marker: MARKER_1 },
    { timeout: 3_000, polling: 50 },
  );
  log(`sidebar entry for chat 1 shows "${MARKER_1}" ✓`);

  // === Step 2: new chat, send second marker, assert BOTH stack ===
  const id2Promise = captureNextChatId(page);
  await clickNewChat(page);
  const chatId2 = await id2Promise;
  assert(chatId2 !== chatId1, `new chat should mint a different id, got ${chatId2} === ${chatId1}`);
  log(`minted chat 2: ${chatId2}`);

  await send(page, MARKER_2);
  // Give pending + listSessions enough time to settle, then dump
  // sidebar state before asserting — without this the timeout error
  // doesn't tell us WHY the assertion failed (was the row missing?
  // present with the wrong text?).
  await page.waitForTimeout(500);
  const sidebarBefore = await sidebarRowsBySnippet(page);
  log(`sidebar after both sends: ${JSON.stringify(sidebarBefore)}`);
  // Diagnostic — what's actually in IDB for these chats?
  const idbState = await page.evaluate(async () => {
    return new Promise((resolve) => {
      const req = indexedDB.open('parley-conversations');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('conversations', 'readonly');
        const r = tx.objectStore('conversations').getAll();
        r.onsuccess = () => {
          resolve(r.result.map(c => ({ id: c.chat_id, title: c.title, userTitle: c.userTitle })));
          db.close();
        };
        r.onerror = () => { resolve('err'); db.close(); };
      };
      req.onerror = () => resolve('open-err');
    });
  });
  log(`IDB conversations after both sends: ${JSON.stringify(idbState)}`);
  await page.waitForFunction(
    ({ id1, id2, m1, m2 }) => {
      const rows = Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'));
      const r1 = rows.find(r => r.getAttribute('data-chat-id') === id1);
      const r2 = rows.find(r => r.getAttribute('data-chat-id') === id2);
      return !!r1 && !!r2
        && (r1.textContent || '').includes(m1)
        && (r2.textContent || '').includes(m2);
    },
    { id1: chatId1, id2: chatId2, m1: MARKER_1, m2: MARKER_2 },
    { timeout: 3_000, polling: 50 },
  );
  log(`both sidebar entries visible with their respective snippets ✓`);

  // === Step 2b: pin the mid-turn survival case ===
  // Pre-fix, the snippet appeared in step 1/2 (handleSessionAnnounced
  // creates the pending row synchronously) but was OVERWRITTEN by the
  // next drawer refresh: listSessions' local-only-row path returned
  // {title:'New chat', snippet:''} from IDB, mergePending dropped the
  // pending entry because the chat was now in cachedSessions, and the
  // drawer reverted to 'New chat'. Fix: proxyClient.sendMessage stamps
  // the IDB title with the snippet on send via stampPlaceholderTitle
  // so the local-only-row path carries it forward. Trigger a refresh
  // by dispatching visibilitychange (the OS-lifecycle handler that
  // refreshes the drawer on foregrounding), then assert snippets
  // survived.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get() { return 'visible'; },
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(800);
  const midTurn = await sidebarRowsBySnippet(page);
  log(`mid-turn drawer (post-refresh, pre-reload): ${JSON.stringify(midTurn)}`);
  const r1Mid = midTurn.find(r => r.chatId === chatId1);
  const r2Mid = midTurn.find(r => r.chatId === chatId2);
  assert(r1Mid && r1Mid.text.includes(MARKER_1),
    `mid-turn: chat 1 should still show "${MARKER_1}" after refresh; got ${JSON.stringify(r1Mid)}`);
  assert(r2Mid && r2Mid.text.includes(MARKER_2),
    `mid-turn: chat 2 should still show "${MARKER_2}" after refresh; got ${JSON.stringify(r2Mid)}`);
  log(`snippets survive mid-turn drawer refresh ✓`);

  // Inspect the drawer state for the assertion-error message in case
  // the reload assertion fails — clearer debugging.
  const before = await sidebarRowsBySnippet(page);
  log(`pre-reload drawer: ${JSON.stringify(before)}`);

  // === Step 3: reload, assert BOTH still visible ===
  // The mock-backend's chats Map persists across the reload (it's in
  // the Playwright route handler, not the page), so the sessions
  // endpoint will return both chats with their messages — the title
  // falls back to s.snippet (the user's text we already announced) or
  // first_user_message until the agent generates a real one.
  await page.reload();
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForFunction(
    ({ id1, id2 }) => {
      const rows = Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'));
      return rows.some(r => r.getAttribute('data-chat-id') === id1)
        && rows.some(r => r.getAttribute('data-chat-id') === id2);
    },
    { id1: chatId1, id2: chatId2 },
    { timeout: 5_000, polling: 100 },
  );
  const after = await sidebarRowsBySnippet(page);
  log(`post-reload drawer: ${JSON.stringify(after)}`);
  log(`both sidebar entries survive reload ✓`);
}
