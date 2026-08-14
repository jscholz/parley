// Pin the 61c381a/148ed75 fix: tool-call info renders into the
// activity row, NOT as cumulative agent text bubbles.
//
// Bug class:
//   Pre-fix, the hermes plugin's edit_message override opted us into
//   the gateway's tool-progress sender — every tool call was emitted
//   BOTH as a tool_call envelope (→ activity-row) AND as a synthetic
//   reply_delta carrying "⚙️ tool_name: ..." text. Cumulative-text
//   semantics meant each successive tool grew an N+1 line bubble next
//   to the previous N-line bubble, and the actual reply ended up
//   buried under tool noise. Fix dropped the override; tool info
//   flows ONLY via the tool_call envelope path.
//
// Test plan (mocked):
//   1. addChat with a single user message + scheduled assistant reply.
//   2. Click the chat in the drawer to make it the active session.
//   3. Push a sequence of tool_call + tool_result envelopes for that
//      chat (simulating an agent that fired N tools mid-turn).
//   4. Push a single reply_delta + reply_final with the actual reply.
//   5. Assert:
//      - Exactly ONE finalized .line.agent text bubble.
//      - That bubble's text is the reply text — NOT a "⚙️ tool_name"
//        progress string.
//      - At least one .activity-row exists (activity row is the proper
//        carrier for tool info).
//      - At least one .tool-row inside it (one per tool envelope).

import { waitForReady, openSidebar, assert, SEL } from './lib.mjs';

export const NAME = 'tool-progress-not-bubbles';
export const DESCRIPTION = 'tool_call envelopes render into activity row, not as cumulative agent bubbles';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-tool-progress';
const REPLY_TEXT = 'Here is the answer after running the tools.';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Tool turn',
    messages: [
      { role: 'user', content: 'do a tool thing', timestamp: Date.now() / 1000 - 5 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
  // Persist the turn's tool rows to durable like real hermes does, so
  // the post-final durable refresh carries them and the activity row
  // survives inflight drain (2026-08-14 — fixes the ~3/8 "activity
  // rows: 0" flake; the vanish was a mock-fidelity gap, not a prod bug).
  mock.setPersistToolRows(true);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Click into our seeded chat so it becomes the viewed session.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 5_000 });
  await page.locator(`#sessions-list li[data-chat-id="${CHAT_ID}"] .sess-body`).first().click();
  await page.waitForFunction(
    (id) => {
      const t = document.getElementById('transcript');
      return t && /do a tool thing/.test(t.textContent || '');
    },
    CHAT_ID,
    { timeout: 4_000, polling: 50 },
  );
  log('chat seeded + viewed');

  // Push 3 tool_call envelopes mid-turn (faithful to what hermes emits
  // for a tool-using agent). Each has a unique call_id so the activity
  // row's by-callId map keeps them distinct.
  const tools = [
    { call_id: 'call-1', tool_name: 'web_search', args: { q: 'london weather' } },
    { call_id: 'call-2', tool_name: 'fetch_url', args: { url: 'https://example.com' } },
    { call_id: 'call-3', tool_name: 'extract_text', args: { selector: 'main' } },
  ];
  for (const t of tools) {
    mock.pushEnvelope({
      type: 'tool_call',
      chat_id: CHAT_ID,
      call_id: t.call_id,
      tool_name: t.tool_name,
      args: t.args,
      started_at: new Date().toISOString(),
    });
    mock.pushEnvelope({
      type: 'tool_result',
      chat_id: CHAT_ID,
      call_id: t.call_id,
      result: 'ok',
      duration_ms: 42,
    });
  }

  // Wait for the activity row to render with all 3 tool entries.
  await page.waitForFunction(
    () => document.querySelectorAll('.tool-row').length >= 3,
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('3 tool rows rendered into activity row');

  // Push the actual reply.
  mock.pushReply(CHAT_ID, REPLY_TEXT, 'reply-msg-1');

  await page.waitForFunction(
    (text) => {
      const bubbles = document.querySelectorAll('.line.agent:not(.streaming):not(.pending)');
      return Array.from(bubbles).some(b => (b.textContent || '').includes(text));
    },
    REPLY_TEXT,
    { timeout: 4_000, polling: 50 },
  );

  // Settle so any stragglers land before we count.
  await page.waitForTimeout(200);

  const result = await page.evaluate(() => {
    const transcript = document.getElementById('transcript');
    const allAgent = Array.from(transcript?.querySelectorAll('.line.agent') || []);
    return {
      agentBubbleTexts: allAgent.map((b) => (b.textContent || '').slice(0, 120)),
      finalizedCount: allAgent.filter((b) =>
        !b.classList.contains('streaming') && !b.classList.contains('pending'),
      ).length,
      activityRowCount: document.querySelectorAll('.activity-row').length,
      toolRowCount: document.querySelectorAll('.tool-row').length,
    };
  });

  log(`agent bubbles: ${JSON.stringify(result.agentBubbleTexts)}`);
  log(`activity rows: ${result.activityRowCount}, tool rows: ${result.toolRowCount}`);

  // The cardinal assertion: tool-progress text should NEVER appear in
  // an agent bubble. Pre-fix the bridge wrapped each tool emoji blurb
  // into reply_delta — `⚙️ web_search: …` would have shown up here.
  for (const t of result.agentBubbleTexts) {
    assert(
      !/⚙️\s*\w+:/u.test(t) && !/^\s*tool_name:/i.test(t),
      `tool-progress string leaked into agent bubble: ${JSON.stringify(t)}`,
    );
  }

  // Exactly one finalized agent bubble — the actual reply.
  assert(
    result.finalizedCount === 1,
    `expected exactly 1 finalized agent bubble, got ${result.finalizedCount}: ${JSON.stringify(result.agentBubbleTexts)}`,
  );

  // Tool info lives in the activity row.
  assert(result.activityRowCount >= 1, `expected ≥1 activity row, got ${result.activityRowCount}`);
  assert(result.toolRowCount >= 3, `expected ≥3 tool rows, got ${result.toolRowCount}`);
  log('tool info collapsed into activity row, single agent bubble holds the actual reply ✓');

  // SEL is imported for selector-rename robustness even though we read
  // the DOM directly above; reference to silence unused warnings.
  void SEL.activityRow;
}
