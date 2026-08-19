// Regression guard: every short turn renders TWICE. State.db's
// assistant row has `sidekick_id="sk-<unix>-<seq>"` (synthetic shape,
// minted by the plugin's `_next_message_id()` at __init__.py:1432
// when the envelope had no message_id). Live SSE envelopes for the
// same logical turn carry an envelope-shape `message_id` (e.g.
// `msg_xxx`). The two ids don't match, the projection's key-based
// dedup sees them as different rows, both render.
//
// This is the SAME failure CLASS as the earlier inflight-vs-no-link-
// durable dupe but a different SHAPE: there, durable's sidekick_id
// was missing; here it's present but doesn't equal the envelope's
// message_id. The projection content-match fallback I added earlier
// only fires when sidekick_id is absent, so it doesn't catch this.
//
// What this smoke pins: when (durable.sidekick_id != inflight.message_id)
// but content matches, projection must still render ONE bubble.
//
// Test plan (mocked):
//   1. Pre-seed chat with: user_a, assistant_a (sidekick_id="sk-X-1"),
//      then a NEW user message ready to be sent live.
//   2. Click into chat → assert 2 durable bubbles render.
//   3. Send a NEW user message.
//   4. Mock auto-replies via SSE with envelope-shape message_id and
//      same content as the SECOND assistant turn we'll add to durable.
//   5. Simulate the state.db catching up: add the assistant row to
//      durable with sidekick_id="sk-Y-2" (synthetic shape, NOT the
//      envelope message_id).
//   6. Force a /messages refresh by switching away + back.
//   7. Assert: exactly ONE assistant bubble for the new turn.

import {
  waitForReady, openSidebar, send, clickRow, assert,
} from './lib.mjs';

export const NAME = 'inflight-dedups-against-synthetic-parley-id';
export const DESCRIPTION = 'Projection dedups inflight reply against durable row whose sidekick_id has synthetic sk-<unix>-<seq> shape';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-synth-sid';
const ANCHOR_CHAT = 'mock-chat-synth-anchor';
const PROMPT = 'short reply please';
const REPLY = 'Hey — received.';
const ENVELOPE_MSG_ID = 'msg_envelope_shape_aaa';
const SYNTHETIC_SID = `sk-${Math.floor(Date.now() / 1000)}-1`;

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Synthetic sidekick_id dupe repro',
    source: 'sidekick',
    messages: [
      // pre-existing turn so the chat isn't empty.
      { role: 'user', content: 'earlier msg', sidekick_id: 'umsg_earlier',
        timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'earlier reply', sidekick_id: 'msg_earlier',
        timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 5000,
  });
  // Anchor to force a /messages refetch on switch-back.
  mock.addChat(ANCHOR_CHAT, {
    title: 'Anchor',
    source: 'sidekick',
    messages: [
      { role: 'user', content: 'a', sidekick_id: 'umsg_anchor_synth',
        timestamp: Date.now() / 1000 - 30 },
      { role: 'assistant', content: 'b', sidekick_id: 'msg_anchor_synth',
        timestamp: Date.now() / 1000 - 29 },
    ],
    lastActiveAt: Date.now() - 10000,
  });
  mock.setAutoReplyEnabled(false);
}

async function countAssistantBubblesWith(page, text) {
  return page.evaluate((needle) =>
    Array.from(document.querySelectorAll('#transcript .line.agent'))
      .filter(el => (el.textContent || '').includes(needle))
      .length,
    text,
  );
}

async function lineDump(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line')).map(el => ({
      cls: el.className,
      key: el.getAttribute('data-key') || null,
      text: (el.textContent || '').trim().slice(0, 60),
    })),
  );
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  // Wait for the pre-existing 2 bubbles to render.
  await page.waitForFunction(
    () => /earlier reply/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 80 },
  );

  // Send a new user message.
  await send(page, PROMPT);
  await page.waitForFunction(
    (p) => (document.getElementById('transcript')?.textContent || '').includes(p),
    PROMPT,
    { timeout: 5_000, polling: 100 },
  );

  // Live SSE: reply_delta + reply_final with envelope-shape message_id.
  mock.pushEnvelope({
    type: 'reply_delta',
    chat_id: CHAT_ID,
    message_id: ENVELOPE_MSG_ID,
    text: REPLY,
  });
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: CHAT_ID,
    message_id: ENVELOPE_MSG_ID,
    text: REPLY,
  });

  // Wait for the inflight bubble to land.
  await page.waitForFunction(
    (r) => (document.getElementById('transcript')?.textContent || '').includes(r),
    REPLY,
    { timeout: 4_000, polling: 100 },
  );

  // Now simulate state.db catching up: re-seed the chat with the new
  // turn's assistant row, BUT with the synthetic sk-<unix>-<seq>
  // sidekick_id (NOT the envelope's message_id). Mirrors what the
  // plugin currently does when envelope handler doesn't carry a
  // message_id by the time _persist_response writes through.
  mock.addChat(CHAT_ID, {
    title: 'Synthetic sidekick_id dupe repro',
    source: 'sidekick',
    messages: [
      { role: 'user', content: 'earlier msg', sidekick_id: 'umsg_earlier',
        timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'earlier reply', sidekick_id: 'msg_earlier',
        timestamp: Date.now() / 1000 - 59 },
      { role: 'user', content: PROMPT, sidekick_id: 'umsg_new',
        timestamp: Date.now() / 1000 - 2 },
      // THIS is the bug shape: synthetic sidekick_id, NOT the envelope's
      // message_id. The projection has no way to know this row IS the
      // inflight reply by key alone.
      { role: 'assistant', content: REPLY, sidekick_id: SYNTHETIC_SID,
        timestamp: Date.now() / 1000 - 1 },
    ],
    lastActiveAt: Date.now(),
  });

  // Force a /messages refetch by switching away + back.
  await clickRow(page, ANCHOR_CHAT);
  // Wait for anchor's assistant bubble "b" to render. textContent is
  // the only thing we can reliably grep — selector classes are on
  // separate elements.
  await page.waitForFunction(() => {
    const bubbles = Array.from(document.querySelectorAll('#transcript .line.agent'));
    return bubbles.some(b => (b.textContent || '').trim().startsWith('Clawdian:') &&
                              (b.textContent || '').includes('b'));
  }, null, { timeout: 4_000, polling: 80 });
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    (r) => (document.getElementById('transcript')?.textContent || '').includes(r),
    REPLY,
    { timeout: 4_000, polling: 100 },
  );

  // Assertion: exactly ONE assistant bubble with the reply text.
  const count = await countAssistantBubblesWith(page, REPLY);
  const dump = await lineDump(page);
  log(`assistant bubbles with reply text: ${count}`);
  log(`  dump: ${JSON.stringify(dump)}`);
  assert(
    count === 1,
    `expected exactly 1 bubble with "${REPLY}" (synthetic sidekick_id vs envelope message_id should still dedup); got ${count}. dump: ${JSON.stringify(dump)}`,
  );
}
