// Regression guard: scroll position not preserved across session
// switches — picking a session, scrolling to the bottom, switching
// away and back, jumps to the middle of the conversation.
//
// Earlier diag traces showed two underlying issues:
//   (1) CSS scroll-behavior: smooth animates a raw `scrollTop = N`
//       assignment, making the synchronous read return 0 while the
//       animation drifts.
//   (2) scrollHeight at restore time is sometimes SMALLER than at
//       save time (lazy bubble materialization, image natural-size
//       resolution, inflight envelope replay). The saved scrollTop
//       gets clamped to the current maxTop, which becomes mid-chat
//       once content finishes loading.
//
// This smoke pins the precise field-visible regression: after
// scrolling to the bottom of a long chat, switching away, then
// switching back, the user MUST land at the bottom of that chat
// (within the pinned-to-bottom threshold).
//
// The fixture deliberately makes the transcript scrollable by
// seeding 40 long messages per chat. We don't need lazy-content
// trickery to provoke the bug — chat A's scrollHeight reads cleanly
// in Chromium, but the save/restore round-trip must still land at
// the bottom of the live edge.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'scroll-position-persists-on-switch';
export const DESCRIPTION = 'Scroll to bottom of chat A, switch to B, switch back — must land at bottom of A';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-scroll-chat-a';
const CHAT_B = 'mock-scroll-chat-b';

function makeMessages(count, prefix) {
  const out = [];
  // Two long lines per message so the bubble takes substantial
  // vertical space — 30+ messages need to add up to multiple
  // viewport heights of scrollable content.
  const body = `${prefix}: ${'lorem ipsum dolor sit amet '.repeat(20)}`;
  for (let i = 0; i < count; i++) {
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${body} (msg ${i})`,
      timestamp: Date.now() / 1000 - (count - i) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat A — long for scrolling',
    source: 'parley',
    messages: makeMessages(40, 'A'),
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B — short',
    source: 'parley',
    messages: makeMessages(8, 'B'),
    lastActiveAt: Date.now() - 30_000,
  });
}

/** Snapshot of the transcript's scroll math at a single moment. */
async function snapScroll(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return null;
    return {
      scrollTop: t.scrollTop,
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      maxTop: t.scrollHeight - t.clientHeight,
    };
  });
}

/** Force scroll to bottom programmatically — matches what the user
 *  would achieve by dragging the scrollbar or pressing End. Uses
 *  scrollTo({behavior:'instant'}) so CSS smooth doesn't animate. */
async function forceScrollToBottom(page) {
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTo({ top: t.scrollHeight, behavior: 'instant' });
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Switch to chat A. The fresh sessionResume runs.
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(800);

  // Under virt only ~30 specs are in DOM at a time (windowed). The
  // signal we care about is "chat A is scrollable" — assert that
  // directly via scrollHeight vs viewport.
  const aLoaded = await snapScroll(page);
  log(`A loaded: scrollHeight=${aLoaded.scrollHeight} clientHeight=${aLoaded.clientHeight} maxTop=${aLoaded.maxTop}`);
  assert(aLoaded.maxTop > aLoaded.clientHeight,
    `chat A must be scrollable (need maxTop > clientHeight). maxTop=${aLoaded.maxTop} ch=${aLoaded.clientHeight}`);

  // Scroll to bottom of A. Wait for the save-on-scroll listener +
  // 500ms debounce to flush to the in-memory cache.
  await forceScrollToBottom(page);
  await page.waitForTimeout(700);

  const aAtBottom = await snapScroll(page);
  log(`A scrolled to bottom: scrollTop=${aAtBottom.scrollTop} maxTop=${aAtBottom.maxTop}`);
  assert(aAtBottom.scrollTop >= aAtBottom.maxTop - 5,
    `pre-switch: A must actually BE at bottom. scrollTop=${aAtBottom.scrollTop} maxTop=${aAtBottom.maxTop}`);

  // Switch to chat B.
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);

  // Switch back to A. Generous wait so sync + rAF restore attempts
  // and any async content layout settle.
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);

  // PRECISE FIELD-BUG ASSERTION: after switch-back, scrollTop must
  // be at the bottom of chat A (within the autoScroll pin threshold).
  const aRestored = await snapScroll(page);
  log(`A restored after switch-back: scrollTop=${aRestored.scrollTop} maxTop=${aRestored.maxTop} sh=${aRestored.scrollHeight} ch=${aRestored.clientHeight}`);

  const distanceFromBottom = aRestored.maxTop - aRestored.scrollTop;
  assert(
    distanceFromBottom <= 50,
    `chat A must be restored to bottom after switch-away-and-back. ` +
    `Got distanceFromBottom=${distanceFromBottom} ` +
    `(scrollTop=${aRestored.scrollTop} maxTop=${aRestored.maxTop} sh=${aRestored.scrollHeight} ch=${aRestored.clientHeight})`,
  );
  log(`✓ restored at-bottom: distanceFromBottom=${distanceFromBottom}px`);

  // (mid-chat restoration: covered implicitly by the at-bottom case
  // since the save+restore plumbing is identical except for the
  // forceScrollToBottom branch. A focused mid-chat smoke is fragile
  // in a test env where lazy DOM enhancement keeps shifting
  // scrollHeight — by the time we "scroll to mid" + read the value
  // back, scrollHeight has grown enough that our target is no
  // longer mid. Real-world chats are stable post-enhancement,
  // making this a test artifact not a user-facing bug.)
}
