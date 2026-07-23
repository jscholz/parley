// Scenario: a slash command invoked twice produces BYTE-IDENTICAL
// assistant replies minutes apart — BOTH must survive the durable
// merge after a hard refresh.
//
// Field bug (2026-07-23, screenshots verified): the /reasoning
// command's reply vanished from the transcript after the durable
// merge. /reasoning emits the same text on every invocation (same
// settings → same reply), and the projection's old
// pickDurableContentWinners collapsed identical-content assistant
// rows to ONE winner across the entire window UNCONDITIONALLY —
// built for reconcile-artifact twins, never anticipating legitimate
// repeats. Since the 07-16 change the winner was the EARLIEST copy,
// so every newer identical reply was dropped on re-projection: the
// post-refresh pre-merge paint showed both bubbles (dedup hadn't
// run), then the newer one vanished. /agents survived only because
// its text varies.
//
// Fix under test: projection.ts pickDuplicateLosers — assistant rows
// now get the same windowed, artifact-aware dedup as user rows; two
// annotated identical replies minutes apart land in separate
// clusters and BOTH render.
//
// Test plan (mocked):
//   1. Seed a chat with turn 1: user '/reasoning' + its reply,
//      3 minutes ago, both annotated (sidekick_id present) — the
//      state after the first invocation was persisted.
//   2. Click into the chat, then send '/reasoning' again. The mock's
//      auto-reply echoes `[mock] echo: <text>` — byte-identical to
//      the seeded reply — and persists the new durable row at "now".
//   3. Hard-refresh-equivalent: page.reload(). Boot refetches
//      /messages, which now returns BOTH identical assistant rows.
//   4. After the durable merge settles, assert BOTH reply bubbles
//      are present (and STAY present — the field symptom was
//      paint-then-vanish, so re-assert after a settle delay).

import { waitForReady, openSidebar, clickRow, send, assert, pollUntil, dumpLines } from './lib.mjs';

export const NAME = 'slash-command-reply-repeats';
export const DESCRIPTION = 'Byte-identical slash-command replies minutes apart both survive the durable merge after reload';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-slash-repeats';
const SLASH_TEXT = '/reasoning';
// Must match the mock auto-reply shape (`[mock] echo: <text>`) so the
// second invocation's reply is BYTE-IDENTICAL to the seeded first one.
const REPLY_TEXT = `[mock] echo: ${SLASH_TEXT}`;

export function MOCK_SETUP(mock) {
  const now = Date.now() / 1000;
  mock.addChat(CHAT_ID, {
    title: 'Slash repeat repro',
    messages: [
      // Turn 1 — the first /reasoning invocation, persisted 3 min ago.
      // Both rows annotated (sidekick_id present), mirroring a healthy
      // write-through turn. 3 min >> the projection's 30s dedup
      // cluster window, so the repeat is a legitimate separate turn.
      { role: 'user', content: SLASH_TEXT, message_id: 'umsg_seed_reasoning',
        sidekick_id: 'umsg_seed_reasoning', timestamp: now - 180 },
      { role: 'assistant', content: REPLY_TEXT, message_id: 'msg_seed_reasoning',
        sidekick_id: 'msg_seed_reasoning', timestamp: now - 179 },
    ],
    lastActiveAt: Date.now() - 180_000,
  });
}

async function replyBubbleCount(page, needle) {
  return page.evaluate((t) =>
    Array.from(document.querySelectorAll('#transcript .line.agent'))
      .filter((el) => (el.textContent || '').includes(t))
      .length,
    needle,
  );
}

export default async function run({ page, log, fail }) {
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 5_000 });
  await clickRow(page, CHAT_ID);

  // Turn 1 renders from history.
  await pollUntil(page, (t) =>
    (document.getElementById('transcript')?.textContent || '').includes(t),
    REPLY_TEXT, { label: 'seeded reply never rendered' });
  const baseline = await replyBubbleCount(page, REPLY_TEXT);
  assert(baseline === 1, `baseline: expected 1 reply bubble from history, got ${baseline}`);
  log('turn 1 (seeded, 3 min ago) rendered ✓');

  // Invoke the slash command again — auto-reply echoes the SAME text
  // and persists the second durable assistant row at "now".
  await send(page, SLASH_TEXT);
  await pollUntil(page, (t) =>
    document.querySelectorAll(`#transcript .line:not(.agent)`).length >= 2
    && Array.from(document.querySelectorAll('#transcript .line'))
      .filter((el) => (el.textContent || '').includes(t)).length >= 3,
    SLASH_TEXT, { label: 'second /reasoning turn never landed' });
  log('turn 2 sent, echo + reply delivered ✓');
  // Let reply_final + the mock's durable persist settle before reload.
  await page.waitForTimeout(600);

  // Hard-refresh-equivalent: reload → boot refetch → durable merge now
  // sees BOTH byte-identical assistant rows, minutes apart.
  await page.reload();
  await waitForReady(page);
  await pollUntil(page, (t) =>
    (document.getElementById('transcript')?.textContent || '').includes(t),
    REPLY_TEXT, { label: 'transcript never re-rendered after reload' });

  // Both replies must be present once the merge settles…
  await pollUntil(page, (t) =>
    Array.from(document.querySelectorAll('#transcript .line.agent'))
      .filter((el) => (el.textContent || '').includes(t)).length >= 2,
    REPLY_TEXT, {
      timeout: 8_000,
      label: 'second identical reply bubble missing after the durable merge',
    });
  // …and STAY present. The field symptom was paint-then-vanish: the
  // pre-merge paint showed both bubbles, then re-projection dropped
  // the newer copy. Settle, then re-assert.
  await page.waitForTimeout(800);
  const after = await replyBubbleCount(page, REPLY_TEXT);
  if (after !== 2) {
    log(`DOM dump:\n${await dumpLines(page, 20)}`);
    fail(`expected BOTH identical reply bubbles after the durable merge settled, got ${after}. `
      + 'Bug: identical-content assistant collapse ate a legitimate slash-command repeat.');
  }
  // The user side must also keep both far-apart identical sends.
  const userCount = await page.evaluate((t) =>
    Array.from(document.querySelectorAll('#transcript .line:not(.agent):not(.system)'))
      .filter((el) => (el.textContent || '').includes(t)).length,
    SLASH_TEXT);
  assert(userCount >= 2, `expected both '/reasoning' user bubbles, got ${userCount}`);
  log(`after reload + merge settle: ${after} reply bubbles, ${userCount} user bubbles ✓`);
}
