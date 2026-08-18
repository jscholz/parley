// Regression guard: sending a message produced TWO "Hey — received."
// bubbles in the transcript, one at the correct timestamp and one at
// 01:00 BST (= unix 0 + UTC+1, i.e. a row whose `created_at` is 0).
//
// Root cause (server-side): the items endpoint's
// `reconcile_from_state_db` tries to LINK the envelope-written
// parley.db row to its state.db twin by `(role, content)` match
// (Pass 1). When that fails — e.g. whitespace differs, hermes
// post-processed the assistant content slightly, or the link was
// raced — Pass 2 inserts a `legacy:<state_id>` row alongside the
// existing `msg_xyz` row. The items endpoint then returns BOTH
// rows; PWA projection keys them by their (different) sidekick_ids
// and renders BOTH bubbles.
//
// This is a parley.db.msg_links integrity bug; the proper fix is
// server-side (see structural notes in the same commit). This smoke
// pins a PWA-side defense: even when the wire response contains
// duplicate (role, content) assistant rows, the projection's
// content-dedup pre-pass collapses them to ONE bubble. The "winner"
// is the row with a real timestamp; the timestamp=0 ghost loses.
//
// Test plan (mocked):
//   1. Pre-seed a chat whose /messages response contains TWO assistant
//      rows with identical content, different sidekick_ids, and one
//      has timestamp=0 (the bug shape).
//   2. Click into the chat.
//   3. Assert exactly ONE .line.agent in transcript; the surviving
//      bubble's data-key is the real-timestamp one.

import { waitForReady, openSidebar, assert, clickRow } from './lib.mjs';

export const NAME = 'items-endpoint-dupes-dedup';
export const DESCRIPTION = 'Two durable assistant rows with same content + same role → ONE bubble (server-side reconcile dupe defense)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-items-dupes';
const REPLY_TEXT = 'Hey — received.';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Items endpoint dupe repro',
    source: 'sidekick',
    messages: [
      { role: 'user', content: 'hey test message', sidekick_id: 'umsg_user_q',
        timestamp: Date.now() / 1000 - 10 },
      // BAD duplicate row — timestamp=0, fake legacy sidekick_id.
      // Mirrors `reconcile_from_state_db` Pass 2 inserting a
      // `legacy:<state_id>` row when Pass 1's content-link match
      // failed.
      { role: 'assistant', content: REPLY_TEXT, sidekick_id: 'legacy:101',
        message_id: 'legacy:101', timestamp: 0 },
      // GOOD row — real timestamp, SSE-shape sidekick_id (what
      // write-through originally wrote).
      { role: 'assistant', content: REPLY_TEXT, sidekick_id: 'msg_xyz_real',
        message_id: 'msg_xyz_real', timestamp: Date.now() / 1000 - 5 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

async function dump(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line'))
      .map(el => ({
        cls: el.className,
        key: el.getAttribute('data-key') || null,
        text: (el.textContent || '').trim().slice(0, 80),
      })),
  );
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  // Wait until the chat's content renders.
  await page.waitForFunction(
    (t) => (document.getElementById('transcript')?.textContent || '').includes(t),
    REPLY_TEXT,
    { timeout: 4_000, polling: 80 },
  );

  // Count assistant bubbles whose text contains the reply marker.
  const matchCount = await page.evaluate((needle) =>
    Array.from(document.querySelectorAll('#transcript .line.agent'))
      .filter(el => (el.textContent || '').includes(needle))
      .length,
    REPLY_TEXT,
  );

  const lines = await dump(page);
  log(`assistant bubbles with reply text: ${matchCount}`);
  log(`  dump: ${JSON.stringify(lines)}`);

  assert(
    matchCount === 1,
    `expected exactly 1 assistant bubble (durable-vs-durable dedup); got ${matchCount}. dump: ${JSON.stringify(lines)}`,
  );

  // The surviving bubble should be the one with the real timestamp.
  // Its data-key (sidekick_id) is `msg_xyz_real`; the bad timestamp=0
  // row (`legacy:101`) should be absent from the DOM.
  const survivorKey = await page.evaluate((needle) => {
    const el = Array.from(document.querySelectorAll('#transcript .line.agent'))
      .find(el => (el.textContent || '').includes(needle));
    return el?.getAttribute('data-key') || null;
  }, REPLY_TEXT);
  assert(
    survivorKey === 'msg_xyz_real',
    `survivor should be the real-timestamp row (msg_xyz_real); got data-key=${survivorKey}`,
  );
}
