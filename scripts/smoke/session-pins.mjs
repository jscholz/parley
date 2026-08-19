// Session pinning (#113-118) — distinct from the message-PIN feature
// (src/pins/*, the "Pinned messages" drawer). This pins whole SESSIONS
// to the top of the left session drawer; the order is persisted in the
// synced `pinnedSessions` setting (a JSON-encoded id array), so it
// rides the same cross-device prefs store as every other synced setting
// with no dedicated backend table.
//
// What this proves, end-to-end:
//   1. PIN → TOP — pinning the oldest (bottom) row lifts it into a
//      pinned region at the top, marked `.sess-pinned`, ahead of the
//      recency list. The rest stay in recency order below.
//   2. PERSIST — the pin is written to `pinnedSessions` (PUT /prefs) and
//      survives a reload (DB-backed, applied by settings.load() on boot).
//   3. UNPIN → RECENCY — unpinning drops the row back to its recency
//      position and clears `.sess-pinned`.
//   4. AUTO-UNPIN ON DELETE — deleting a pinned session removes it from
//      `pinnedSessions` so no dangling id lingers as a landing default.

import { waitForReady, openSidebar, pollUntil, assert } from './lib.mjs';

export const NAME = 'session-pins';
export const DESCRIPTION = 'Pin a session → top region; persists across reload; unpin → recency; delete auto-unpins';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const LABELS = ['alpha', 'beta', 'gamma'];
const ID = (label) => `mock-chat-${label}`;

export function MOCK_SETUP(mock) {
  // alpha newest → gamma oldest, so the unpinned drawer order is
  // [alpha, beta, gamma] (most-recent first).
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

/** Drawer rows in display order (skips the divider + placeholder, which
 *  carry no data-chat-id). */
const listOrder = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'))
      .map((li) => li.dataset.chatId));

/** Ids of rows currently in the pinned region, in display order. */
const pinnedIds = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#sessions-list li.sess-pinned'))
      .map((li) => li.dataset.chatId));

/** Open a row's ⋮ menu and click the button whose label matches. */
async function rowMenuAction(page, chatId, label) {
  await page.click(`#sessions-list li[data-chat-id="${chatId}"] .sess-menu-btn`);
  await page.locator('.sess-menu button', { hasText: label }).first().click();
}

/** Toggle pin via the row's right-side .sess-pin-btn icon (pin/unpin
 *  moved off the ⋮ menu and onto this clickable icon — see sessionDrawer
 *  renderRow). */
async function togglePin(page, chatId) {
  await page.click(`#sessions-list li[data-chat-id="${chatId}"] .sess-pin-btn`);
}

/** Delete a row through the UI (row ⋮ → Delete → accept confirm()), so the
 *  delete routes through deleteSessionAtomic where auto-unpin lives. A direct
 *  backend DELETE (lib.deleteChat) bypasses that path and never auto-unpins. */
async function uiDeleteChat(page, chatId) {
  page.once('dialog', (d) => d.accept());
  await rowMenuAction(page, chatId, 'Delete');
}

/** The persisted pinnedSessions setting, parsed to an id array. */
const persistedPins = (page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/parley/prefs/pinnedSessions', { cache: 'no-store' });
    if (!r.ok) return null;
    const b = await r.json();
    const raw = b?.value;
    if (typeof raw !== 'string' || raw === '') return [];
    try { return JSON.parse(raw); } catch { return null; }
  });

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Sanity: all three rows present in recency order.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${ID('gamma')}"]`, { timeout: 5_000 });
  let order = await listOrder(page);
  assert(
    JSON.stringify(order) === JSON.stringify([ID('alpha'), ID('beta'), ID('gamma')]),
    `expected recency order [alpha,beta,gamma]; got ${JSON.stringify(order)}`,
  );
  log('setup ✓ recency order alpha, beta, gamma');

  // ── 1. PIN gamma (the bottom row) → it lifts to the top region ──────
  await togglePin(page, ID('gamma'));
  await page.waitForFunction(
    (id) => {
      const first = document.querySelector('#sessions-list li[data-chat-id]');
      return first?.dataset.chatId === id && first.classList.contains('sess-pinned');
    },
    ID('gamma'),
    { timeout: 5_000, polling: 50 },
  );
  assert(JSON.stringify(await pinnedIds(page)) === JSON.stringify([ID('gamma')]),
    `gamma should be the only pinned row; got ${JSON.stringify(await pinnedIds(page))}`);
  order = await listOrder(page);
  assert(JSON.stringify(order) === JSON.stringify([ID('gamma'), ID('alpha'), ID('beta')]),
    `after pin, order should be [gamma(pinned), alpha, beta]; got ${JSON.stringify(order)}`);
  log('pin ✓ gamma jumped to top region, rest stay in recency order');

  // ── 2. PERSIST — pinnedSessions written + survives reload ───────────
  await pollUntil(page,
    () => fetch('/api/parley/prefs/pinnedSessions')
      .then((r) => r.json()).then((b) => typeof b?.value === 'string' && b.value.includes('gamma')),
    null, { timeout: 3_000, polling: 100, label: 'gamma pin never persisted to pinnedSessions' },
  );
  assert(JSON.stringify(await persistedPins(page)) === JSON.stringify([ID('gamma')]),
    `pinnedSessions should persist [gamma]; got ${JSON.stringify(await persistedPins(page))}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForFunction(
    (id) => {
      const first = document.querySelector('#sessions-list li[data-chat-id]');
      return first?.dataset.chatId === id && first.classList.contains('sess-pinned');
    },
    ID('gamma'),
    { timeout: 5_000, polling: 50 },
  );
  log('persist ✓ gamma still pinned + at top after reload');

  // ── 3. UNPIN gamma → returns to its recency position (bottom) ───────
  await togglePin(page, ID('gamma'));
  await page.waitForFunction(
    () => document.querySelectorAll('#sessions-list li.sess-pinned').length === 0,
    null, { timeout: 5_000, polling: 50 },
  );
  order = await listOrder(page);
  assert(JSON.stringify(order) === JSON.stringify([ID('alpha'), ID('beta'), ID('gamma')]),
    `after unpin, recency order should be restored; got ${JSON.stringify(order)}`);
  assert(JSON.stringify(await persistedPins(page)) === JSON.stringify([]),
    `pinnedSessions should be empty after unpin; got ${JSON.stringify(await persistedPins(page))}`);
  log('unpin ✓ gamma back to recency position, pins cleared');

  // ── 4. AUTO-UNPIN ON DELETE — pin alpha + beta, delete beta ─────────
  await togglePin(page, ID('alpha'));
  await page.waitForFunction(
    () => document.querySelectorAll('#sessions-list li.sess-pinned').length === 1,
    null, { timeout: 5_000, polling: 50 },
  );
  await togglePin(page, ID('beta'));
  await page.waitForFunction(
    () => document.querySelectorAll('#sessions-list li.sess-pinned').length === 2,
    null, { timeout: 5_000, polling: 50 },
  );
  // beta pinned last → appends at the bottom of the pinned region.
  assert(JSON.stringify(await persistedPins(page)) === JSON.stringify([ID('alpha'), ID('beta')]),
    `expected pins [alpha,beta] (newest pin at bottom); got ${JSON.stringify(await persistedPins(page))}`);

  await uiDeleteChat(page, ID('beta'));
  await pollUntil(page,
    () => fetch('/api/parley/prefs/pinnedSessions')
      .then((r) => r.json()).then((b) => !String(b?.value || '').includes('beta')),
    null, { timeout: 5_000, polling: 100, label: 'deleted beta never auto-unpinned from pinnedSessions' },
  );
  assert(JSON.stringify(await persistedPins(page)) === JSON.stringify([ID('alpha')]),
    `deleting pinned beta must auto-unpin it; expected [alpha], got ${JSON.stringify(await persistedPins(page))}`);
  log('auto-unpin ✓ deleting a pinned session removed it from pinnedSessions');

  log('PASS: session pin → top, persist across reload, unpin → recency, auto-unpin on delete');
}
