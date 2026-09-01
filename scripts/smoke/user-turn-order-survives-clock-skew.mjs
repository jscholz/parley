// Field 2026-09-01 (walking, dictation early-fire). His words:
//
//   "I had a dictation early fire... when it's sent and I kept talking, I
//    thought that the session was wedged and it wasn't recording my input
//    — until I scrolled up and noticed that the input bubble was actually
//    ABOVE the bubble that had landed."
//
// The new bubble rendered above the just-sent one, off-screen above the
// fold, which reads exactly like the app stopped hearing him — the worst
// possible false signal for this product.
//
// Cause: the projection sorted purely on wall-clock, but the two sides
// are stamped by DIFFERENT clocks. A still-optimistic bubble carries the
// CLIENT's Date.now() at mint; the message before it carries the SERVER's
// created_at once its echo / durable row lands. Skew (or a state.db row
// stamped at turn-END batch write instead of at receipt) puts the OLDER
// message later on the number line and the two flip.
//
// Ordering between two of HIS turns is causal — turn N+1 was spoken after
// turn N was sent — so the projection now floors a locally-minted bubble
// above every message this client already sent (causalUserFloor).
//
// Shape here, end-to-end through the real send path:
//   1. Open a seeded chat with one prior turn.
//   2. Send utterance A through the composer (client-minted umsg_ key,
//      sentAt = this device's clock).
//   3. Echo A back and republish durable with A stamped SKEW_MS AHEAD of
//      the client clock; switch away/back to force the /messages refresh.
//      Wait on the bubble's own rendered timestamp title to prove the
//      skewed durable row actually landed — not a sleep.
//   4. Send utterance B ("keep talking"). Its optimistic bubble is minted
//      at client-now, which is BEHIND A's server stamp.
//   5. Assert on RENDERED DOM order: B is below A.
//
// SKEW_MS is 5 minutes only so step 3's wait has something visible to
// latch onto (HH:MM changes); the flip needs no more than the dispatch →
// echo latency to happen for real.

import {
  waitForReady, openSidebar, send, clickRow, pollUntil, assert, dumpLines,
} from './lib.mjs';

export const NAME = 'user-turn-order-survives-clock-skew';
export const DESCRIPTION = 'A bubble minted after a send renders BELOW it even when the server stamps the send later';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-user-turn-order';
const ANCHOR_ID = 'mock-chat-user-turn-order-anchor';
const SKEW_MS = 5 * 60_000;
const TEXT_A = 'first utterance that already landed';
const TEXT_B = 'second utterance he kept talking through';
const PRIOR_SEC = Date.now() / 1000 - 300;

/** Prior turn — the transcript is never empty in the field shape, and a
 *  chat where the agent has already spoken is what the projection's
 *  first-turn placeholder gate expects. */
const priorTurn = () => [
  { role: 'user', content: 'earlier question', parley_id: 'umsg_prior_turn_order', timestamp: PRIOR_SEC },
  { role: 'assistant', content: 'earlier answer', parley_id: 'msg_prior_turn_order', timestamp: PRIOR_SEC + 5 },
];

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Turn order under clock skew',
    source: 'parley',
    messages: priorTurn(),
    lastActiveAt: Date.now() - 1000,
  });
  // Anchor chat: switching away and back is what forces the /messages
  // refetch that delivers the skewed durable row.
  mock.addChat(ANCHOR_ID, {
    title: 'Anchor',
    source: 'parley',
    messages: [
      { role: 'assistant', content: 'anchor-marker', parley_id: 'msg_anchor_turn_order', timestamp: PRIOR_SEC },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  // Drive every envelope by hand — an auto-reply would retire the
  // optimistic bubbles we are trying to order.
  mock.setAutoReplyEnabled(false);
}

/** Rendered user bubbles, top to bottom: their reconcile key + text. */
function readUserBubbles(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line.s0'))
      .map(el => ({
        key: el.getAttribute('data-key'),
        text: (el.querySelector('.line-text')?.textContent || el.textContent || '').trim().slice(0, 60),
        ts: el.querySelector('.line-ts')?.getAttribute('title') || null,
      })),
  );
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await pollUntil(
    page,
    () => (document.getElementById('transcript')?.textContent || '').includes('earlier answer'),
    undefined,
    { timeout: 6_000, label: 'seeded chat never rendered' },
  );

  // ── 1. Send utterance A through the real composer path ───────────────
  await send(page, TEXT_A);
  const afterA = await pollUntil(
    page,
    (text) => {
      const hit = Array.from(document.querySelectorAll('#transcript .line.s0'))
        .find(el => (el.textContent || '').includes(text));
      if (!hit) return null;
      const key = hit.getAttribute('data-key');
      const title = hit.querySelector('.line-ts')?.getAttribute('title') || null;
      return key ? { key, title } : null;
    },
    TEXT_A,
    { timeout: 8_000, label: 'optimistic bubble for utterance A never rendered' },
  );
  const keyA = afterA.key;
  log(`utterance A optimistic: key=${keyA} ts-title=${JSON.stringify(afterA.title)}`);
  assert(
    keyA.startsWith('umsg_'),
    `expected a client-minted umsg_ key for the optimistic bubble, got ${keyA}`,
  );

  // ── 2. Server acknowledges A, and persists it with a SKEWED stamp ─────
  mock.pushEnvelope({ type: 'user_message', chat_id: CHAT_ID, message_id: keyA, text: TEXT_A });
  mock.addChat(CHAT_ID, {
    title: 'Turn order under clock skew',
    source: 'parley',
    messages: [
      ...priorTurn(),
      // The trigger: server's created_at for A is AHEAD of this device's
      // clock. Same row, same key — only the timestamp is skewed.
      { role: 'user', content: TEXT_A, parley_id: keyA, timestamp: (Date.now() + SKEW_MS) / 1000 },
    ],
    lastActiveAt: Date.now(),
  });

  // Force the durable refresh, then WAIT for proof it landed: A's own
  // rendered timestamp must move off the optimistic one.
  await clickRow(page, ANCHOR_ID);
  await pollUntil(
    page,
    () => (document.getElementById('transcript')?.textContent || '').includes('anchor-marker'),
    undefined,
    { timeout: 6_000, label: 'anchor chat never rendered' },
  );
  await clickRow(page, CHAT_ID);
  await pollUntil(
    page,
    (arg) => {
      const el = document.querySelector(`#transcript .line.s0[data-key="${arg.key}"]`);
      if (!el) return false;
      const title = el.querySelector('.line-ts')?.getAttribute('title') || null;
      return !!title && title !== arg.title;
    },
    { key: keyA, title: afterA.title },
    { timeout: 10_000, label: 'the skewed durable row for A never reached the bubble' },
  );
  const skewed = await readUserBubbles(page);
  log(`after durable refresh: ${JSON.stringify(skewed)}`);

  // ── 3. He keeps talking: a fresh bubble minted on the CLIENT clock ────
  await send(page, TEXT_B);
  const bubbles = await pollUntil(
    page,
    (text) => {
      const rows = Array.from(document.querySelectorAll('#transcript .line.s0'))
        .map(el => ({
          key: el.getAttribute('data-key'),
          text: (el.textContent || '').trim(),
        }));
      return rows.some(r => r.text.includes(text)) ? rows : null;
    },
    TEXT_B,
    { timeout: 8_000, label: 'optimistic bubble for utterance B never rendered' },
  );

  // ── 4. Assert on RENDERED order ──────────────────────────────────────
  const iA = bubbles.findIndex(r => r.text.includes(TEXT_A));
  const iB = bubbles.findIndex(r => r.text.includes(TEXT_B));
  log(`rendered user bubbles: ${JSON.stringify(bubbles.map(r => r.key))}`);
  log(`  index(A)=${iA} index(B)=${iB}`);
  assert(iA >= 0 && iB >= 0, `both utterances must be on screen (A=${iA}, B=${iB})`);
  if (iB <= iA) {
    // Only pay for the dump on the failing path.
    assert(
      false,
      `the bubble he is still speaking must render BELOW the one that just landed — `
      + `got index(A)=${iA}, index(B)=${iB}. Lines:\n${await dumpLines(page, 20)}`,
    );
  }

  log('user-turn-order-survives-clock-skew: skewed durable row landed ✓ new bubble stayed below it ✓');
}
