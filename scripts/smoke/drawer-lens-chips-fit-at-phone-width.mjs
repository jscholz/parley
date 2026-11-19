// Drawer lens chips at phone width (field 2026-11-19: "the sidebar on the
// left on mobile is clipped since we added the bubbles underneath the
// filter box" — Drafts read "Dra"). Two causes: the chip row could not
// wrap, and the drawer's content kept a desktop min-width wider than the
// phone drawer. Pins: every chip is inside the drawer's visible box, the
// row has no horizontal overflow, and the drawer's content is no wider
// than the drawer.
import { waitForReady, assert } from './lib.mjs';
export const NAME = 'drawer-lens-chips-fit-at-phone-width';
export const DESCRIPTION = 'lens chips (All · Meetings · Unread · Drafts) are fully visible in the phone drawer, wrapping when they must';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = true;
const OUT = process.env.LENS_SHOTS || '';
export function MOCK_SETUP(mock) {
  for (let i = 0; i < 6; i++) mock.addChat(`parley:lens-${i}`, { title: `Session ${i}`, messages: [{ role: 'user', content: 'seed', parley_id: `s${i}`, timestamp: Date.now() / 1000 - i * 60 }], lastActiveAt: Date.now() - i * 60000 });
}
export default async function run({ page, log }) {
  await waitForReady(page);
  await page.evaluate(() => { document.getElementById('sb-toggle-mobile')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  await page.waitForFunction(() => document.getElementById('sidebar')?.classList.contains('expanded'), null, { timeout: 5000 });
  await page.waitForTimeout(400);
  // The field shape: a count on Unread (widens the chip).
  await page.evaluate(() => { const c = document.querySelector('.sess-lens-chip[data-lens="unread"] .sess-lens-count'); c.textContent = '1'; c.hidden = false; });
  const m = await page.evaluate(() => {
    const row = document.getElementById('sess-lens');
    const sb = document.getElementById('sidebar').getBoundingClientRect();
    const content = document.querySelector('#sidebar .sidebar-content').getBoundingClientRect();
    const chips = Array.from(row.querySelectorAll('.sess-lens-chip')).map((c) => { const r = c.getBoundingClientRect(); return { label: c.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) }; });
    return { sidebarRight: Math.round(sb.right), contentW: Math.round(content.width), sidebarW: Math.round(sb.width), rowClient: row.clientWidth, rowScroll: row.scrollWidth, rows: new Set(chips.map((c) => c.top)).size, chips };
  });
  log(JSON.stringify(m));
  if (OUT) await page.screenshot({ path: `${OUT}/lens-after.png`, clip: { x: 0, y: 0, width: 420, height: 420 } });
  assert(m.chips.length === 4, 'four lens chips');
  for (const c of m.chips) assert(c.right <= m.sidebarRight - 4 && c.left >= 0, `chip "${c.label}" must be inside the drawer (right ${c.right} vs drawer ${m.sidebarRight})`);
  assert(m.rowScroll <= m.rowClient, `the chip row must not overflow horizontally (${m.rowScroll} > ${m.rowClient})`);
  assert(m.contentW <= m.sidebarW, `drawer content must not be wider than the drawer (${m.contentW} > ${m.sidebarW})`);
  log(`chips on ${m.rows} line(s), drawer ${m.sidebarW}px, content ${m.contentW}px ✓`);
}
