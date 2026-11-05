// FIELD, Jonathan 2026-11-05: "a vertical shift in the right sidebar when
// I expand and collapse a markdown document … it moved enough for my
// cursor to select an alternate document when I just clicked twice."
//
// Cause: the rail buttons above the document tabs were 38 px tall with
// the drawer open and 30 px collapsed, so the tabs moved 24 px between
// the two states (a tab's pitch is 32 px). A tab click toggles the drawer,
// so click-click selected the neighbour.
//
//   T1  every rail button and every document tab has the same top and
//       height whether the drawer is open or collapsed
//   T2  the real gesture: two clicks at the same point on a tab open and
//       then close the drawer, and the selected document never changes

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'rail-tabs-stay-put';
export const DESCRIPTION = 'Right rail: document tabs and rail buttons keep their position across open/collapse; a double-click on a tab never selects a neighbour';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:rail-stay';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, { title: 'Rail', messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_rs', timestamp: Date.now() / 1000 - 60 }], lastActiveAt: Date.now() });
}

const geo = (page) => page.evaluate(() => {
  const rows = (sel) => Array.from(document.querySelectorAll(sel)).map((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), label: el.title || el.id }; });
  return { open: !document.getElementById('pin-drawer')?.classList.contains('collapsed'), btns: rows('.right-drawer-rail-btn'), tabs: rows('.doc-rail-tab') };
});

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  for (const [i, t] of ['Alpha notes', 'Bravo brief', 'Charlie memo'].entries()) {
    mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title: t, content: `# ${t}\n\n${'text. '.repeat(60)}`, format: 'markdown', path: `/w/stay-${i}.md`, displayed_at: Date.now() - (3 - i) * 1000 });
  }
  await page.waitForFunction(() => document.querySelectorAll('.doc-rail-tab').length === 3, null, { timeout: 5_000 });
  await page.waitForTimeout(400);

  // ── T1 — geometry is identical in both states ───────────────────────
  const a = await geo(page);
  // The Docs rail button: reader in front → the list; list in front →
  // close. Up to two clicks flip the drawer.
  const flip = async () => { for (let i = 0; i < 2; i++) { const was = (await geo(page)).open; await page.evaluate(() => document.getElementById('btn-doc-drawer-rail')?.click()); await page.waitForTimeout(600); if ((await geo(page)).open !== was) return; } };
  await flip();
  const b = await geo(page);
  assert(a.open !== b.open, `T1: the rail button should toggle the drawer (${a.open} → ${b.open})`);
  const same = (x, y) => x.length === y.length && x.every((r, i) => r.top === y[i].top && r.h === y[i].h);
  log(`T1 open=${a.open}: buttons ${a.btns.map((r) => `${r.top}+${r.h}`).join(' ')} tabs ${a.tabs.map((r) => r.top).join(' ')}; open=${b.open}: buttons ${b.btns.map((r) => `${r.top}+${r.h}`).join(' ')} tabs ${b.tabs.map((r) => r.top).join(' ')}`);
  assert(same(a.btns, b.btns), 'T1: rail buttons changed size or position with the drawer state');
  assert(same(a.tabs, b.tabs), 'T1: document tabs moved with the drawer state');

  // ── T2 — the real double-click ──────────────────────────────────────
  // Start open on Alpha, then click Bravo's tab twice at one point.
  if (!b.open) await flip();
  const bravo = await page.evaluate(() => { const t = Array.from(document.querySelectorAll('.doc-rail-tab')).find((x) => /Bravo/.test(x.title)); const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const selected = () => page.evaluate(() => import('/build/rightDrawer/docStore.mjs').then((m) => m.currentDoc()?.title || null));
  await page.mouse.click(bravo.x, bravo.y);          // opens Bravo (drawer open, reader)
  await page.waitForTimeout(600);
  const afterFirst = await selected();
  const openAfterFirst = (await geo(page)).open;
  await page.mouse.click(bravo.x, bravo.y);          // same spot: closes the drawer
  await page.waitForTimeout(600);
  const afterSecond = await selected();
  const openAfterSecond = (await geo(page)).open;
  log(`T2 after click 1: ${afterFirst} (open=${openAfterFirst}); after click 2 at the same point: ${afterSecond} (open=${openAfterSecond})`);
  assert(afterFirst === 'Bravo brief', `T2: first click should select Bravo, got ${afterFirst}`);
  assert(afterSecond === 'Bravo brief', `T2: the second click at the same point selected a different document: ${afterSecond}`);
  assert(openAfterFirst && !openAfterSecond, 'T2: click-click should open then close the drawer');
}
