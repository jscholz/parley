// Sending re-pins the transcript (field 2026-11-21: "when I send a message
// and the agent replies, the chat doesn't auto-scroll"). Every chat UI
// brings the new message and the reply into view on send, whatever the
// scroll position was; Parley only followed replies while already
// pinned, so a send after reading back up left the user's bubble below
// the fold and the reply streamed unseen.
//   1. Open a long chat (lands at the bottom). Scroll up well past the
//      pin threshold.
//   2. Send a message → the transcript must be at the bottom at once
//      (own bubble visible) and must FOLLOW the reply that streams in.
//   3. Scrolling up afterwards still unpins (reading is protected).
import { waitForReady, assert, pollUntil, send } from './lib.mjs';
export const NAME = 'send-repins-transcript';
export const DESCRIPTION = 'a send scrolls the transcript to the bottom and re-pins it so the reply is followed, even after reading back up';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
const CHAT_ID = 'parley:send-repin';
export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 3600;
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'user', content: `Question ${i} — ${'lorem ipsum '.repeat(8)}`, parley_id: `umsg_sr_${i}`, timestamp: t0 + i * 2 });
    messages.push({ role: 'assistant', content: `Answer ${i} — ${'dolor sit amet '.repeat(10)}`, parley_id: `msg_sr_${i}`, timestamp: t0 + i * 2 + 1 });
  }
  mock.addChat(CHAT_ID, { title: 'Send re-pin chat', source: 'parley', messages, lastActiveAt: Date.now() });
  mock.setReplier(() => 'Here is a long reply. ' + 'More words to make the bubble tall enough to matter. '.repeat(12));
}
const metrics = (page) => page.evaluate(() => {
  const el = document.getElementById('transcript');
  return { st: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight, dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
});
export default async function run({ page, log }) {
  await waitForReady(page, undefined);
  await page.goto(`${page.url().split('?')[0]}?chat=${encodeURIComponent(CHAT_ID)}`, { waitUntil: 'domcontentloaded' });
  await pollUntil(page, () => document.querySelectorAll('#transcript .line').length > 20, undefined, { label: 'transcript rendered' });
  await page.waitForTimeout(400);
  const opened = await metrics(page);
  assert(opened.sh > opened.ch + 400, `precondition: chat must scroll (sh ${opened.sh} ch ${opened.ch})`);
  // Read back up: well past the 300 px pin threshold.
  await page.evaluate(() => { const el = document.getElementById('transcript'); el.scrollTo({ top: Math.round(el.scrollHeight * 0.4), behavior: 'instant' }); });
  await page.waitForTimeout(300);
  const up = await metrics(page);
  assert(up.dist > 400, `precondition: scrolled up off the bottom (dist ${up.dist})`);
  log(`scrolled up: dist=${up.dist}`);
  // Send.
  await send(page, 'What about the next step?');
  await pollUntil(page, () => {
    const el = document.getElementById('transcript');
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= 60;
  }, undefined, { label: 'the send brought the transcript to the bottom' });
  log('send → at bottom ✓');
  // The reply streams: the view must follow it to the new bottom.
  await pollUntil(page, () => Array.from(document.querySelectorAll('#transcript .line')).some((l) => /Here is a long reply/.test(l.textContent || '')), undefined, { label: 'reply landed' });
  await page.waitForTimeout(500);
  const after = await metrics(page);
  assert(after.sh > up.sh, 'the reply grew the transcript');
  assert(after.dist <= 60, `the view must follow the reply to the bottom (dist ${after.dist})`);
  log(`reply followed: dist=${after.dist} ✓`);
  // Reading back up still unpins: a later reply must not yank.
  await page.mouse.move(300, 400);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(500);
  const reread = await metrics(page);
  assert(reread.dist > 300, `wheel-up unpins (dist ${reread.dist})`);
  await page.evaluate(() => { window.dispatchEvent(new CustomEvent('parley:test-noop')); });
  log('reading back up still protected ✓');
}
