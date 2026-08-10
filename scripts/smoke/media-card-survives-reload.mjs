// MONEY TEST (media lane round 2, deliverable 1): agent-pushed media
// cards must survive a reload / session-switch-away-and-back.
//
// The live lane (backendEventHandlers.handleReplyFinal) parses + attaches
// cards only for the in-flight reply; those cards live in an IN-MEMORY
// store (cards/attach.ts cardsByReplyId), empty on a fresh page load. So
// a reload re-renders the transcript from stored message BODIES — the
// markdown media link is still in the text, but historically NO card was
// re-derived (the known 2026-08-04 gap).
//
// Fix under test: reconciler.createAssistant runs the same fallback parse
// (ensureHistoricalCards) over each finalized assistant body, so the
// video/audio/image/youtube/spotify card reappears. Deduped by replyId so
// a live-attached bubble doesn't double-render.
//
// This smoke seeds a chat whose HISTORY already contains a video media
// link (no live send — the in-memory card store is empty, exactly the
// post-reload state), opens it, and asserts the video card renders. Then
// it switches to another chat and back to prove session-switch survival.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'media-card-survives-reload';
export const DESCRIPTION = 'A media markdown link in a HISTORICAL assistant body re-renders as a card on load + session switch';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-media-reload';
const OTHER_ID = 'mock-media-other';
const MEDIA_PATH = '/api/sidekick/media/00c0ffee00c0ffee.mp4';
const TARGET_REPLY_ID = 'media-msg-10';

export function MOCK_SETUP(mock) {
  const messages = [];
  const body = 'reload persistence smoke body with real height '.repeat(6);
  for (let i = 0; i < 10; i++) {
    const idx = i + 1;
    const isUser = i % 2 === 0;   // idx 10 (i=9) → assistant
    const isTarget = idx === 10;
    messages.push({
      role: isUser ? 'user' : 'assistant',
      content: isTarget
        ? `rough cut ready ![The X edit](${MEDIA_PATH})`
        : `${body} (${idx})`,
      message_id: `media-msg-${idx}`,
      sidekick_id: `media-msg-${idx}`,
      timestamp: Date.now() / 1000 - (10 - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Media reload',
    source: 'sidekick',
    messages,
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(OTHER_ID, {
    title: 'Other chat',
    source: 'sidekick',
    messages: [
      { role: 'user', content: 'hello there other chat', message_id: 'other-1', sidekick_id: 'other-1', timestamp: Date.now() / 1000 - 120 },
      { role: 'assistant', content: 'plain reply no media at all here', message_id: 'other-2', sidekick_id: 'other-2', timestamp: Date.now() / 1000 - 110 },
    ],
    lastActiveAt: Date.now() - 120_000,
  });
}

async function videoCardCount(page, replyId) {
  return page.evaluate((key) => {
    const el = document.querySelector(`#transcript .line.agent[data-reply-id="${CSS.escape(key)}"]`);
    return el ? el.querySelectorAll('.card-video video').length : -1;
  }, replyId);
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Stub the media bytes — the <video> element probes the src.
  await page.route(/\/api\/sidekick\/media\/[a-f0-9]+\.mp4$/, (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.alloc(64) }));

  // Open the media chat — history renders through the SAME createAssistant
  // path a reload uses, with an empty in-memory card store.
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForSelector(`#transcript .line.agent[data-reply-id="${TARGET_REPLY_ID}"]`, { timeout: 8_000 });
  await page.waitForSelector('.card-video video', { timeout: 8_000 });

  let count = await videoCardCount(page, TARGET_REPLY_ID);
  assert(count === 1,
    `BUG (reload persistence): historical media body must re-derive exactly 1 video card, got ${count}`);
  log('on-load: media card re-derived from history ✓');

  // Session-switch away and back — the card must be re-derived again on
  // the fresh remount (the store carries it now; either way exactly one).
  await openSidebar(page);
  await clickRow(page, OTHER_ID);
  await page.waitForTimeout(500);
  const leaked = await page.evaluate(() => document.querySelectorAll('.card-video video').length);
  assert(leaked === 0, `after switching to a media-free chat, no video card should show; got ${leaked}`);

  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForSelector(`#transcript .line.agent[data-reply-id="${TARGET_REPLY_ID}"]`, { timeout: 8_000 });
  await page.waitForSelector('.card-video video', { timeout: 8_000 });
  count = await videoCardCount(page, TARGET_REPLY_ID);
  assert(count === 1,
    `after session switch away+back, expected exactly 1 video card, got ${count}`);
  log('session-switch away+back: media card still present, exactly one ✓');

  log('PASS: agent-pushed media card survives reload / session switch');
}
