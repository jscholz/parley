// Contract (#204): a foreground transcript reconcile that FAILS stays
// owed — the next lifecycle event re-runs it even when its own gap is
// short, and a bounded backoff retry covers the no-further-event case.
//
// Field bug 2026-06-12 (CAP): foregrounding the app on a cold radio
// fired visibility→forceReconnect with a big gap, the reconcile fetch
// failed (network not up yet), and the 'online' event ~3s later was
// skipped by the <10s gap check — leaving a stale transcript with
// nothing left to retry until a manual refresh.
//
// Repro (deterministic via Playwright's fake clock):
//   1. View a chat; dispatch 'online' once to seed lastReconnectAt.
//   2. Server gains a message with NO envelope broadcast (simulates
//      envelopes missed while the channel was dead) and the transcript
//      endpoint starts failing with 503.
//   3. clock.fastForward(11s) + dispatch 'online' → big-gap reconcile
//      runs and FAILS.
//   4. Clear the failure, dispatch 'online' again — gap is now tiny.
//      Old code skips it (<10s) and the transcript stays stale; the
//      owed-reconcile fix re-runs it (or the backoff retry fires) and
//      the fresh message must appear with no interaction.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'foreground-reconcile-retries';
export const DESCRIPTION = 'failed foreground reconcile stays owed: next lifecycle event (or backoff retry) refetches the transcript';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-chat-reconcile-retry';
const FRESH_ID = 'umsg_reconcile_fresh';
const FRESH_TEXT = 'message missed while the stream channel was dead';

const BASE_MESSAGES = [
  { role: 'user', content: 'reconcile seed question', parley_id: 'umsg_reconcile_1', timestamp: Date.now() / 1000 - 120 },
  { role: 'assistant', content: 'reconcile seed answer', parley_id: 'umsg_reconcile_2', timestamp: Date.now() / 1000 - 110 },
];

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, {
    title: 'Reconcile Retry',
    messages: BASE_MESSAGES,
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  // Fake clock so the ">10s since last reconnect" gap is fabricated
  // instead of slept through. Time still flows at normal speed;
  // fastForward jumps it. Installed before the app boots.
  await page.clock.install();
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line[data-message-id]').length >= 2,
    null,
    { timeout: 5_000, polling: 100 },
  );
  log('chat viewed + seed transcript rendered ✓');

  // Seed lastReconnectAt: the FIRST forceReconnect ever computes gap=0
  // by design, so the gap we fabricate below is measured from here.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(700); // let the 500ms reconcile debounce drain (skipped: gap 0)
  log('lastReconnectAt seeded via first online event ✓');

  // Server-side: a message the client never got an envelope for
  // (addChat replaces the chat entry — no broadcast), and the
  // transcript endpoint starts failing.
  mock.addChat(CHAT, {
    title: 'Reconcile Retry',
    messages: [
      ...BASE_MESSAGES,
      { role: 'assistant', content: FRESH_TEXT, parley_id: FRESH_ID, timestamp: Date.now() / 1000 - 5 },
    ],
    lastActiveAt: Date.now(),
  });
  let failed = 0;
  page.on('response', (resp) => {
    if (resp.url().includes(`/sessions/${CHAT}/messages`) && resp.status() >= 500) failed++;
  });
  mock.setMessageFailure(CHAT, 503);

  // Big-gap foreground: reconcile runs and FAILS.
  await page.clock.fastForward(11_000);
  const failurePromise = page
    .waitForResponse((r) => r.url().includes(`/sessions/${CHAT}/messages`) && r.status() === 503, { timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const sawFailure = await failurePromise;
  assert(sawFailure, 'big-gap reconcile should have fired a (failing) transcript fetch');
  log(`big-gap reconcile fired and failed (${failed} failed fetch(es)) ✓`);

  // Network back: the NEXT lifecycle event has a tiny gap. Old code
  // skips it (<10s) → stale forever; the fix re-runs the owed
  // reconcile (the pending backoff retry would also recover us).
  mock.setMessageFailure(CHAT, 0);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  try {
    await page.waitForFunction(
      (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
      FRESH_ID,
      { timeout: 8_000, polling: 200 },
    );
  } catch {
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#transcript .line[data-message-id]'))
        .map((l) => l.getAttribute('data-message-id')));
    assert(false, `BUG (#204, field 2026-06-12): failed reconcile must stay owed — transcript still stale after network recovered (ids=${JSON.stringify(ids)})`);
  }
  const text = await page.evaluate(
    (mid) => document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`)?.textContent || '',
    FRESH_ID,
  );
  assert(text.includes(FRESH_TEXT), `fresh bubble should carry the missed content, got: ${text.slice(0, 120)}`);
  log('owed reconcile recovered the missed message — no interaction needed ✓');
}
