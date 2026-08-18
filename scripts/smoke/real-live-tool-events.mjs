// Real-Hermes live tool event smoke.
//
// Creates a disposable chat, asks the agent to run a harmless slow terminal
// command, and asserts the activity row appears before the final answer.
// This catches regressions where tool_call/tool_result envelopes only become
// visible after the turn finishes and history is re-fetched.

import {
  waitForReady,
  clickNewChat,
  send,
  deleteChat,
  captureNextChatId,
  SEL,
  assert,
} from './lib.mjs';

export const NAME = 'real-live-tool-events';
export const DESCRIPTION = 'Real Hermes tool call appears in the transcript before reply_final';
export const STATUS = 'install-only';
export const BACKEND = 'real';

const RUN = Math.random().toString(36).slice(2, 8);
const FINAL_MARKER = `PARLEY_TOOL_FINAL_${RUN}`;

export default async function run({ page, log }) {
  await waitForReady(page);

  const chatIdP = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await chatIdP;

  try {
    const t0 = await send(page,
      `Temporary Parley smoke ${RUN}. ` +
      `You must search the web for the current weather in London before answering. ` +
      `Do not use terminal and do not ask for approval. After the search/tool returns, reply with exactly: ${FINAL_MARKER}`,
    );

    const deadline = Date.now() + 60_000;
    while (true) {
      const state = await page.evaluate(({ activitySel, agentFinalSel, finalMarker }) => {
        const text = Array.from(document.querySelectorAll(agentFinalSel))
          .map((el) => el.textContent || '')
          .join('\n');
        return {
          hasActivity: !!document.querySelector(activitySel),
          hasFinal: text.includes(finalMarker),
        };
      }, { activitySel: SEL.activityRow, agentFinalSel: SEL.agentFinal, finalMarker: FINAL_MARKER });
      if (state.hasActivity && !state.hasFinal) break;
      if (state.hasFinal && !state.hasActivity) {
        throw new Error('final answer arrived before any live activity row');
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for live activity row before final answer');
      }
      await page.waitForTimeout(250);
    }
    const liveText = await page.locator(SEL.activityRow).first().textContent();
    log(`activity row appeared live in ${Date.now() - t0} ms: ${(liveText || '').replace(/\s+/g, ' ').trim()}`);

    const toolRows = await page.locator(SEL.toolRow).count();
    assert(toolRows >= 1, `expected at least one live tool row, got ${toolRows}`);

    await page.waitForFunction(
      ({ agentFinalSel, marker }) => Array.from(document.querySelectorAll(agentFinalSel))
        .some((el) => (el.textContent || '').includes(marker)),
      { agentFinalSel: SEL.agentFinal, marker: FINAL_MARKER },
      { timeout: 90_000, polling: 250 },
    );
    log(`final marker arrived in ${Date.now() - t0} ms`);
  } finally {
    if (chatId) await deleteChat(page, chatId);
  }
}
