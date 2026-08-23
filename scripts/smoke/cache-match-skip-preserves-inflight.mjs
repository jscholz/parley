// Regression guard: switching away and back twice cleared the inflight
// cache, losing in-flight bubbles.
//
// Root cause located in sessionDrawer.ts at the
// `server-render-skip-cache-match` early-return. When the cache
// already rendered N messages AND the server fetch returns the same
// N, the optimization skips the entire onResumeCb call — which also
// skips replayInflight. Any inflight envelopes (mid-turn user echo,
// reply_delta, tool_call) get dropped on the floor.
//
// This smoke pins the precise shape: chat A has 4 pre-persisted
// messages on the server. The proxy's in-memory inflight cache holds
// one extra user_message envelope (turn 3, mid-flight). The PWA
// switches into A, then to B, then back to A. On the SECOND switch-in:
//   - sessionCache returns 4 cached messages → renders them
//   - server fetch returns the same 4 messages + 1 inflight envelope
//   - cached.length (4) === messages.length (4) → cache-match skip
//   - Without the fix: replayInflight is bypassed → inflight bubble lost
//   - With the fix: inflight envelopes still replayed → bubble survives
//
// Crucial: this smoke does NOT call send() — that would POST to
// /messages, which the mock persists to state.db immediately, making
// server return 5 not 4 (counts mismatch, cache-match path never
// triggers). Inflight envelopes are seeded directly via setInflight.
//
// Sibling smoke `multi-switch-inflight-bubble-survival.mjs` pins the
// two-round-trip shape against a fresh-chat-A (0 persisted messages).
// This smoke covers the orthogonal "persisted chat with new in-flight
// turn" path — together they cover both observed field-bug shapes.

import {
  waitForReady, openSidebar, clickRow, assert,
} from './lib.mjs';

export const NAME = 'cache-match-skip-preserves-inflight';
export const DESCRIPTION = 'cache-match skip path replays inflight envelopes (field bug 2026-05-12: turn 3 user bubble dropped when cache/server message counts match)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-cache-match-chat';
const CHAT_B = 'mock-cache-match-other';
const INFLIGHT_TEXT = 'can you check the calendar for me';
const INFLIGHT_MSG_ID = 'umsg_inflight_turn3';

export function MOCK_SETUP(mock) {
  // Chat A: 2 prior turns already persisted. Server keeps returning
  // these 4 messages on every /messages fetch. The inflight envelope
  // for "turn 3" sits ONLY in the proxy's in-memory cache — exactly
  // the shape the field bug requires.
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(CHAT_A, {
    title: 'Working chat',
    source: 'parley',
    messages: [
      { role: 'user',      content: 'hello',               parley_id: 'm1', message_id: 'm1', timestamp: t0 + 0 },
      { role: 'assistant', content: 'hi! how can I help?', parley_id: 'm2', message_id: 'm2', timestamp: t0 + 1 },
      { role: 'user',      content: 'what time is it',     parley_id: 'm3', message_id: 'm3', timestamp: t0 + 2 },
      { role: 'assistant', content: 'morning',             parley_id: 'm4', message_id: 'm4', timestamp: t0 + 3 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  // Chat B — somewhere to switch TO so the away-and-back path runs.
  mock.addChat(CHAT_B, {
    title: 'Other chat',
    source: 'parley',
    messages: [
      { role: 'user', content: 'hi', timestamp: Date.now() / 1000 - 200 },
      { role: 'assistant', content: 'hello!', timestamp: Date.now() / 1000 - 199 },
    ],
    lastActiveAt: Date.now() - 80_000,
  });
  // Seed the inflight envelope directly — this is the turn-3 user
  // message the proxy is holding in memory because reply_final hasn't
  // landed yet to promote it to state.db.
  mock.setInflight(CHAT_A, [
    {
      type: 'user_message',
      chat_id: CHAT_A,
      message_id: INFLIGHT_MSG_ID,
      text: INFLIGHT_TEXT,
      timestamp: Date.now() / 1000,
    },
  ]);
}

async function getUserBubbles(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line.s0, #transcript .line.user'))
      .map(el => ({
        msgId: el.getAttribute('data-message-id') || '',
        text: (el.textContent || '').trim().slice(0, 80),
      }))
  );
}

async function dumpTranscript(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line'))
      .map(el => ({
        msgId: el.getAttribute('data-message-id') || '',
        cls: el.className,
        text: (el.textContent || '').trim().slice(0, 60),
      }))
  );
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // ── First switch-in: primes sessionCache with the 4 server msgs ────
  // Cache is empty, so cache-render path is skipped (length 0); the
  // server-fetch render runs, replays inflight, leaves cache holding 4.
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1200);

  const initial = await getUserBubbles(page);
  const initialHasInflight = initial.some(b => b.text.includes(INFLIGHT_TEXT.slice(0, 15)));
  assert(
    initialHasInflight,
    `priming switch-in: inflight envelope should produce a user bubble. ` +
    `Got: ${JSON.stringify(initial)}\nTranscript: ${JSON.stringify(await dumpTranscript(page))}`,
  );
  log(`priming switch-in: 4 persisted msgs + inflight bubble rendered ✓`);

  // ── Switch A → B → A — THE cache-match path ───────────────────────
  // Cache now has 4 messages; server still returns 4 messages + 1
  // inflight. cached.length === messages.length triggers the skip.
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);
  log(`switched A → B`);

  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);

  const afterSwitchBack = await getUserBubbles(page);
  const survived = afterSwitchBack.some(b => b.text.includes(INFLIGHT_TEXT.slice(0, 15)));
  assert(
    survived,
    `BUG (field bug 2026-05-12): cache-match skip dropped the inflight user bubble. ` +
    `Bubbles after switch-back: ${JSON.stringify(afterSwitchBack)}\n` +
    `Full transcript: ${JSON.stringify(await dumpTranscript(page))}`,
  );
  log(`switch-back through cache-match path: inflight bubble preserved ✓`);
}
