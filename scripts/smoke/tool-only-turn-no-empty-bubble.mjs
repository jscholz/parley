// #270 A "tool-only" turn — the agent fires tools and then closes the
// turn with NO prose reply — must NOT leave a blank `.line.agent`
// bubble behind. The terminal `reply_final` for such a turn carries
// empty text; the projection used to faithfully emit an assistant
// bubble for it, rendering an empty bubble next to the activity row
// (the "sloppy" empty tool-only bubble Jonathan flagged; also what
// tripped text-turn's `bubble[0] empty` assertion on a tool-heavy chat).
//
// This is NOT an interleaving bug: an all-tools-no-prose turn is a
// legitimate shape, the SSE turn just closes with a text-less final.
// The fix lives in the projection's empty-assistant sweep.
//
// Test plan (mocked):
//   1. Seed a chat + view it.
//   2. Push tool_call + tool_result envelopes (the turn's real work).
//   3. Close the turn with a BARE reply_final — no reply_delta, no text.
//   4. Assert:
//      - the activity row + tool rows rendered (tool work is visible);
//      - ZERO empty finalized `.line.agent` bubbles exist.

import { waitForReady, openSidebar, assert, SEL } from './lib.mjs';

export const NAME = 'tool-only-turn-no-empty-bubble';
export const DESCRIPTION = 'a tool-only turn (empty reply_final) renders the activity row but no blank agent bubble (#270)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-tool-only-turn';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Tool-only turn',
    messages: [
      { role: 'user', content: 'just run the tools, no commentary', timestamp: Date.now() / 1000 - 5 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 5_000 });
  await page.locator(`#sessions-list li[data-chat-id="${CHAT_ID}"] .sess-body`).first().click();
  await page.waitForFunction(
    () => {
      const t = document.getElementById('transcript');
      return t && /just run the tools/.test(t.textContent || '');
    },
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('chat seeded + viewed');

  // Two tools fire, then the turn ends — no reply text.
  const tools = [
    { call_id: 'call-a', tool_name: 'search_files', args: { q: 'todo' } },
    { call_id: 'call-b', tool_name: 'read_file', args: { path: '/etc/hosts' } },
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
      duration_ms: 17,
    });
  }

  await page.waitForFunction(
    () => document.querySelectorAll('.tool-row').length >= 2,
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('2 tool rows rendered');

  // Close the turn with a BARE reply_final — no text, no preceding
  // reply_delta. This is the tool-only turn's terminal envelope.
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT_ID, message_id: 'reply-empty-270' });

  // Let the projection re-render + settle.
  await page.waitForTimeout(400);

  const result = await page.evaluate(() => {
    const transcript = document.getElementById('transcript');
    const finalized = Array.from(
      transcript?.querySelectorAll('.line.agent:not(.streaming):not(.pending)') || [],
    );
    // Measure the message BODY (`.text` span), not whole-bubble textContent —
    // the latter carries the speaker label + timestamp chrome even on a blank
    // bubble. An empty tool-only bubble has an empty (or missing) `.text` span,
    // which is exactly what text-turn's `bubble[i] empty` guard checks.
    const bodyText = (b) => {
      const span = b.querySelector('.text');
      return (span?.textContent || '').trim();
    };
    return {
      finalizedAgentBodies: finalized.map(bodyText),
      emptyFinalizedCount: finalized.filter(b => bodyText(b) === '').length,
      activityRowCount: document.querySelectorAll('.activity-row').length,
      toolRowCount: document.querySelectorAll('.tool-row').length,
    };
  });

  log(`finalized agent bubble bodies: ${JSON.stringify(result.finalizedAgentBodies)}`);
  log(`activity rows: ${result.activityRowCount}, tool rows: ${result.toolRowCount}`);

  // The tool work must be visible — that's the turn's actual content.
  assert(result.activityRowCount >= 1, `expected ≥1 activity row, got ${result.activityRowCount}`);
  assert(result.toolRowCount >= 2, `expected ≥2 tool rows, got ${result.toolRowCount}`);

  // The cardinal assertion: no blank agent bubble for the text-less final.
  assert(
    result.emptyFinalizedCount === 0,
    `tool-only turn left ${result.emptyFinalizedCount} blank agent bubble(s): ` +
    `${JSON.stringify(result.finalizedAgentBodies)}`,
  );
  log('tool-only turn rendered activity row + no blank agent bubble ✓');

  void SEL.agentFinal;
}
