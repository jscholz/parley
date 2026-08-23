// Unified pin+tail buffer (#227). Field complaint: "the pin and the tail
// are mutually exclusive, and I often have to reload the pin or tail based
// on my clicks." The old deep-drill REPLACED the tail-anchored transcript
// with a floating around-window centered on the target, so the live tail
// vanished until a scroll-down walk (or jump-to-latest) re-fetched it.
//
// New behavior under test: when the buffer already reaches the live tail
// (hasMoreNewer=false), drilling to a DEEP pin SPLICES the pin's around
// window alongside the retained tail with a `…` gap placeholder at the
// discontinuity — instead of replacing. After the drill BOTH the deep
// target AND the live tail are rendered, with exactly one transcript-gap
// row between them. Tapping the gap fetches the page after its older edge
// (loadLater) and fillGap shrinks/closes it.
//
// Test plan (mocked):
//   1. Seed a 120-msg chat (first page 30). Open it tail-anchored.
//   2. Pin a DEEP message (idx 5), drill via the pin drawer.
//   3. Assert: deep target rendered AND live tail STILL rendered AND
//      exactly one `.transcript-gap` placeholder present.
//   4. Click the gap → assert a `?after=` load fires and the gap either
//      closes or advances (fewer/zero gap rows; new rows appear).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'drill-splices-pin-alongside-tail';
export const DESCRIPTION = 'drilling a deep pin from a tail-anchored view splices the pin window alongside the retained tail with a gap placeholder (no pin/tail mutual exclusivity)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-splice-pin-tail';
const TOTAL_MSGS = 120;
const FIRST_PAGE = 30;
const DEEP_IDX = 5;
const TAIL_IDX = TOTAL_MSGS;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      parley_id: `splice-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Splice pin+tail test',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

const isRendered = (page, mid) => page.evaluate(
  (m) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(m)}"]`),
  mid,
);

const gapCount = (page) => page.evaluate(
  () => document.querySelectorAll('#transcript .transcript-gap').length,
);

export default async function run({ page, log }) {
  await waitForReady(page);

  // 1. Open tail-anchored.
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, CHAT_ID);
  await page.waitForTimeout(800);

  const deepMsg = `splice-msg-${DEEP_IDX}`;
  const tailMsg = `splice-msg-${TAIL_IDX}`;

  assert(await isRendered(page, tailMsg), 'tail-anchored open: live tail must be rendered');
  assert((await gapCount(page)) === 0, 'tail-anchored open: no gap placeholder yet');
  log('tail-anchored: tail rendered, no gap ✓');

  // 2. Pin the deep message, open the drawer, drill.
  await page.evaluate(({ chatId, msgId, idx }) => {
    return import('/build/pins/store.mjs').then((mod) => mod.pinMessage({
      chatId, msgId, role: 'user', text: `user marker ${idx}`, timestamp: Date.now(),
    }));
  }, { chatId: CHAT_ID, msgId: deepMsg, idx: DEEP_IDX });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    (document.getElementById('btn-pin-drawer-rail') || document.getElementById('btn-pin-drawer'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  await page.evaluate((mid) => {
    const li = document.querySelector(`#pin-drawer-list .pin-drawer-item[data-msg-id="${mid}"]`);
    li?.querySelector('.pin-item-jump-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, deepMsg);

  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    deepMsg, { timeout: 8_000, polling: 60 },
  );
  await page.waitForTimeout(400);

  // 3. Splice invariants: deep target AND live tail both present, with
  //    exactly one gap placeholder between them (no mutual exclusivity).
  assert(await isRendered(page, deepMsg), `deep target ${deepMsg} must render after the drill`);
  assert(await isRendered(page, tailMsg),
    `live tail ${tailMsg} must REMAIN rendered after drilling to a pin (pin+tail not mutually exclusive)`);
  const gaps = await gapCount(page);
  assert(gaps === 1, `exactly one gap placeholder expected at the discontinuity (got ${gaps})`);
  log(`splice: deep target + live tail both rendered, ${gaps} gap placeholder ✓`);

  // 4. Tap the gap → a ?after= load fires; the gap shrinks or closes.
  let afterCount = 0;
  const onReq = (req) => {
    const u = req.url();
    if (/\/sessions\/[^/]+\/messages/.test(u) && /[?&]after=/.test(u)) afterCount++;
  };
  page.on('request', onReq);

  await page.evaluate(() => {
    document.querySelector('#transcript .transcript-gap .transcript-gap-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  // The gap fill brings in the page after the gap's older edge — assert a
  // message just past the deep target (idx 6+) materializes.
  const nextMsg = `splice-msg-${DEEP_IDX + 1}`;
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    nextMsg, { timeout: 8_000, polling: 100 },
  );
  await page.waitForTimeout(300);
  page.off('request', onReq);

  assert(afterCount >= 1, `tapping the gap must issue at least one ?after= load (got ${afterCount})`);
  assert(await isRendered(page, nextMsg), `gap fill must bring in ${nextMsg}`);
  assert(await isRendered(page, tailMsg), 'tail must remain after the gap fill');
  log(`gap fill: ?after=${afterCount}, ${nextMsg} loaded, tail retained ✓`);
}
