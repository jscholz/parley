// THE badge invariant (field escalation 2026-07-09: "sidebar 0,
// sessions 1, app badge 2 — should be impossible by construction"):
//
//   OS app badge  ≡  totalUnreadCount()  ≡  Σ unreadFor(chat)  ≡  Σ visible row chips
//
// Enforced structurally: totalUnread() is DEFINED as the sum of the
// same per-chat accessor the row chips render (badge.ts), the server
// force-includes unread chats in the sessions window, and the sidebar
// sorts unread rows to the top of the unpinned region so every badge
// unit has a VISIBLE chip. This smoke seeds the exact divergence shapes
// from the field report:
//   - an unread chat DEEP in the recency order (was: below the fold,
//     counted by the badge, invisible in the sidebar)
//   - a marked-unread chat with no new messages (was: counted by the
//     badge total but chip-less — two formulas over one map)

import { waitForReady } from './lib.mjs';

export const NAME = 'unread-badges-single-source';
export const DESCRIPTION = 'App badge ≡ Σ row chips by construction: single accessor, unread-first ordering, no below-the-fold unreads';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  const now = Date.now();
  // 8 read chats, newest first…
  for (let i = 0; i < 8; i++) {
    mock.addChat(`mock-read-${i}`, {
      title: `Read chat ${i}`,
      messages: [{ role: 'user', content: 'x', sidekick_id: `u_r${i}`, timestamp: now / 1000 - 100 - i }],
      lastActiveAt: now - 10_000 - i * 1000,
    });
  }
  // …an UNREAD chat parked at the very BOTTOM of the recency order…
  mock.addChat('mock-unread-old', {
    title: 'Old unread chat',
    messages: [{ role: 'user', content: 'y', sidekick_id: 'u_old', timestamp: now / 1000 - 9999 }],
    lastActiveAt: now - 9_000_000,
  });
  mock.setUnread('mock-unread-old', 1);
  // …and a MARKED-unread chat with zero new messages.
  mock.addChat('mock-marked', {
    title: 'Marked chat',
    messages: [{ role: 'user', content: 'z', sidekick_id: 'u_m', timestamp: now / 1000 - 5000 }],
    lastActiveAt: now - 5_000_000,
  });
  mock.setMarkedUnread('mock-marked', true);
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Let the badge store hydrate from /unread.
  await page.waitForFunction(async () => {
    const badge = await import('/build/notifications/badge.mjs');
    return badge.totalUnreadCount() >= 2;
  }, null, { timeout: 10_000, polling: 200 });

  const state = await page.evaluate(async () => {
    const badge = await import('/build/notifications/badge.mjs');
    const rows = [...document.querySelectorAll('#sessions-list li[data-chat-id]')];
    const chips = rows
      .map((li) => ({
        id: li.dataset.chatId,
        chip: Number(li.querySelector('.sess-unread-chip')?.textContent || 0),
        index: rows.indexOf(li),
        pinned: li.dataset.pinned === '1',
      }))
      .filter((r) => r.chip > 0);
    return {
      total: badge.totalUnreadCount(),
      perAccessor: rows.map((li) => badge.unreadFor(li.dataset.chatId)).reduce((a, b) => a + b, 0),
      chipSum: chips.reduce((a, c) => a + c.chip, 0),
      chips,
      rowCount: rows.length,
      firstUnpinnedIds: rows.filter((li) => li.dataset.pinned !== '1').slice(0, 2).map((li) => li.dataset.chatId),
    };
  });

  // The invariant, all three ways.
  if (state.total !== 2) throw new Error(`expected badge total 2, got ${state.total}`);
  if (state.chipSum !== state.total) {
    throw new Error(`chip sum (${state.chipSum}) must equal badge total (${state.total}) — divergence regression: ${JSON.stringify(state.chips)}`);
  }
  if (state.perAccessor !== state.total) {
    throw new Error(`Σ unreadFor over rendered rows (${state.perAccessor}) must equal total (${state.total})`);
  }
  log(`badge total == Σ chips == Σ accessor == ${state.total}`);

  // No below-the-fold unreads: both unread rows lead the unpinned region.
  const leaders = new Set(state.firstUnpinnedIds);
  if (!leaders.has('mock-unread-old') || !leaders.has('mock-marked')) {
    throw new Error(`unread rows must sort to the top of the unpinned region, got leaders: ${state.firstUnpinnedIds.join(', ')}`);
  }
  log('unread rows (deep-recency + marked-only) lead the list — nothing counted is invisible');
}
