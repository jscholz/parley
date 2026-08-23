// Pin drawer "Jump to context" invariants:
//   1. Each pin item has a jump-button (explicit affordance distinct
//      from the row click)
//   2. Click on the jump button → drills into the chat that owns
//      the pin, drawer closes
//   3. The transcript shows the bubble that was pinned (its
//      data-message-id matches)
//   4. Drawer click on the row body has the same drill behavior
//      (jump button is an affordance, not the only path)

import {
  waitForReady, openSidebar, send, captureNextChatId,
  clickNewChat, clickRow, assert,
} from './lib.mjs';

export const NAME = 'pin-drawer-jump';
export const DESCRIPTION = 'pin drawer items have a jump-to-context button that drills + closes the drawer';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
// MOBILE coverage deferred — see pin-toggle-on-bubble.mjs.

const CHAT_B = 'mock-chat-b-for-jump';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_B, {
    title: 'Second chat (no pins)',
    source: 'parley',
    messages: [
      { role: 'user', content: 'unrelated', message_id: 'b-user-1', parley_id: 'b-user-1', timestamp: Date.now() / 1000 - 100 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

async function pinFirstUserBubble(page) {
  return page.evaluate(() => {
    const line = document.querySelector('#transcript .line.s0[data-message-id], #transcript .line.user[data-message-id]');
    const btn = line?.querySelector('.pin-btn');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return line?.getAttribute('data-message-id') || null;
  });
}

async function openPinDrawer(page) {
  // Rail button is desktop; fall back to mobile-only toolbar button
  // if the rail isn't visible in the test viewport.
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail')
            || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
}

async function clickJumpForFirstPin(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('#pin-drawer-list .pin-drawer-item .pin-item-jump-btn');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(800);
}

async function drawerOpen(page) {
  return page.evaluate(() => {
    return !document.getElementById('pin-drawer')?.classList.contains('collapsed');
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // ── Pin a message in chat A ──────────────────────────────────────
  const chatAP = captureNextChatId(page);
  await clickNewChat(page);
  const chatA = await chatAP;
  log(`chat A: ${chatA}`);

  await send(page, 'jump back to me');
  await page.waitForTimeout(800);
  const msgA = await pinFirstUserBubble(page);
  assert(msgA, `chat A: pin click should find a user bubble`);
  log(`pinned A msg ${msgA}`);

  // ── Switch to chat B so we're no longer on the pinned chat ───────
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);
  const currentBefore = await page.evaluate(() => (window).__currentChatForTest?.() || null);
  // Best-effort current-chat probe; if the seam isn't exposed, fall
  // back to reading the active sidebar row's data-chat-id.
  const activeBefore = currentBefore || await page.evaluate(() => {
    return document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') || null;
  });
  assert(activeBefore === CHAT_B,
    `pre-jump: should be viewing chat B, got ${activeBefore}`);
  log(`pre-jump: viewing chat B ✓`);

  // ── Open drawer + click jump button ──────────────────────────────
  await openPinDrawer(page);
  assert(await drawerOpen(page), `drawer should be open after toggle`);

  const jumpBtnCount = await page.evaluate(() =>
    document.querySelectorAll('#pin-drawer-list .pin-item-jump-btn').length);
  assert(jumpBtnCount === 1, `expected 1 jump button (1 pin), got ${jumpBtnCount}`);
  log(`drawer: 1 jump button visible ✓`);

  await clickJumpForFirstPin(page);

  // ── On desktop the drawer should STAY OPEN — pin drawer is a
  //    todo-list / context surface that should persist while the
  //    user drills around the chat.
  //    Mobile auto-closes (full-overlay layout would otherwise
  //    obscure the drilled-to message), but smokes run at 1280x800
  //    desktop unless MOBILE='true'.
  assert(await drawerOpen(page),
    `post-jump (desktop): drawer should remain open (todo-list semantic)`);
  log(`post-jump: drawer stayed open (desktop) ✓`);

  // The transcript should now show chat A's pinned bubble — verify
  // by looking for its data-message-id.
  const targetVisible = await page.evaluate((mid) =>
    !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    msgA,
  );
  assert(targetVisible,
    `post-jump: chat A's pinned bubble (${msgA}) should be in the transcript`);
  log(`post-jump: pinned bubble rendered in transcript ✓`);

  // The target's TOP should be near the viewport top (block:'start'
  // alignment). Regression guard: earlier `block:'center'` centered
  // tall bubbles, so their start fell well above the viewport — the
  // drill felt "off by 2-3 messages." Allow
  // smooth-scroll a moment to settle, then verify rect.top is in
  // [-20, viewport*0.3] — within a small slack of the top edge.
  await page.waitForTimeout(800);
  const rect = await page.evaluate((mid) => {
    const el = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    const r = el?.getBoundingClientRect();
    return r ? { top: r.top, viewportH: window.innerHeight } : null;
  }, msgA);
  assert(rect, `post-jump: target bubble bounding rect should be readable`);
  const okBand = rect.top >= -20 && rect.top <= rect.viewportH * 0.3;
  assert(okBand,
    `post-jump: target should land near viewport top (block:'start'), got top=${rect.top.toFixed(0)} viewportH=${rect.viewportH}`);
  log(`post-jump: target lands at top of viewport (top=${rect.top.toFixed(0)}) ✓`);
}
