// Field bug 2026-06-12 (missing user bubble, [SF meeting planning]):
// the TFC-B stale-tail sweep fetches the tiny 12-row prefetch window
// and merges it into the cached transcript. When a stale chat gained
// MORE new rows than the window covers, the window does not overlap
// the cached tail — mergeNewestPage (id-keyed upsert+append, no
// contiguity check) splices the newest rows onto the old tail and the
// uncovered middle rows become a permanent mid-transcript hole. Delta
// resume (#191) then uses the merged cache's newest id as its `after`
// cursor, fetches nothing, and the hole never heals.
//
// Fix under test: the merge is only taken when the fetched window
// OVERLAPS the cache (shares at least one id); otherwise the cache is
// replaced by the window flagged `partial: true`, which delta resume
// refuses as a cursor — the next open does a full fetch and heals.
//
// Test plan (mocked):
//   1. Seed chats A (to view) and B (20 msgs, last activity ~10 min ago).
//   2. Open B → resume primes its cache. Switch to A.
//   3. Silently re-seed B with 15 NEW messages (21..35, > the 12-row
//      prefetch window) + lastActiveAt = now. No SSE.
//   4. Kick drawer refresh() → sweep fetches newest 12 (msgs 24..35) —
//      ZERO overlap with cached 1..20. Wait for msg 35 in cache.
//   5. Switch to B. Messages 21..23 (the would-be hole — analog of the
//      missing user bubble) MUST render once the resume settles.

import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'stale-tail-no-hole';
export const DESCRIPTION = 'stale-tail sweep with more new rows than the prefetch window must not splice a permanent hole into the cached transcript';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-tfcb2-viewed';
const CHAT_B = 'mock-tfcb2-stale';
const B_MSGS = 20;
const NEW_MSGS = 15; // > the 12-row prefetch window → no overlap
const HOLE_MSG_IDS = ['tfcb2-msg-21', 'tfcb2-msg-22', 'tfcb2-msg-23'];
const WINDOW_TAIL_ID = `tfcb2-msg-${B_MSGS + NEW_MSGS}`;

function bMessages(count, { base = Date.now() - 10 * 60_000, startIdx = 1 } = {}) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    const idx = startIdx + i;
    const role = idx % 2 === 1 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user b ${idx}` : `agent b ${idx}`,
      parley_id: `tfcb2-msg-${idx}`,
      timestamp: (base - (count - 1 - i) * 60_000) / 1000,
    });
  }
  return messages;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'TFC-B2 viewed chat',
    source: 'parley',
    messages: [
      { role: 'user', content: 'hello from A', parley_id: 'tfcb2-a-1', timestamp: Date.now() / 1000 },
    ],
    lastActiveAt: Date.now(),
  });
  mock.addChat(CHAT_B, {
    title: 'TFC-B2 stale chat',
    source: 'parley',
    messages: bMessages(B_MSGS),
    lastActiveAt: Date.now() - 10 * 60_000,
  });
}

const clickChat = (page, cid) => page.evaluate((c) => {
  document.body.classList.add('sidebar-expanded');
  document.querySelector(`#sessions-list li[data-chat-id="${c}"] .sess-body`)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}, cid);

const cacheHasMsg = (page, chatId, sid) => page.evaluate(async ({ c, s }) => {
  const sc = await import('/build/sessionCache.mjs');
  const rec = await sc.getMessagesCache(c);
  return !!rec?.messages?.some((m) => m?.parley_id === s);
}, { c: chatId, s: sid });

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // 1-2. Prime B's cache via a real resume, then move to A.
  await clickChat(page, CHAT_B);
  await page.waitForFunction(
    () => !!document.querySelector('#transcript .line[data-message-id="tfcb2-msg-20"]'),
    { timeout: 8_000, polling: 100 });
  await page.waitForTimeout(600); // resume reconcile + cache write settle
  await clickChat(page, CHAT_A);
  await page.waitForFunction(
    () => !!document.querySelector('#transcript .line[data-message-id="tfcb2-a-1"]'),
    { timeout: 8_000, polling: 100 });
  assert(await cacheHasMsg(page, CHAT_B, 'tfcb2-msg-20'), 'B cache primed with its tail');
  log('B cache primed (msgs 1..20); now viewing A ✓');

  // 3. B advances by 15 messages server-side, silently (no SSE).
  mock.addChat(CHAT_B, {
    title: 'TFC-B2 stale chat',
    source: 'parley',
    messages: [
      ...bMessages(B_MSGS),
      ...bMessages(NEW_MSGS, { base: Date.now(), startIdx: B_MSGS + 1 }),
    ],
    lastActiveAt: Date.now(),
  });
  assert(!(await cacheHasMsg(page, CHAT_B, WINDOW_TAIL_ID)),
    'before the sweep, B cache must NOT contain the new tail');
  log(`server-side burst of ${NEW_MSGS} messages landed silently ✓`);

  // 4. Drawer refresh → sweep fetches the newest 12 rows (24..35),
  //    which share NO id with the cached 1..20.
  await page.evaluate(async () => {
    const sd = await import('/build/sessionDrawer.mjs');
    await sd.refresh();
  });
  await pollUntil(page, async ({ c, s }) => {
    const sc = await import('/build/sessionCache.mjs');
    const rec = await sc.getMessagesCache(c);
    return !!rec?.messages?.some((m) => m?.parley_id === s);
  }, { c: CHAT_B, s: WINDOW_TAIL_ID }, { timeout: 8_000, polling: 200, label: `sweep never merged ${WINDOW_TAIL_ID} into B's cache` });
  log('sweep refreshed B cache with the no-overlap window ✓');

  // 5. Switch to B — the messages the window skipped (21..23) must
  //    render once the resume settles. With the splice bug the cache
  //    is non-partial and delta resume's after-cursor is already at
  //    the tail, so the hole never heals and this times out.
  await clickChat(page, CHAT_B);
  await page.waitForFunction(
    (m) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(m)}"]`),
    WINDOW_TAIL_ID, { timeout: 8_000, polling: 100 });
  const holeHealed = await page.waitForFunction(
    (ids) => ids.every((m) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(m)}"]`)),
    HOLE_MSG_IDS, { timeout: 8_000, polling: 100 }).then(() => true).catch(() => false);
  assert(holeHealed,
    `mid-transcript hole: ${HOLE_MSG_IDS.join(', ')} never rendered after switching back (missing-user-bubble field bug)`);
  assert(await cacheHasMsg(page, CHAT_B, HOLE_MSG_IDS[0]),
    'healed transcript must also be persisted to the cache');
  log('hole messages 21..23 rendered and cached after resume ✓');
}
