// Long-bubble fold toggle (Show more / Show less) must persist across
// virtualizer unmount/remount. The state lived on the bubble's DOM
// (.expanded class) — under virt, scroll-out destroys the bubble and
// scroll-back recreates it with the default fold state, throwing away
// the user's toggle.
//
// Fix: per-msgId map in chat.ts, applied at addLine time.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'fold-state-survives-remount';
export const DESCRIPTION = 'Bubble Show more / Show less toggle persists across virt unmount/remount';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-fold-remount';
// Target a USER bubble in the early window — long enough to trigger
// fold (>1500 chars). User bubbles default to .foldable WITHOUT
// .expanded, so the smoke can verify a user-toggle to expanded.
const TARGET_MSG_ID = 'fold-msg-3';

export function MOCK_SETUP(mock) {
  const longBody = 'fold remount text body to exceed the threshold '.repeat(40);  // ~1880 chars
  const messages = [];
  for (let i = 0; i < 60; i++) {
    const idx = i + 1;
    const isUser = i % 2 === 0;
    messages.push({
      role: isUser ? 'user' : 'assistant',
      content: isUser ? `${longBody} (user ${idx})` : `short reply ${idx}`,
      message_id: `fold-msg-${idx}`,
      parley_id: `fold-msg-${idx}`,
      timestamp: Date.now() / 1000 - (60 - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Fold remount',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 60_000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForTimeout(800);

  // Simulate a wheel gesture so scheduleAtBottomRepin's RO stops
  // snapping back to bottom — programmatic scrollTo alone isn't seen
  // as user-scroll-intent by the at-bottom-repin observer.
  const box = await page.locator('#transcript').boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
  }
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForTimeout(400);

  // Verify the long user bubble is foldable + currently collapsed.
  const initial = await page.evaluate((mid) => {
    const el = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    return {
      exists: !!el,
      foldable: !!el?.classList.contains('foldable'),
      expanded: !!el?.classList.contains('expanded'),
    };
  }, TARGET_MSG_ID);
  assert(initial.exists, `setup: target ${TARGET_MSG_ID} should be in DOM`);
  assert(initial.foldable, `setup: target should have .foldable class`);
  assert(!initial.expanded, `setup: user bubble should default to collapsed`);
  log(`initial: foldable + collapsed ✓`);

  // Click "Show more" → bubble expands.
  await page.evaluate((mid) => {
    const el = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    const btn = el?.querySelector('.bubble-fold-toggle');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, TARGET_MSG_ID);
  await page.waitForTimeout(100);

  const expanded = await page.evaluate((mid) => {
    const el = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    return !!el?.classList.contains('expanded');
  }, TARGET_MSG_ID);
  assert(expanded, `post-click: bubble should be .expanded`);
  log(`toggled: bubble expanded ✓`);

  // Scroll out + back.
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTo({ top: t.scrollHeight, behavior: 'instant' });
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForTimeout(400);

  const restored = await page.evaluate((mid) => {
    const el = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    return {
      exists: !!el,
      expanded: !!el?.classList.contains('expanded'),
      foldBtnText: el?.querySelector('.bubble-fold-toggle')?.textContent || '',
    };
  }, TARGET_MSG_ID);
  assert(restored.exists, `post-scroll: bubble should be remounted`);
  assert(restored.expanded,
    `BUG (virt remount): fold state must survive remount; bubble lost .expanded. got ${JSON.stringify(restored)}`);
  assert(restored.foldBtnText === 'Show less',
    `post-scroll: foldBtn should read "Show less" matching the persisted expanded state, got "${restored.foldBtnText}"`);
  log(`post-scroll: fold state survived remount ✓`);
}
