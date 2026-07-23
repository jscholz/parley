// Per-session identity (#146-149) — delete cleanup. Deleting a session
// that carries an identity (nickname/voice) must drop its entry from the
// synced `sessionIdentities` map, mirroring the auto-unpin-on-delete
// behavior — so a recycled id never inherits a stale name/voice and no
// dangling entry lingers in the prefs blob.
//
// The delete must route through the UI (row ⋮ → Delete → accept confirm),
// because deleteSessionAtomic is where sessionIdentity.remove() lives. A
// direct backend DELETE bypasses that path.

import { waitForReady, openSidebar, pollUntil, assert } from './lib.mjs';

export const NAME = 'session-identity-delete-cleanup';
export const DESCRIPTION = 'Deleting a session with an identity prunes it from sessionIdentities';
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

async function rowMenuAction(page, chatId, label) {
  await page.click(`#sessions-list li[data-chat-id="${chatId}"] .sess-menu-btn`);
  await page.locator('.sess-menu button', { hasText: label }).first().click();
}

const persistedIdentities = (page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/sidekick/prefs/sessionIdentities', { cache: 'no-store' });
    if (!r.ok) return null;
    const b = await r.json();
    const raw = b?.value;
    if (typeof raw !== 'string' || raw === '') return {};
    try { return JSON.parse(raw); } catch { return null; }
  });

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForSelector(`#sessions-list li[data-chat-id="${ID('beta')}"]`, { timeout: 5_000 });

  // Give BOTH sessions an identity so we can prove only the deleted one
  // is pruned (the survivor's entry must remain).
  for (const label of LABELS) {
    await rowMenuAction(page, ID(label), 'Name & voice');
    await page.waitForSelector('.session-identity-dialog .ident-nickname', { timeout: 5_000 });
    await page.fill('.session-identity-dialog .ident-nickname', `Nick ${label}`);
    await page.click('.session-identity-dialog .ident-save');
    await page.waitForFunction(
      (id) => {
        const li = document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
        return !!li?.querySelector('.sess-nickname');
      },
      ID(label), { timeout: 5_000, polling: 50 },
    );
  }
  let ids = await persistedIdentities(page);
  assert(ids?.[ID('alpha')] && ids?.[ID('beta')],
    `both sessions should have identities; got ${JSON.stringify(ids)}`);
  log('setup ✓ alpha + beta both carry an identity');

  // ── Delete beta through the UI → its identity entry must be pruned ──
  page.once('dialog', (d) => d.accept());
  await rowMenuAction(page, ID('beta'), 'Delete');

  await pollUntil(page,
    () => fetch('/api/sidekick/prefs/sessionIdentities')
      .then((r) => r.json())
      .then((b) => !String(b?.value || '').includes('Nick beta')),
    null, { timeout: 5_000, polling: 100, label: 'beta identity never pruned from sessionIdentities' },
  );
  ids = await persistedIdentities(page);
  assert(!ids?.[ID('beta')],
    `deleting beta must prune its identity; got ${JSON.stringify(ids)}`);
  assert(ids?.[ID('alpha')]?.nickname === 'Nick alpha',
    `alpha's identity must survive beta's delete; got ${JSON.stringify(ids)}`);
  log('cleanup ✓ beta identity pruned, alpha identity intact');

  log('PASS: deleting a session prunes only its sessionIdentities entry');
}
