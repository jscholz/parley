// Under virtualization the agent bubble's DOM is destroyed when it
// leaves the visible window. Cards attached via cards/attach.ts (image
// blocks, canvas.show payloads, fallback URL parses) lived in a
// per-bubble WeakMap — when the bubble dies, the WeakMap entry is
// gc'd and the .line-cards container is gone. On remount, the bubble
// has no cards.
//
// Fix: keyed by replyId (stable across re-renders) + rehydrateCards
// replay on createAssistant.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'cards-survive-remount';
export const DESCRIPTION = 'Cards attached to an agent bubble persist across virt unmount/remount';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-cards-remount';
const TARGET_REPLY_ID = 'cards-msg-4';  // even idx → assistant

export function MOCK_SETUP(mock) {
  const messages = [];
  const body = 'card remount smoke text body with real height '.repeat(8);
  for (let i = 0; i < 60; i++) {
    const idx = i + 1;
    const isUser = i % 2 === 0;
    messages.push({
      role: isUser ? 'user' : 'assistant',
      content: `${body} (${idx})`,
      message_id: `cards-msg-${idx}`,
      parley_id: `cards-msg-${idx}`,
      timestamp: Date.now() / 1000 - (60 - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Cards remount',
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

  // Simulate a wheel gesture before the programmatic scrollTo.
  // scheduleAtBottomRepin only treats wheel/touch/pointerdown as
  // user-scroll-intent — without this precursor its RO keeps snapping
  // us back to the bottom for the 1.5s repin window. Production users
  // wheel-scroll naturally; smokes need to simulate it.
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

  const targetVisible = await page.evaluate((key) => {
    return !!document.querySelector(`#transcript .line.agent[data-reply-id="${CSS.escape(key)}"]`);
  }, TARGET_REPLY_ID);
  assert(targetVisible, `setup: target ${TARGET_REPLY_ID} should be in DOM after scrollTo(0)`);

  // Attach a simple text card via the public attachCard API. The
  // markdown kind is stable + cheap to render.
  await page.evaluate(async (key) => {
    const mod = await import('/build/cards/attach.mjs');
    const bubble = document.querySelector(`#transcript .line.agent[data-reply-id="${CSS.escape(key)}"]`);
    mod.attachCard(bubble, { v: 1, kind: 'markdown', payload: { text: '## card under test' } });
  }, TARGET_REPLY_ID);
  await page.waitForTimeout(200);

  const preScroll = await page.evaluate((key) => {
    const el = document.querySelector(`#transcript .line.agent[data-reply-id="${CSS.escape(key)}"]`);
    return {
      exists: !!el,
      cardCount: el?.querySelectorAll('.line-cards .card-slot').length || 0,
    };
  }, TARGET_REPLY_ID);
  assert(preScroll.cardCount === 1, `pre-scroll: expected 1 card slot, got ${preScroll.cardCount}`);
  log(`pre-scroll: 1 card attached ✓`);

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

  const postScroll = await page.evaluate((key) => {
    const el = document.querySelector(`#transcript .line.agent[data-reply-id="${CSS.escape(key)}"]`);
    return {
      exists: !!el,
      cardCount: el?.querySelectorAll('.line-cards .card-slot').length || 0,
    };
  }, TARGET_REPLY_ID);
  assert(postScroll.exists, `post-scroll: target bubble should be remounted`);
  assert(postScroll.cardCount === 1,
    `BUG (virt remount): card must rehydrate on remount, got ${postScroll.cardCount} slots`);
  log(`post-scroll: card survived remount ✓`);
}
