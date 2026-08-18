// Scenario: slash-command popover renders from the agent's
// /v1/commands catalog, filters as the user types, and dispatches the
// highlighted command on Enter. Plus: typed session-boundary commands
// (/new, /clear, /reset) — hidden from the catalog — get the right
// Parley-side mapping (see sendTypedMessage):
//   /new   → New Chat button codepath ("New chat started" marker).
//   /clear → New Chat hint line (no gateway behavior; cli_only).
//   /reset → sent upstream as a real command (in-place session reset);
//            shows as a user bubble, NOT swallowed by a hint.
//
// History (2026-05-31): the old "optimistic reset-signal" path was dead
// code (those commands are hidden from the catalog so isCommand() never
// matched). Removed. A first cut hinted all three at New Chat; corrected
// after confirming gateway /reset is a distinct in-place reset worth
// keeping and gateway /new is NOT a new-thread action.
//
// /reset is surfaced via a Parley-side SYNTHETIC catalog entry
// (slashCommands.ts) even though the gateway hides it — so it appears as
// a popover row and dispatches upstream. /new stays unsurfaced.
//
// Test plan (mocked):
//   1. Catalog WITHOUT session-boundary commands (matches prod hiding).
//   2. Type `/` → popover with rows; synthetic /reset present, /new
//      absent; `/voi` narrows to /voice; Enter dispatches + clears + closes.
//   3. `/new` + Enter → "New chat started" marker; composer cleared.
//   4. `/clear` + Enter → New Chat hint line; composer cleared.
//   5. `/reset` + Enter → user bubble with "/reset" (sent upstream via the
//      synthetic catalog entry, not hinted); composer cleared.

import { waitForReady, SEL, assert } from './lib.mjs';

export const NAME = 'slash-commands';
export const DESCRIPTION = 'Slash popover dispatches; typed /new→New Chat, /clear→hint, /reset→upstream';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  // Mirror prod: /new, /reset, /clear are hidden from the catalog, so
  // they never appear as popover rows. Only browsable commands here.
  mock.setCommandsCatalog([
    {
      name: 'voice', description: 'Toggle voice mode', category: 'Configuration',
      aliases: [], args_hint: '[on|off|tts|status]',
      subcommands: ['on', 'off', 'tts', 'status'],
    },
    {
      name: 'model', description: 'Show or set the model', category: 'Configuration',
      aliases: [], args_hint: '[name]', subcommands: [],
    },
  ]);
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Wait for the catalog fetch to land. Cheap polling — we just need
  // catalog.length>0 inside slashCommands. The module exposes nothing
  // publicly for this, so we rely on `/` opening the popover.
  await page.fill(SEL.composer, '/');
  await page.waitForSelector('.slash-popover', { state: 'visible', timeout: 3_000 });
  log('popover opened on /');

  const rowCount0 = await page.locator('.slash-popover-row').count();
  assert(rowCount0 >= 1, `expected >=1 popover row, got ${rowCount0}`);
  log(`popover rendered ${rowCount0} rows`);

  // /reset is a Parley-injected synthetic row (not in the mocked
  // catalog above) — it must surface even though the upstream catalog
  // doesn't list it. /new is deliberately NOT surfaced (New Chat button
  // covers it).
  const rowTexts = await page.locator('.slash-popover-row').allTextContents();
  assert(
    rowTexts.some((t) => t.startsWith('/reset')),
    `expected a /reset popover row (synthetic), got rows: ${JSON.stringify(rowTexts)}`,
  );
  assert(
    !rowTexts.some((t) => t.startsWith('/new')),
    `/new should NOT be a popover row, got rows: ${JSON.stringify(rowTexts)}`,
  );
  log('synthetic /reset row present; /new absent ✓');

  // Type `voi` (so composer reads `/voi`) — should narrow to /voice.
  await page.fill(SEL.composer, '/voi');
  await page.waitForFunction(
    () => {
      const rows = Array.from(document.querySelectorAll('.slash-popover-row'));
      return rows.length === 1 && /\/voice/.test(rows[0].textContent || '');
    },
    null,
    { timeout: 2_000 },
  );
  log('filter narrowed to /voice');

  // Enter dispatches /voice via slashCommands. Composer clears, popover closes.
  await page.focus(SEL.composer);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => {
      const p = document.querySelector('.slash-popover');
      return !p || p.style.display === 'none';
    },
    null,
    { timeout: 2_000 },
  );
  log('popover closed after Enter');

  const composerVal = await page.locator(SEL.composer).inputValue();
  assert(composerVal === '', `composer should be empty post-dispatch, got ${JSON.stringify(composerVal)}`);
  log('composer cleared after /voice dispatch');

  // ── /new → New Chat button codepath ────────────────────────────────
  // /new is NOT in the catalog → no popover row matches. Typing it and
  // pressing Enter falls through to sendTypedMessage, which runs the
  // New Chat button codepath (mint a fresh thread). The handler drops a
  // "New chat started" marker and does NOT send a "/new" bubble upstream.
  await page.fill(SEL.composer, '/new');
  await page.focus(SEL.composer);
  await page.keyboard.press('Enter');

  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#transcript .line.system'))
      .some(el => /New chat started/i.test(el.textContent || '')),
    null,
    { timeout: 5_000 },
  );
  const strayNew = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line.s0'))
      .some(el => (el.textContent || '').includes('/new')),
  );
  assert(!strayNew, 'typed /new should not produce a "/new" user bubble');
  const composerVal2 = await page.locator(SEL.composer).inputValue();
  assert(composerVal2 === '', `composer should be empty after /new, got ${JSON.stringify(composerVal2)}`);
  log('typed /new → New chat started, no stray bubble, composer cleared ✓');

  // ── /clear → New Chat hint ─────────────────────────────────────────
  // cli_only command with no gateway behavior — nudge to New Chat.
  await page.fill(SEL.composer, '/clear');
  await page.focus(SEL.composer);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#transcript .line.system'))
      .some(el => /Use the New Chat button/i.test(el.textContent || '')),
    null,
    { timeout: 3_000 },
  );
  const composerVal3 = await page.locator(SEL.composer).inputValue();
  assert(composerVal3 === '', `composer should be empty after /clear, got ${JSON.stringify(composerVal3)}`);
  log('typed /clear → New Chat hint line, composer cleared ✓');

  // ── /reset → sent upstream (in-place reset) ────────────────────────
  // /reset is a synthetic catalog command, so typing it opens the popover
  // and Enter dispatches it through slashCommands → upstream (NOT a
  // session-boundary intercept, NOT a hint). Client-side that means an
  // optimistic "/reset" user bubble appears (proves it reached the send
  // path, not swallowed by a hint or the New Chat codepath).
  await page.fill(SEL.composer, '/reset');
  await page.focus(SEL.composer);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#transcript .line.s0'))
      .some(el => (el.textContent || '').includes('/reset')),
    null,
    { timeout: 3_000 },
  );
  const composerVal4 = await page.locator(SEL.composer).inputValue();
  assert(composerVal4 === '', `composer should be empty after /reset send, got ${JSON.stringify(composerVal4)}`);
  log('typed /reset → sent upstream as user bubble, composer cleared ✓');
}
