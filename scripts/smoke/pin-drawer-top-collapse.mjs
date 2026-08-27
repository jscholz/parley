// Top collapse caret on an expanded pin (2026-08-27).
//
// V2 "body first" puts the caption row — which carries the only caret —
// BELOW the body. Expanding a long pin therefore pushed its collapse
// control past the end of the text: "If I expand a message, I have to
// scroll all the way to the bottom of it to collapse it." A sticky bar
// at the top of the expanded item fixes that.
//
// The contract this pins down, in the state that actually broke (an item
// TALLER than the list viewport, scrolled past its own top):
//   - collapsed items render no bar at all (zero footprint on the
//     approved resting layout)
//   - expanded: the bar sits above the body, the caption stays below it
//   - scrolled deep into the body the caption is GONE from view while
//     the bar is still on screen AND hit-testable — the assertion that
//     would have caught the original complaint
//   - clicking it (a real mouse click at its on-screen position, not an
//     element.click(), so an overlapping element would fail here)
//     collapses
//   - the ENTIRE bar is the hit target, not just the 14px glyph — but a
//     bar click that completes a text selection declines to fold
//   - a click inside the expanded body still does not fold, so the text
//     stays selectable (the bar is chrome and holds no text, which is
//     why widening its hit area doesn't threaten that)
import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'pin-drawer-top-collapse';
export const DESCRIPTION = 'expanded pin exposes a sticky top collapse caret reachable from any scroll position';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const PIN_CHAT = 'parley:pin-top-collapse-source';
const OTHER_CHAT = 'parley:pin-top-collapse-other';
const MSG_ID = 'msg-pin-top-collapse';

// Long enough that the expanded item overflows the drawer viewport on
// any reasonable window — that is the whole failure mode.
const LONG_TEXT = Array.from({ length: 24 }, (_, i) =>
  `Paragraph ${i + 1}: the hosted demo instance needs HTTPS and a mic permission grant before the launch funnel can work end to end.`,
).join('\n\n');

export function MOCK_SETUP(mock) {
  const nowSec = Date.now() / 1000;
  mock.addChat(PIN_CHAT, {
    title: 'Pinned Source',
    messages: [{ role: 'assistant', content: LONG_TEXT, message_id: MSG_ID, parley_id: MSG_ID, timestamp: nowSec - 120 }],
    lastActiveAt: Date.now() - 120_000,
  });
  mock.addChat(OTHER_CHAT, {
    title: 'Other Chat',
    messages: [{ role: 'user', content: 'other chat seed', parley_id: 'other-seed', timestamp: nowSec - 60 }],
    lastActiveAt: Date.now() - 60_000,
  });
  mock.seedPin(PIN_CHAT, MSG_ID, {
    role: 'assistant', text: LONG_TEXT, timestamp: nowSec - 120, pinnedAt: nowSec - 120,
  });
}

const ITEM = '#pin-drawer-list .pin-drawer-item';

async function openPinDrawer(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail') || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForSelector(ITEM, { timeout: 3_000 });
}

const expanded = (page) => page.evaluate(() =>
  document.querySelector('#pin-drawer-list .pin-drawer-item')?.classList.contains('expanded') || false);

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, OTHER_CHAT);
  await openPinDrawer(page);

  const collapsedBar = await page.evaluate(() => {
    const bar = document.querySelector('#pin-drawer-list .pin-drawer-item .pin-item-collapse-bar');
    return bar ? getComputedStyle(bar).display : 'missing';
  });
  assert(collapsedBar === 'none', `collapsed pin should render no top bar, got display=${collapsedBar}`);
  log('collapsed item carries no top bar ✓');

  await page.click('#pin-drawer-list .pin-item-expand-btn');
  assert(await expanded(page), 'caret should expand the pin');

  const order = await page.evaluate(() => {
    const li = document.querySelector('#pin-drawer-list .pin-drawer-item.expanded');
    const bar = li.querySelector('.pin-item-collapse-bar').getBoundingClientRect();
    const body = li.querySelector('.pin-item-body').getBoundingClientRect();
    const cap = li.querySelector('.pin-item-caption').getBoundingClientRect();
    const list = document.getElementById('pin-drawer-list');
    return {
      barAboveBody: bar.top <= body.top,
      captionBelowBody: cap.top >= body.bottom - 1,
      overflows: li.getBoundingClientRect().height > list.clientHeight,
    };
  });
  assert(order.barAboveBody, 'top bar should sit above the body');
  assert(order.captionBelowBody, 'caption row should stay below the body (V2 body-first layout)');
  assert(order.overflows, 'fixture pin must overflow the drawer viewport or this test proves nothing');
  log('expanded: bar above body, caption still below ✓');

  // Scroll past the item's own top — the state where the bottom-anchored
  // caret was unreachable.
  await page.evaluate(() => {
    const list = document.getElementById('pin-drawer-list');
    const li = document.querySelector('#pin-drawer-list .pin-drawer-item.expanded');
    list.scrollTop = li.offsetTop + 200;
  });
  await page.waitForTimeout(150);

  const stuck = await page.evaluate(() => {
    const list = document.getElementById('pin-drawer-list');
    const li = document.querySelector('#pin-drawer-list .pin-drawer-item.expanded');
    const lb = list.getBoundingClientRect();
    const bar = li.querySelector('.pin-item-collapse-bar').getBoundingClientRect();
    const cap = li.querySelector('.pin-item-caption').getBoundingClientRect();
    const hit = document.elementFromPoint(bar.left + bar.width - 16, bar.top + bar.height / 2);
    return {
      scrolled: list.scrollTop > 0,
      barVisible: bar.top >= lb.top - 1 && bar.bottom <= lb.bottom,
      captionVisible: cap.top >= lb.top && cap.bottom <= lb.bottom,
      hitIsCollapseBtn: !!hit?.closest('.pin-item-collapse-btn'),
    };
  });
  assert(stuck.scrolled, 'list should have scrolled');
  assert(!stuck.captionVisible, 'fixture should scroll the caption row out of view — otherwise the bug is not reproduced');
  assert(stuck.barVisible, 'top collapse bar should stay in view while scrolled into the body');
  assert(stuck.hitIsCollapseBtn, 'collapse caret should be hit-testable (not covered by body text scrolling under it)');
  log('caret stays on screen and clickable with the caption scrolled away ✓');

  // Real mouse click at its rendered position — an overlapping element
  // or a mis-stacked bar fails here where element.click() would pass.
  const at = await page.evaluate(() => {
    const b = document.querySelector('#pin-drawer-list .pin-drawer-item.expanded .pin-item-collapse-btn');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(150);
  assert(!(await expanded(page)), 'clicking the top caret should collapse the pin');
  log('top caret collapses on a real click ✓');

  // The WHOLE bar is the target, not just the glyph (his nit): click the
  // empty left end of the strip, far from the caret, and it must fold.
  await page.click('#pin-drawer-list .pin-item-expand-btn');
  assert(await expanded(page), 're-expand for the whole-row hit test');
  const farLeft = await page.evaluate(() => {
    const bar = document.querySelector('#pin-drawer-list .pin-drawer-item.expanded .pin-item-collapse-bar');
    const btn = bar.querySelector('.pin-item-collapse-btn');
    const r = bar.getBoundingClientRect(), b = btn.getBoundingClientRect();
    return { x: r.left + 12, y: r.top + r.height / 2, glyphLeft: b.left, barLeft: r.left };
  });
  assert(farLeft.x < farLeft.glyphLeft - 8, 'probe point must be clear of the caret glyph or this proves nothing');
  await page.mouse.click(farLeft.x, farLeft.y);
  await page.waitForTimeout(150);
  assert(!(await expanded(page)), 'clicking the empty part of the top bar should collapse the pin');
  log('whole top row is the hit target, not just the glyph ✓');

  // ...but a click that completes a text SELECTION must not fold, so a
  // stray mouseup over the bar never eats the user's drag.
  await page.click('#pin-drawer-list .pin-item-expand-btn');
  const guarded = await page.evaluate(() => {
    const li = document.querySelector('#pin-drawer-list .pin-drawer-item.expanded');
    const body = li.querySelector('.pin-item-body');
    const bar = li.querySelector('.pin-item-collapse-bar');
    const range = document.createRange();
    range.selectNodeContents(body.querySelector('p') || body);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return {
      selLen: String(window.getSelection()).length,
      stillExpanded: li.classList.contains('expanded'),
    };
  });
  assert(guarded.selLen > 0, 'selection fixture should have selected text');
  assert(guarded.stillExpanded, 'a bar click that completes a selection must not fold the pin');
  log('bar click declines while a selection is live ✓');

  // Hover tooltips on BOTH carets; the caption one tracks state.
  // Read title OR data-tip: src/util/tooltip.ts moves `title` into
  // `data-tip` for the duration of a hover (so the native bubble doesn't
  // double up with the styled one) and moves it back on mouseout. A bare
  // getAttribute('title') therefore reads null whenever the pointer
  // happens to rest on the element — which, after a page.click, it does.
  const tips = await page.evaluate(() => {
    const tip = (el) => el?.getAttribute('title') ?? el?.getAttribute('data-tip') ?? null;
    const li = document.querySelector('#pin-drawer-list .pin-drawer-item');
    return {
      expandedNow: li.classList.contains('expanded'),
      captionTip: tip(li.querySelector('.pin-item-expand-btn')),
      barTip: tip(li.querySelector('.pin-item-collapse-bar')),
      barBtnTip: tip(li.querySelector('.pin-item-collapse-btn')),
    };
  });
  assert(tips.barTip === 'Collapse', `top bar tooltip should read Collapse, got ${tips.barTip}`);
  assert(tips.barBtnTip === 'Collapse', `top caret tooltip should read Collapse, got ${tips.barBtnTip}`);
  assert(tips.captionTip === (tips.expandedNow ? 'Collapse' : 'Expand'),
    `caption caret tooltip should track state (expanded=${tips.expandedNow}), got ${tips.captionTip}`);
  await page.click('#pin-drawer-list .pin-item-expand-btn');
  const flipped = await page.evaluate(() => {
    const el = document.querySelector('#pin-drawer-list .pin-drawer-item .pin-item-expand-btn');
    const li = document.querySelector('#pin-drawer-list .pin-drawer-item');
    return {
      expandedNow: li.classList.contains('expanded'),
      tip: el.getAttribute('title') ?? el.getAttribute('data-tip') ?? null,
    };
  });
  assert(flipped.tip === (flipped.expandedNow ? 'Collapse' : 'Expand'),
    `caption caret tooltip should flip with state, got ${flipped.tip}`);
  log('both carets carry hover tooltips; caption one tracks state ✓');

  // Text selection must survive: body clicks never fold.
  await page.click('#pin-drawer-list .pin-item-expand-btn');
  assert(await expanded(page), 're-expand for the selection check');
  const sel = await page.evaluate(() => {
    const body = document.querySelector('#pin-drawer-list .pin-drawer-item.expanded .pin-item-body');
    const target = body.querySelector('p') || body;
    const range = document.createRange();
    range.selectNodeContents(target);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    const len = String(s).length;
    body.click();
    return { len, stillExpanded: !!document.querySelector('#pin-drawer-list .pin-drawer-item.expanded') };
  });
  assert(sel.len > 0, 'pin body text should be selectable');
  assert(sel.stillExpanded, 'a click inside the expanded body must not fold it');
  log('expanded body stays selectable, body click does not fold ✓');
}
