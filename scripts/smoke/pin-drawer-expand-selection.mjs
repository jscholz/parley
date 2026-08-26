// Pin drawer interaction contract (V2 "body first", UX-pass pt7,
// user-approved 2026-08-26 — body leads, ONE caption row below it):
// - collapsed body click expands
// - expanded body click does not collapse, preserving text selection
// - caption row/caret toggles collapse and expand
// - the caption's jump button remains the drill-to-chat target

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'pin-drawer-expand-selection';
export const DESCRIPTION = 'pin body expands without stealing text selection; caption toggles; jump drills';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const PIN_CHAT = 'parley:pin-expand-selection-source';
const OTHER_CHAT = 'parley:pin-expand-selection-other';
const MSG_ID = 'msg-pin-expand-selection';

export function MOCK_SETUP(mock) {
  const nowSec = Date.now() / 1000;
  mock.addChat(PIN_CHAT, {
    title: 'Pinned Source',
    messages: [
      { role: 'assistant', content: 'Selectable pin text line one.\nSelectable pin text line two.\nSelectable pin text line three.\nSelectable pin text line four.', message_id: MSG_ID, parley_id: MSG_ID, timestamp: nowSec - 120 },
    ],
    lastActiveAt: Date.now() - 120_000,
  });
  mock.addChat(OTHER_CHAT, {
    title: 'Other Chat',
    messages: [{ role: 'user', content: 'other chat seed', parley_id: 'other-seed', timestamp: nowSec - 60 }],
    lastActiveAt: Date.now() - 60_000,
  });
  mock.seedPin(PIN_CHAT, MSG_ID, {
    role: 'assistant',
    text: 'Selectable pin text line one.\nSelectable pin text line two.\nSelectable pin text line three.\nSelectable pin text line four.',
    timestamp: nowSec - 120,
    pinnedAt: nowSec - 120,
  });
}

async function openPinDrawer(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail') || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('#pin-drawer-list .pin-drawer-item', { timeout: 3_000 });
}

async function expanded(page) {
  return page.evaluate(() => document.querySelector('#pin-drawer-list .pin-drawer-item')?.classList.contains('expanded') || false);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, OTHER_CHAT);
  await openPinDrawer(page);

  assert(!(await expanded(page)), 'pin should start collapsed');
  await page.click('#pin-drawer-list .pin-item-body');
  assert(await expanded(page), 'collapsed body click should expand pin');
  log('body click expands collapsed pin ✓');

  await page.click('#pin-drawer-list .pin-item-body');
  assert(await expanded(page), 'expanded body click should not collapse pin');
  log('expanded body click leaves text selectable ✓');

  // V2: the caption ROW (not the caption's buttons) is the collapse
  // toggle — click its text cluster so the toggle handler, not a
  // stopPropagation'd child button, is what's exercised.
  await page.click('#pin-drawer-list .pin-item-caption .pin-item-caption-text');
  assert(!(await expanded(page)), 'caption row click should collapse pin');
  await page.click('#pin-drawer-list .pin-item-expand-btn');
  assert(await expanded(page), 'caret button should expand pin');
  const aria = await page.locator('#pin-drawer-list .pin-item-expand-btn').first().getAttribute('aria-expanded');
  assert(aria === 'true', `caret aria-expanded should be true, got ${aria}`);
  log('caption/caret toggles pin expansion ✓');

  await page.click('#pin-drawer-list .pin-item-jump-btn');
  await page.waitForFunction((chatId) => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') === chatId, PIN_CHAT, { timeout: 4_000, polling: 50 });
  log('jump button drills to source chat ✓');
}
