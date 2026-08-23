// Regression guard: scrolled to TOP of a long chat, switched away,
// scroll position lost on return / reload.
//
// Why a new smoke instead of editing existing ones:
//   - existing smokes scroll via page.evaluate(scrollTo). Real wheel
//     events fire different code paths; we use page.mouse.wheel here.
//   - existing smokes wait 700ms between scroll and switch — above the
//     IDB-persist debounce. We switch within ~150ms to expose any
//     "switched before persist" race; the onBeforeSwitch flush should
//     paper over it.
//   - existing smokes don't reload. Reload is the only way to verify
//     the IDB-only restore path (in-memory cache starts empty).
//   - scrolling to the absolute TOP has a special interaction with
//     load-earlier (fires when scrollTop near 0) that no other smoke
//     covers.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'scroll-top-survives-switch-and-reload';
export const DESCRIPTION = 'Scroll to TOP via real wheel events, fast-switch + reload — restore must land at top';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-scroll-top-a';
const CHAT_B = 'mock-scroll-top-b';

function makeMessages(count, prefix) {
  const out = [];
  const body = `${prefix}: ${'lorem ipsum dolor sit amet consectetur '.repeat(18)}`;
  for (let i = 0; i < count; i++) {
    out.push({
      id: i + 1,
      parley_id: `${prefix.toLowerCase()}-top-${i + 1}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${body} (msg ${i})`,
      timestamp: Date.now() / 1000 - (count - i) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat A — long for scroll-to-top',
    source: 'parley',
    messages: makeMessages(80, 'A'),
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B — short',
    source: 'parley',
    messages: makeMessages(8, 'B'),
    lastActiveAt: Date.now() - 30_000,
  });
}

async function snapScroll(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return null;
    return {
      scrollTop: Math.round(t.scrollTop),
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      maxTop: t.scrollHeight - t.clientHeight,
    };
  });
}

/** Use the real Playwright wheel API to scroll the transcript. Driving
 *  the input layer exercises the production save-on-scroll path exactly
 *  as a human triggers it.
 *
 *  page.mouse.wheel resolves when the event is DISPATCHED, not when the
 *  scroll settles. Firing a tight burst lets headless Chrome's compositor
 *  COALESCE the deltas — most get dropped and the transcript stalls
 *  partway (the old 12×-1500 burst deterministically stuck at ~3441).
 *  So wheel one tick at a time, yielding a frame between ticks so each
 *  delta applies, and poll scrollTop until we actually reach the top
 *  (mirrors a human flicking the wheel repeatedly). */
async function wheelTowardTop(page) {
  const box = await page.locator('#transcript').boundingBox();
  if (!box) throw new Error('transcript bounding box missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 60; i++) {
    const top = await page.evaluate(
      () => document.getElementById('transcript')?.scrollTop ?? 0);
    if (top <= 50) break;
    await page.mouse.wheel(0, -1500);
    await page.waitForTimeout(16);
  }
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Step 1: open chat A, confirm scrollable.
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(800);
  const aLoaded = await snapScroll(page);
  log(`A loaded: scrollTop=${aLoaded.scrollTop} maxTop=${aLoaded.maxTop}`);
  assert(aLoaded.maxTop > aLoaded.clientHeight * 2,
    `chat A must be deeply scrollable: maxTop=${aLoaded.maxTop} ch=${aLoaded.clientHeight}`);

  // Step 2: scroll to TOP via real wheel events.
  await wheelTowardTop(page);
  await page.waitForTimeout(150);
  const aAtTop = await snapScroll(page);
  log(`A wheeled to top: scrollTop=${aAtTop.scrollTop}`);
  assert(aAtTop.scrollTop <= 50, `chat A must reach top after wheel chain. scrollTop=${aAtTop.scrollTop}`);

  // Step 3: fast-switch to B (under the IDB debounce window).
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);

  // Step 4: switch BACK to A. In-memory cache should hold scrollTop=0.
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);
  const aRestored = await snapScroll(page);
  log(`A restored (no reload): scrollTop=${aRestored.scrollTop} maxTop=${aRestored.maxTop}`);
  assert(aRestored.scrollTop <= 80,
    `chat A must restore near top after switch-back. ` +
    `Got scrollTop=${aRestored.scrollTop} maxTop=${aRestored.maxTop}`);

  // Step 5: full page reload, then switch to A. This is the IDB-only
  // path — in-memory cache starts empty, restore must read from IDB.
  // The onBeforeSwitch + pagehide flushes are what makes this case
  // work; without them, the 200ms IDB debounce would lose the position.
  await page.waitForTimeout(300);  // allow IDB debounce to settle
  await page.reload();
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);
  const aAfterReload = await snapScroll(page);
  log(`A restored (after reload): scrollTop=${aAfterReload.scrollTop} maxTop=${aAfterReload.maxTop}`);
  assert(aAfterReload.scrollTop <= 80,
    `chat A must restore near top AFTER PAGE RELOAD. ` +
    `Got scrollTop=${aAfterReload.scrollTop} maxTop=${aAfterReload.maxTop}`);
}
