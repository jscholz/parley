// #242 — switch-back must paint from the in-memory transcriptStore
// SYNCHRONOUSLY, with no blank frame and no `.transcript-loading` spinner.
//
// Field report (CAP/WKWebView): every session switch flashed a loading
// spinner — even switching BACK to a session already visited this app-
// session. Root cause: sessionDrawer.resume() always called
// showTranscriptLoading() (blanks #transcript + arms the 200ms spinner)
// and then `await`ed an async IDB read (sessionCache.getMessagesCache)
// before repainting. On desktop the IDB read beats 200ms so the spinner
// never shows; on the slower WKWebView store the read loses the race and
// the spinner fades in — even though the session's durable rows were
// already sitting in the in-memory transcriptStore (synchronously
// available; SSE keeps background chats current in place).
//
// Fix: on switch-back, if the in-memory store holds the session AND it's
// tail-anchored (!hasMoreNewer), paint synchronously from it instead of
// blanking + arming the spinner.
//
// Discriminator: a MutationObserver records whether `.transcript-loading`
// is EVER present on #transcript during the switch-back (attributeOldValue
// catches a transient add+remove that a poll would miss). Pre-fix it is
// armed (blank+spinner); post-fix it is never armed.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'switchback-paints-from-memory-no-spinner';
export const DESCRIPTION = 'switch-back paints from in-memory store with no blank/spinner';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-switchback-mem-a';
const CHAT_B = 'mock-switchback-mem-b';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat A — revisited',
    source: 'parley',
    messages: [
      { role: 'user', content: 'AAA distinctive marker one', message_id: 'a-1', parley_id: 'a-1',
        timestamp: Date.now() / 1000 - 120 },
      { role: 'assistant', content: 'AAA distinctive marker two', message_id: 'a-2', parley_id: 'a-2',
        timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B — sibling',
    source: 'parley',
    messages: [
      { role: 'user', content: 'BBB sibling marker', message_id: 'b-1', parley_id: 'b-1',
        timestamp: Date.now() / 1000 - 30 },
    ],
    lastActiveAt: Date.now() - 30_000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. Open A — populates transcriptStore (in-memory) + IDB cache.
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => /AAA distinctive marker two/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 3_000, polling: 50 });
  log('chat A opened, durable rows rendered + in-memory store populated');
  await page.waitForTimeout(300); // let snapshot persist debounce flush

  // 2. Switch to B (A stays resident in transcriptStore).
  await clickRow(page, CHAT_B);
  await page.waitForFunction(
    () => /BBB sibling marker/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 3_000, polling: 50 });
  log('switched to chat B');

  // 3. Arm a MutationObserver on #transcript BEFORE switching back. It
  //    records (a) whether `.transcript-loading` is ever present, and
  //    (b) whether the transcript is ever blanked to empty — both are
  //    symptoms of the showTranscriptLoading() path we want to skip.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__sbLoading = false;
    w.__sbBlanked = false;
    const el = document.getElementById('transcript');
    w.__sbObs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.attributeName === 'class') {
          if ((r.oldValue || '').includes('transcript-loading')
              || el.classList.contains('transcript-loading')) {
            w.__sbLoading = true;
          }
        }
        if (r.type === 'childList' && (el.textContent || '').trim() === '') {
          w.__sbBlanked = true;
        }
      }
    });
    w.__sbObs.observe(el, {
      attributes: true, attributeOldValue: true, attributeFilter: ['class'],
      childList: true, subtree: true,
    });
  });

  // 4. Switch back to A. Post-fix: synchronous in-memory paint, no blank,
  //    no spinner. Pre-fix: blank + .transcript-loading armed.
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => /AAA distinctive marker two/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 3_000, polling: 50 });
  // Let the observer flush any final mutation records + the async server
  // reconcile run (it must not re-arm the spinner either).
  await page.waitForTimeout(800);

  const { loading, blanked, text } = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__sbObs?.disconnect();
    return {
      loading: w.__sbLoading,
      blanked: w.__sbBlanked,
      text: document.getElementById('transcript')?.textContent || '',
    };
  });

  assert(/AAA distinctive marker two/.test(text),
    'post-switchback: chat A durable rows must be rendered');
  assert(loading === false,
    'BUG: `.transcript-loading` spinner was armed on switch-back. The in-memory ' +
    'transcriptStore already holds chat A tail-anchored, so resume() should paint ' +
    'from it synchronously instead of blanking + arming the 200ms spinner.');
  assert(blanked === false,
    'BUG: #transcript was blanked to empty during switch-back (showTranscriptLoading ' +
    'path). Switch-back from in-memory must repaint without a blank frame.');
  log('switch-back painted from memory — no blank, no spinner ✓');
}
