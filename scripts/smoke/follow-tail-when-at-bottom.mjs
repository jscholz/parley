// Contract: the transcript follows the live edge
// ONLY while the scrollbar is at the very bottom — so a reply streaming in
// stays in view hands-free (bike / cursor in another window). The moment
// the user scrolls UP off the bottom, new replies (and tool calls) must NOT
// auto-scroll — their reading position is preserved.
//
// Written test-first. No ResizeObserver needed: "at bottom" = read
// scrollHeight−scrollTop−clientHeight≈0 on scroll; "follow" = autoScroll on
// content append IFF pinned. (The separate at-bottom-repin RO is unrelated
// and being removed.)
//
// Plan (mocked, autoReply off so we drive the replies):
//   1. Seed a tall chat, open it → loads at bottom.
//   2. Push a reply → assert it FOLLOWED (still at bottom, latest in view).
//   3. Scroll UP to mid → assert NOT at bottom.
//   4. Push another reply → assert scrollTop did NOT move (no auto-scroll).

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'follow-tail-when-at-bottom';
export const DESCRIPTION = 'auto-scroll follows new replies only while pinned to the bottom; scrolled-up position is preserved';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-follow-tail';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 1000;
  const messages = [];
  // ~14 turns of moderately long content so the transcript is scrollable
  // in the 1280×800 test viewport.
  for (let i = 0; i < 14; i++) {
    messages.push({ role: 'user', content: `Question number ${i} — ${'lorem ipsum '.repeat(6)}`, parley_id: `umsg_ft_${i}`, timestamp: t0 + i * 2 });
    messages.push({ role: 'assistant', content: `Answer number ${i} — ${'dolor sit amet '.repeat(6)}`, parley_id: `msg_ft_${i}`, timestamp: t0 + i * 2 + 1 });
  }
  mock.addChat(CHAT_ID, { title: 'Follow-tail chat', source: 'parley', messages, lastActiveAt: Date.now() });
  mock.setAutoReplyEnabled(false);
}

const metrics = (page) => page.evaluate(() => {
  const el = document.getElementById('transcript');
  return { st: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight,
    distFromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
});

async function pushReply(page, mock, id, text, { waitForText = true } = {}) {
  mock.pushEnvelope({ type: 'reply_delta', chat_id: CHAT_ID, message_id: id, text });
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT_ID, message_id: id });
  if (waitForText) {
    // Only valid when at-bottom: a reply that lands below a scrolled-up
    // viewport is virtualized OUT of the DOM, so its text won't be present.
    await page.waitForFunction(
      (t) => (document.getElementById('transcript')?.textContent || '').includes(t),
      text, { timeout: 5_000, polling: 80 });
  }
  await page.waitForTimeout(300); // let store update + autoScroll + layout settle
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(() => {
    const el = document.getElementById('transcript');
    return el && el.scrollHeight > el.clientHeight + 50;  // scrollable
  }, null, { timeout: 5_000, polling: 100 });
  await page.waitForTimeout(400);

  let m = await metrics(page);
  log(`on open: distFromBottom=${m.distFromBottom} (sh=${m.sh} ch=${m.ch})`);
  assert(m.distFromBottom <= 60, `should open at the bottom, dist=${m.distFromBottom}`);

  // 2. STREAM a reply (multiple deltas) while at bottom → the view must
  //    follow each delta so the latest stays in view (the hands-free
  //    "watch the reply come in" case).
  const streamId = 'msg_ft_stream';
  let acc = '';
  for (let k = 0; k < 5; k++) {
    acc += `STREAMING chunk ${k} — ${'follow me '.repeat(12)}\n`;
    mock.pushEnvelope({ type: 'reply_delta', chat_id: CHAT_ID, message_id: streamId, text: acc });
    await page.waitForTimeout(160);
    const md = await metrics(page);
    log(`  stream delta ${k}: distFromBottom=${md.distFromBottom} (sh=${md.sh})`);
    assert(md.distFromBottom <= 60,
      `while at bottom, the view must follow each streaming delta — dist=${md.distFromBottom} at chunk ${k}`);
  }
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT_ID, message_id: streamId });
  await page.waitForTimeout(250);
  m = await metrics(page);
  log(`after stream final (at bottom): distFromBottom=${m.distFromBottom}`);
  assert(m.distFromBottom <= 60, `at-bottom stream must end pinned to the new bottom, dist=${m.distFromBottom}`);

  // 3. Scroll UP off the bottom.
  await page.evaluate(() => {
    const el = document.getElementById('transcript');
    el.scrollTo({ top: Math.round(el.scrollHeight * 0.3), behavior: 'instant' });
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(200);
  const scrolledUp = await metrics(page);
  log(`after scroll-up: st=${scrolledUp.st} distFromBottom=${scrolledUp.distFromBottom}`);
  assert(scrolledUp.distFromBottom > 200, `precondition: should be scrolled up off bottom, dist=${scrolledUp.distFromBottom}`);

  // 4. Reply while scrolled up → must NOT auto-scroll; position preserved.
  // The reply lands below the (scrolled-up) viewport, so it's virtualized
  // out of the DOM — verify it actually LANDED via scrollHeight growth, and
  // that the user's scrollTop did NOT move.
  await pushReply(page, mock, 'msg_ft_live2', 'FOLLOW_TAIL_REPLY_TWO should not yank', { waitForText: false });
  const after = await metrics(page);
  log(`after reply (scrolled up): st=${after.st} (was ${scrolledUp.st}) sh=${after.sh} (was ${scrolledUp.sh}) distFromBottom=${after.distFromBottom}`);
  assert(after.sh > scrolledUp.sh, `precondition: the reply should have landed (scrollHeight grew) — ${scrolledUp.sh}→${after.sh}`);
  assert(Math.abs(after.st - scrolledUp.st) <= 40,
    `scrolled-up reading position must be preserved when a reply arrives — scrollTop moved ${scrolledUp.st}→${after.st}`);
  log('follows at bottom; preserves position when scrolled up ✓');
}
