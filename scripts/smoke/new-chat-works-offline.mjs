// Offline-first #1 (field 2026-07-21, walking test): New chat must be
// FULLY LOCAL. The button was gated on backend.isConnected() — the SSE
// EventSource boolean, which flaps constantly on spotty mobile links —
// so the tap was silently swallowed (status-line "Gateway offline" is
// easy to miss on mobile) and the user stayed on the previous session
// after being promised new-chat-cannot-fall-back "by construction".
//
// Contract exercised here:
//   1. SSE down (isConnected()=false) → click New chat → the view
//      switches to a fresh empty session INSTANTLY (<100ms class; 500ms
//      assert for CI headroom, same budget as
//      new-chat-immune-to-idb-contention).
//   2. No fallback: the previous session's content must never repaint
//      over the fresh chat — not while offline, and not when the
//      reconnect landing runs (the boot-only landing gate).
//   3. Reconnect → server state converges: a send in the fresh chat
//      round-trips (optimistic bubble → mock echo reply) and the chat
//      materializes server-side.

import { waitForReady, openSidebar, clickRow, send, waitForDrawerQuiet, assert } from './lib.mjs';

export const NAME = 'new-chat-works-offline';
export const DESCRIPTION = 'SSE down: New chat still switches instantly to a fresh session (no fallback); server converges on reconnect';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-offline-newchat-a';
const SEED = 'OFFLINE-NEWCHAT-SEED';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    source: 'parley',
    title: 'Offline new-chat seed',
    messages: [
      { role: 'user', content: SEED, timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'ack', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    SEED, { timeout: 5_000, polling: 50 },
  );
  await waitForDrawerQuiet(page);

  // Stash the (import-map singleton) backend module for connection polls.
  await page.evaluate(() => import('/build/backend.mjs').then((m) => { window.__backend = m; }));

  // ── Drop the SSE channel — the field condition the gate keyed off ──
  mock.setStreamOutage(true);
  await page.waitForFunction(
    () => window.__backend && window.__backend.isConnected() === false,
    null, { timeout: 10_000, polling: 100 },
  );
  log('stream outage active — isConnected()=false');

  // ── Click New chat while "offline": must switch instantly ──
  const ms = await page.evaluate(async (seed) => {
    const t0 = performance.now();
    document.getElementById('sb-new-chat')?.click();
    for (;;) {
      const text = document.getElementById('transcript')?.textContent || '';
      if (text.includes('New chat started') && !text.includes(seed)) {
        return performance.now() - t0;
      }
      if (performance.now() - t0 > 4000) return -1;
      await new Promise((r) => setTimeout(r, 10));
    }
  }, SEED);
  if (ms < 0) {
    throw new Error('New chat did nothing while the SSE channel was down — the click was swallowed by a connectivity gate (field bug 2026-07-21)');
  }
  log(`view switched to fresh session in ${ms.toFixed(0)}ms while offline`);
  if (ms > 500) {
    throw new Error(`new chat took ${ms.toFixed(0)}ms offline — must be <100ms-class (local mint, no network on the critical path)`);
  }

  // ── No fallback while offline: give any stale resume/repaint a window ──
  await new Promise((r) => setTimeout(r, 1200));
  const offlineText = await page.evaluate(() => document.getElementById('transcript')?.textContent || '');
  assert(!offlineText.includes(SEED), 'previous session repainted over the fresh chat while offline — fell back');
  assert(offlineText.includes('New chat started'), 'fresh chat marker vanished while offline');

  // ── Reconnect: outage off + 'online' lifecycle event (the CLOSED
  //    EventSource never retries on its own — mirrors mobile foreground) ──
  mock.setStreamOutage(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(
    () => window.__backend && window.__backend.isConnected() === true,
    null, { timeout: 10_000, polling: 100 },
  );
  log('reconnected');

  // The reconnect landing must NOT yank the (empty, server-unknown)
  // fresh chat back to the most-recent session.
  await new Promise((r) => setTimeout(r, 1000));
  const postReconnect = await page.evaluate(() => document.getElementById('transcript')?.textContent || '');
  assert(!postReconnect.includes(SEED), 'reconnect landing repainted the previous session over the fresh chat — new chat fell back after reconnect');

  // ── Server convergence: a send in the fresh chat round-trips ──
  const MSG = 'offline-newchat-hello';
  await send(page, MSG);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(`[mock] echo: ${m}`),
    MSG, { timeout: 8_000, polling: 100 },
  );
  log('reply arrived in the fresh chat after reconnect');
  const freshChats = mock.listChats().filter((c) => c.chatId !== CHAT_A);
  assert(
    freshChats.some((c) => c.messages.some((m) => m.role === 'user' && m.content === MSG)),
    'fresh chat never materialized server-side with the sent message',
  );
  log('server state converged — fresh chat exists server-side with the message ✓');
}
