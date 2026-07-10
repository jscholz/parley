// Drawer cross-chat aggregation invariants:
//   1. Pin one message in chat A and another in chat B
//   2. Open the right-side pin drawer
//   3. Both items appear in the list, newest-first by pinnedAt
//   4. Each item shows the right body text + role label + chat label
//   5. The toolbar pin-button count banner reflects total (2)
//
// This is THE differentiator surface (Frontier Labs don't have
// across-chat aggregation), so it gets pinned regression coverage
// from day 1.

import {
  waitForReady, openSidebar, send, captureNextChatId,
  clickNewChat, clickRow, assert,
} from './lib.mjs';

export const NAME = 'pin-drawer-aggregation';
export const DESCRIPTION = 'pin drawer aggregates pinned messages across multiple chats, newest-first';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
// MOBILE coverage deferred — see pin-toggle-on-bubble.mjs.

const CHAT_B = 'mock-chat-b-for-pin-agg';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_B, {
    title: 'Second chat',
    source: 'sidekick',
    messages: [
      { role: 'user', content: 'first msg in B', message_id: 'b-user-1', sidekick_id: 'b-user-1', timestamp: Date.now() / 1000 - 100 },
      { role: 'assistant', content: 'first reply in B', message_id: 'b-asst-1', sidekick_id: 'b-asst-1', timestamp: Date.now() / 1000 - 99 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

async function clickPinOnFirstUserBubble(page) {
  return page.evaluate(() => {
    const line = document.querySelector('#transcript .line.s0[data-message-id], #transcript .line.user[data-message-id]');
    const btn = line?.querySelector('.pin-btn');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return line?.getAttribute('data-message-id') || null;
  });
}

async function openPinDrawer(page) {
  // Mobile uses the toolbar (.mobile-only) toggle; desktop uses the
  // rail toggle. Try rail first, fall back to toolbar.
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail')
            || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
}

async function drawerItems(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('#pin-drawer-list .pin-drawer-item')).map((li) => ({
      chatId: (li).dataset.chatId || '',
      msgId: (li).dataset.msgId || '',
      role: li.querySelector('.pin-item-role')?.textContent?.trim() || '',
      body: li.querySelector('.pin-item-body')?.textContent?.trim() || '',
    }));
  });
}

async function bannerCount(page) {
  return page.evaluate(() => {
    const el = document.getElementById('pin-drawer-count');
    if (!el || el.hidden) return 0;
    return Number(el.textContent || '0');
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // ── Chat A: fresh chat, send, pin the user bubble ────────────────
  const chatAP = captureNextChatId(page);
  await clickNewChat(page);
  const chatA = await chatAP;
  log(`chat A: ${chatA}`);

  await send(page, 'pin me in A');
  await page.waitForTimeout(800);
  const msgA = await clickPinOnFirstUserBubble(page);
  assert(msgA, `chat A: pin click should find a user bubble`);
  await page.waitForTimeout(150);
  log(`pinned A msg ${msgA}`);

  // ── Chat B: switch in (has prior content from MOCK_SETUP) ────────
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);
  const msgB = await clickPinOnFirstUserBubble(page);
  assert(msgB, `chat B: pin click should find a user bubble`);
  await page.waitForTimeout(150);
  log(`pinned B msg ${msgB}`);

  // ── One-number rule (2026-07-10): pins carry NO numeric badge ────
  const bannerHidden = await page.evaluate(() =>
    ['pin-drawer-count', 'pin-drawer-count-rail']
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .every((el) => el.hidden));
  assert(bannerHidden, 'pin numeric badge is retired (one-number rule) and must stay hidden');
  log('pin numeric badge stays hidden (one-number rule) ✓');

  // ── Open the drawer ──────────────────────────────────────────────
  await openPinDrawer(page);
  const items = await drawerItems(page);
  assert(items.length === 2,
    `drawer should aggregate 2 items, got ${items.length}: ${JSON.stringify(items)}`);
  log(`drawer items: ${items.length}`);

  // ── Newest-first sort: chat B was pinned LAST, should be index 0 ─
  assert(items[0].msgId === msgB,
    `newest-first sort: index 0 should be chat B pin (${msgB}), got ${items[0].msgId}`);
  assert(items[1].msgId === msgA,
    `newest-first sort: index 1 should be chat A pin (${msgA}), got ${items[1].msgId}`);
  log(`drawer items sorted newest-first ✓`);

  // ── Body text + role label match what was pinned ─────────────────
  assert(items[0].body.includes('first msg in B'),
    `chat B body should preserve text, got "${items[0].body}"`);
  assert(items[1].body.includes('pin me in A'),
    `chat A body should preserve text, got "${items[1].body}"`);
  assert(items[0].role === 'You' && items[1].role === 'You',
    `both should be 'You' (user bubbles), got [${items[0].role}, ${items[1].role}]`);
  log(`item bodies + roles correct ✓`);
}
