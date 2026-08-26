// Rail doc-tab DRAG-REORDER (2026-08-26): tabs reorder by drag
// (SortableJS, same vendored bundle as the pinned-session rows), the
// order persists in docStore's localStorage snapshot, and the ⌘⇧n
// hotkeys follow the new VISUAL order (browser semantics — a deliberate
// reorder renumbers).
//
// Covered here:
//   1. Real mouse drag: top tab dragged below the second → DOM order
//      flips.
//   2. The order survives a reload (persisted `order` field).
//   3. Hotkey 1 selects the doc NOW at the top (the formerly-second
//      one) — numbering follows visual order, not push order.
//   4. The list view rows show the same (reordered) sequence.

import { waitForReady } from './lib.mjs';

export const NAME = 'doc-rail-reorder';
export const DESCRIPTION = 'Doc tab drag-reorder: DOM order flips, persists across reload, hotkeys follow visual order, list view agrees';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-doc-rail-reorder-chat';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Doc rail reorder chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_reorder_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

const tabLabels = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')].map(t => t.getAttribute('aria-label')));

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  const push = (title, content, path) => mock.pushEnvelope({
    type: 'doc_show', chat_id: CHAT_ID, title, content, format: 'markdown', path,
  });
  push('Alpha', '# A\n\nALPHA-MARK', '/w/a.md');
  push('Bravo', '# B\n\nBRAVO-MARK', '/w/b.md');
  push('Charlie', '# C\n\nCHARLIE-MARK', '/w/c.md');
  await page.waitForFunction(
    () => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length === 3,
    null, { timeout: 6000, polling: 50 },
  );
  if (JSON.stringify(await tabLabels(page)) !== JSON.stringify(['Alpha', 'Bravo', 'Charlie'])) {
    throw new Error(`precondition: insertion order, got ${JSON.stringify(await tabLabels(page))}`);
  }

  // Wait for the lazily-loaded Sortable to attach before dragging —
  // the bundle import races the first render.
  await page.waitForTimeout(600);

  // 1. Drag Alpha (top) below Bravo. Sortable runs in forceFallback
  // mode with fallbackTolerance 4 and no mouse delay, so a plain
  // down-move-up with intermediate steps engages it.
  const first = await page.locator('#doc-rail-tabs .doc-rail-tab').first().boundingBox();
  if (!first) throw new Error('no bounding box for the first tab');
  const startX = first.x + first.width / 2;
  const startY = first.y + first.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Step through the second tab's slot to just past its center (tab
  // pitch = height + 2px gap) so Sortable commits one swap.
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(startX, startY + ((first.height + 8) * i) / 8, { steps: 2 });
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForFunction(
    () => [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')]
      .map(t => t.getAttribute('aria-label')).join(',') === 'Bravo,Alpha,Charlie',
    null, { timeout: 4000, polling: 50 },
  );
  log('drag moved Alpha below Bravo');

  // 2. Reload → the persisted order (not push order) hydrates.
  await page.reload();
  await waitForReady(page);
  await page.waitForFunction(
    () => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length === 3,
    null, { timeout: 6000, polling: 50 },
  );
  const after = await tabLabels(page);
  if (JSON.stringify(after) !== JSON.stringify(['Bravo', 'Alpha', 'Charlie'])) {
    throw new Error(`reorder must survive reload, got ${JSON.stringify(after)}`);
  }
  log('reorder survived a reload');

  // 3. Hotkey numbering follows the new visual order: position 1 is
  // Bravo now.
  await page.keyboard.press('Control+Digit1');
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('BRAVO-MARK'),
    null, { timeout: 4000, polling: 50 },
  );
  log('hotkey 1 selected the doc now at the top');

  // 4. List view shows the same sequence (one order everywhere).
  await page.click('.doc-drawer-listbtn');
  await page.waitForSelector('.doc-shelf-item', { timeout: 4000 });
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.doc-shelf-item-title')].map(el => el.textContent));
  if (JSON.stringify(rows) !== JSON.stringify(['Bravo', 'Alpha', 'Charlie'])) {
    throw new Error(`list view must mirror tab order, got ${JSON.stringify(rows)}`);
  }
  log('list view rows mirror the tab order');
}
