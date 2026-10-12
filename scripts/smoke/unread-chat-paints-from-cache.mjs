// An unread chat must paint from the IndexedDB cache on tap, not from
// a fresh (slow) history fetch.
//
// Field 2026-10-12: "unread sessions from crons take a while to load
// when I click them". The boot prefetch covers the top-8 chats once per
// page load and the stale-tail sweep only refreshes chats that already
// have a cache, so a chat that produced its output after boot was a
// cold miss on tap — a full newest page over cellular before anything
// painted. Now the moment a chat turns unread its transcript is warmed
// into IDB in the background (src/unreadWarm.ts), so the tap paints
// from cache and only reconciles a delta.
//
// Mocked: user sits in chat A; a background reply lands in chat B and
// the stream announces unread_changed (as the real proxy does); the
// smoke waits for B's cache to hold the new message, THEN makes B's
// history fetch take 8 s, taps B, and expects the new reply on screen
// well inside that — with no loading state in between.

import { waitForReady, pollUntil, assert } from './lib.mjs';

/** Row tap that works at both widths: the mobile drawer is an overlay
 *  that the toggle button animates; forcing the expanded class and
 *  dispatching the click on the row body is what the other MOBILE='both'
 *  smokes do (user-attachments-survive-reload). */
async function tapRow(page, chatId) {
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, chatId);
}

export const NAME = 'unread-chat-paints-from-cache';
export const DESCRIPTION = 'A chat that turned unread while viewing another is warmed into IDB and paints instantly on tap even when its history fetch is slow';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const CHAT_A = 'parley:mock-unread-warm-a';
const CHAT_B = 'parley:mock-unread-warm-b';
const BG_MARKER = `CRON_OUTPUT_${Math.random().toString(36).slice(2, 8)}`;
const BG_MSG_ID = `msg_cron_${Math.random().toString(36).slice(2, 8)}`;

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(CHAT_A, {
    title: 'Where I am sitting', source: 'parley', lastActiveAt: Date.now() - 1000,
    messages: [
      { role: 'user', content: 'hello A', parley_id: 'umsg_a1', timestamp: t0 },
      { role: 'assistant', content: 'reply A', message_id: 'm-a1', timestamp: t0 + 1 },
    ],
  });
  mock.addChat(CHAT_B, {
    title: 'Daily recap (cron)', source: 'parley', lastActiveAt: Date.now() - 60_000,
    messages: [
      { role: 'user', content: 'older recap request', parley_id: 'umsg_b1', timestamp: t0 - 100 },
      { role: 'assistant', content: 'older recap', message_id: 'm-b1', timestamp: t0 - 99 },
    ],
  });
  mock.setAutoReplyEnabled(false);
}

async function cachedIds(page, chatId) {
  return page.evaluate((id) => new Promise((resolve) => {
    const req = indexedDB.open('parley-sessions');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction('messages', 'readonly').objectStore('messages').get(id);
        get.onsuccess = () => { db.close(); resolve((get.result?.messages || []).map((m) => String(m.message_id || m.id))); };
        get.onerror = () => { db.close(); resolve(null); };
      } catch { db.close(); resolve(null); }
    };
  }), chatId);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await pollUntil(page, (cid) => !!document.querySelector(`#sessions-list li[data-chat-id="${cid}"]`), CHAT_A,
    { timeout: 8_000, label: 'drawer never listed chat A' });
  await tapRow(page, CHAT_A);
  await pollUntil(page, () => /reply A/.test(document.getElementById('transcript')?.textContent || ''), null,
    { timeout: 8_000, label: 'chat A did not paint' });

  // Cron output lands in B while A is viewed; the proxy announces it.
  mock.pushReply(CHAT_B, BG_MARKER, BG_MSG_ID);      // persisted + streamed, like hermes
  mock.setUnread(CHAT_B, 1);                         // the plugin's unread_state write
  mock.pushEnvelope({ type: 'unread_changed', chat_id: CHAT_B });
  log('background reply + unread_changed pushed for chat B');

  // The badge refresh is debounced ~1.5 s; the warm follows it.
  const t0 = Date.now();
  let ids = null;
  while (Date.now() - t0 < 12_000) {
    ids = await cachedIds(page, CHAT_B);
    if (ids && ids.includes(BG_MSG_ID)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ids && ids.includes(BG_MSG_ID), `chat B's IDB cache never gained the background reply (cache: ${JSON.stringify(ids)})`);
  log(`chat B warmed into IDB ${Date.now() - t0} ms after the unread announce ✓`);

  // Now the network is slow. The tap must not care.
  mock.setMessageDelay(CHAT_B, 8_000);
  // The switch toggles `.transcript-loading` on and off around its first
  // paint; what matters is how long it STAYS on — a cache paint clears it
  // within a frame or two, a network paint leaves it up for the fetch.
  await page.evaluate(() => {
    window.__loadingMs = 0; let since = null;
    const el = document.getElementById('transcript');
    const mo = new MutationObserver(() => {
      const on = el.classList.contains('transcript-loading');
      if (on && since == null) since = performance.now();
      if (!on && since != null) { window.__loadingMs += performance.now() - since; since = null; }
    });
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  const tapAt = Date.now();
  await tapRow(page, CHAT_B);
  await pollUntil(page, (m) => (document.getElementById('transcript')?.textContent || '').includes(m), BG_MARKER,
    { timeout: 3_000, label: 'the cron output did not paint from cache' });
  const paintMs = Date.now() - tapAt;
  const loadingMs = await page.evaluate(() => Math.round(window.__loadingMs));
  assert(paintMs < 2_500, `painted after ${paintMs} ms — that is the slow fetch, not the cache`);
  assert(loadingMs < 600, `transcript sat in its loading state for ${loadingMs} ms on a cache-warm chat`);
  log(`tap → cron output on screen in ${paintMs} ms (loading state ${loadingMs} ms) with the history fetch stalled at 8 s ✓`);
}
