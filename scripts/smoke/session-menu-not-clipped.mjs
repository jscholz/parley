// Field nit 2026-10-23: "the info pop-up for the three dots menu in the
// lower left, if I'm low in the scroll bar, is underneath the
// Refresh/Settings box". The row menu now portals to <body> with fixed
// positioning: fully inside the viewport, never under the sidebar's
// bottom box, flipping above the ⋮ when there is no room below.

import { waitForReady, assert, openSidebar } from './lib.mjs';

export const NAME = 'session-menu-not-clipped';
export const DESCRIPTION = 'Session row ⋮ menu near the bottom of a long list stays fully visible and on top of the sidebar footer';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  const now = Date.now();
  for (let i = 0; i < 40; i++) {
    mock.addChat(`mock-menu-clip-${i}`, {
      title: `Long list row ${i}`,
      messages: [{ role: 'user', content: 'seed', parley_id: `umsg_mc_${i}`, timestamp: now / 1000 - 60 - i }],
      lastActiveAt: now - 1000 - i * 1000,
    });
  }
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForFunction(() => document.querySelectorAll('#sidebar .sess-menu-btn').length >= 20, null, { timeout: 8000, polling: 100 });
  // Scroll the list to the very bottom and open the LAST row's menu.
  await page.evaluate(() => {
    const sc = document.querySelector('.sidebar-content');
    sc.scrollTop = sc.scrollHeight;
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#sidebar .sess-menu-btn'));
    const last = btns[btns.length - 1];
    last.scrollIntoView({ block: 'end' });
    last.click();
  });
  await page.waitForSelector('.sess-menu', { timeout: 3000 });
  const anchorVisible = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#sidebar .sess-menu-btn'));
    const r = btns[btns.length - 1].getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  });
  assert(anchorVisible, 'the last row must be on screen for this test to mean anything');
  const geo = await page.evaluate(() => {
    const m = document.querySelector('.sess-menu');
    const r = m.getBoundingClientRect();
    const info = Array.from(m.querySelectorAll('button')).find((b) => b.textContent === 'Info');
    const ir = info.getBoundingClientRect();
    const hit = document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2);
    const del = Array.from(m.querySelectorAll('button')).find((b) => b.textContent === 'Delete');
    const dr = del.getBoundingClientRect();
    const hitDel = document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2);
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
      vw: innerWidth, vh: innerHeight,
      infoOnTop: hit === info, deleteOnTop: hitDel === del,
      parentIsBody: m.parentElement === document.body,
    };
  });
  assert(geo.parentIsBody, 'menu must be portaled to <body>');
  assert(geo.top >= 0 && geo.bottom <= geo.vh && geo.left >= 0 && geo.right <= geo.vw,
    `menu must sit fully inside the viewport: ${JSON.stringify(geo)}`);
  assert(geo.infoOnTop && geo.deleteOnTop, `every item must be on top (not under the sidebar footer): ${JSON.stringify(geo)}`);
  log(`bottom-row menu fully visible and on top (${geo.top}→${geo.bottom} of ${geo.vh}) ✓`);

  // Scrolling the list closes it (its anchor moved); a tap outside closes it too.
  await page.evaluate(() => { document.querySelector('.sidebar-content').scrollTop -= 100; });
  await page.waitForFunction(() => !document.querySelector('.sess-menu'), null, { timeout: 2000 });
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#sidebar .sess-menu-btn'));
    btns[0].click();
  });
  await page.waitForSelector('.sess-menu', { timeout: 3000 });
  await page.mouse.click(Math.round(geo.vw * 0.75), Math.round(geo.vh * 0.5));
  await page.waitForFunction(() => !document.querySelector('.sess-menu'), null, { timeout: 2000 });
  log('menu closes on list scroll and on outside click ✓');
}
