// Stale-snapshot revert (measured 2026-07-21): badge.ts's
// refreshFromServer used to apply whatever GET /notifications/unread
// response landed, even one that was already in flight when a local
// mutation (markUnread's applyLocal) happened. The stale snapshot —
// taken BEFORE the mark — wiped the chip/badge at delivery time
// (reproduced: chip gone at exactly +2s with a 2s-delayed stale GET;
// iOS aggravation: foregrounding fires visibilitychange+focus
// refreshes, so a stale GET is nearly always in flight across the
// user's tap).
//
// Contract under test (the serverBackedStore-pattern guard ported into
// badge.ts):
//   1. Start a slow GET /unread (mock holds a PRE-computed snapshot —
//      snapshot-then-deliver, so it is genuinely stale).
//   2. markUnread() well into its flight → chip + badge flip
//      optimistically. The 1.5s gap between GET start and the mark
//      makes the pre-fix dip wide (stale lands, and pre-fix NOTHING
//      re-triggers a refresh — the wipe persists), so the 40ms
//      sampler cannot miss it.
//   3. The stale response lands → DISCARDED (epoch/pendingWrites/
//      writesSettled moved) → the chip NEVER dips to zero, through the
//      stale landing AND the trailing debounced refresh.

import { waitForReady, openSidebar, waitForDrawerQuiet, assert } from './lib.mjs';

export const NAME = 'stale-refresh-cannot-revert-optimistic-mark';
export const DESCRIPTION = 'GET /unread in flight across a markUnread never reverts the chip: stale snapshot discarded, trailing refresh reconciles';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-stale-a';   // most recent — boot lands here
const CHAT_B = 'mock-stale-b';   // background chat the user marks unread
const STALE_HOLD_MS = 4_000;

export function MOCK_SETUP(mock) {
  const now = Date.now();
  mock.addChat(CHAT_A, {
    source: 'parley',
    title: 'Landing chat',
    messages: [{ role: 'user', content: 'landing', timestamp: now / 1000 - 30 }],
    lastActiveAt: now - 30_000,
  });
  mock.addChat(CHAT_B, {
    source: 'parley',
    title: 'Background chat',
    messages: [{ role: 'user', content: 'background', timestamp: now / 1000 - 600 }],
    lastActiveAt: now - 600_000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await waitForDrawerQuiet(page);

  // Bind the badge module once (same instance as the app via the page's
  // import map). NOTE: waitForFunction does NOT await async predicates,
  // so all in-page checks go through this handle or evaluate().
  await page.evaluate(async () => {
    window.__badge = await import('/build/notifications/badge.mjs');
  });

  // Hold /unread GETs open (snapshot taken at request time — before the
  // mark below — so the held response is genuinely stale).
  mock.setUnreadDelay(STALE_HOLD_MS);

  // Kick a refresh the way a foreground/server envelope would and wait
  // for its GET to actually leave (1500ms debounce).
  const staleGet = page.waitForRequest(
    (req) => /\/api\/parley\/notifications\/unread/.test(req.url()) && req.method() === 'GET',
    { timeout: 8_000 },
  );
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('parley:server-unread-changed'));
  });
  await staleGet;
  const tStale = Date.now();
  log(`stale GET /unread in flight (held ${STALE_HOLD_MS}ms, pre-mark snapshot)`);

  // Let the GET age 1.5s so the mark lands squarely mid-flight AND the
  // pre-fix dip window (stale landing → nothing re-fetches) is wide.
  await new Promise((r) => setTimeout(r, 1_500));

  // Mark chat B unread mid-flight + start a 40ms sampler over BOTH
  // surfaces (accessor + rendered row chip). Any dip to zero at any
  // sample is the revert regression.
  await page.evaluate(async (chatId) => {
    const badge = window.__badge;
    window.__dips = [];
    window.__samples = 0;
    window.__sampler = setInterval(() => {
      window.__samples++;
      const accessor = badge.unreadFor(chatId);
      const chip = document.querySelector(
        `#sessions-list li[data-chat-id="${chatId}"] .sess-unread-chip`,
      );
      if (accessor === 0 || !chip) {
        window.__dips.push({ t: Date.now(), accessor, chip: !!chip });
      }
    }, 40);
    await badge.markUnread(chatId);
  }, CHAT_B);

  // Optimistic flip is synchronous — chip visible immediately.
  const flipped = await page.evaluate((chatId) => window.__badge.unreadFor(chatId), CHAT_B);
  assert(flipped === 1, `markUnread must flip locally now, got unreadFor=${flipped}`);
  log('optimistic mark applied — chip up, sampler armed');

  // Any refresh REQUESTED from here on is instant (in-flight holds keep
  // the delay they captured at request time), so the post-discard
  // trailing reconcile is quick. markUnread's own reconcile GET may
  // still ride the old hold — covered by the ride-through budget below.
  mock.setUnreadDelay(0);

  // Ride through: stale landing (tStale + hold) + trailing debounced
  // refresh (+1.5s) + slack.
  const rideMs = (tStale + STALE_HOLD_MS + 3_500) - Date.now();
  await new Promise((r) => setTimeout(r, Math.max(rideMs, 1_000)));

  const result = await page.evaluate((chatId) => {
    clearInterval(window.__sampler);
    const badge = window.__badge;
    return {
      dips: window.__dips,
      samples: window.__samples,
      finalAccessor: badge.unreadFor(chatId),
      finalMarked: badge.isMarkedUnread(chatId),
      finalChip: !!document.querySelector(
        `#sessions-list li[data-chat-id="${chatId}"] .sess-unread-chip`,
      ),
      total: badge.totalUnreadCount(),
    };
  }, CHAT_B);

  log(`sampled ${result.samples}x through the stale landing; dips=${result.dips.length}`);
  assert(result.samples > 80, `sampler must actually run (got ${result.samples} samples)`);
  assert(
    result.dips.length === 0,
    `chip/badge must NEVER dip through the stale landing + trailing refresh — dipped ${result.dips.length}x, first: ${JSON.stringify(result.dips[0])}`,
  );
  assert(result.finalAccessor === 1, `unreadFor must settle at 1, got ${result.finalAccessor}`);
  assert(result.finalMarked === true, 'marked-unread must survive reconcile');
  assert(result.finalChip, 'row chip must still be rendered after reconcile');

  // Server truth converged too (the mark POST landed).
  const server = mock.getUnreadState();
  assert(server.marked.has(CHAT_B), 'server must hold the sticky mark after the dust settles');
  log(`no revert: accessor=1 marked=true chip=present total=${result.total} — guard holds`);
}
