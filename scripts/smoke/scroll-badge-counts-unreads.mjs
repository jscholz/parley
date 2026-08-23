// Contract (#214 TFC-badge): the jump-to-latest badge counts UNREADS —
// live messages (replies / notifications / cross-device sends) that
// arrived while the user was scrolled up — NOT "rows appended while not
// pinned". Field report 2026-06-12: the badge "happens without a fresh
// reply, and is inconsistent" because the old counter lived in
// autoScroll's else-branch and bumped on every render pass (streaming
// deltas, tool rows, dictation interims, batch flushes).
//
// Plan (mocked, autoReply off so we drive every envelope):
//   1. Seed a tall chat, open it → at bottom, badge hidden.
//   2. Scroll up off the bottom → chevron visible, badge 0 (no unread).
//   3. Push tool_call/tool_result envelopes → rows append BELOW the
//      viewport but they are not messages → badge stays 0. (Old code
//      counted these.)
//   4. Stream a reply: 5 deltas + 1 final on ONE message_id → badge
//      reads exactly '1'. (Old code counted each render pass.)
//   5. Second reply → badge '2'.
//   6. Click jump-to-latest → pinned, badge cleared.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'scroll-badge-counts-unreads';
export const DESCRIPTION = 'jump-to-latest badge counts unread live messages (deduped per message), not appended rows';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-badge-unreads';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 1000;
  const messages = [];
  for (let i = 0; i < 14; i++) {
    messages.push({ role: 'user', content: `Question number ${i} — ${'lorem ipsum '.repeat(6)}`, parley_id: `umsg_bu_${i}`, timestamp: t0 + i * 2 });
    messages.push({ role: 'assistant', content: `Answer number ${i} — ${'dolor sit amet '.repeat(6)}`, parley_id: `msg_bu_${i}`, timestamp: t0 + i * 2 + 1 });
  }
  mock.addChat(CHAT_ID, { title: 'Badge unreads chat', source: 'parley', messages, lastActiveAt: Date.now() });
  mock.setAutoReplyEnabled(false);
}

const badgeState = (page) => page.evaluate(() => {
  const btn = document.getElementById('scroll-to-bottom');
  const badge = btn?.querySelector('.scroll-to-bottom-badge');
  return {
    visible: btn?.classList.contains('visible') ?? false,
    hasUnread: btn?.classList.contains('has-unread') ?? false,
    // textContent is only rewritten while count>0, so the zero state is
    // hasUnread=false (text may be stale by design).
    text: badge?.textContent ?? '',
  };
});

const metrics = (page) => page.evaluate(() => {
  const el = document.getElementById('transcript');
  return { st: Math.round(el.scrollTop), sh: el.scrollHeight,
    distFromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
});

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(() => {
    const el = document.getElementById('transcript');
    return el && el.scrollHeight > el.clientHeight + 50;
  }, null, { timeout: 5_000, polling: 100 });
  await page.waitForTimeout(400);

  // 1. At bottom: chevron hidden, no unread.
  let b = await badgeState(page);
  log(`at bottom: visible=${b.visible} hasUnread=${b.hasUnread}`);
  assert(!b.visible, 'jump-to-latest must be hidden while pinned to bottom');
  assert(!b.hasUnread, 'no unread badge while pinned to bottom');

  // 2. Scroll up off the bottom (> PINNED_THRESHOLD_PX = 300).
  await page.evaluate(() => {
    const el = document.getElementById('transcript');
    el.scrollTo({ top: Math.round(el.scrollHeight * 0.3), behavior: 'instant' });
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(250);
  const up = await metrics(page);
  assert(up.distFromBottom > 300, `precondition: scrolled up off bottom, dist=${up.distFromBottom}`);
  b = await badgeState(page);
  log(`scrolled up: visible=${b.visible} hasUnread=${b.hasUnread}`);
  assert(b.visible, 'chevron must be visible while scrolled up');
  assert(!b.hasUnread, `scrolling up alone must not create unreads — badge says '${b.text}'`);

  // 3. Tool activity (not a message) → badge must stay 0. The old
  //    counter bumped for every appended row, including these.
  for (let i = 0; i < 3; i++) {
    mock.pushEnvelope({ type: 'tool_call', chat_id: CHAT_ID, call_id: `call_bu_${i}`, tool_name: 'mock_tool', args: { idx: i } });
    mock.pushEnvelope({ type: 'tool_result', chat_id: CHAT_ID, call_id: `call_bu_${i}`, result: `r${i}` });
  }
  await page.waitForTimeout(600);
  const afterTools = await metrics(page);
  assert(afterTools.sh > up.sh, `precondition: tool rows should have landed (scrollHeight grew ${up.sh}→${afterTools.sh})`);
  b = await badgeState(page);
  log(`after tool rows: hasUnread=${b.hasUnread} text='${b.text}'`);
  assert(!b.hasUnread, `tool rows are not messages — badge must stay 0, got '${b.text}'`);

  // 4. Streaming reply: 5 deltas + final, ONE message_id → exactly 1 unread.
  const streamId = 'msg_bu_stream';
  let acc = '';
  for (let k = 0; k < 5; k++) {
    acc += `STREAM chunk ${k} — ${'unread me '.repeat(10)}\n`;
    mock.pushEnvelope({ type: 'reply_delta', chat_id: CHAT_ID, message_id: streamId, text: acc });
    await page.waitForTimeout(120);
  }
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT_ID, message_id: streamId });
  await page.waitForTimeout(400);
  b = await badgeState(page);
  log(`after streamed reply: hasUnread=${b.hasUnread} text='${b.text}'`);
  assert(b.hasUnread, 'a live reply while scrolled up must set the unread badge');
  assert(b.text === '1', `one streamed reply = one unread (deltas+final dedup by message_id) — badge says '${b.text}'`);

  // 5. Second reply → 2.
  mock.pushEnvelope({ type: 'reply_delta', chat_id: CHAT_ID, message_id: 'msg_bu_live2', text: 'SECOND reply while scrolled up' });
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT_ID, message_id: 'msg_bu_live2' });
  await page.waitForTimeout(400);
  b = await badgeState(page);
  log(`after second reply: text='${b.text}'`);
  assert(b.text === '2', `second live reply must increment to 2 — badge says '${b.text}'`);

  // 6. Jump to latest → pinned, badge cleared.
  await page.click('#scroll-to-bottom');
  await page.waitForTimeout(400);
  const m = await metrics(page);
  b = await badgeState(page);
  log(`after jump: distFromBottom=${m.distFromBottom} visible=${b.visible} hasUnread=${b.hasUnread}`);
  assert(m.distFromBottom <= 60, `jump-to-latest must land at the bottom, dist=${m.distFromBottom}`);
  assert(!b.hasUnread, 'badge must clear on jump-to-latest');
  log('badge counts unreads, dedups per message, ignores non-message rows ✓');
}
