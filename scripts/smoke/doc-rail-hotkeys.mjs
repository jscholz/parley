// Rail doc-tab HOTKEYS (2026-08-26): Cmd/Ctrl+1…9 (no Shift — ⌘⇧3/4/5 are macOS screenshot keys the page never receives) select the Nth
// doc tab by current visual order (1 = top), with full click parity —
// including opening the drawer and the active-tab toggle.
//
// The dispatcher matches on e.code ('Digit1'…'Digit9'), NOT e.key:
// shift+digit mangles e.key layout-dependently ('!' on US, '+' on
// German). Playwright's keyboard.press takes the code name directly, so
// this ALSO fails if the implementation regresses to e.key matching
// (layout-mangled keys were the reason the binding matches e.code).
//
// Covered here:
//   1. Ctrl+Digit2 selects the SECOND tab and opens its reader.
//   2. The hotkey fires from inside the composer (modifier combos are
//      not typing — the isShortcut path).
//   3. Hotkey of the doc already in front toggles the drawer closed
//      (click parity); with the drawer closed, the hotkey reopens it.
//   4. A digit with no tab behind it (Digit9, 3 docs open) is NOT
//      claimed — no drawer state change.

import { waitForReady } from './lib.mjs';

export const NAME = 'doc-rail-hotkeys';
export const DESCRIPTION = 'Doc tab hotkeys: Ctrl+Digit_n selects tab n by visual order, works from inputs, click parity';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-doc-rail-hotkeys-chat';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Doc rail hotkeys chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_hotkeys_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  const push = (title, content, path) => mock.pushEnvelope({
    type: 'doc_show', chat_id: CHAT_ID, title, content, format: 'markdown', path,
  });
  push('First doc', '# One\n\nFIRST-MARK', '/w/one.md');
  push('Second doc', '# Two\n\nSECOND-MARK', '/w/two.md');
  push('Third doc', '# Three\n\nTHIRD-MARK', '/w/three.md');
  await page.waitForFunction(
    () => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length === 3,
    null, { timeout: 6000, polling: 50 },
  );

  const readerHas = (mark) => page.waitForFunction(
    (m) => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes(m),
    mark, { timeout: 4000, polling: 50 },
  );
  const drawerOpen = () => page.evaluate(() => document.body.classList.contains('pin-drawer-open'));

  // 1. Second tab via hotkey (reader currently shows Third — the last
  // push activated it).
  await page.keyboard.press('Control+Digit2');
  await readerHas('SECOND-MARK');
  const sel = await page.evaluate(() =>
    [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')]
      .findIndex(t => t.getAttribute('aria-selected') === 'true'));
  if (sel !== 1) throw new Error(`hotkey 2 must select tab index 1, got ${sel}`);
  log('Ctrl+Digit2 selected the second doc');

  // 2. From inside the composer — modifier combos fire even in inputs.
  await page.click('#composer-input');
  await page.keyboard.press('Control+Digit1');
  await readerHas('FIRST-MARK');
  log('hotkey fires with focus in the composer');

  // 3. Click parity: same-doc hotkey with its reader in front toggles
  // the drawer closed; pressing again reopens on the same doc.
  await page.keyboard.press('Control+Digit1');
  await page.waitForFunction(
    () => !document.body.classList.contains('pin-drawer-open'),
    null, { timeout: 4000, polling: 50 },
  );
  await page.keyboard.press('Control+Digit1');
  await page.waitForFunction(
    () => document.body.classList.contains('pin-drawer-open'),
    null, { timeout: 4000, polling: 50 },
  );
  await readerHas('FIRST-MARK');
  log('same-doc hotkey toggles the drawer (click parity)');

  // 4. No tab at position 9 → the keystroke is not claimed; nothing
  // changes.
  const before = await drawerOpen();
  await page.keyboard.press('Control+Digit9');
  await page.waitForTimeout(300);
  if (await drawerOpen() !== before) throw new Error('unmapped digit must not change drawer state');
  log('digit beyond the tab count is left to the browser');
}
