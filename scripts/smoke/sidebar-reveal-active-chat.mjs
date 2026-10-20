// "A way to scroll to the session my transcript is viewing" (2026-10-20):
//   1. opening the sidebar brings the viewed chat's row into view;
//   2. clicking the header chat title opens the sidebar (if closed),
//      scrolls to the row and flashes it — and if a lens chip hides the
//      row, switches back to All.

import { waitForReady, openSidebar, assert, pollUntil } from './lib.mjs';

export const NAME = 'sidebar-reveal-active-chat';
export const DESCRIPTION = 'Sidebar open reveals the viewed chat; header title click scrolls to + flashes its row (resets a hiding lens)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const DEEP = 'parley:mock-reveal-35';

export function MOCK_SETUP(mock) {
  const now = Date.now();
  for (let i = 0; i < 40; i++) {
    const id = `parley:mock-reveal-${i}`;
    mock.addChat(id, {
      title: `Reveal chat ${i}`, lastActiveAt: now - 60_000 * (i + 1),
      messages: [{ role: 'assistant', content: `body of reveal chat ${i}`, message_id: `m-rv-${i}`, timestamp: (now - 60_000 * (i + 1)) / 1000 }],
    });
  }
}

const inView = (id) => {
  const li = document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
  const sc = document.querySelector('#sidebar .sidebar-content');
  if (!li || !sc) return false;
  const a = li.getBoundingClientRect(); const b = sc.getBoundingClientRect();
  return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
};

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  // View the deep chat.
  await page.locator(`#sessions-list li[data-chat-id="${DEEP}"] .sess-body`).scrollIntoViewIfNeeded();
  await page.locator(`#sessions-list li[data-chat-id="${DEEP}"] .sess-body`).click();
  await pollUntil(page, () => /body of reveal chat 35/.test(document.getElementById('transcript')?.textContent || ''), null,
    { timeout: 8_000, label: 'deep chat never opened' });

  // 1. Scroll the list away, close the sidebar, reopen → row in view.
  await page.evaluate(() => { document.querySelector('#sidebar .sidebar-content').scrollTop = 0; });
  await page.locator('#sb-toggle').click();
  await pollUntil(page, () => !document.getElementById('sidebar').classList.contains('expanded'), null, { timeout: 3_000, label: 'sidebar did not close' });
  await page.locator('#sb-toggle').click();
  await pollUntil(page, inView, DEEP, { timeout: 5_000, label: 'opening the sidebar did not bring the viewed chat into view' });
  log('open: viewed chat scrolled into view');

  // 2. Scroll away again, hide the row behind the Unread lens, click the title.
  await page.evaluate(() => {
    document.querySelector('#sidebar .sidebar-content').scrollTop = 0;
    document.querySelector('#sess-lens .sess-lens-chip[data-lens="unread"]').click();
  });
  await pollUntil(page, (id) => !document.querySelector(`#sessions-list li[data-chat-id="${id}"]`), DEEP,
    { timeout: 3_000, label: 'Unread lens should hide the viewed (read) chat' });
  const tip = await page.evaluate(() => document.getElementById('header-title')?.getAttribute('title'));
  assert(tip === 'Show in sidebar', `header title tooltip: ${tip}`);
  await page.locator('#header-title').click();
  await pollUntil(page, (id) => !!document.querySelector(`#sessions-list li[data-chat-id="${id}"].sess-reveal`), DEEP,
    { timeout: 3_000, label: 'title click did not flash the row' });
  await pollUntil(page, inView, DEEP, { timeout: 3_000, label: 'title click did not scroll the row into view' });
  const lens = await page.evaluate(() => document.querySelector('#sess-lens .sess-lens-chip.active')?.dataset.lens);
  assert(lens === 'all', `lens should reset to All, got ${lens}`);
  log('title click: lens reset to All, row scrolled into view and flashed ✓');

  // 3. Closed sidebar + title click → opens it and reveals.
  await page.locator('#sb-toggle').click();
  await pollUntil(page, () => !document.getElementById('sidebar').classList.contains('expanded'), null, { timeout: 3_000, label: 'sidebar did not close' });
  await page.locator('#header-title').click();
  await pollUntil(page, (id) => document.getElementById('sidebar').classList.contains('expanded') && !!document.querySelector(`#sessions-list li[data-chat-id="${id}"]`), DEEP,
    { timeout: 3_000, label: 'title click did not open the sidebar' });
  await pollUntil(page, inView, DEEP, { timeout: 3_000, label: 'row not in view after opening via title' });
  log('closed sidebar: title click opens it on the viewed chat ✓');
}
