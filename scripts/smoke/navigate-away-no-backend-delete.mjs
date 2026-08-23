// Regression: navigating AWAY from a chat that exists on the server
// must NEVER trigger a backend.deleteSession call. Cleanup is
// local-IDB-only; backend deletes are reserved for explicit user
// actions (menu delete, multi-select bulk).
//
// 2026-05-03 data-loss bug (origin):
//   1. Plugin patch made the gateway emit `${source}:${chat_id}` ids.
//      Local IDB still held bare chat_ids from before the patch.
//   2. Pre-fix merge appended every local bare-id row as "server
//      doesn't know about this" → 0-msg ghost shadowing each real
//      prefixed sibling.
//   3. cleanupAbandonedChat saw the 0-msg ghost on navigate-away,
//      called backend.deleteSession(bare_id).
//   4. Plugin's bare-id DELETE fallback defaulted source=parley,
//      found the real session, deleted it. 9 chats wiped silently.
//
// Post-v0.383 unification (current shape):
//   - IDB schema v2 clears the store on upgrade; bare-id rows can
//     no longer exist locally.
//   - mintChatId stamps `parley:`; cross-device hydrate carries the
//     gateway prefix. Local + server use the SAME id format.
//   - Merge dedup collapsed to direct key-equality — no prefix
//     arithmetic.
//
// This smoke seeds the realistic post-unification cross-device case
// (server has prefixed row, IDB has the SAME prefixed row from a
// prior hydrate) and locks in BOTH halves of the post-fix invariant:
//   A. Merge dedup: same prefixed key on both sides → ONE drawer row.
//   B. Cleanup contract: navigate-away from any populated chat fires
//      ZERO `DELETE /api/parley/sessions/*` requests.
//
// Companion to `empty-chat-navigate-away-cleanup.mjs` — that one tests
// the LEGITIMATE orphan-cleanup feature (which is preserved). This one
// tests the safety guarantee that backend data isn't collateral damage.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'navigate-away-no-backend-delete';
export const DESCRIPTION = 'Cross-device prefixed IDB row + prefixed server sibling: no ghost in drawer, no backend DELETE on navigate-away';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

// Post-v0.383: server has prefixed id; IDB has the SAME prefixed id
// (cross-device hydrate scenario). The merge collapses on direct
// key-equality.
const NATIVE_CHAT_ID = 'a4705789-9c40-4c09-a3c1-8a7c0acba35c';
const PREFIXED_ID = `parley:${NATIVE_CHAT_ID}`;
const OTHER_CHAT = 'parley:188ebca3-105c-45e9-b130-4fa63d7d6055';

export function MOCK_SETUP(mock) {
  // Server-side row with content — same shape the post-patch gateway
  // returns. Source intentionally "parley" to mirror the bug repro.
  mock.addChat(PREFIXED_ID, {
    title: 'Populating Notion Pitch Deck Page',
    source: 'parley',
    messages: [
      { role: 'user', content: 'real-server-msg-1', timestamp: Date.now() / 1000 - 120 },
      { role: 'assistant', content: 'real-server-reply-1', timestamp: Date.now() / 1000 - 119 },
    ],
    lastActiveAt: Date.now() - 120_000,
  });
  // Second real chat to navigate TO (the trigger for cleanupAbandonedChat).
  mock.addChat(OTHER_CHAT, {
    title: 'Reconnecting After a Connection Loss',
    source: 'parley',
    messages: [
      { role: 'user', content: 'other-msg', timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'other-reply', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  // Note: the bare-id local IDB row is NOT added to the mock — it's
  // pre-seeded into the PWA's IndexedDB via seedBareIdbRow below to
  // mirror exactly what a pre-patch user upgrading would see.
}

/** Seed a local IDB row matching a prefixed server row — the
 *  post-v0.383 cross-device hydrate shape. The merge in
 *  proxyClient.listSessions must collapse them into ONE drawer entry. */
async function seedPrefixedIdbRow(page, chatId) {
  await page.evaluate(async (id) => {
    const DB_NAME = 'parley-conversations';
    const STORE = 'conversations';
    const META = 'meta';
    // v2 schema (matches src/conversations.ts post-v0.383). Test must
    // open at the SAME version the PWA expects — opening at v1 would
    // trigger the v1→v2 clear() upgrade path on next PWA load and
    // wipe the seed.
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'chat_id' });
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        chat_id: id, title: 'New chat',
        created_at: Date.now() - 24 * 60 * 60 * 1000,
        last_message_at: Date.now() - 24 * 60 * 60 * 1000,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, chatId);
}

async function clickRow(page, chatId) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`).first().click();
}

export default async function run({ page, ctx, log }) {
  // Intercept ALL backend DELETE requests so we can assert the negative.
  // We don't care about other methods — fall through.
  const deleteCalls = [];
  await ctx.route('**/api/parley/sessions/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      const url = new URL(route.request().url());
      deleteCalls.push(decodeURIComponent(url.pathname));
      // Respond 200 so we don't break any flow that legitimately expected
      // delete to succeed (none should in this smoke, but be polite).
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    return route.fallback();
  });

  // Pre-seed the post-v0.383 cross-device shape: prefixed IDB row
  // matching the prefixed server sibling. Reload so boot's listSessions
  // merge picks it up.
  await waitForReady(page);
  await seedPrefixedIdbRow(page, PREFIXED_ID);
  await page.evaluate(() => location.reload());
  await waitForReady(page);
  await openSidebar(page);

  // ── Assertion A: merge dedup ── only ONE row for this chat in the
  // drawer. Same prefixed key on both sides → simple key-equality dedup
  // (post-v0.383 unification dropped the prefix-arithmetic dedup hack).
  await page.waitForSelector(`#sessions-list li[data-chat-id="${PREFIXED_ID}"]`, { timeout: 5_000 });
  const allMatching = await page.evaluate((nativeId) => {
    return Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'))
      .map(li => li.getAttribute('data-chat-id'))
      .filter(id => id === nativeId || id?.endsWith(`:${nativeId}`));
  }, NATIVE_CHAT_ID);
  assert(
    allMatching.length === 1 && allMatching[0] === PREFIXED_ID,
    `merge dedup: expected ONE row [${PREFIXED_ID}]; got ${JSON.stringify(allMatching)} ` +
    `(local + server should collapse on direct key-equality)`,
  );
  log('merge dedup ✓ — single row for the chat');

  // ── Assertion B: cleanup contract ── activate the prefixed row, then
  // navigate to the other chat. cleanupAbandonedChat fires with leaving =
  // PREFIXED_ID. Pre-rewrite rule: prefixed ids are off-limits to
  // auto-cleanup (rewritten in a follow-up commit to key off cached
  // messageCount instead of id shape — same end-result for this case).
  await clickRow(page, PREFIXED_ID);
  await page.waitForFunction(
    (id) => document.querySelector('#sessions-list li.active[data-chat-id]')?.getAttribute('data-chat-id') === id,
    PREFIXED_ID,
    { timeout: 5_000, polling: 100 },
  );
  log(`activated ${PREFIXED_ID.slice(0, 24)}…`);

  await clickRow(page, OTHER_CHAT);
  await page.waitForFunction(
    (id) => document.querySelector('#sessions-list li.active[data-chat-id]')?.getAttribute('data-chat-id') === id,
    OTHER_CHAT,
    { timeout: 5_000, polling: 100 },
  );
  log(`navigated to ${OTHER_CHAT.slice(0, 24)}…`);

  // Hold to let any deferred cleanup fire. cleanupAbandonedChat is sync
  // on the navigate-away callback; this just guards against any timer-
  // backed code path that might queue a delayed delete.
  await page.waitForTimeout(1000);

  // ── Negative assertion ── no DELETE was sent for either form.
  const offenders = deleteCalls.filter(p =>
    p.endsWith(`/${NATIVE_CHAT_ID}`) ||
    p.endsWith(`/${encodeURIComponent(PREFIXED_ID)}`) ||
    p.includes(NATIVE_CHAT_ID),
  );
  assert(
    offenders.length === 0,
    `cleanup contract: navigate-away triggered ${offenders.length} backend DELETE(s) for ` +
    `the populated chat — backend.deleteSession must be reserved for user-initiated actions. ` +
    `offenders: ${JSON.stringify(offenders)}`,
  );
  log(`cleanup contract ✓ — zero backend DELETEs (saw ${deleteCalls.length} unrelated)`);

  // Sanity: the prefixed row is still in the drawer after navigation.
  const stillThere = await page.evaluate((id) =>
    Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'))
      .some(li => li.getAttribute('data-chat-id') === id),
    PREFIXED_ID,
  );
  assert(stillThere, `${PREFIXED_ID} should still be in drawer after navigate-away`);
  log('survived navigation ✓');
}
