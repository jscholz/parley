// Contract (#204): a boot resume whose transcript fetch FAILS must
// retry (with backoff) until it succeeds — the user must not be left
// on a stale cached snapshot with nothing refreshing it.
//
// Field bug 2026-06-12 (CAP): transcripts were stale on app open until
// a manual refresh or activity-row click. Boot cause: resumeSession
// NEVER throws — failures come back as `result.error` with an empty
// transcript — so main.ts's try/catch around the boot resume was dead
// code, an errored fetch (radio not up yet at cold launch) rendered
// nothing, and the most-recent fallback's single attempt failed the
// same way. Fix: resumeWithRetry checks result.error and retries with
// backoff on both boot paths.
//
// Repro: view a chat, append a message server-side WITHOUT broadcasting
// it (simulates envelopes missed while the app was closed), make the
// transcript endpoint 503 for the first several requests, reload.
// Old code burns at most ~4 requests (boot resume + most-recent
// fallback, each delta+full) within the first second and gives up; the
// retry path keeps going past the failure window and must render the
// fresh message with zero interaction.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'boot-resume-retries-after-failed-fetch';
export const DESCRIPTION = 'boot resume retries past transient transcript-fetch failures and renders fresh messages (no interaction)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-chat-boot-retry';
const FRESH_ID = 'umsg_boot_retry_fresh';
const FRESH_TEXT = 'fresh message added while app was closed';
// Old code's worst case is 4 failed requests (2 attempts × delta+full
// fallback); the new path retries past that. Clearing the failure
// after the 5th failed response means only the retry path can ever
// see a success.
const FAILED_BEFORE_RECOVERY = 5;

const BASE_MESSAGES = [
  { role: 'user', content: 'boot retry seed question', parley_id: 'umsg_boot_retry_1', timestamp: Date.now() / 1000 - 120 },
  { role: 'assistant', content: 'boot retry seed answer', parley_id: 'umsg_boot_retry_2', timestamp: Date.now() / 1000 - 110 },
];

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, {
    title: 'Boot Retry',
    messages: BASE_MESSAGES,
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line[data-message-id]').length >= 2,
    null,
    { timeout: 5_000, polling: 100 },
  );
  log('chat viewed + seed transcript rendered ✓');

  // Server gains a message the client never saw an envelope for
  // (addChat replaces the mock's chat entry — no broadcast).
  mock.addChat(CHAT, {
    title: 'Boot Retry',
    messages: [
      ...BASE_MESSAGES,
      { role: 'assistant', content: FRESH_TEXT, parley_id: FRESH_ID, timestamp: Date.now() / 1000 - 5 },
    ],
    lastActiveAt: Date.now(),
  });

  // Fail the transcript endpoint, then auto-recover after enough
  // failures that ONLY the retry path can reach a success.
  let failed = 0;
  page.on('response', (resp) => {
    if (!resp.url().includes(`/sessions/${CHAT}/messages`)) return;
    if (resp.status() < 500) return;
    failed++;
    log(`transcript fetch failed (${failed}/${FAILED_BEFORE_RECOVERY})`);
    if (failed >= FAILED_BEFORE_RECOVERY) mock.setMessageFailure(CHAT, 0);
  });
  mock.setMessageFailure(CHAT, 503);

  log('reloading with transcript endpoint failing…');
  await page.reload();
  await waitForReady(page);

  // NO interactions — the boot path itself must converge.
  try {
    await page.waitForFunction(
      (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
      FRESH_ID,
      { timeout: 12_000, polling: 200 },
    );
  } catch {
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#transcript .line[data-message-id]'))
        .map((l) => l.getAttribute('data-message-id')));
    assert(false, `BUG (#204, field 2026-06-12): boot resume must retry past transient fetch failures — fresh message never rendered (${failed} failed fetches, transcript ids=${JSON.stringify(ids)})`);
  }
  assert(failed >= 1, `expected the failure window to be exercised; saw ${failed} failed fetches`);
  const text = await page.evaluate(
    (mid) => document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`)?.textContent || '',
    FRESH_ID,
  );
  assert(text.includes(FRESH_TEXT), `fresh bubble should carry the new content, got: ${text.slice(0, 120)}`);
  log(`fresh message rendered after ${failed} failed fetch(es) — boot retry works ✓`);
}
