// Pin the 2026-05-27 fix: a backend double-write — the SAME user message
// stored twice within seconds (once native, once via hermes' platform-ingest
// path, different ids) — must render as ONE bubble. AND a legitimate verbatim
// repeat (same text minutes apart, e.g. a voice-test phrase) must stay TWO.
//
// The projection's durable dedup deliberately skips user rows (identical user
// content is often legit), so this was the rendering gap that showed the dup.
// Fix: pickUserDuplicateLosers() — time-windowed (30s) user dedup.
//
// Test plan (mocked): seed a chat whose durable history contains (a) two
// identical user rows ~4s apart with different parley_ids, and (b) two
// identical user rows ~2min apart. Open it; assert the close pair collapses
// to 1 bubble and the far pair stays 2.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'user-double-write-collapses';
export const DESCRIPTION = 'near-simultaneous duplicate user rows collapse to one bubble; far-apart legit repeats stay separate';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-double-write';
const DUP = 'Hey. I migrated you from Cortex to FontBrain.';
const REPEAT = '1 2 3 4 5 6 7 8 9 10';
const now = Date.now() / 1000;

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Double-write repro',
    source: 'parley',
    messages: [
      // (a) backend double-write: same content, 4s apart, different ids.
      { role: 'user', content: DUP, parley_id: 'umsg_native_1', timestamp: now - 300 },
      { role: 'user', content: DUP, parley_id: 'legacy:44461',  timestamp: now - 296 },
      { role: 'assistant', content: 'On it.', parley_id: 'msg_a1', timestamp: now - 295 },
      // (b) legit verbatim repeat: same content, 2 min apart.
      { role: 'user', content: REPEAT, parley_id: 'umsg_rep_1', timestamp: now - 200 },
      { role: 'user', content: REPEAT, parley_id: 'umsg_rep_2', timestamp: now - 80 },
    ],
    lastActiveAt: Date.now(),
  });
  mock.setAutoReplyEnabled(false);
}

const countUserBubblesWith = (page, needle) => page.evaluate((n) =>
  Array.from(document.querySelectorAll('#transcript .line.s0'))
    .filter(el => (el.textContent || '').includes(n)).length, needle);

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    (n) => (document.getElementById('transcript')?.textContent || '').includes(n),
    REPEAT, { timeout: 5_000, polling: 100 });

  const dupCount = await countUserBubblesWith(page, DUP);
  const repeatCount = await countUserBubblesWith(page, REPEAT);
  log(`duplicate-content user bubbles: ${dupCount} (want 1)`);
  log(`legit-repeat user bubbles: ${repeatCount} (want 2)`);

  assert(dupCount === 1, `double-write should collapse to ONE user bubble; got ${dupCount}`);
  assert(repeatCount === 2, `far-apart legit repeats must BOTH render; got ${repeatCount}`);
  log('double-write collapses to one; legit repeat preserved ✓');
}
