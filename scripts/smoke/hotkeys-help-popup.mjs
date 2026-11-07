// Regression gate for the Cmd+/ (or Ctrl+/) hotkey help modal.
//
// Pure UI: dispatch a keyboard event, assert the <dialog> opens with
// the expected categorical structure, escape closes it. No backend.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'hotkeys-help-popup';
export const DESCRIPTION = 'Cmd+/ opens the keyboard-shortcut reference modal';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await waitForReady(page);

  // Fire the open shortcut at the document level — the listener is
  // wired in main.ts via hotkeysHelp.init(). Use Meta on the test
  // platform unconditionally; the impl listens on both Meta-only (mac)
  // and Ctrl-only (other) so either lands as long as one modifier is
  // exclusive.
  const isMac = await page.evaluate(() =>
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || ''));
  const modifier = isMac ? 'Meta' : 'Control';
  log(`platform=${isMac ? 'mac' : 'other'}; sending ${modifier}+/`);

  await page.keyboard.down(modifier);
  await page.keyboard.press('/');
  await page.keyboard.up(modifier);

  // Wait for the dialog. Playwright treats <dialog open> as visible.
  await page.waitForSelector('dialog.hotkeys-help-dialog[open]', {
    state: 'visible', timeout: 3_000,
  });
  log('dialog opened ✓');

  // Snapshot structure: at least the named categories the user expects
  // to find, and at least a handful of binding rows total.
  const snapshot = await page.evaluate(() => {
    const dlg = document.querySelector('dialog.hotkeys-help-dialog');
    if (!dlg) return null;
    return {
      open: dlg.open,
      headings: Array.from(dlg.querySelectorAll('.hotkeys-help-section h3'))
        .map(h => h.textContent?.trim() || ''),
      rowCount: dlg.querySelectorAll('.hotkeys-help-row').length,
      hasComposerEnter: !!Array.from(dlg.querySelectorAll('.hotkeys-help-row')).find(
        r => /Send message/i.test(r.textContent || ''),
      ),
      hasSlashSlash: !!Array.from(dlg.querySelectorAll('.hotkeys-help-row')).find(
        r => /Open slash-command popover/i.test(r.textContent || ''),
      ),
      hasMessageNav: !!Array.from(dlg.querySelectorAll('.hotkeys-help-row')).find(
        r => /highlight the most recent message/i.test(r.textContent || ''),
      ),
      // 2026-11-07: ⌘⇧A became Artifacts; Activity moved to ⌘⇧E.
      hasActivityDrawer: !!Array.from(dlg.querySelectorAll('.hotkeys-help-row')).find(
        r => /Toggle Artifacts panel/i.test(r.textContent || '') && /⌘⇧A|Ctrl\+Shift\+A/.test(r.textContent || ''),
      ) && !!Array.from(dlg.querySelectorAll('.hotkeys-help-row')).find(
        r => /Toggle Activity panel/i.test(r.textContent || '') && /⌘⇧E|Ctrl\+Shift\+E/.test(r.textContent || ''),
      ),
    };
  });
  assert(snapshot, 'dialog disappeared between waitFor and evaluate');
  log(`headings=${JSON.stringify(snapshot.headings)} rows=${snapshot.rowCount}`);

  // Expected categories (order-insensitive, must all be present).
  const expected = ['Composer', 'Slash menu', 'Message navigation', 'Sessions', 'Voice'];
  for (const want of expected) {
    assert(
      snapshot.headings.includes(want),
      `missing category "${want}" in dialog; got ${JSON.stringify(snapshot.headings)}`,
    );
  }

  assert(snapshot.hasComposerEnter, 'expected a row describing the Send message binding');
  assert(snapshot.hasSlashSlash, 'expected a row describing the slash-popover binding');
  assert(snapshot.hasMessageNav, 'expected a row describing the message-navigation entry binding');
  assert(snapshot.hasActivityDrawer, 'expected rows for the Artifacts (⌘⇧A) and Activity (⌘⇧E) panel hotkeys');
  assert(snapshot.rowCount >= 12, `expected ≥12 binding rows total, got ${snapshot.rowCount}`);
  log('categories + key rows present ✓');

  // Escape closes (built into <dialog>).
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.querySelector('dialog.hotkeys-help-dialog[open]'),
    null,
    { timeout: 2_000 },
  );
  log('Esc closes ✓');

  await page.click('#composer-hotkeys-hint');
  await page.waitForSelector('dialog.hotkeys-help-dialog[open]', {
    state: 'visible', timeout: 3_000,
  });
  log('composer hint opens ✓');
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.querySelector('dialog.hotkeys-help-dialog[open]'),
    null,
    { timeout: 2_000 },
  );

  // Re-opening renders again (not a one-shot).
  await page.keyboard.down(modifier);
  await page.keyboard.press('/');
  await page.keyboard.up(modifier);
  await page.waitForSelector('dialog.hotkeys-help-dialog[open]', {
    state: 'visible', timeout: 3_000,
  });
  log('re-open works ✓');
  await page.keyboard.press('Escape');
}
