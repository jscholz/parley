// Regression guard: switching between two existing sessions with
// MID-history scroll positions doesn't reliably restore — switchback
// lands at a different place than the user left it. The existing
// scroll-top smoke only exercises scroll-to-zero, where a poisoned
// save of 0 still matches the (wrong) restore-to-top assertion.
//
// This smoke scrolls each chat to a mid-history position (not top, not
// bottom), bounces between them via drawer rows, then asserts each
// chat restored within a small tolerance of the saved scrollTop.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'scroll-mid-history-survives-switch';
export const DESCRIPTION = 'Two chats, both scrolled mid-history — round-trip switch must restore each saved position';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-scroll-mid-a';
const CHAT_B = 'mock-scroll-mid-b';

function makeMessages(count, prefix) {
  const out = [];
  const body = `${prefix}: ${'lorem ipsum dolor sit amet consectetur '.repeat(18)}`;
  for (let i = 0; i < count; i++) {
    out.push({
      id: i + 1,
      parley_id: `${prefix.toLowerCase()}-mid-${i + 1}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${body} (msg ${i})`,
      timestamp: Date.now() / 1000 - (count - i) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat A — long',
    source: 'parley',
    messages: makeMessages(80, 'A'),
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B — long',
    source: 'parley',
    messages: makeMessages(80, 'B'),
    lastActiveAt: Date.now() - 30_000,
  });
}

async function snapScroll(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return null;
    // Capture first-visible bubble for under-virt-correct invariants:
    // anchor restore preserves SAME bubble across switch, but the
    // computed scrollTop may differ by a few hundred px when offscreen
    // height-cache defaults diverge from actual heights. Asserting
    // on first-visible KEY is the user-meaningful invariant.
    const tr = t.getBoundingClientRect();
    const lines = Array.from(t.querySelectorAll('.line'));
    let firstVisible = null;
    for (const el of lines) {
      const r = el.getBoundingClientRect();
      if (r.bottom <= tr.top) continue;
      if (r.top >= tr.bottom) break;
      firstVisible = {
        key: el.getAttribute('data-key'),
        topOffset: Math.round(r.top - tr.top),
      };
      break;
    }
    return {
      scrollTop: Math.round(t.scrollTop),
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      maxTop: t.scrollHeight - t.clientHeight,
      firstVisible,
    };
  });
}

/** Scroll the transcript toward (but not all the way to) the middle
 *  via real wheel events. Returns the resulting scrollTop. */
async function wheelTowardMiddle(page, fromTopFraction) {
  const box = await page.locator('#transcript').boundingBox();
  if (!box) throw new Error('transcript bounding box missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Pre-step: chat opens at bottom by default. Scroll up first to land
  // somewhere in the middle. fromTopFraction = 0.4 means "40% from top".
  const before = await snapScroll(page);
  const targetTop = Math.round(before.maxTop * fromTopFraction);
  const delta = before.scrollTop - targetTop;  // positive → wheel up
  const stepPx = 400;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / stepPx));
  const sign = delta > 0 ? -1 : 1;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, sign * stepPx);
  }
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // ── Step 1: open A, scroll to mid-history (~40% from top).
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(800);
  const aLoaded = await snapScroll(page);
  log(`A loaded: scrollTop=${aLoaded.scrollTop} maxTop=${aLoaded.maxTop}`);
  assert(aLoaded.maxTop > aLoaded.clientHeight * 2,
    `chat A must be deeply scrollable: maxTop=${aLoaded.maxTop}`);

  await wheelTowardMiddle(page, 0.4);
  await page.waitForTimeout(400);  // allow save debounce to settle
  const aMid = await snapScroll(page);
  log(`A scrolled mid: scrollTop=${aMid.scrollTop} (target ~${Math.round(aLoaded.maxTop * 0.4)})`);
  assert(aMid.scrollTop > 200 && aMid.scrollTop < aMid.maxTop - 200,
    `chat A must be mid-history (not at top or bottom). scrollTop=${aMid.scrollTop} maxTop=${aMid.maxTop}`);

  // ── Step 2: switch to B, scroll B mid-history.
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);

  await wheelTowardMiddle(page, 0.5);
  await page.waitForTimeout(400);
  const bMid = await snapScroll(page);
  log(`B scrolled mid: scrollTop=${bMid.scrollTop} maxTop=${bMid.maxTop}`);
  assert(bMid.scrollTop > 200 && bMid.scrollTop < bMid.maxTop - 200,
    `chat B must be mid-history. scrollTop=${bMid.scrollTop} maxTop=${bMid.maxTop}`);

  // ── Step 3: switch back to A. Anchor restore must land on the SAME
  //          first-visible bubble at the SAME viewport offset (≤25px).
  //          Pixel-drift on scrollTop alone is fragile under virt because
  //          height-cache defaults for unmeasured offscreen specs diverge
  //          from actual measured heights.
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);
  const aRestored = await snapScroll(page);
  log(`A restored: scrollTop=${aRestored.scrollTop} firstVisible=${JSON.stringify(aRestored.firstVisible)}`);
  assert(aMid.firstVisible?.key && aRestored.firstVisible?.key,
    `must capture first-visible at save+restore`);
  assert(aRestored.firstVisible.key === aMid.firstVisible.key,
    `chat A must restore the SAME first-visible bubble. saved=${aMid.firstVisible.key} restored=${aRestored.firstVisible.key}`);
  const aOffsetDrift = Math.abs(
    (aRestored.firstVisible.topOffset ?? 0) - (aMid.firstVisible.topOffset ?? 0));
  assert(aOffsetDrift <= 25,
    `chat A anchor viewport offset drifted ${aOffsetDrift}px (need ≤25). ` +
    `saved-top=${aMid.firstVisible.topOffset} restored-top=${aRestored.firstVisible.topOffset}`);

  // ── Step 4: switch back to B. Same invariant.
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(1500);
  const bRestored = await snapScroll(page);
  log(`B restored: scrollTop=${bRestored.scrollTop} firstVisible=${JSON.stringify(bRestored.firstVisible)}`);
  assert(bRestored.firstVisible.key === bMid.firstVisible.key,
    `chat B must restore the SAME first-visible bubble. saved=${bMid.firstVisible.key} restored=${bRestored.firstVisible.key}`);
  const bOffsetDrift = Math.abs(
    (bRestored.firstVisible.topOffset ?? 0) - (bMid.firstVisible.topOffset ?? 0));
  assert(bOffsetDrift <= 25,
    `chat B anchor viewport offset drifted ${bOffsetDrift}px (need ≤25). ` +
    `saved-top=${bMid.firstVisible.topOffset} restored-top=${bRestored.firstVisible.topOffset}`);
}
