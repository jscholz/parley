// Design pass 2026-11-07: the Artifacts list (ex "Docs").
//   G1  grouped by Kind by default: a Documents section and a Meetings
//       section, each a list; the rail tab order is Documents then
//       Meetings, in list order
//   G2  Recent flattens to one list in tab order; the choice persists
//       across a reload (per device)
//   G3  the toolbar holds the back link and the Kind | Recent switch
//   K1  ⌘⇧A toggles the Artifacts pane; ⌘⇧E toggles Activity
//       (⌘⇧A used to be Activity — "I want to toggle that bar with my
//       left hand")

import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'artifacts-list-groups';
export const DESCRIPTION = 'Artifacts list: Documents / Meetings sections by default, Recent flattens and persists, tab order follows the sections; ⌘⇧A = Artifacts, ⌘⇧E = Activity';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:artifacts-groups';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, { title: 'Groups', messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_ag', timestamp: Date.now() / 1000 - 60 }], lastActiveAt: Date.now() });
}

const sections = (page) => page.evaluate(() => {
  const body = document.getElementById('doc-drawer-body');
  const out = []; let cur = { label: null, titles: [] };
  for (const el of Array.from(body.children)) {
    if (el.classList.contains('doc-shelf-group')) { if (cur.titles.length || cur.label) out.push(cur); cur = { label: el.textContent.trim(), titles: [] }; }
    else if (el.classList.contains('doc-shelf-list')) { cur.titles.push(...Array.from(el.querySelectorAll('.doc-shelf-item-title')).map((t) => t.textContent.trim())); }
  }
  if (cur.titles.length || cur.label) out.push(cur);
  return { sections: out, tabs: Array.from(document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')).map((t) => t.title.split(' — ')[0]), on: document.querySelector('.doc-shelf-seg-btn.on')?.dataset.group, toolbarHasBack: !!document.querySelector('.doc-shelf-toolbar .doc-shelf-back') };
});

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  const push = (title, extra = {}) => mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title, content: `# ${title}\n\nbody`, format: 'markdown', path: `/w/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`, displayed_at: Date.now(), ...extra });
  push('Alpha plan');
  push('Standup, 4 Nov', { source: 'capture', capture_id: 'cap-ag-1' });
  push('Bravo brief');
  await pollUntil(page, () => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length === 3, null, { timeout: 5_000, label: 'tabs did not arrive' });
  // Open the list view.
  const toList = async () => {
    for (let i = 0; i < 3; i++) {
      if (await page.evaluate(() => !!document.querySelector('.doc-shelf-toolbar'))) return;
      await page.evaluate(() => document.getElementById('btn-doc-drawer-rail')?.click());
      await page.waitForTimeout(400);
    }
  };
  await toList();
  await pollUntil(page, () => !!document.querySelector('.doc-shelf-toolbar'), null, { timeout: 3_000, label: 'list did not show' });

  // ── G1 — Kind by default ────────────────────────────────────────────
  const g1 = await sections(page);
  log(`G1 ${JSON.stringify(g1)}`);
  assert(g1.on === 'kind', `G1: default grouping should be Kind, got ${g1.on}`);
  assert(g1.sections.map((s) => s.label).join('|') === 'Documents|Meetings', `G1: expected Documents then Meetings, got ${g1.sections.map((s) => s.label).join('|')}`);
  assert(g1.sections[0].titles.join('|') === 'Alpha plan|Bravo brief' && g1.sections[1].titles.join('|') === 'Standup, 4 Nov', `G1: wrong rows per section: ${JSON.stringify(g1.sections)}`);
  assert(g1.tabs.join('|') === 'Alpha plan|Bravo brief|Standup, 4 Nov', `G1: rail tabs must read Documents then Meetings in list order, got ${g1.tabs.join('|')}`);
  assert(g1.toolbarHasBack, 'G3: the back link belongs in the toolbar row with the switch');

  // ── G2 — Recent flattens, persists ──────────────────────────────────
  await page.click('.doc-shelf-seg-btn[data-group="recent"]');
  await pollUntil(page, () => document.querySelector('.doc-shelf-seg-btn.on')?.dataset.group === 'recent' && !document.querySelector('.doc-shelf-group'), null, { timeout: 3_000, label: 'G2: Recent did not flatten' });
  const g2 = await sections(page);
  // Recent = the stored (arrival / drag) order, meetings interleaved; the
  // rail tabs read the same order.
  assert(g2.sections.length === 1 && g2.sections[0].label === null && g2.sections[0].titles.join('|') === 'Alpha plan|Standup, 4 Nov|Bravo brief', `G2: Recent should be one flat list in stored order: ${JSON.stringify(g2.sections)}`);
  assert(g2.tabs.join('|') === 'Alpha plan|Standup, 4 Nov|Bravo brief', `G2: rail tabs must follow the flat order, got ${g2.tabs.join('|')}`);
  await page.reload({ waitUntil: 'load' });
  await waitForReady(page);
  await pollUntil(page, () => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length === 3, null, { timeout: 8_000, label: 'G2: tabs did not come back after reload' });
  await toList();
  await pollUntil(page, () => !!document.querySelector('.doc-shelf-toolbar'), null, { timeout: 3_000, label: 'G2: list did not show after reload' });
  const g2b = await sections(page);
  assert(g2b.on === 'recent' && g2b.sections.length === 1, `G2: Recent should persist across a reload: ${JSON.stringify(g2b)}`);
  await page.click('.doc-shelf-seg-btn[data-group="kind"]');
  await pollUntil(page, () => document.querySelectorAll('.doc-shelf-group').length === 2, null, { timeout: 3_000, label: 'G2: Kind did not regroup' });
  log('G2 Recent flattens, persists, Kind regroups ✓');

  // ── K1 — hotkeys ────────────────────────────────────────────────────
  const panel = () => page.evaluate(() => ({
    collapsed: document.getElementById('pin-drawer')?.classList.contains('collapsed'),
    doc: document.getElementById('btn-doc-drawer-rail')?.getAttribute('aria-selected') === 'true',
    activity: document.getElementById('btn-activity-drawer-rail')?.getAttribute('aria-selected') === 'true',
  }));
  await page.evaluate(() => document.getElementById('composer-input')?.focus());
  const before = await panel();
  await page.keyboard.press('Control+Shift+A');
  await page.waitForTimeout(500);
  const afterA = await panel();
  log(`K1 ⌃⇧A: ${JSON.stringify(before)} → ${JSON.stringify(afterA)}`);
  assert(afterA.collapsed !== before.collapsed || afterA.doc !== before.doc, 'K1: ⌘⇧A should toggle the Artifacts pane');
  await page.keyboard.press('Control+Shift+E');
  await page.waitForTimeout(500);
  const afterE = await panel();
  log(`K1 ⌃⇧E: → ${JSON.stringify(afterE)}`);
  assert(afterE.activity && !afterE.collapsed, `K1: ⌘⇧E should open the Activity pane: ${JSON.stringify(afterE)}`);
  const titles = await page.evaluate(() => ({ rail: document.getElementById('btn-doc-drawer-rail')?.getAttribute('aria-label'), label: document.querySelector('#right-drawer-title')?.textContent?.trim() }));
  assert(titles.rail === 'Artifacts', `rail button should be named Artifacts, got ${titles.rail}`);
  log('K1 ⌘⇧A → Artifacts, ⌘⇧E → Activity ✓');
}
