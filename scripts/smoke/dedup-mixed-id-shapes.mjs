// Scenario: history-fetch returns a mix of messages with and without
// `parley_id`. Both paths must dedupe on reload — the with-link
// rows via the SSE-shape parley_id, the without-link rows via the
// integer-id fallback.
//
// Why this matters: after the plugin's parley_msg_links table
// landed, only NEW turns get a link row. Pre-existing messages and
// messages from other channels (telegram, slack, ...) won't have a
// link and rely on the integer-id fallback in renderHistoryMessage.
// If the fallback breaks, every legacy chat duplicates on reload.
//
// Test plan (mocked):
//   1. Seed a chat with 4 messages: 2 with parley_id (modeling new
//      parley turns), 2 without (modeling legacy / cross-channel).
//   2. Click into the chat.
//   3. page.reload().
//   4. After replay, assert: exactly 4 .line elements, no duplicate
//      data-message-id values. The dedup-by-parley_id and dedup-
//      by-integer paths both held.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'dedup-mixed-id-shapes';
export const DESCRIPTION = 'History with mixed parley_id presence dedupes via both paths on reload';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-mixed-ids';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Mixed id shapes',
    messages: [
      // Two rows from the legacy era — no parley_id. Mock will fall
      // back to `mock-msg-history-${chatId}-${i}` integer-shaped ids.
      { role: 'user', content: 'legacy user msg', timestamp: Date.now() / 1000 - 30 },
      { role: 'assistant', content: 'legacy assistant reply', timestamp: Date.now() / 1000 - 29 },
      // Two rows from the post-fix era — parley_id present. PWA
      // dedups on the parley_id key, ignoring the integer.
      { role: 'user', content: 'modern user msg', parley_id: 'umsg_test_modern_user',
        timestamp: Date.now() / 1000 - 5 },
      { role: 'assistant', content: 'modern assistant reply', parley_id: 'msg_test_modern_assistant',
        timestamp: Date.now() / 1000 - 4 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

async function lineCount(page) {
  return await page.evaluate(
    () => document.querySelectorAll('#transcript .line').length,
  );
}

async function lineMessageIds(page) {
  return await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('#transcript .line[data-message-id]'));
    return lines.map(l => l.getAttribute('data-message-id'));
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Click into the seeded chat so its history loads.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 5_000 });
  await page.locator(`#sessions-list li[data-chat-id="${CHAT_ID}"] .sess-body`).first().click();
  await page.waitForFunction(
    () => /modern user msg/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('chat seeded + viewed (4 messages, 2 with parley_id + 2 without)');

  // Baseline: 4 messages should be in the DOM with 4 unique ids.
  const baselineCount = await lineCount(page);
  const baselineIds = await lineMessageIds(page);
  assert(baselineCount === 4, `baseline expected 4 .line, got ${baselineCount}`);
  assert(
    new Set(baselineIds).size === baselineIds.length,
    `baseline ids should all be unique, got ${JSON.stringify(baselineIds)}`,
  );
  // Modern rows should use the parley_id we set; legacy rows
  // should use the mock's integer-shaped fallback id.
  assert(
    baselineIds.includes('umsg_test_modern_user'),
    `expected umsg_test_modern_user in ids, got ${JSON.stringify(baselineIds)}`,
  );
  assert(
    baselineIds.includes('msg_test_modern_assistant'),
    `expected msg_test_modern_assistant in ids, got ${JSON.stringify(baselineIds)}`,
  );
  log(`baseline: ${baselineCount} .line elements with both id shapes ✓`);

  // Reload — IDB rehydrates the previous render, then server replay
  // fires. Both id paths must dedupe correctly.
  await page.reload();
  await waitForReady(page);
  await page.waitForFunction(
    () => /modern user msg/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 5_000, polling: 100 },
  );
  await page.waitForTimeout(250);

  const after = await lineCount(page);
  const afterIds = await lineMessageIds(page);
  assert(
    after === 4,
    `after reload expected 4 .line, got ${after} — mixed-id dedup is broken`,
  );
  assert(
    new Set(afterIds).size === afterIds.length,
    `after reload ids should all be unique, got ${JSON.stringify(afterIds)}`,
  );
  log(`after reload: ${after} .line elements, ids unique ✓`);
}
