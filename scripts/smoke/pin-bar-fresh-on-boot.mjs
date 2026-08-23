// Contract (#205): the pin bar (right-drawer pins panel + count
// banner) is populated on the FIRST boot render — no toggle, no pin
// action, no reload needed.
//
// Field bug 2026-06-12 (CAP): pin bar booted empty until manually
// toggled. Two compounding causes:
//   1. initPinDrawer built + rendered the drawer host BEFORE pins
//      hydrated (the only hydratePins call sat in chat.ts after an
//      awaited IDB read), so the initial render saw an empty store.
//   2. ServerBackedStore loaded the localStorage cache SILENTLY (no
//      notifyChange), and when the server snapshot equaled the cache
//      the diff-aware refresh stayed silent too — so nothing ever
//      repainted the empty panel/banner.
// Fix: hydratePins at the top of initPinDrawer + notifyChange after a
// non-empty cache hydrate (+ bounded retry on a failed boot refresh).
//
// This smoke reproduces the silent case exactly: localStorage cache
// and the mock server hold IDENTICAL pins, and the drawer expanded
// pref restores the drawer open at boot. After a reload, the pin rows
// and the count banner must be there with ZERO interactions.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'pin-bar-fresh-on-boot';
export const DESCRIPTION = 'pin drawer rows + count banner populated on first boot render (cache == server, no toggle)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-chat-pin-boot';
// Fixed ms-epoch values (> 1e10 so parsePin's seconds→ms normalization
// leaves them untouched on BOTH the cache and server paths — the
// store's equality check then sees identical pinnedAt and stays
// silent, which is the regression window).
const T1 = 1_765_000_000_000;
const PINS = [
  { chatId: CHAT, msgId: 'umsg_pin_boot_1', role: 'user', text: 'pinned boot message one', timestamp: T1, pinnedAt: T1 + 1000 },
  { chatId: CHAT, msgId: 'umsg_pin_boot_2', role: 'assistant', text: 'pinned boot message two', timestamp: T1 + 2000, pinnedAt: T1 + 3000 },
];

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT, {
    title: 'Pin Boot',
    messages: [
      { role: 'user', content: 'pin boot seed', parley_id: 'umsg_pin_boot_seed', timestamp: t0 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
  for (const p of PINS) {
    mock.seedPin(p.chatId, p.msgId, { role: p.role, text: p.text, timestamp: p.timestamp, pinnedAt: p.pinnedAt });
  }
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Seed the perf cache identical to the server, and restore the
  // drawer open so the host renders the pins panel at boot.
  await page.evaluate((pins) => {
    localStorage.setItem('parley.pins.items.v1', JSON.stringify(pins));
    localStorage.setItem('parley.pin-drawer.expanded', '1');
  }, PINS);

  log('reloading with seeded cache + expanded drawer pref…');
  await page.reload();
  await waitForReady(page);

  // NO interactions from here on — the whole point is first paint.
  await page.waitForFunction(
    () => document.getElementById('pin-drawer')?.classList.contains('expanded'),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('drawer restored open ✓');

  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#pin-drawer-list .pin-drawer-item').length === 2,
      null,
      { timeout: 5_000, polling: 100 },
    );
  } catch {
    const n = await page.evaluate(() => document.querySelectorAll('#pin-drawer-list .pin-drawer-item').length);
    const empty = await page.evaluate(() => !document.getElementById('pin-drawer-empty')?.hidden);
    assert(false, `BUG (#205, field 2026-06-12): pin bar must be populated on first boot render without a toggle — got ${n} row(s), empty-state visible=${empty}`);
  }
  log('2 pin rows on first render ✓');

  const emptyVisible = await page.evaluate(() => !document.getElementById('pin-drawer-empty')?.hidden);
  assert(!emptyVisible, 'pin-drawer empty state must be hidden when rows are present');

  // One-number rule (2026-07-10): the pins NUMERIC badge is retired —
  // pins are inventory, not attention; the only number in the app is
  // the chat-unread total. The banner elements must stay hidden even
  // with pins present.
  const banner = await page.evaluate(() => {
    const els = ['pin-drawer-count', 'pin-drawer-count-rail']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    return els.map((el) => ({ hidden: el.hidden }));
  });
  assert(banner.length > 0, 'expected at least one pin count banner element');
  for (const b of banner) {
    assert(b.hidden, `pin numeric badge is retired (one-number rule) and must stay hidden, got ${JSON.stringify(banner)}`);
  }
  log('pin numeric badge stays hidden (one-number rule) ✓');

  // Belt-and-suspenders: the in-memory store really has the pins (i.e.
  // rows came from hydrated state, not stale DOM).
  const size = await page.evaluate(() => window.__pinsDebug?.size() || 0);
  assert(size === 2, `store should hold 2 pins after boot hydrate, got ${size}`);
  log('pin bar fresh on boot — no toggle needed ✓');
}
