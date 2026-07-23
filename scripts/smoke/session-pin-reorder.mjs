// Session-pin drag-reorder (#117) — the only way the user controls the
// cold-open landing default (index 0 of the pinned region is "home
// base"), so the reorder gesture is MVP-critical, not polish.
//
// Drives a REAL pointer drag (Playwright mouse = pointer events) on the
// pinned region: press the top pinned row, drag it below its sibling's
// midpoint, release. Asserts the live DOM reorder AND that the new order
// is committed to the synced `pinnedSessions` setting (so it survives a
// reload / syncs across devices).

import { waitForReady, openSidebar, pollUntil, assert } from './lib.mjs';

export const NAME = 'session-pin-reorder';
export const DESCRIPTION = 'Drag-reorder within the pinned region commits the new order to pinnedSessions';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const LABELS = ['alpha', 'beta', 'gamma'];
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

const pinnedIds = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#sessions-list li.sess-pinned'))
      .map((li) => li.dataset.chatId));

const persistedPins = (page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/sidekick/prefs/pinnedSessions', { cache: 'no-store' });
    const b = await r.json();
    const raw = b?.value;
    if (typeof raw !== 'string' || raw === '') return [];
    try { return JSON.parse(raw); } catch { return null; }
  });

async function rowMenuPin(page, chatId) {
  // Pin via the row's right-side .sess-pin-btn icon (pin/unpin moved off
  // the ⋮ menu onto this clickable icon — see sessionDrawer renderRow).
  await page.click(`#sessions-list li[data-chat-id="${chatId}"] .sess-pin-btn`);
}

const rowBox = (page, chatId) =>
  page.locator(`#sessions-list li[data-chat-id="${chatId}"]`).boundingBox();

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Pin alpha then beta → newest pin lands on top, so the pinned region
  // is [beta, alpha].
  await rowMenuPin(page, ID('alpha'));
  await page.waitForFunction(
    () => document.querySelectorAll('#sessions-list li.sess-pinned').length === 1,
    null, { timeout: 5_000, polling: 50 });
  await rowMenuPin(page, ID('beta'));
  await page.waitForFunction(
    () => document.querySelectorAll('#sessions-list li.sess-pinned').length === 2,
    null, { timeout: 5_000, polling: 50 });
  assert(JSON.stringify(await pinnedIds(page)) === JSON.stringify([ID('beta'), ID('alpha')]),
    `pre-drag pinned order should be [beta, alpha]; got ${JSON.stringify(await pinnedIds(page))}`);
  log('setup ✓ pinned region [beta, alpha]');

  // ── Drag beta (top) down past alpha's midpoint → [alpha, beta] ──────
  const beta = await rowBox(page, ID('beta'));
  const alpha = await rowBox(page, ID('alpha'));
  assert(beta && alpha, 'could not measure pinned row boxes');

  const startX = beta.x + beta.width / 2;
  const startY = beta.y + beta.height / 2;
  // Target just past alpha's vertical midpoint so the handler inserts
  // beta AFTER alpha.
  const endY = alpha.y + alpha.height * 0.75;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Multiple steps so the handler sees real intermediate pointermoves
  // (it commits the drag only after crossing the 6px vertical threshold).
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX, startY + ((endY - startY) * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();

  await page.waitForFunction(
    (want) => {
      const ids = Array.from(document.querySelectorAll('#sessions-list li.sess-pinned'))
        .map((li) => li.dataset.chatId);
      return JSON.stringify(ids) === JSON.stringify(want);
    },
    [ID('alpha'), ID('beta')],
    { timeout: 5_000, polling: 50 },
  );
  log('drag ✓ DOM pinned order is now [alpha, beta]');

  // Committed to the synced setting.
  await pollUntil(page,
    () => fetch('/api/sidekick/prefs/pinnedSessions')
      .then((r) => r.json())
      .then((b) => {
        try { return JSON.stringify(JSON.parse(b.value)) === JSON.stringify(['mock-chat-alpha', 'mock-chat-beta']); }
        catch { return false; }
      }),
    null, { timeout: 5_000, polling: 100, label: 'reordered pin order never committed to pinnedSessions' },
  );
  assert(JSON.stringify(await persistedPins(page)) === JSON.stringify([ID('alpha'), ID('beta')]),
    `reorder must persist [alpha, beta]; got ${JSON.stringify(await persistedPins(page))}`);
  log('persist ✓ reordered pins committed to pinnedSessions');

  log('PASS: drag-reorder swaps pinned order in DOM + persists to the synced setting');
}
