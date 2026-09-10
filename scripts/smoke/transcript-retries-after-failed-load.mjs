// A transient /messages failure must not leave a permanently blank
// transcript (field report 2026-09-10, CAP on flaky 5G): he switched away
// from a chat and back, and it came back EMPTY — only the live turn
// indicator, which rides SSE and so survives independently.
//
// Mechanism: the switch blanks the transcript on purpose
// ("switch-then-load"), the cache render is skipped when nothing is cached
// for that chat, and the failed fetch then had nothing to fall back to.
// The failure path set a status line and refreshed the DRAWER, but nothing
// re-tried the transcript, and the "reconnecting…" text referred to the
// SSE stream — which had never dropped ("Connected" in his header), so
// there was no reconnect to heal it.
import { waitForReady, openSidebar, clickRow } from './lib.mjs';

export const NAME = 'transcript-retries-after-failed-load';
export const DESCRIPTION =
  'A transient /messages failure on switch heals itself: the transcript retries and lands';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-retry-chat-a';
const CHAT_B = 'mock-retry-chat-b';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT_A, {
    title: 'Retry chat A',
    messages: [
      { id: 1, role: 'user', content: 'A seed question', created_at: t0 },
      { id: 2, role: 'assistant', content: 'A seed answer', created_at: t0 + 1 },
    ],
  });
  mock.addChat(CHAT_B, {
    title: 'Retry chat B',
    messages: [{ id: 10, role: 'user', content: 'B seed', created_at: t0 + 2 }],
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  await clickRow(page, CHAT_B);
  await page.waitForFunction(
    () => /B seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 5_000 },
  );
  log('seeded on chat B');

  // Wipe A's local cache so the switch has nothing to fall back on — the
  // condition that turns a transient failure into a blank screen.
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('parley-transcripts');
      req.onsuccess = req.onerror = req.onblocked = () => resolve(null);
    });
  });

  mock.failMessagesOnce(CHAT_A, 503);
  await clickRow(page, CHAT_A);

  // The first fetch fails; nothing is on screen. Then the retry lands.
  await page.waitForFunction(
    () => /A seed answer/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 12_000, polling: 200 },
  ).catch(async () => {
    const body = await page.$eval('#transcript', (el) => el.textContent?.slice(0, 300) || '(empty)');
    throw new Error(`transcript never healed after a transient failure — transcript="${body}"`);
  });
  log('transcript healed itself after the failed load ✓');

  const stillA = await page.evaluate(
    () => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') || '(none)',
  );
  if (stillA !== CHAT_A) {
    throw new Error(`retry must not move the user — active row is ${stillA}, expected ${CHAT_A}`);
  }
  log('the retry kept the user on the chat they chose ✓');
}
