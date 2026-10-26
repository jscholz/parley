// Docs shelf sync (2026-10-24). Field: "it confuses me to have different
// write panel documents and meetings open between my laptop and CAP, and
// having them synchronized would be useful." The open set + tab order
// live on the proxy; every device converges on it.
//   (a) a doc_show on THIS device → the shelf record gains it (outbound);
//   (b) the OTHER device opens a doc this one never received → it
//       appears here, content fetched from the proxy's doc cache, no
//       unread dot, reader stays where it was (inbound open);
//   (c0) a doc the shelf never knew survives a remote write and goes up (merge, not intersect);
//   (c) the other device closes a doc this device has SEEN on the shelf → it closes here;
//   (d) closing a doc here → gone from the shelf record (outbound close).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'doc-shelf-sync';
export const DESCRIPTION = 'Docs shelf is shared across devices: local opens/closes update the proxy shelf; remote opens/closes apply here with content from the doc cache';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-doc-shelf-sync-chat';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Shelf sync chat', lastActiveAt: Date.now() - 1000,
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_dss_seed', timestamp: Date.now() / 1000 - 60 }],
  });
}

async function until(fn, ms, every = 100) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  return v;
}
const tabTitles = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')).map((t) => t.getAttribute('aria-label')));

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // (a) outbound: an agent push here lands in the shelf record.
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT_ID, title: 'Alpha doc', content: '# Alpha\n\nALPHA-MARK', format: 'markdown', path: '/w/alpha.md' });
  await page.waitForFunction(() => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('ALPHA-MARK'), null, { timeout: 6000, polling: 50 });
  const alphaId = mock.docIdFor('/w/alpha.md', 'Alpha doc');
  const shelfA = await until(() => { const s = mock.getDocShelf(); return s.docs[alphaId] ? s : null; }, 5000);
  assert(shelfA, `the shelf record must gain the local doc within the debounce (${JSON.stringify(mock.getDocShelf())})`);
  assert(shelfA.order[0] === alphaId && shelfA.docs[alphaId].title === 'Alpha doc', `shelf carries order + metadata: ${JSON.stringify(shelfA)}`);
  log(`outbound: local doc_show → shelf v${shelfA.version} ✓`);

  // (b) inbound: the other device opened Bravo (never pushed to us).
  const bravoId = mock.seedDoc({ title: 'Bravo doc', content: '# Bravo\n\nBRAVO-MARK', format: 'markdown', path: '/w/bravo.md', chat_id: CHAT_ID });
  const dotBefore = await page.evaluate(() => !document.getElementById('doc-drawer-dot-rail')?.hidden);
  mock.setDocShelf({
    by: 'other-device',
    order: [alphaId, bravoId],
    docs: [shelfA.docs[alphaId], { id: bravoId, title: 'Bravo doc', path: '/w/bravo.md', format: 'markdown', chatId: CHAT_ID, updatedAt: Date.now() }],
  });
  const tabsB = await until(async () => { const t = await tabTitles(page); return t.includes('Bravo doc') ? t : null; }, 6000);
  assert(tabsB && tabsB.join(',') === 'Alpha doc,Bravo doc', `remote open must appear here in shelf order (got ${JSON.stringify(tabsB)})`);
  const reader = await page.evaluate(() => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent || '');
  assert(/ALPHA-MARK/.test(reader), 'the reader stays on the doc this device was reading');
  const dotAfter = await page.evaluate(() => !document.getElementById('doc-drawer-dot-rail')?.hidden);
  assert(dotAfter === dotBefore, `a synced open is not an unread push (dot before=${dotBefore} after=${dotAfter})`);
  const bravoBody = await page.evaluate(async () => {
    const mod = await import('/build/rightDrawer/docStore.mjs');
    return mod.listDocs().find((d) => d.title === 'Bravo doc')?.content || '';
  });
  assert(/BRAVO-MARK/.test(bravoBody), 'content came from the doc cache');
  log('inbound: remote open → tab here, content fetched, reader untouched, no dot ✓');

  // (c0) MERGE, not intersect (field 2026-10-24: the CAP closed a bunch of
  // docs on first contact): a doc opened here that the shelf has NEVER
  // known must survive a remote write that lacks it, and go up.
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT_ID, title: 'Charlie doc', content: '# Charlie\n\nCHARLIE-MARK', format: 'markdown', path: '/w/charlie.md' });
  await page.waitForFunction(() => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('CHARLIE-MARK'), null, { timeout: 6000, polling: 50 });
  const charlieId = mock.docIdFor('/w/charlie.md', 'Charlie doc');
  // The other device writes the shelf before our debounced push lands — without Charlie.
  const shelfB0 = mock.getDocShelf();
  mock.setDocShelf({ by: 'other-device', order: [alphaId, bravoId], docs: [shelfB0.docs[alphaId] || shelfA.docs[alphaId], shelfB0.docs[bravoId] || { id: bravoId, title: 'Bravo doc', path: '/w/bravo.md', format: 'markdown', chatId: CHAT_ID, updatedAt: Date.now() }] });
  await page.waitForTimeout(600);
  const tabsC0 = await tabTitles(page);
  assert(tabsC0.includes('Charlie doc'), `a doc the shelf never knew must NOT be closed by a remote write (got ${JSON.stringify(tabsC0)})`);
  const shelfC0 = await until(() => { const s = mock.getDocShelf(); return s.docs[charlieId] ? s : null; }, 6000);
  assert(shelfC0, `…and it must be contributed to the shelf (${JSON.stringify(mock.getDocShelf().order)})`);
  log('merge: local-only doc survives a remote write and goes up ✓');

  // (c) close-sync: the other device closed Alpha — a doc this device
  // has SEEN on the shelf — so it closes here. Charlie stays.
  const shelfB = mock.getDocShelf();
  mock.setDocShelf({ by: 'other-device', order: [bravoId, charlieId], docs: [shelfB.docs[bravoId], shelfB.docs[charlieId]] });
  const tabsC = await until(async () => { const t = await tabTitles(page); return !t.includes('Alpha doc') ? t : null; }, 6000);
  assert(tabsC && tabsC.join(',') === 'Bravo doc,Charlie doc', `remote close of a KNOWN doc closes here, nothing else moves (got ${JSON.stringify(tabsC)})`);
  log('close-sync: remote close of a known doc → closed here ✓');
  // …and it is undoable here too (field 2026-10-26): the pop-up names the
  // other device; a click on its body dismisses it (the undo path itself is
  // the same restoreDocs the local close uses).
  const remoteUndo = await page.evaluate(() => { const b = document.querySelector('#doc-drawer-panel .doc-undo-bar'); return { hidden: !b || b.hidden, text: b?.querySelector('.doc-undo-text')?.textContent || '' }; });
  assert(!remoteUndo.hidden && /Closed "Alpha doc" on another device/.test(remoteUndo.text), `remote close offers Undo: ${JSON.stringify(remoteUndo)}`);
  await page.evaluate(() => document.querySelector('#doc-drawer-panel .doc-undo-text').click());
  log('remote close → Undo offered ✓');

  // Charlie is closed here before (d) so the empty-shelf assertion holds.
  await page.evaluate(() => { const t = [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')].find((x) => x.getAttribute('aria-label') === 'Charlie doc'); t?.click(); });
  await page.waitForFunction(() => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('CHARLIE-MARK'), null, { timeout: 4000, polling: 50 });
  await page.evaluate(() => document.querySelector('#doc-drawer-body .doc-drawer-remove').click());
  await until(() => { const s = mock.getDocShelf(); return !s.docs[charlieId] ? s : null; }, 5000);

  // (d) outbound close: closing Bravo here empties the shelf record.
  await page.waitForFunction(() => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('BRAVO-MARK'), null, { timeout: 4000, polling: 50 });
  await page.evaluate(() => document.querySelector('#doc-drawer-body .doc-drawer-remove').click());
  const shelfD = await until(() => { const s = mock.getDocShelf(); return !s.docs[bravoId] ? s : null; }, 5000);
  assert(shelfD && shelfD.order.length === 0, `local close must reach the shelf record (${JSON.stringify(mock.getDocShelf())})`);
  log(`outbound close: shelf v${shelfD.version} empty ✓`);
}
