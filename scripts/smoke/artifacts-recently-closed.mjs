// Recently closed (2026-11-07): "a view across a history of things
// they've created" — kept inside the canvas metaphor: the last ten shelf
// entries the user put away, from the proxy's shelf record, as a
// collapsed section at the foot of the Artifacts list. Not a file
// browser.
//   C1  closing a doc in the reader → the list's foot gains
//       "Recently closed (1)" naming it (after the shelf round-trip)
//   C2  expanding and pressing Reopen puts it back on the shelf, in the
//       reader; the section empties (the proxy drops reopened ids)
//   C3  a clear-all lands every doc there, newest first, cap 10
//
// Polls, never one-shot samples.

import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'artifacts-recently-closed';
export const DESCRIPTION = 'Artifacts list: closed docs appear under a collapsed "Recently closed" section (proxy shelf record), Reopen re-shelves them and removes the row; clear-all fills it newest first';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:recently-closed';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, { title: 'Closed', messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_rc', timestamp: Date.now() / 1000 - 60 }], lastActiveAt: Date.now() });
}

const section = (page) => page.evaluate(() => {
  const s = document.querySelector('#doc-drawer-body .recently-closed');
  return {
    present: !!s,
    label: s?.querySelector('.recently-deleted-label')?.textContent || '',
    rows: Array.from(s?.querySelectorAll('.recently-closed-item .recently-deleted-item-title') || []).map((t) => t.textContent.trim()),
    expanded: s?.querySelector('.recently-deleted-toggle')?.getAttribute('aria-expanded') === 'true',
  };
});

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  const push = (title, i) => mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title, content: `# ${title}\n\n${title.toUpperCase()}-MARK`, format: 'markdown', path: `/w/rc-${i}.md`, displayed_at: Date.now() - (9 - i) * 1000 });
  push('Alpha', 0); push('Bravo', 1); push('Charlie', 2);
  await pollUntil(page, () => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length === 3, null, { timeout: 5_000, label: 'tabs did not arrive' });
  // The proxy only knows a doc was closed once it knew the doc was open:
  // wait for this device's (debounced) shelf push to land before closing.
  await pollUntil(page, () => fetch('/api/parley/docs/shelf').then((r) => r.json()).then((s) => Object.keys(s.docs || {}).length === 3), null, { timeout: 8_000, label: 'the shelf push with the three docs did not land' });
  const openReader = async () => {
    for (let i = 0; i < 3; i++) {
      if (await page.evaluate(() => !!document.querySelector('#doc-drawer-body .doc-drawer-remove') && !document.getElementById('pin-drawer')?.classList.contains('collapsed'))) return;
      await page.evaluate(() => [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')].pop()?.click());
      await page.waitForTimeout(400);
    }
  };
  const openList = async () => {
    for (let i = 0; i < 3; i++) {
      if (await page.evaluate(() => !!document.querySelector('#doc-drawer-body .doc-shelf-toolbar'))) return;
      await page.evaluate(() => document.getElementById('btn-doc-drawer-rail')?.click());
      await page.waitForTimeout(400);
    }
  };

  // ── C1 — close one in the reader ────────────────────────────────────
  await openReader();
  const closing = await page.evaluate(() => document.querySelector('#doc-drawer-body .doc-drawer-title-text')?.textContent.trim());
  await page.click('#doc-drawer-body .doc-drawer-remove');
  await pollUntil(page, () => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length === 2, null, { timeout: 3_000, label: 'C1: close did not take' });
  await openList();
  await pollUntil(page, () => !!document.querySelector('#doc-drawer-body .recently-closed'), null, { timeout: 8_000, label: 'C1: Recently closed section did not appear after the shelf round-trip' });
  const c1 = await section(page);
  log(`C1 closed "${closing}" → ${JSON.stringify(c1)}`);
  assert(/Recently closed \(1\)/.test(c1.label), `C1: expected "Recently closed (1)", got "${c1.label}"`);
  assert(!c1.expanded, 'C1: the section starts collapsed');
  await page.click('#doc-drawer-body .recently-closed .recently-deleted-toggle');
  await pollUntil(page, () => document.querySelector('#doc-drawer-body .recently-closed .recently-deleted-toggle')?.getAttribute('aria-expanded') === 'true', null, { timeout: 2_000, label: 'C1: did not expand' });
  const c1b = await section(page);
  assert(c1b.rows.length === 1 && c1b.rows[0] === closing, `C1: expected the closed doc "${closing}" listed, got ${JSON.stringify(c1b.rows)}`);

  // ── C2 — Reopen ─────────────────────────────────────────────────────
  await page.click('#doc-drawer-body .recently-closed .recently-deleted-restore');
  await pollUntil(page, (t) => document.querySelector('#doc-drawer-body .doc-drawer-title-text')?.textContent.trim() === t && document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length === 3, closing, { timeout: 5_000, label: 'C2: Reopen did not put the doc back in the reader' });
  await openList();
  await pollUntil(page, () => !document.querySelector('#doc-drawer-body .recently-closed'), null, { timeout: 8_000, label: 'C2: the reopened doc should leave Recently closed' });
  log('C2 Reopen re-shelved it and the section emptied ✓');

  // ── C3 — clear all → every doc, newest first ────────────────────────
  await page.click('#pin-drawer-clear');
  await pollUntil(page, () => !document.getElementById('doc-drawer-empty')?.hidden, null, { timeout: 4_000, label: 'C3: clear all did not empty the shelf' });
  // The empty state hosts the section too once the shelf round-trip lands.
  await pollUntil(page, () => /Recently closed \(3\)/.test(document.querySelector('#pin-drawer .recently-closed .recently-deleted-label')?.textContent || ''), null, { timeout: 8_000, label: 'C3: all three should be recently closed' });
  log('C3 clear all → Recently closed (3) ✓');
}
