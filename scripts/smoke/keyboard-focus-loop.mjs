// Keyboard loop between picking a session and replying in it
// (his ask, 2026-08-27: "hotkeys to focus the composer, and to focus the
// session sidebar... pressing enter while in session focus should take
// to composer in that session").
//
// The three moves, and why each is asserted the way it is:
//   - Enter (bare, not typing) drops into the composer. The value of
//     this is that ↑/↓ session navigation is ALREADY live whenever focus
//     is outside a text field, so Enter/Esc are the only two moves that
//     were missing. Asserted end-to-end: navigate with arrows, press
//     Enter, type, and check the text landed in the composer of the
//     session the arrows selected — not merely that focus moved.
//   - Esc goes back out, so ↑/↓ resume moving between sessions. Asserted
//     by pressing Esc and then ACTUALLY ARROWING to a different session,
//     which is the thing that was broken while the composer held focus.
//   - The two configurable bindings do the same from anywhere, including
//     from inside a text field (that is what they are for).
//
// Enter is heavily overloaded, so the negative cases matter as much as
// the positive ones: a focused button must keep Enter, and an open
// overlay must keep Enter. Both are asserted below — without them this
// feature would quietly break dialogs.
import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'keyboard-focus-loop';
export const DESCRIPTION = 'Enter/Esc + hotkeys move focus between the session list and the composer';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'parley:kbd-focus-a';
const CHAT_B = 'parley:kbd-focus-b';

export function MOCK_SETUP(mock) {
  const nowSec = Date.now() / 1000;
  mock.addChat(CHAT_A, {
    title: 'Alpha session',
    messages: [{ role: 'user', content: 'alpha seed', parley_id: 'a-seed', timestamp: nowSec - 30 }],
    lastActiveAt: Date.now() - 30_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Bravo session',
    messages: [{ role: 'user', content: 'bravo seed', parley_id: 'b-seed', timestamp: nowSec - 90 }],
    lastActiveAt: Date.now() - 90_000,
  });
}

const activeId = (page) => page.evaluate(() =>
  document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') || null);

const focusedId = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  return el.id || el.tagName.toLowerCase();
});

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(300);

  // Start from a clean, unfocused state: click the transcript so focus
  // is outside any text field (the state in which ↑/↓ navigate).
  await page.click('#transcript', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur?.());

  // ── Enter drops into the composer of whatever session is selected ──
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  assert(await focusedId(page) === 'composer-input',
    `Enter should focus the composer, focus was ${await focusedId(page)}`);
  await page.keyboard.type('typed after enter');
  const landed = await page.evaluate(() =>
    document.getElementById('composer-input').value);
  assert(landed.includes('typed after enter'),
    `typing after Enter should land in the composer, got ${JSON.stringify(landed)}`);
  log('Enter focuses the composer and typing lands there ✓');

  // ── Esc steps back out, and arrows work again ──
  const before = await activeId(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  assert(await focusedId(page) !== 'composer-input', 'Esc should leave the composer');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(
    (prev) => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') !== prev,
    before, { timeout: 4_000, polling: 50 },
  );
  const after = await activeId(page);
  assert(after && after !== before,
    `ArrowDown after Esc should move to another session (${before} -> ${after})`);
  log('Esc returns to the list; arrows navigate again ✓');

  // ── Enter enters the composer OF THE SESSION the arrows landed on ──
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert(await focusedId(page) === 'composer-input', 'Enter should focus the composer again');
  assert(await activeId(page) === after,
    'focusing the composer must not change which session is active');
  log('Enter lands in the composer of the arrowed-to session ✓');

  // ── The configurable bindings, from inside a text field ──
  await page.keyboard.press('Meta+Shift+J');
  await page.waitForTimeout(150);
  assert(await focusedId(page) !== 'composer-input',
    'focus-sessions hotkey should pull focus out of the composer');
  await page.keyboard.press('Meta+Shift+Enter');
  await page.waitForTimeout(150);
  assert(await focusedId(page) === 'composer-input',
    'focus-composer hotkey should put focus back in the composer');
  log('configurable focus hotkeys work in both directions ✓');

  // ── Negative: a focused BUTTON keeps Enter ──
  // Enter on a button must activate it, not get hijacked into "go type".
  // Asserted via the pin-drawer rail toggle, which has a visible effect.
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    const btn = document.getElementById('btn-pin-drawer-rail') || document.getElementById('btn-pin-drawer');
    btn?.focus();
  });
  const btnFocused = await page.evaluate(() => document.activeElement?.id || null);
  assert(btnFocused && btnFocused !== 'composer-input', 'setup: a button should hold focus');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  assert(await focusedId(page) !== 'composer-input',
    'Enter on a focused button must not be stolen by the composer shortcut');
  log('Enter on a focused button is left alone ✓');

  // ── Negative: an open overlay keeps Enter ──
  // Covers each overlay the guard names, because the FIRST version of
  // that selector list guessed two class names that don't exist
  // (.cmdk-overlay, .confirm-dialog) — a miss that would have let Enter
  // yank focus out from under the search palette and the delete
  // confirmation. Driving the real palette catches that; asserting a
  // hand-written selector would not.
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    document.getElementById('settings')?.classList.add('on');
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert(await focusedId(page) !== 'composer-input',
    'Enter while the settings panel is open must not jump to the composer');
  await page.evaluate(() => document.getElementById('settings')?.classList.remove('on'));

  // The search palette, opened for real. NOTE the platform gate in
  // cmdkPalette.ts: it binds Cmd+K only when navigator.platform looks
  // like a Mac, and Ctrl+K otherwise — the smoke browser is Linux, so
  // Meta+K here opens nothing and the assertion below fails for a
  // harness reason rather than a product one. (The focus hotkeys above
  // are unaffected: their matcher accepts meta OR ctrl by design.)
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(300);
  const paletteOpen = await page.evaluate(() => !!document.querySelector('.cmdk-dialog'));
  assert(paletteOpen, 'setup: cmd+K should open the search palette');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  assert(await focusedId(page) !== 'composer-input',
    'Enter inside the search palette must not jump to the composer');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  log('Enter with an overlay open (settings, search palette) is left alone ✓');
}
