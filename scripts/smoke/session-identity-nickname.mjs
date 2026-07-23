// Per-session identity (#146-149) — the nickname half. The user can give
// any SESSION a friendly nickname + its own TTS voice via the row ⋮ →
// "Name & voice" sheet. The map is persisted in the synced
// `sessionIdentities` setting (a JSON-encoded id→{nickname,voice} object),
// riding the same cross-device prefs store as pinnedSessions with no
// dedicated backend table.
//
// What this proves:
//   1. SET — opening the sheet, typing a nickname, and saving renders a
//      `.sess-nickname` chip in that row (ahead of the title/snippet).
//   2. PERSIST — the nickname is written to `sessionIdentities`
//      (PUT /prefs) and survives a reload (DB-backed, applied on boot).
//   3. CLEAR — re-opening the sheet, blanking the nickname, saving drops
//      the chip and prunes the entry from `sessionIdentities`.

import { waitForReady, openSidebar, pollUntil, assert } from './lib.mjs';

export const NAME = 'session-identity-nickname';
export const DESCRIPTION = 'Set a session nickname via the sheet → chip renders, persists across reload, clears on blank';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const LABELS = ['alpha', 'beta'];
const ID = (label) => `mock-chat-${label}`;

export function MOCK_SETUP(mock) {
  for (let i = 0; i < LABELS.length; i++) {
    const label = LABELS[i];
    const tSec = Date.now() / 1000 - i * 60;
    mock.addChat(ID(label), {
      title: `Chat ${label}`,
      messages: [
        { role: 'user', content: `marker-${label}`, timestamp: tSec },
        { role: 'assistant', content: `Reply ${label}`, timestamp: tSec + 1 },
      ],
      lastActiveAt: Date.now() - i * 60_000,
    });
  }
}

/** Open a row's ⋮ menu and click the button whose label matches. */
async function rowMenuAction(page, chatId, label) {
  await page.click(`#sessions-list li[data-chat-id="${chatId}"] .sess-menu-btn`);
  await page.locator('.sess-menu button', { hasText: label }).first().click();
}

/** The persisted sessionIdentities setting, parsed to an id→identity map. */
const persistedIdentities = (page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/sidekick/prefs/sessionIdentities', { cache: 'no-store' });
    if (!r.ok) return null;
    const b = await r.json();
    const raw = b?.value;
    if (typeof raw !== 'string' || raw === '') return {};
    try { return JSON.parse(raw); } catch { return null; }
  });

const nicknameChip = (page, chatId) =>
  page.evaluate((id) => {
    const li = document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
    return li?.querySelector('.sess-nickname')?.textContent ?? null;
  }, chatId);

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForSelector(`#sessions-list li[data-chat-id="${ID('alpha')}"]`, { timeout: 5_000 });

  // ── 1. SET nickname via the sheet ──────────────────────────────────
  await rowMenuAction(page, ID('alpha'), 'Name & voice');
  await page.waitForSelector('.session-identity-dialog .ident-nickname', { timeout: 5_000 });
  await page.fill('.session-identity-dialog .ident-nickname', 'Acme client');
  await page.click('.session-identity-dialog .ident-save');

  await page.waitForFunction(
    (id) => {
      const li = document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
      return li?.querySelector('.sess-nickname')?.textContent === 'Acme client';
    },
    ID('alpha'),
    { timeout: 5_000, polling: 50 },
  );
  assert((await nicknameChip(page, ID('beta'))) === null,
    'beta should have no nickname chip');
  log('set ✓ nickname chip renders on alpha only');

  // ── 2. PERSIST — written to sessionIdentities + survives reload ─────
  await pollUntil(page,
    () => fetch('/api/sidekick/prefs/sessionIdentities')
      .then((r) => r.json())
      .then((b) => typeof b?.value === 'string' && b.value.includes('Acme client')),
    null, { timeout: 3_000, polling: 100, label: 'nickname never persisted to sessionIdentities' },
  );
  let ids = await persistedIdentities(page);
  assert(ids?.[ID('alpha')]?.nickname === 'Acme client',
    `sessionIdentities should hold alpha→Acme client; got ${JSON.stringify(ids)}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForFunction(
    (id) => {
      const li = document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
      return li?.querySelector('.sess-nickname')?.textContent === 'Acme client';
    },
    ID('alpha'),
    { timeout: 5_000, polling: 50 },
  );
  log('persist ✓ nickname survives reload');

  // ── 3. CLEAR — blank the nickname → chip drops, entry pruned ────────
  await rowMenuAction(page, ID('alpha'), 'Name & voice');
  await page.waitForSelector('.session-identity-dialog .ident-nickname', { timeout: 5_000 });
  await page.fill('.session-identity-dialog .ident-nickname', '');
  await page.click('.session-identity-dialog .ident-save');

  await page.waitForFunction(
    (id) => {
      const li = document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
      return li && !li.querySelector('.sess-nickname');
    },
    ID('alpha'),
    { timeout: 5_000, polling: 50 },
  );
  ids = await persistedIdentities(page);
  assert(!ids?.[ID('alpha')],
    `blanking the nickname should prune the entry; got ${JSON.stringify(ids)}`);
  log('clear ✓ chip dropped + entry pruned from sessionIdentities');

  log('PASS: session nickname set → chip, persist across reload, clear → pruned');
}
