// Regression guard: clicking a pinned message in the right drawer
// drills into the chat correctly, but ALSO closes the left session
// sidebar. Only the pin drawer should auto-close on drill — the
// sidebar is an independent surface and should stay in whatever state
// the user left it.
//
// Pin a message → open both drawers (desktop) → click the pin item
// → assert sidebar remains expanded, pin drawer closes, transcript
// shows the target.

import {
  waitForReady, openSidebar, send, captureNextChatId,
  clickNewChat, clickRow, assert,
} from './lib.mjs';

export const NAME = 'pin-drill-preserves-sidebar';
export const DESCRIPTION = 'desktop: clicking a pinned message preserves sidebar expanded-state';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_B = 'mock-chat-b-preserve';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_B, {
    title: 'Other chat',
    source: 'parley',
    messages: [
      { role: 'user', content: 'unrelated B', message_id: 'b-1', parley_id: 'b-1', timestamp: Date.now() / 1000 - 100 },
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
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail')
            || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
}

async function sidebarOpen(page) {
  return page.evaluate(() => !!document.getElementById('sidebar')?.classList.contains('expanded'));
}

async function pinDrawerOpen(page) {
  return page.evaluate(() => !document.getElementById('pin-drawer')?.classList.contains('collapsed'));
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  assert(await sidebarOpen(page), `pre: sidebar should be expanded by openSidebar helper`);

  // Pin a message in chat A.
  const chatAP = captureNextChatId(page);
  await clickNewChat(page);
  const chatA = await chatAP;
  log(`chat A: ${chatA}`);

  await send(page, 'drill me from the drawer');
  await page.waitForTimeout(800);
  const msgA = await pinFirstUserBubble(page);
  assert(msgA, `pin click should find a user bubble`);
  log(`pinned msg ${msgA}`);

  // Switch to chat B so the drill is a real chat-switch.
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(600);

  // Sidebar should still be open (desktop).
  assert(await sidebarOpen(page), `mid: sidebar should remain open after row click`);

  // Open pin drawer.
  await openPinDrawer(page);
  assert(await pinDrawerOpen(page), `pin drawer should open via toggle`);
  assert(await sidebarOpen(page), `sidebar should remain open with pin drawer open`);
  log(`both drawers open ✓`);

  // Click the pin item's drill target. The right-drawer refactor (commit
  // e936c90, 2026-05-21) moved the drill onclick off the LI itself; the
  // V2 "body first" redesign (UX-pass pt7, 2026-08-26) then removed the
  // footer row entirely — the caption's `.pin-item-jump-btn` is now the
  // ONLY drill target (the caption row itself toggles expand/collapse).
  // Dispatch against the jump button so the handler actually fires.
  await page.evaluate(() => {
    const jump = document.querySelector('#pin-drawer-list .pin-drawer-item .pin-item-jump-btn');
    jump?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(800);

  // BOTH drawers should remain open on desktop — pin drawer is a
  // persistent todo-list surface, and the session sidebar is
  // independent.
  assert(await pinDrawerOpen(page),
    `post-drill (desktop): pin drawer should stay open (todo-list semantic)`);
  log(`pin drawer stayed open ✓`);
  assert(await sidebarOpen(page),
    `BUG (field bug 2026-05-13): sidebar must remain open after pin-drill on desktop`);
  log(`sidebar preserved ✓`);

  // Target bubble visible in transcript.
  const visible = await page.evaluate((mid) =>
    !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    msgA,
  );
  assert(visible, `post-drill: pinned bubble should be in the transcript`);
  log(`target bubble rendered ✓`);
}
