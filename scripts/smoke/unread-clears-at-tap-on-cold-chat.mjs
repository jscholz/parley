// Cold-chat unread clear is fetch-gated (measured 2026-07-21): the
// badge.clearUnread + activityStore.markChatRead pair ran only inside
// applyViewChangedEffects — i.e. at view COMMIT, after the /messages
// fetch. On an UNCACHED chat over a slow link the unread chip hung on
// for the full multi-second fetch after the user had already tapped the
// row. The tap is the "seen" signal, not the render.
//
// Contract under test (noteViewIntent, fired at the row tap):
//   - unread chat, transcript NOT cached, /messages held open 4s
//   - tap the row → chip + accessor clear in the tap's synchronous
//     turn (<100ms class; asserted well under the 4s fetch)
//   - the transcript still loads afterwards (commit-time backstop and
//     ordering unharmed).
//
// Timing note: boot warm-prefetch (proxy-client.prefetch limit=12) also
// fetches B and would IDB-warm it ~4s after boot (the per-chat message
// delay applies to it too). The tap below lands well before that, so B
// is genuinely cold at tap time — the pre-fix behavior is a ~4s clear.
//
// Playwright trap: waitForFunction does NOT await async predicates (a
// returned Promise is truthy → vacuous instant pass), so the badge
// module is stashed on window via evaluate() first and every predicate
// below is synchronous.

import { waitForReady, openSidebar, waitForDrawerQuiet, assert } from './lib.mjs';

export const NAME = 'unread-clears-at-tap-on-cold-chat';
export const DESCRIPTION = 'uncached unread chat + slow /messages: the chip clears at tap time, not at fetch completion';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-coldtap-a';   // most recent — boot lands here
const CHAT_B = 'mock-coldtap-b';   // unread, cold, slow
const B_BODY = 'COLD-CHAT-BODY-MARKER';
const FETCH_DELAY_MS = 4_000;

export function MOCK_SETUP(mock) {
  const now = Date.now();
  mock.addChat(CHAT_A, {
    source: 'sidekick',
    title: 'Landing chat',
    messages: [{ role: 'user', content: 'landing', timestamp: now / 1000 - 30 }],
    lastActiveAt: now - 30_000,
  });
  mock.addChat(CHAT_B, {
    source: 'sidekick',
    title: 'Cold unread chat',
    messages: [
      { role: 'user', content: 'ping', timestamp: now / 1000 - 600 },
      { role: 'assistant', content: B_BODY, timestamp: now / 1000 - 599 },
    ],
    lastActiveAt: now - 600_000,
  });
  // Unread before the app ever boots (another device's replies).
  mock.setUnread(CHAT_B, 2);
  // The slow link: B's transcript fetch takes 4s. Fresh Playwright
  // context → IDB empty → B is genuinely uncached at tap time.
  mock.setMessageDelay(CHAT_B, FETCH_DELAY_MS);
}

const CHIP_SEL = (id) => `#sessions-list li[data-chat-id="${id}"] .sess-unread-chip`;

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await waitForDrawerQuiet(page);

  // Bind the badge module once (same instance as the app via the page's
  // import map) so the waits below can stay synchronous.
  await page.evaluate(async () => {
    window.__badge = await import('/build/notifications/badge.mjs');
  });

  // Badge hydrated: B's chip is up before the tap.
  await page.waitForFunction(
    ({ id, sel }) => window.__badge.unreadFor(id) > 0 && !!document.querySelector(sel),
    { id: CHAT_B, sel: CHIP_SEL(CHAT_B) },
    { timeout: 10_000, polling: 100 },
  );
  log(`chip up on ${CHAT_B} (unread=2), transcript uncached, /messages held ${FETCH_DELAY_MS}ms`);

  // Tap the row and clock the clear.
  const t0 = Date.now();
  await page.click(`#sessions-list li[data-chat-id="${CHAT_B}"] .sess-body`);
  await page.waitForFunction(
    ({ id, sel }) => window.__badge.unreadFor(id) === 0 && !document.querySelector(sel),
    { id: CHAT_B, sel: CHIP_SEL(CHAT_B) },
    { timeout: FETCH_DELAY_MS + 3_000, polling: 20 },
  );
  const clearedAfterMs = Date.now() - t0;

  // The discriminator: tap-time (<100ms class — generous 1s budget for
  // CI scheduling) vs fetch-time (>= 4s). Regression fails by ~4s.
  log(`chip cleared ${clearedAfterMs}ms after the tap`);
  assert(
    clearedAfterMs < 1_000,
    `unread must clear at TAP time, not fetch completion — took ${clearedAfterMs}ms (fetch is ${FETCH_DELAY_MS}ms)`,
  );

  // The transcript still lands after the slow fetch (ordering intact).
  await page.waitForFunction(
    (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
    B_BODY, { timeout: FETCH_DELAY_MS + 5_000, polling: 100 },
  );
  log('transcript rendered after the slow fetch — commit path unharmed');

  // And it stays cleared through the post-commit backstop + reconcile.
  await new Promise((r) => setTimeout(r, 1_500));
  const final = await page.evaluate((id) => ({
    unread: window.__badge.unreadFor(id),
    chip: !!document.querySelector(`#sessions-list li[data-chat-id="${id}"] .sess-unread-chip`),
  }), CHAT_B);
  assert(final.unread === 0 && !final.chip, `unread must stay cleared after commit/reconcile, got ${JSON.stringify(final)}`);
  log('stays cleared through commit backstop + server reconcile');
}
