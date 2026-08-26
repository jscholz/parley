// Doc shelf v2 (design: parley-docs-panel-ux-research-2026-07-07.md):
// multiple agent-pushed docs coexist on a shelf (list + single reader).
//
// Covered here:
//   1. Two doc_show pushes with different paths → shelf holds BOTH;
//      reader shows the newest.
//   2. Re-push of the FIRST path with new content → replaces in place
//      (no duplicate), becomes active — latest-wins per document.
//   3. List view (via the Docs rail button — the reader's breadcrumb was
//      removed 2026-08-26) → rows for both; tapping the other row
//      switches the reader.
//   4. Per-row ✕ removes a doc; reader falls back to the remaining one.
//   5. Download button present in the reader header.

import { waitForReady } from './lib.mjs';

export const NAME = 'doc-shelf-multi-doc';
export const DESCRIPTION = 'Doc shelf: multi-doc coexistence, path-identity re-push, list switching, per-doc close';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-doc-shelf-chat';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Doc shelf chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_shelf_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  const push = (title, content, path) => mock.pushEnvelope({
    type: 'doc_show', chat_id: CHAT_ID, title, content, format: 'markdown', path,
  });

  // Shelf size observable: one rail tab per doc (the reader's
  // `‹ All docs (n)` count label was removed with the breadcrumb,
  // 2026-08-26 — the tab strip is the always-visible count now).
  const tabCount = () => page.evaluate(
    () => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length,
  );
  // List entry: the Docs rail button. With the doc panel already in
  // front it TOGGLES (close), so a reader-first state needs the
  // close+reopen dance the doc-rail-tabs smoke documents.
  const openListView = async () => {
    for (let i = 0; i < 2; i++) {
      await page.click('#btn-doc-drawer-rail');
      const showing = await page.evaluate(() => {
        const panel = document.getElementById('doc-drawer-panel');
        return !!panel && !panel.hidden && panel.getClientRects().length > 0
          && !!document.querySelector('#doc-drawer-body .doc-shelf-list');
      });
      if (showing) return;
    }
    throw new Error('Docs rail button did not reach the list view');
  };

  // 1. Two docs, different paths.
  push('Deck outline', '# Deck\n\nDECK-V1-MARK', '/w/deck.md');
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('DECK-V1-MARK'),
    null, { timeout: 6000, polling: 50 },
  );
  push('Meeting notes', '# Notes\n\nNOTES-MARK', '/w/notes.md');
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('NOTES-MARK'),
    null, { timeout: 6000, polling: 50 },
  );
  const count1 = await tabCount();
  if (count1 !== 2) throw new Error(`expected 2 docs on shelf, rail shows ${count1} tabs`);
  log('two docs coexist; reader shows the newest');

  // 2. Re-push first path → replaces in place, activates, still 2 docs.
  push('Deck outline', '# Deck\n\nDECK-V2-MARK', '/w/deck.md');
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('DECK-V2-MARK'),
    null, { timeout: 6000, polling: 50 },
  );
  const count2 = await tabCount();
  if (count2 !== 2) throw new Error(`re-push must not duplicate — rail shows ${count2} tabs`);
  log('same-path re-push replaced in place (no duplicate), refreshed content');

  // 3. List view: two rows; switch to the other doc.
  await openListView();
  await page.waitForSelector('.doc-shelf-item', { timeout: 4000 });
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.doc-shelf-item-title')].map(el => el.textContent));
  if (rows.length !== 2) throw new Error(`expected 2 list rows, got ${JSON.stringify(rows)}`);
  // Tap the non-active row (Meeting notes).
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.doc-shelf-item')];
    const other = items.find(li => !li.classList.contains('active'));
    other?.querySelector('.doc-shelf-item-main')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('NOTES-MARK'),
    null, { timeout: 4000, polling: 50 },
  );
  log('list view switches the reader');

  // 4. Remove the active doc via the list ✕ → reader falls back.
  await openListView();
  await page.waitForSelector('.doc-shelf-item', { timeout: 4000 });
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.doc-shelf-item')];
    const active = items.find(li => li.classList.contains('active'));
    active?.querySelector('.doc-shelf-item-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // Removal keeps you in the list (you might prune more) — the list
  // shrinks to one row and the removed doc's row is gone.
  await page.waitForFunction(
    () => document.querySelectorAll('.doc-shelf-item').length === 1,
    null, { timeout: 4000, polling: 50 },
  );
  log('per-doc close removed the entry from the list');

  // 5. Back to the reader → fallback doc renders + Download affordance.
  await page.click('.doc-shelf-back');
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('DECK-V2-MARK'),
    null, { timeout: 4000, polling: 50 },
  );
  await page.waitForSelector('.doc-drawer-download', { timeout: 4000 });
  log('reader fell back to remaining doc; download button present');
}
