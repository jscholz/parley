// Rail DOC TABS (2026-08-26): browser-style tabs in the right-drawer
// rail, one per open document, below the three view-toggle buttons.
//
// Covered here:
//   1. One tab per doc, INSERTION order (not the shelf's newest-first),
//      with the group divider visible.
//   2. Glyph anatomy: format suffix inside the file outline for plain
//      docs; capture docs keep the record glyph and get NO suffix.
//   3. Click switches the reader + active state (aria-selected) tracks.
//   4. Clicking the ACTIVE doc's tab with its reader up toggles the
//      drawer closed; clicking again reopens it.
//   5. The generic Docs rail button now opens the LIST view (management
//      home) — the tabs are the reader entry points.
//   6. Rail honesty (field report 2026-08-26): the reader carries NO
//      `‹ All docs` breadcrumb, and while the LIST view is showing the
//      Docs rail button is the selected element with ZERO doc tabs
//      aria-selected; selecting a doc from the list restores its tab's
//      tint.

import { waitForReady } from './lib.mjs';

export const NAME = 'doc-rail-tabs';
export const DESCRIPTION = 'Rail doc tabs: per-doc tabs render in insertion order, click switches reader, active-tab toggle, Docs button opens list view';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-doc-rail-tabs-chat';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Doc rail tabs chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_tabs_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  const push = (title, content, path, format = 'markdown', extra = {}) => mock.pushEnvelope({
    type: 'doc_show', chat_id: CHAT_ID, title, content, format, path, ...extra,
  });

  push('Alpha doc', '# Alpha\n\nALPHA-MARK', '/w/alpha.md');
  push('Bravo doc', 'BRAVO-MARK', '/w/bravo.txt', 'text');
  push('Meeting: standup', '# Standup\n\nCAP-MARK', '/cap/standup.md', 'markdown',
    { source: 'capture', capture_id: 'cap-tabs-1' });

  // 1. Three tabs, insertion order — even though the SHELF (listDocs)
  // is newest-first, the tab strip must read top-to-bottom in the order
  // the docs were opened.
  await page.waitForFunction(
    () => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length === 3,
    null, { timeout: 6000, polling: 50 },
  );
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')].map(t => t.getAttribute('aria-label')));
  if (JSON.stringify(labels) !== JSON.stringify(['Alpha doc', 'Bravo doc', 'Meeting: standup'])) {
    throw new Error(`tabs must render in insertion order, got ${JSON.stringify(labels)}`);
  }
  const dividerHidden = await page.evaluate(() =>
    document.getElementById('doc-rail-divider')?.hidden);
  if (dividerHidden !== false) throw new Error('group divider must be visible when docs are open');
  log('three tabs in insertion order, divider visible');

  // 2. Glyph anatomy: suffix text inside the outline for plain docs;
  // record glyph and NO suffix for the capture doc.
  const anatomy = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')];
    return tabs.map(t => ({
      suffix: t.querySelector('svg text')?.textContent ?? null,
      capture: !!t.querySelector('.doc-capture-glyph'),
    }));
  });
  if (anatomy[0].suffix !== 'md' || anatomy[1].suffix !== 'txt') {
    throw new Error(`plain tabs must carry format suffixes, got ${JSON.stringify(anatomy)}`);
  }
  if (!anatomy[2].capture || anatomy[2].suffix !== null) {
    throw new Error(`capture tab must keep the record glyph with no suffix, got ${JSON.stringify(anatomy)}`);
  }
  log('glyph anatomy correct (md/txt suffixes; capture record glyph, no suffix)');

  // 3. The last push auto-opened the reader on the capture doc; the
  // capture tab must be the selected one. Click the FIRST tab → reader
  // switches to Alpha and selection follows.
  const selected = () => page.evaluate(() =>
    [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')]
      .findIndex(t => t.getAttribute('aria-selected') === 'true'));
  if (await selected() !== 2) throw new Error(`capture tab should start selected, got index ${await selected()}`);
  await page.click('#doc-rail-tabs .doc-rail-tab:nth-child(1)');
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('ALPHA-MARK'),
    null, { timeout: 4000, polling: 50 },
  );
  if (await selected() !== 0) throw new Error('clicked tab must become aria-selected');
  log('tab click switches the reader; active state tracks');

  // 6a. Breadcrumb GONE from the reader (2026-08-26: "the 'all docs'
  // link … feels like it's doing that in the current tab since there's
  // no panel tint highlight change") — the rail button/+N chip are the
  // list entries now.
  const crumb = await page.evaluate(() => !!document.querySelector('.doc-drawer-listbtn'));
  if (crumb) throw new Error('reader must not render the `‹ All docs` breadcrumb (removed 2026-08-26)');
  log('reader carries no All-docs breadcrumb');

  // 4. Active-tab toggle: clicking Alpha's tab again (reader up, drawer
  // open) closes the drawer; a third click reopens it on the same doc.
  const drawerOpen = () => page.evaluate(() => document.body.classList.contains('pin-drawer-open'));
  if (!(await drawerOpen())) throw new Error('drawer should be open after the tab click');
  await page.click('#doc-rail-tabs .doc-rail-tab:nth-child(1)');
  await page.waitForFunction(
    () => !document.body.classList.contains('pin-drawer-open'),
    null, { timeout: 4000, polling: 50 },
  );
  await page.click('#doc-rail-tabs .doc-rail-tab:nth-child(1)');
  await page.waitForFunction(
    () => document.body.classList.contains('pin-drawer-open')
      && document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('ALPHA-MARK'),
    null, { timeout: 4000, polling: 50 },
  );
  log('active-tab click toggles the drawer closed/open (rail-toggle semantics)');

  // 5. The generic Docs rail button opens the LIST view now (the tabs
  // took over per-doc reader entry; management — Clear all — lives in
  // the list).
  await page.click('#btn-doc-drawer-rail');   // active doc panel open → closes
  await page.waitForFunction(
    () => !document.body.classList.contains('pin-drawer-open'),
    null, { timeout: 4000, polling: 50 },
  );
  await page.click('#btn-doc-drawer-rail');   // reopen → list view
  await page.waitForFunction(
    () => document.querySelectorAll('#doc-drawer-body .doc-shelf-item').length === 3,
    null, { timeout: 4000, polling: 50 },
  );
  log('generic Docs rail button opens the list view');

  // 6b. Rail honesty in LIST view: the Docs button carries the selected
  // tint and NO doc tab does — a tinted tab would claim a reader that
  // isn't showing (the exact lie the field report called out).
  const listState = await page.evaluate(() => ({
    docsBtnSelected: document.getElementById('btn-doc-drawer-rail')?.getAttribute('aria-selected'),
    tintedTabs: document.querySelectorAll('#doc-rail-tabs .doc-rail-tab[aria-selected="true"]').length,
  }));
  if (listState.docsBtnSelected !== 'true') {
    throw new Error(`list view: Docs rail button must be aria-selected, got ${listState.docsBtnSelected}`);
  }
  if (listState.tintedTabs !== 0) {
    throw new Error(`list view: no doc tab may be aria-selected, got ${listState.tintedTabs}`);
  }
  log('list view: Docs button selected, zero tabs tinted');

  // 6c. Back to a reader (tab click from the list) → that tab re-tints.
  await page.click('#doc-rail-tabs .doc-rail-tab:nth-child(2)');
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('BRAVO-MARK'),
    null, { timeout: 4000, polling: 50 },
  );
  if (await selected() !== 1) throw new Error('reader via tab click must restore the tab tint');
  log('reader restores the active tab tint');
}
