// Regression guard: sent a message in the active chat,
// got TWO identical assistant bubbles. Screenshot showed the same
// "Hey — received." text rendered twice for a single response.
//
// Repro shape: when the plugin mirrors the assistant row into
// state.db / parley.db but the link write doesn't include a
// sidekick_id (whether because the link table write failed, raced,
// or hasn't run yet), the projection sees TWO rows for the same
// message:
//   - durable assistant row keyed by integer id (e.g. "101")
//   - inflight reply_final/reply_delta keyed by SSE message_id
//     (e.g. "msg_xyz")
// Different keys → both pass the key-based dedup → two bubbles.
//
// This is the regression from the earlier "background-reply-first-
// switch-shows-content" fix (commit 71fcb54). That fix preserved
// inflight on switch-in when sidekick_id was missing, which fixed
// the blank-content bug but reopened the original ghost-tail
// duplication scenario for active-chat sends.
//
// The proper fix layers a content-match fallback in the projection:
// if a durable assistant row has no sidekick_id but its content
// matches an inflight assistant spec's text, drop the inflight
// spec. Durable owns the bubble.
//
// Test plan (mocked):
//   1. Click new chat.
//   2. Send a user message; mock receives + adds user row to durable.
//   3. Suppress the mock auto-reply so we can drive the reply
//      envelopes ourselves AND seed durable WITHOUT sidekick_id
//      (the bug shape).
//   4. Push reply_delta + reply_final envelopes for a fresh SSE
//      message_id, AND append a durable assistant row with the
//      same content but NO sidekick_id.
//   5. Trigger a /messages fetch (switch away + back, or wait for
//      the proxy's regular fetch).
//   6. Assert: exactly ONE .line.agent in transcript.

import {
  waitForReady, openSidebar, send, captureNextChatId,
  clickNewChat, clickRow, assert,
} from './lib.mjs';

export const NAME = 'active-chat-reply-no-dupe-without-parley-id';
export const DESCRIPTION = 'Assistant reply renders ONCE even when durable mirror lacks sidekick_id';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_B_ID = 'mock-chat-B-dupe-anchor';
const USER_MARKER = `user-A-${Math.random().toString(36).slice(2, 8)}`;
const REPLY_TEXT = `Reply_${Math.random().toString(36).slice(2, 8)}_unique`;
const REPLY_MSG_ID = `msg_${Math.random().toString(36).slice(2, 8)}`;

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_B_ID, {
    title: 'Anchor chat (forces /messages refetch on switch)',
    source: 'sidekick',
    messages: [
      { role: 'user', content: 'anchor-user', sidekick_id: 'umsg_anchor_dupe',
        timestamp: Date.now() / 1000 - 30 },
      { role: 'assistant', content: 'anchor-reply', sidekick_id: 'msg_anchor_dupe',
        timestamp: Date.now() / 1000 - 29 },
    ],
    lastActiveAt: Date.now() - 5000,
  });
  mock.setAutoReplyEnabled(false);
}

async function countAssistantBubblesContaining(page, text) {
  return page.evaluate((needle) =>
    Array.from(document.querySelectorAll('#transcript .line.agent'))
      .filter(el => (el.textContent || '').includes(needle))
      .length,
    text,
  );
}

async function lineDump(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line'))
      .map(el => ({
        cls: el.className,
        key: el.getAttribute('data-key') || null,
        msgId: el.getAttribute('data-message-id') || null,
        text: (el.textContent || '').trim().slice(0, 60),
      })),
  );
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  const idP = captureNextChatId(page);
  await clickNewChat(page);
  const chatA = await idP;
  log(`minted chat A: ${chatA}`);

  await send(page, USER_MARKER);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    USER_MARKER,
    { timeout: 5_000, polling: 100 },
  );
  log(`user bubble visible`);

  // ── Fire the assistant reply via SSE (inflight) AND seed durable.
  // The trick: the durable assistant row has NO sidekick_id, so the
  // projection's key-based dedup can't match it against the inflight
  // envelope's message_id. Without the content-match fallback, both
  // render → dupe.
  mock.pushEnvelope({
    type: 'reply_delta',
    chat_id: chatA,
    message_id: REPLY_MSG_ID,
    text: REPLY_TEXT,
  });
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: chatA,
    message_id: REPLY_MSG_ID,
  });
  // Re-call addChat to overwrite the in-memory chat record with the
  // full message set — durable assistant row included, but WITHOUT
  // sidekick_id. Mirrors what state.db / parley.db would look like
  // if the plugin's link write skipped this row.
  mock.addChat(chatA, {
    title: 'Chat A',
    source: 'sidekick',
    messages: [
      { role: 'user', content: USER_MARKER, sidekick_id: `umsg_${USER_MARKER}`,
        timestamp: Date.now() / 1000 - 2 },
      { role: 'assistant', content: REPLY_TEXT, // NO sidekick_id — the bug shape.
        timestamp: Date.now() / 1000 - 1 },
    ],
    lastActiveAt: Date.now(),
  });

  // Give the SSE envelopes time to land.
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    REPLY_TEXT,
    { timeout: 5_000, polling: 100 },
  );

  // Switch to B and back to A so the projector consumes the durable
  // pass with the new server-side state. This is the realistic moment
  // the dupe surfaces — durable just refreshed, and inflight still has
  // the reply envelope.
  await clickRow(page, CHAT_B_ID);
  await page.waitForFunction(
    () => /anchor-reply/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  await clickRow(page, chatA);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    REPLY_TEXT,
    { timeout: 4_000, polling: 100 },
  );

  const count = await countAssistantBubblesContaining(page, REPLY_TEXT);
  const dump = await lineDump(page);
  log(`assistant bubbles containing reply text: ${count}`);
  log(`  dump: ${JSON.stringify(dump)}`);
  assert(
    count === 1,
    `expected exactly 1 assistant bubble with the reply text; got ${count}. `
    + `dump: ${JSON.stringify(dump)}`,
  );
}
