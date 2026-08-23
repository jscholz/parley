// Streaming reply + scroll-up must NOT yank the user back to the bottom
// (Jonathan field bug 2026-08-09, long misfiled as "network
// glitchiness": an agent turn streams in, he wheels up to read the
// message from its start, and moments later the view jumps to the end —
// repeatedly).
//
// Mechanism under test: pinnedToBottom is re-derived from GEOMETRY on
// every scroll event with a generous 300px threshold. Early in a
// stream the reply is still short, so "scrolled to the start of the
// message" is within 300px of the bottom — geometry re-latched
// pinned=true and the next delta's autoScroll yanked. Fix: a
// deliberate upward gesture (wheel/touch) unpins immediately and holds
// the geometric re-latch; returning to the bottom re-pins as before.
//
//   A. Wheel up EARLY in a stream (inside the 300px threshold) → keep
//      streaming → scroll position must hold through every delta AND
//      through reply_final.
//   B. Wheel back to the bottom mid-stream → following resumes (the
//      unpin must not be sticky).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'stream-scrollup-no-yank';
export const DESCRIPTION = 'Wheeling up during a streaming reply unpins immediately (even inside the 300px threshold) — deltas stop yanking to the bottom; wheeling back re-pins';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-stream-yank';

export function MOCK_SETUP(mock) {
  const messages = [];
  // Enough history that the transcript scrolls.
  for (let i = 0; i < 30; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `filler message with some real height to it (${i}) `.repeat(3),
      message_id: `yank-msg-${i}`,
      parley_id: `yank-msg-${i}`,
      timestamp: Date.now() / 1000 - (30 - i) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Stream yank',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 60_000,
  });
}

const scrollState = (page) => page.evaluate(() => {
  const t = document.getElementById('transcript');
  return {
    top: t.scrollTop,
    fromBottom: t.scrollHeight - t.scrollTop - t.clientHeight,
  };
});

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  const { openSidebar, clickRow } = await import('./lib.mjs');
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForSelector(`#transcript .line[data-key="yank-msg-29"]`, { timeout: 5_000 });
  await page.waitForTimeout(600); // land pinned at the bottom

  // ── A: wheel up early in the stream; position must hold ─────────────
  const LONG = 'streamed sentence with plenty of words to grow the bubble well past the pinned threshold. '.repeat(30);
  const streaming = mock.streamReply(CHAT_ID, LONG, { chunks: 12, intervalMs: 200 });
  // Wait for the FIRST chunk to render (message exists, still short).
  await page.waitForFunction(
    () => document.querySelector('#transcript .line.agent:last-of-type')?.textContent?.includes('streamed sentence'),
    null, { timeout: 5_000, polling: 50 },
  );
  // Real wheel gesture UP — a modest distance that stays INSIDE the
  // 300px pinned threshold (the bug's trigger zone).
  const box = await page.locator('#transcript').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -80);
  await page.waitForTimeout(120);
  await page.mouse.wheel(0, -60);
  await page.waitForTimeout(150);
  const parked = await scrollState(page);
  assert(parked.fromBottom > 20,
    `setup: wheel-up should have moved us off the live edge; fromBottom=${parked.fromBottom}`);
  log(`parked at fromBottom=${Math.round(parked.fromBottom)}px (inside the 300px threshold) — streaming continues`);

  // Sample while the remaining deltas land. scrollTop may only change by
  // layout ABOVE the viewport (none here) — any snap where fromBottom
  // collapses toward 0 is the yank.
  let minTopDelta = 0;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(220);
    const s = await scrollState(page);
    // The message grows BELOW us, so fromBottom must strictly GROW —
    // never collapse back under the parked distance.
    assert(s.fromBottom >= parked.fromBottom - 5,
      `delta yanked the view toward the bottom at sample ${i}: fromBottom ${Math.round(parked.fromBottom)} → ${Math.round(s.fromBottom)}`);
    minTopDelta = Math.min(minTopDelta, Math.abs(s.top - parked.top));
  }
  await streaming;               // reply_final has fired by now
  await page.waitForTimeout(300);
  const afterFinal = await scrollState(page);
  assert(afterFinal.fromBottom >= parked.fromBottom - 5,
    `reply_final yanked the view: fromBottom ${Math.round(parked.fromBottom)} → ${Math.round(afterFinal.fromBottom)}`);
  log('A ✓ reading position held through every delta and reply_final');

  // ── B: wheel back down to the bottom → following resumes ────────────
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(600); // outlive the re-latch hold
  const backDown = await scrollState(page);
  assert(backDown.fromBottom <= 60,
    `should be back at the live edge; fromBottom=${Math.round(backDown.fromBottom)}`);
  const pinnedNow = await page.evaluate(async () =>
    (await import('/build/chat.mjs')).isPinnedToBottom());
  log(`back at bottom: fromBottom=${Math.round(backDown.fromBottom)} pinned=${pinnedNow}`);
  const streaming2 = mock.streamReply(CHAT_ID, 'follow me to the bottom please. '.repeat(20), { chunks: 6, intervalMs: 120 });
  await page.waitForTimeout(1_200);
  const following = await scrollState(page);
  assert(following.fromBottom <= 40,
    `after returning to the bottom, streaming must follow again; fromBottom=${Math.round(following.fromBottom)}`);
  await streaming2;
  log('B ✓ returning to the bottom re-pins — streaming follows again');

  log('PASS: upward gesture beats the geometry threshold; no more mid-stream yanks');
}
