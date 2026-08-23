// Field bug 2026-05-11 — user bubble loses its newlines.
//
// Repro: type a multi-line message into the composer (Shift+Enter
// separated lines, blank lines between paragraphs), hit send.
// First render via renderedMessages.upsert's CREATE path goes
// through chat.addLine which correctly does
// `escapeHtml(text).replace(/\n/g, '<br>')`. Then the upstream's
// user_message echo round-trips back, hits the UPDATE-EXISTING
// path in renderedMessages.upsert, which called `escapeText(text)`
// — escaped HTML but did NOT convert \n → <br>. So the second
// render wiped the <br>s and collapsed the prompt into a wall of
// text.
//
// Fix: src/renderedMessages.ts:escapeText now does both escape AND
// newline conversion so update-existing matches the create path.
//
// This smoke pins the invariant: after a send + user_message
// roundtrip, the bubble DOM contains <br> tags AND the rendered
// text shows visible newlines (offsetHeight reflects multiple
// rendered lines).

import { waitForReady, openSidebar, clickRow, send, assert } from './lib.mjs';

export const NAME = 'user-bubble-preserves-newlines';
export const DESCRIPTION = 'multi-line composer text renders with <br>s in the bubble; survives the user_message echo upsert';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-newline-preserve';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Newline preservation test',
    messages: [
      { role: 'user', content: 'seed',
        parley_id: 'umsg_newline_seed',
        timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000, polling: 50 },
  );
  log('chat opened ✓');

  // Multi-line text: three paragraphs, blank lines between. The exact
  // text matters for the count assertions below.
  const MULTILINE_TEXT = 'line one\nline two\n\nparagraph two starts\nstill paragraph two\n\nthird paragraph';
  // page.fill respects \n in input — they land as real newlines in the
  // textarea's value. send() then triggers the click handler which
  // reads composerInput.value as-is.
  await page.fill('#composer-input', MULTILINE_TEXT);
  await page.evaluate(() => document.getElementById('composer-send')?.click());

  // Wait for the optimistic bubble (create path) to land. Match by
  // any .line.s0 NOT belonging to the seed.
  await page.waitForFunction(
    (marker) => {
      const bubbles = Array.from(document.querySelectorAll('#transcript .line.s0'));
      return bubbles.some((b) => (b.textContent || '').includes(marker));
    },
    'line one',
    { timeout: 3_000, polling: 50 },
  );

  // Mock auto-reply fires the user_message broadcast at +50ms — that's
  // the round-trip that lands on the UPDATE-EXISTING path. Wait long
  // enough that the second upsert has definitely run.
  await page.waitForTimeout(400);

  // The optimistic-bubble + user_message echo both target the same
  // messageId (umsg_*). The bubble's .text span should now have <br>
  // tags AND should render across multiple visible lines.
  const state = await page.evaluate((marker) => {
    const bubbles = Array.from(document.querySelectorAll('#transcript .line.s0'));
    const target = bubbles.find((b) => (b.textContent || '').includes(marker));
    if (!target) return { found: false };
    const textSpan = target.querySelector('.text');
    return {
      found: true,
      html: textSpan?.innerHTML || '',
      textContent: textSpan?.textContent || '',
      offsetHeight: textSpan?.offsetHeight || 0,
      brCount: textSpan ? textSpan.querySelectorAll('br').length : 0,
    };
  }, 'line one');

  assert(state.found, 'optimistic bubble for the multi-line message not found');
  log(`bubble html (first 100): ${state.html.slice(0, 100)}…`);
  log(`<br> count: ${state.brCount}, rendered height: ${state.offsetHeight}px`);

  // The text has 6 explicit \n (two are doubled for the blank-line
  // paragraph breaks) → expect 6 <br>s after the round-trip. If
  // escapeText regresses (drops the \n → <br> step), brCount would
  // be 0 and the line would render as a single-line wall of text.
  assert(
    state.brCount === 6,
    `expected exactly 6 <br> tags (one per newline in the source text); got ${state.brCount}. ` +
    `Most likely cause: renderedMessages.escapeText regressed — UPDATE-EXISTING upsert is now ` +
    `stripping newlines that the CREATE path correctly inserted.`,
  );
  log('multi-line bubble preserved newlines across the user_message round-trip ✓');
}
