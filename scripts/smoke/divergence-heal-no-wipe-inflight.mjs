// Regression guard: divergence-heal wipes inflight bubbles.
//
// Symptom: [chat-resume] divergence detected: DOM has 75 bubbles vs
// server 41 — clearing + re-rendering.
//
// The divergence-heal in replaySessionMessages compares finalized DOM
// bubble count to server message count and re-renders from scratch
// when DOM is materially higher. The historical concern was a dedup-
// mismatch bug that leaked stale bubbles. But the check has a blind
// spot: bubbles rendered from INFLIGHT ENVELOPES (proxy in-memory
// cache) count toward the DOM total but aren't in state.db yet, so
// the heal trips and wipes them.
//
// This smoke pins the precise field-visible regression: if /messages
// returns N state.db messages + K inflight envelopes that render into
// finalized bubbles, the user-visible transcript must show all N+K
// bubbles, NOT just N (the wiped-and-re-rendered state.db set).

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'divergence-heal-no-wipe-inflight';
export const DESCRIPTION = 'Divergence-heal must not wipe bubbles rendered from inflight envelopes';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-divhealchat-a';

export function MOCK_SETUP(mock) {
  // Pre-existing state.db content — short transcript.
  mock.addChat(CHAT_A, {
    title: 'Chat A — divergence heal test',
    source: 'parley',
    messages: [
      { role: 'user', content: 'A: state.db user msg #1', timestamp: Date.now() / 1000 - 3600 },
      { role: 'assistant', content: 'A: state.db agent msg #1', timestamp: Date.now() / 1000 - 3599 },
      { role: 'user', content: 'A: state.db user msg #2', timestamp: Date.now() / 1000 - 3500 },
      { role: 'assistant', content: 'A: state.db agent msg #2', timestamp: Date.now() / 1000 - 3499 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  // Stage a substantial inflight envelope set — 5 finalized user+
  // assistant pairs (10 envelopes) that the proxy "has but state.db
  // doesn't yet." These render as 10 finalized bubbles on resume.
  // With 4 state.db + 10 inflight = 14 in DOM, server count = 4,
  // delta = 10 → way over the +1 tolerance, heal wipes them.
  const inflightEnvelopes = [];
  for (let i = 1; i <= 5; i++) {
    const userMsgId = `inflight-umsg-${i}`;
    const replyMsgId = `inflight-rmsg-${i}`;
    inflightEnvelopes.push({
      type: 'user_message',
      chat_id: CHAT_A,
      message_id: userMsgId,
      text: `A: inflight user msg #${i}`,
    });
    inflightEnvelopes.push({
      type: 'reply_final',
      chat_id: CHAT_A,
      message_id: replyMsgId,
      text: `A: inflight reply #${i}`,
    });
  }
  mock.setInflight(CHAT_A, inflightEnvelopes);
}

async function transcriptStats(page) {
  return page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('#transcript .line'));
    return {
      total: lines.length,
      finalized: lines.filter(l => !l.classList.contains('pending')
                                && !l.classList.contains('failed')
                                && !l.classList.contains('streaming')).length,
      msgIds: lines.map(l => l.getAttribute('data-message-id') || '').filter(Boolean),
      sample: lines.slice(0, 20).map(l => ({
        cls: l.className,
        text: (l.querySelector('.text')?.textContent || '').trim().slice(0, 40),
      })),
    };
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);

  const stats = await transcriptStats(page);
  log(`transcript after switch-in: total=${stats.total} finalized=${stats.finalized}`);
  log(`msgIds: ${JSON.stringify(stats.msgIds)}`);

  // We expect 4 state.db + 5 inflight user_messages = 9 user-visible
  // bubbles, plus 5 inflight reply_final = 5 more agent bubbles. The
  // exact count depends on whether each envelope creates a finalized
  // bubble; reply_final WITHOUT a prior reply_delta might create an
  // empty-text bubble.
  //
  // Minimum bubble survival assertion: every inflight user msg must
  // be a visible line. If divergence-heal wiped them, they'd be
  // missing.
  for (let i = 1; i <= 5; i++) {
    const marker = `inflight user msg #${i}`;
    const found = await page.evaluate((m) => {
      return Array.from(document.querySelectorAll('#transcript .line'))
        .some(l => (l.textContent || '').includes(m));
    }, marker);
    assert(
      found,
      `BUG: inflight user msg #${i} was rendered but then wiped by divergence-heal. ` +
      `Sample of current transcript: ${JSON.stringify(stats.sample)}`,
    );
  }
  log(`✓ all 5 inflight user_message bubbles survived`);
}
