// Field nits 2026-10-22: (1) the drawer-header "Clear all" belongs to the
// all-docs LIST only — never the reader; (2) closing a doc (reader ×, list
// row ✕) or clearing the shelf offers a temporary Undo in an in-flow bar
// at the top of the Docs panel, which restores exactly what went away.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'doc-close-undo';
export const DESCRIPTION = 'Docs panel: Clear all only in the list view; close / clear-all show an in-flow Undo bar that restores the doc(s)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-doc-close-undo';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Doc close undo', lastActiveAt: Date.now() - 1000,
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_dcu_seed', timestamp: Date.now() / 1000 - 60 }],
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  const push = (title, mark, path) => mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT_ID, title, content: `# ${title}\n\n${mark}`, format: 'markdown', path });
  const shows = (mark) => page.waitForFunction((m) => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes(m), mark, { timeout: 6000, polling: 50 });
  const tabs = () => page.evaluate(() => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length);
  const bar = () => page.evaluate(() => {
    const b = document.querySelector('#doc-drawer-panel .doc-undo-bar');
    const r = b?.getBoundingClientRect();
    return { hidden: !b || b.hidden, text: b?.querySelector('.doc-undo-text')?.textContent ?? '', bottom: r?.bottom ?? 0 };
  });
  const clearBtn = () => page.evaluate(() => { const b = document.getElementById('pin-drawer-clear'); return { hidden: !b || b.hidden, display: b ? getComputedStyle(b).display : 'none' }; });

  push('Alpha', 'ALPHA-MARK', '/w/alpha.md'); await shows('ALPHA-MARK');
  push('Bravo', 'BRAVO-MARK', '/w/bravo.md'); await shows('BRAVO-MARK');
  // Drawer on screen with Bravo's reader up (the push may already have
  // auto-opened it — clicking the active tab then would toggle it shut).
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(() => document.body.classList.contains('pin-drawer-open'));
    if (open) break;
    await page.evaluate(() => [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')].pop()?.click());
    await page.waitForTimeout(300);
  }
  await page.waitForFunction(() => document.body.classList.contains('pin-drawer-open')
    && document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('BRAVO-MARK'), null, { timeout: 4000 });
  await page.waitForTimeout(350);

  // 1. Reader: no Clear all.
  const inReader = await clearBtn();
  assert(inReader.hidden && inReader.display === 'none', `Clear all must be hidden in the reader: ${JSON.stringify(inReader)}`);
  assert((await bar()).hidden, 'no Undo bar before anything is closed');
  log('reader: Clear all hidden ✓');

  // 2. Reader × → Undo bar names the doc, sits above the content, Undo restores it.
  await page.evaluate(() => document.querySelector('#doc-drawer-body .doc-drawer-remove').click());
  await shows('ALPHA-MARK');
  assert(await tabs() === 1, 'Bravo closed');
  const b1 = await bar();
  assert(!b1.hidden && /Closed "Bravo"/.test(b1.text), `Undo bar should name the closed doc: ${JSON.stringify(b1)}`);
  const geo = await page.evaluate(() => {
    const b = document.querySelector('#doc-drawer-panel .doc-undo-bar').getBoundingClientRect();
    const h = document.querySelector('#doc-drawer-body .doc-drawer-header, #doc-drawer-body .doc-drawer-content').getBoundingClientRect();
    return { barBottom: Math.round(b.bottom), contentTop: Math.round(h.top) };
  });
  assert(geo.barBottom <= geo.contentTop, `the bar must sit ABOVE the content, not over it: ${JSON.stringify(geo)}`);
  await page.evaluate(() => document.querySelector('#doc-drawer-panel .doc-undo-action').click());
  await shows('BRAVO-MARK');
  assert(await tabs() === 2, 'Undo re-shelves Bravo');
  assert((await bar()).hidden, 'Undo hides the bar');
  const sel = await page.evaluate(() => [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')].map((t) => t.getAttribute('aria-selected')));
  assert(sel[1] === 'true', `restored doc's tab is selected again: ${JSON.stringify(sel)}`);
  log('reader ×: Undo bar above content; Undo restores Bravo in the reader ✓');

  // 3. List view: Clear all visible; row ✕ → Undo restores into the list.
  await page.click('#btn-doc-drawer-rail');
  await page.waitForFunction(() => document.querySelectorAll('#doc-drawer-body .doc-shelf-item').length === 2, null, { timeout: 4000, polling: 50 });
  const inList = await clearBtn();
  assert(!inList.hidden && inList.display !== 'none', `Clear all must show in the list: ${JSON.stringify(inList)}`);
  await page.evaluate(() => document.querySelector('#doc-drawer-body .doc-shelf-item .doc-shelf-item-close').click());
  await page.waitForFunction(() => document.querySelectorAll('#doc-drawer-body .doc-shelf-item').length === 1, null, { timeout: 4000, polling: 50 });
  assert(!(await bar()).hidden, 'row ✕ offers Undo');
  await page.evaluate(() => document.querySelector('#doc-drawer-panel .doc-undo-action').click());
  await page.waitForFunction(() => document.querySelectorAll('#doc-drawer-body .doc-shelf-item').length === 2, null, { timeout: 4000, polling: 50 });
  log('list ✕: Undo restores the row, list stays ✓');

  // 4. Clear all → empty state + "Closed 2 documents" → Undo brings both back.
  await page.click('#pin-drawer-clear');
  await page.waitForFunction(() => !document.getElementById('doc-drawer-empty')?.hidden, null, { timeout: 4000, polling: 50 });
  assert(await tabs() === 0, 'shelf cleared');
  const b2 = await bar();
  assert(!b2.hidden && /Closed 2 documents/.test(b2.text), `clear-all Undo bar: ${JSON.stringify(b2)}`);
  const geo2 = await page.evaluate(() => {
    const b = document.querySelector('#doc-drawer-panel .doc-undo-bar').getBoundingClientRect();
    const e = document.getElementById('doc-drawer-empty').getBoundingClientRect();
    return { barBottom: Math.round(b.bottom), emptyTop: Math.round(e.top) };
  });
  assert(geo2.barBottom <= geo2.emptyTop, `the bar must sit above the empty state: ${JSON.stringify(geo2)}`);
  await page.evaluate(() => document.querySelector('#doc-drawer-panel .doc-undo-action').click());
  await page.waitForFunction(() => document.querySelectorAll('#doc-drawer-body .doc-shelf-item').length === 2, null, { timeout: 4000, polling: 50 });
  assert(await tabs() === 2, 'both tabs back');
  assert((await bar()).hidden, 'bar gone after Undo');
  log('Clear all: Undo restores both docs into the list ✓');
}
