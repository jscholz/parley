// Scenario: user sends a message in chat A, agent replies, user
// switches to chat B in the sidebar, then switches back to A. Both
// the user's message AND the agent's reply must be visible in A's
// transcript. Regression guard: only the agent reply was visible
// after switching back; the user's original message had disappeared
// from the rendered DOM despite being present in state.db.
//
// Test plan (mocked):
//   1. Seed two chats: chat A (just the title, no messages — we'll
//      send live) and chat B (pre-populated with a marker so we
//      have somewhere distinct to switch to).
//   2. Click into chat A, send "user-A-marker".
//   3. Wait for the mock's auto-reply ("[mock] echo: user-A-marker").
//   4. Click into chat B; assert chat B's contents are visible
//      and chat A's marker is GONE from the transcript.
//   5. Click back into chat A; assert BOTH the user marker and the
//      agent reply are present in the transcript.
//   6. Reload, repeat the switch dance; assert both still present.

import { waitForReady, openSidebar, captureNextChatId, clickNewChat, send, clickRow, assert } from './lib.mjs';

export const NAME = 'switch-away-and-back';
export const DESCRIPTION = 'User message + agent reply both visible after switching away and back';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_B_ID = 'mock-chat-B-anchor';
const USER_MARKER = `user-A-marker-${Math.random().toString(36).slice(2, 8)}`;
const MOCK_REPLY_PREFIX = '[mock] echo:';

export function MOCK_SETUP(mock) {
  // Pre-seed chat B with a distinct message so we can verify the
  // switch genuinely happened (transcript should change to B's
  // content during the away leg).
  mock.addChat(CHAT_B_ID, {
    title: 'Anchor chat',
    messages: [
      { role: 'user', content: 'anchor-message-on-chat-B',
        parley_id: 'umsg_anchor_b', timestamp: Date.now() / 1000 - 30 },
      { role: 'assistant', content: 'anchor-reply-on-chat-B',
        parley_id: 'msg_anchor_b', timestamp: Date.now() / 1000 - 29 },
    ],
    lastActiveAt: Date.now() - 5000,
  });
}

async function transcriptText(page) {
  return await page.evaluate(() =>
    (document.getElementById('transcript')?.textContent || '').replace(/\s+/g, ' ').trim(),
  );
}

async function lineCount(page) {
  return await page.evaluate(
    () => document.querySelectorAll('#transcript .line').length,
  );
}

async function lineDump(page) {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line')).map(l => ({
      msgId: l.getAttribute('data-message-id') || null,
      cls: l.className,
      text: (l.textContent || '').slice(0, 60).replace(/\s+/g, ' ').trim(),
    })),
  );
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // === Step 1: send msg in chat A (lazily-minted on new-chat click) ===
  const idPromise = captureNextChatId(page);
  await clickNewChat(page);
  const chatA = await idPromise;
  log(`minted chat A: ${chatA}`);

  await send(page, USER_MARKER);
  await page.waitForFunction(
    ({ marker, prefix }) => {
      const t = document.getElementById('transcript')?.textContent || '';
      return t.includes(marker) && t.includes(prefix);
    },
    { marker: USER_MARKER, prefix: MOCK_REPLY_PREFIX },
    { timeout: 5_000, polling: 100 },
  );
  const baselineLines = await lineCount(page);
  const baselineDump = await lineDump(page);
  log(`chat A after send/reply: ${baselineLines} .line elements`);
  log(`  dump: ${JSON.stringify(baselineDump)}`);
  assert(baselineLines >= 2, `expected ≥2 lines (user + agent) in chat A, got ${baselineLines}`);

  // === Step 2: switch to chat B ===
  await clickRow(page, CHAT_B_ID);
  await page.waitForFunction(
    () => /anchor-message-on-chat-B/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  const onB = await transcriptText(page);
  assert(
    !onB.includes(USER_MARKER),
    `chat A's marker should NOT appear in chat B's transcript, got: ${onB.slice(0, 200)}`,
  );
  log('switched to chat B; chat A marker absent ✓');

  // === Step 3: switch BACK to chat A ===
  await clickRow(page, chatA);
  // Poll for both the user marker AND the agent reply to be visible.
  // The user marker is the regression target — the agent reply was
  // visible in the original bug, but the user marker disappeared.
  await page.waitForFunction(
    ({ marker, prefix }) => {
      const t = document.getElementById('transcript')?.textContent || '';
      return t.includes(marker) && t.includes(prefix);
    },
    { marker: USER_MARKER, prefix: MOCK_REPLY_PREFIX },
    { timeout: 5_000, polling: 100 },
  );
  const afterSwitchBack = await lineCount(page);
  const afterDump = await lineDump(page);
  log(`chat A after switch-back: ${afterSwitchBack} .line elements`);
  log(`  dump: ${JSON.stringify(afterDump)}`);
  assert(
    afterSwitchBack >= 2,
    `expected ≥2 lines after switch-back (user marker + agent reply), got ${afterSwitchBack}`,
  );
  // Tight assertion: both marker AND reply are in transcript text
  const transcriptA = await transcriptText(page);
  assert(
    transcriptA.includes(USER_MARKER),
    `USER MARKER missing from transcript after switch-back; got: ${transcriptA.slice(0, 200)}`,
  );
  assert(
    transcriptA.includes(MOCK_REPLY_PREFIX),
    `AGENT REPLY missing from transcript after switch-back; got: ${transcriptA.slice(0, 200)}`,
  );
  log('switch-back: both user marker + agent reply visible ✓');

  // === Step 4: reload + same dance ===
  await page.reload();
  await waitForReady(page);
  await openSidebar(page);
  // After reload, the most-recent chat (chat A) should auto-render.
  await page.waitForFunction(
    ({ marker, prefix }) => {
      const t = document.getElementById('transcript')?.textContent || '';
      return t.includes(marker) && t.includes(prefix);
    },
    { marker: USER_MARKER, prefix: MOCK_REPLY_PREFIX },
    { timeout: 5_000, polling: 100 },
  );
  log('reload: chat A still shows both lines ✓');

  await clickRow(page, CHAT_B_ID);
  await page.waitForFunction(
    () => /anchor-message-on-chat-B/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  await clickRow(page, chatA);
  await page.waitForFunction(
    ({ marker, prefix }) => {
      const t = document.getElementById('transcript')?.textContent || '';
      return t.includes(marker) && t.includes(prefix);
    },
    { marker: USER_MARKER, prefix: MOCK_REPLY_PREFIX },
    { timeout: 5_000, polling: 100 },
  );
  log('post-reload switch-away-and-back: both lines still visible ✓');
}
