// Scenario: New-chat rotation must NOT auto-delete empty drawer rows.
//
// Inverted from its original form: the prior version asserted rotation
// cleaned up stale 0-msg chats. That auto-cleanup behavior was removed
// (main.ts:1751 comment) after confirmed data loss — sessions were wiped
// because their messageCount transiently read 0 during
// session-rotation/compression. Hard rule: parley never auto-deletes
// server-side data; stale empty rows stay until the user removes them
// via the row menu.
//
// This test now LOCKS IN that invariant — a regression to "rotation
// auto-deletes empty rows" would re-introduce the data-loss bug.
//
// Test plan (mocked):
//   1. Pre-populate 1 chat with content (chat A) + 3 empty 0-msg chats.
//   2. Click chat A; send "hi" so hasContent guard passes for new-chat.
//   3. Click new-chat (rotation).
//   4. Assert: all 3 stale 0-msg chats are STILL in the drawer.
//      Chat A (with content) is still there. The newly-minted chat may
//      or may not appear depending on server-confirm timing — we don't
//      assert on it.

import { waitForReady, openSidebar, clickNewChat, send, assert } from './lib.mjs';

export const NAME = 'empty-chat-rotation-cleanup';
export const DESCRIPTION = 'New-chat rotation preserves stale 0-msg drawer rows (no auto-delete invariant)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-chat-with-content';
const STALE_IDS = [
  'mock-stale-empty-1',
  'mock-stale-empty-2',
  'mock-stale-empty-3',
];

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat with content',
    messages: [
      { role: 'user', content: 'previous-msg', timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'previous-reply', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  for (let i = 0; i < STALE_IDS.length; i++) {
    mock.addChat(STALE_IDS[i], {
      title: '',
      messages: [],
      lastActiveAt: Date.now() - (120 + i * 30) * 1000,
    });
  }
}

async function clickRow(page, chatId) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`).first().click();
}

async function drawerChatIds(page) {
  return page.evaluate(() => Array.from(
    document.querySelectorAll('#sessions-list li[data-chat-id]'),
  ).map(li => li.getAttribute('data-chat-id')));
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Wait for the drawer to render the pre-populated rows.
  for (const id of [CHAT_A, ...STALE_IDS]) {
    await page.waitForSelector(`#sessions-list li[data-chat-id="${id}"]`, { timeout: 5_000 });
  }
  log(`drawer pre-populated with ${1 + STALE_IDS.length} chats`);

  // Sanity: all 4 visible.
  let ids = await drawerChatIds(page);
  for (const id of [CHAT_A, ...STALE_IDS]) {
    assert(ids.includes(id), `pre-condition: drawer should include ${id}`);
  }

  // 2-3. Activate chat A and send a message so hasContent is true.
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('previous-msg'),
    { timeout: 3_000 },
  );
  await send(page, 'hi');
  log('sent "hi" in chat A; waiting for mock reply');
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('[mock] echo: hi'),
    { timeout: 5_000 },
  );

  // 4. Rotate via new-chat. If a regression re-introduced auto-cleanup,
  //    the stale rows would disappear here within a few hundred ms.
  await clickNewChat(page);
  log('clicked new-chat — stale rows should remain (no auto-delete invariant)');

  // 5. Wait long enough for any (regressed) auto-cleanup to have fired,
  //    then verify the stale rows are STILL there. 1.5s is comfortably
  //    longer than the rotation's refresh + any background sweep cycle.
  await page.waitForTimeout(1500);

  // 6. Final state: chat A still there, all stale rows still there too.
  ids = await drawerChatIds(page);
  assert(
    ids.includes(CHAT_A),
    `chat A (with content) should remain after rotation, got ${JSON.stringify(ids)}`,
  );
  for (const id of STALE_IDS) {
    assert(
      ids.includes(id),
      `stale chat ${id} should STILL be in drawer (no auto-delete invariant); ` +
      `if this assertion regresses, the rotation re-introduced server-side ` +
      `delete that wiped real data on 2026-05-05. drawer = ${JSON.stringify(ids)}`,
    );
  }
  log(`no-auto-delete invariant holds — ${STALE_IDS.length} stale rows preserved ✓`);
}
