// #191 delta resume: with a warm IDB transcript cache, switching back
// into a chat must fetch only the rows AFTER the cached tail
// (?after=<id>) instead of re-downloading the full newest page
// (~750KB-1MB — the 28.5s "resume/replay done" on cellular, 2026-06-09
// device boot log).
//
// Shape: chat A has 6 persisted rows (mock default integer ids
// 1000-1005). First switch-in primes the IDB cache via the full-page
// fetch. The server then gains 2 new rows (ids 1006-1007) + one
// in-flight envelope. On switch-back (A → B → A) the smoke asserts:
//   1. proxyClient issued ?after=1005 for chat A — the delta page;
//   2. NO bare full-page /messages fetch fired for chat A;
//   3. the transcript shows old + new rows (merge, not truncate);
//   4. the in-flight bubble renders — the tail delta page carries
//      `inflight` (proxy attaches it when hasMoreNewer=false), so
//      mid-turn catch-up still works through the delta path.

import {
  waitForReady, openSidebar, clickRow, assert,
} from './lib.mjs';

export const NAME = 'delta-resume';
export const DESCRIPTION = 'switch-back resume fetches only rows after the cached tail (?after=) and still renders new rows + inflight (#191)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-delta-resume-chat';
const CHAT_B = 'mock-delta-resume-other';
const NEW_USER_TEXT = 'delta wave question about trains';
const NEW_REPLY_TEXT = 'delta wave answer about trains';
const INFLIGHT_TEXT = 'mid-turn inflight while away';

const BASE_MESSAGES = [
  { role: 'user',      content: 'hello there' },
  { role: 'assistant', content: 'hi! how can I help?' },
  { role: 'user',      content: 'tell me about boats' },
  { role: 'assistant', content: 'boats float on water' },
  { role: 'user',      content: 'and planes?' },
  { role: 'assistant', content: 'planes fly in the sky' },
];

function stamp(messages) {
  const t0 = Date.now() / 1000 - 600;
  return messages.map((m, i) => ({ ...m, timestamp: t0 + i }));
}

export function MOCK_SETUP(mock) {
  // No message_id on purpose: rows get the mock's default integer ids
  // (1000+i) — the delta path's ?after cursor only engages on
  // digit-shaped ids (state.db id space, cache schema v4).
  mock.addChat(CHAT_A, {
    title: 'Delta chat',
    source: 'sidekick',
    messages: stamp(BASE_MESSAGES),
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Other chat',
    source: 'sidekick',
    messages: stamp([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
    ]),
    lastActiveAt: Date.now() - 80_000,
  });
}

async function transcriptText(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line'))
      .map(el => (el.textContent || '').trim().slice(0, 80)),
  );
}

export default async function run({ page, log, mock }) {
  const aMessagesReqs = [];
  page.on('request', (r) => {
    const url = r.url();
    if (url.includes(`/sessions/${CHAT_A}/messages`)) aMessagesReqs.push(url);
  });

  await waitForReady(page);
  await openSidebar(page);

  // ── Prime: first switch-in does the full-page fetch + fills IDB ───
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);
  const primed = await transcriptText(page);
  assert(
    primed.some(t => t.includes('planes fly in the sky')),
    `priming switch-in should render all 6 base rows. Got: ${JSON.stringify(primed)}`,
  );
  log('primed cache with 6 rows via full fetch ✓');

  // ── Server gains 2 new rows + an in-flight turn while we're away ──
  mock.addChat(CHAT_A, {
    title: 'Delta chat',
    source: 'sidekick',
    messages: stamp([
      ...BASE_MESSAGES,
      { role: 'user',      content: NEW_USER_TEXT },   // id 1006
      { role: 'assistant', content: NEW_REPLY_TEXT },  // id 1007
    ]),
    lastActiveAt: Date.now(),
  });
  mock.setInflight(CHAT_A, [
    {
      type: 'user_message',
      chat_id: CHAT_A,
      message_id: 'umsg_delta_inflight',
      text: INFLIGHT_TEXT,
      timestamp: Date.now() / 1000,
    },
  ]);

  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);
  log('switched A → B');

  aMessagesReqs.length = 0;

  // ── Switch back: must be a delta fetch, not a full page ───────────
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);

  const deltaReqs = aMessagesReqs.filter(u => u.includes('after='));
  // Cursor is the cached tail id. That tail is 1005 when the switch
  // wins the race against TFC-B's background tail-refresh sweep, or
  // 1007 when the sweep has already merged the 2 new rows into cache
  // first (it now writes a non-partial cache for a complete small
  // chat, so delta resume legitimately pages from the newer tail).
  // Both are correct delta fetches — the invariant #191 guards is the
  // ABSENCE of a bare full-page fetch (asserted next), not the exact
  // cursor value.
  assert(
    deltaReqs.some(u => /after=100[57]\b/.test(u)),
    `switch-back should fetch ?after=<cached tail id> (1005 or 1007). ` +
    `Requests: ${JSON.stringify(aMessagesReqs)}`,
  );
  // A bare request (no query) is the full-page fetch the delta path
  // replaces. ?limit=12 warm-prefetches and ?after pages are fine.
  const fullPageReqs = aMessagesReqs.filter(u => !u.includes('?'));
  assert(
    fullPageReqs.length === 0,
    `switch-back must NOT re-download the full newest page. ` +
    `Full-page requests: ${JSON.stringify(fullPageReqs)}`,
  );
  log(`delta fetch used ?after=<tail> (${JSON.stringify(deltaReqs)}), no full-page fetch ✓`);

  const after = await transcriptText(page);
  assert(
    after.some(t => t.includes('hello there')),
    `merge must preserve cached head rows. Got: ${JSON.stringify(after)}`,
  );
  assert(
    after.some(t => t.includes(NEW_REPLY_TEXT)),
    `delta rows must render after merge. Got: ${JSON.stringify(after)}`,
  );
  log('transcript shows cached head + 2 delta rows ✓');

  assert(
    after.some(t => t.includes(INFLIGHT_TEXT.slice(0, 20))),
    `tail delta page must carry inflight (mid-turn catch-up). ` +
    `Got: ${JSON.stringify(after)}`,
  );
  log('inflight bubble rendered through the delta path ✓');
}
