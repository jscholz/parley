// Scenario: a chat with messageCount > 0 but no title AND no snippet
// must render as "(processing…)" in the drawer — NOT "New chat".
//
// Regression guard: an SW reload mid-agent tool-loop left the chat
// with no title and no first_user_message yet (race with proxy session
// enrichment), but with real messageCount. The drawer rendered
// "New chat / 5 msgs" — visually identical to a fresh empty orphan,
// which the cleanup paths key off. Misleading + dangerous.
//
// Post-v0.383 fix: when title is empty AND snippet is empty AND
// messageCount > 0, the drawer surfaces "(processing…)". The "New chat"
// fallback stays for the truly-empty case (messageCount === 0) so the
// orphan affordance the cleanup paths depend on is preserved.
//
// Test plan (mocked):
//   1. Pre-seed two chats:
//        a. Racing chat: title='', messages=[assistant-only] → messageCount > 0,
//           first_user_message=null (mock derives snippet from first user
//           message; no user message ⇒ no snippet).
//        b. Truly-empty chat: title='', messages=[] → messageCount=0,
//           first_user_message=null.
//   2. Open drawer.
//   3. Assert: racing chat's visible label is "(processing…)" — NOT
//      "New chat".
//   4. Assert: truly-empty chat's visible label IS "New chat" (orphan
//      affordance preserved).

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'processing-label-mid-agent';
export const DESCRIPTION = 'Untitled chat with messageCount>0 but no snippet renders as "(processing…)", not "New chat"';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const RACING_ID = 'parley:racing-mid-agent-aaaa-000000000001';
const EMPTY_ID = 'parley:truly-empty-orphan-bbbb-000000000002';

export function MOCK_SETUP(mock) {
  // Racing chat: assistant-only messages give messageCount>0 with NO
  // first_user_message (mock's enrichment derives snippet from the
  // first role='user' message; missing ⇒ null). Mirrors the SW-reload
  // mid-tool-loop race exactly: hermes produced replies but the user
  // turn hasn't been enriched into the sessions row yet.
  mock.addChat(RACING_ID, {
    title: '',
    source: 'parley',
    messages: [
      { role: 'assistant', content: 'tool_call sent', timestamp: Date.now() / 1000 - 30 },
      { role: 'assistant', content: 'tool_result received', timestamp: Date.now() / 1000 - 25 },
      { role: 'assistant', content: 'partial reply', timestamp: Date.now() / 1000 - 20 },
      { role: 'assistant', content: 'still streaming', timestamp: Date.now() / 1000 - 15 },
      { role: 'assistant', content: 'final', timestamp: Date.now() / 1000 - 10 },
    ],
    lastActiveAt: Date.now() - 10_000,
  });
  // Truly empty: no messages at all → messageCount=0. The "New chat"
  // fallback should remain because this IS the orphan affordance the
  // cleanup paths key off.
  mock.addChat(EMPTY_ID, {
    title: '',
    source: 'parley',
    messages: [],
    lastActiveAt: Date.now() - 60_000,
  });
}

async function rowLabel(page, chatId) {
  return page.evaluate((id) => {
    const li = document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
    return li?.querySelector('.sess-snippet')?.textContent ?? null;
  }, chatId);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Wait for both rows to render.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${RACING_ID}"]`, { timeout: 5_000 });
  await page.waitForSelector(`#sessions-list li[data-chat-id="${EMPTY_ID}"]`, { timeout: 5_000 });

  // ── Assertion A: racing chat must NOT render as "New chat".
  // It should surface as "(processing…)" — a non-misleading label that
  // tells the user something is being computed.
  const racingLabel = await rowLabel(page, RACING_ID);
  assert(
    racingLabel !== null,
    `racing row not found in drawer (id=${RACING_ID})`,
  );
  assert(
    racingLabel?.trim() !== 'New chat',
    `racing chat (msgCount>0, no title, no snippet) must NOT render as "New chat" — ` +
    `got ${JSON.stringify(racingLabel)}. This is the 2026-05-03 visual-collision ` +
    `regression: indistinguishable from a fresh orphan, primes the cleanup paths to ` +
    `treat real in-progress work as removable.`,
  );
  assert(
    /processing/i.test(racingLabel || ''),
    `racing chat label should indicate progress (e.g. "(processing…)"), got ${JSON.stringify(racingLabel)}`,
  );
  log(`racing chat renders as ${JSON.stringify(racingLabel)} ✓ — distinguishable from fresh orphan`);

  // ── Assertion B: truly-empty chat MUST still render as "New chat" so
  // the orphan affordance the cleanup paths rely on is preserved.
  const emptyLabel = await rowLabel(page, EMPTY_ID);
  assert(
    emptyLabel?.trim() === 'New chat',
    `truly-empty chat (msgCount=0) must render as "New chat" — got ${JSON.stringify(emptyLabel)}. ` +
    `The orphan affordance keys off this label visually + the messageCount===0 invariant ` +
    `programmatically.`,
  );
  log(`truly-empty chat renders as "New chat" ✓ — orphan affordance preserved`);
}
