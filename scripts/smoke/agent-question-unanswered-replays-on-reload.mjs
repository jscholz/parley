// The guard rail on agent-question-answered-no-replay-on-reload.
//
// Suppressing answered questions must NOT become "questions don't
// replay". Two shapes have to survive a reload:
//
//   1. UNANSWERED — the agent is still blocked on it. A reload that
//      swallowed the question would put us back in the original
//      incident this popup exists to prevent (the agent blocked
//      invisibly for 58 minutes on a clarify parley never rendered).
//   2. DISMISSED — the × button's own tooltip is "Hide (the agent
//      keeps waiting)". Hiding is deliberately NOT answering, so a
//      dismissed question is SUPPOSED to come back.
//
// If the answered-question fix is ever widened to "skip any question
// we've seen before", this scenario fails.

import { waitForReady, openSidebar, clickRow, waitForDrawerQuiet, assert } from './lib.mjs';

export const NAME = 'agent-question-unanswered-replays-on-reload';
export const DESCRIPTION = 'unanswered AND dismissed agent_questions still replay on reload (answered-suppression must stay narrow)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-q-unanswered-reload';
const QID = 'clarify_unanswered_reload';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT, {
    title: 'Unanswered question chat',
    messages: [{ role: 'user', content: 'UQ-SEED', parley_id: 'umsg_uq', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

async function openChat(page) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('UQ-SEED'),
    null, { timeout: 5_000, polling: 50 },
  );
}

export default async function run({ page, log, mock }) {
  await openChat(page);
  await waitForDrawerQuiet(page);

  mock.pushEnvelope({
    type: 'agent_question',
    chat_id: CHAT,
    question_id: QID,
    kind: 'clarify',
    question: 'Still waiting: deploy to staging or prod?',
    choices: ['Staging', 'Prod'],
    allow_free_text: true,
    expires_at: Date.now() + 60 * 60_000,
  });
  await page.waitForFunction(
    (id) => !!document.querySelector(`.question-popup[data-question-id="${id}"]`),
    QID, { timeout: 5_000, polling: 50 },
  );
  log('question popped ✓');

  // ── 1. Reload WITHOUT answering → the still-live question must come
  //       back. The agent is blocked on it; losing it is the incident.
  await page.reload();
  await openChat(page);
  await page.waitForFunction(
    (id) => !!document.querySelector(`.question-popup[data-question-id="${id}"]`),
    QID, { timeout: 8_000, polling: 100 },
  ).catch(() => {
    throw new Error(
      `UNANSWERED question ${QID} did not come back after reload — the agent is still blocked on it and the user can no longer see it`,
    );
  });
  log('unanswered question replayed after reload ✓');

  // ── 2. Dismiss with × (explicitly "Hide (the agent keeps waiting)"),
  //       reload → it must come back too. Dismissal is not an answer.
  const tooltip = await page.evaluate(
    () => document.querySelector('.question-popup .q-dismiss')?.title || '',
  );
  assert(/keeps waiting/i.test(tooltip),
    `the × button must still advertise itself as a HIDE, not an answer (title="${tooltip}")`);
  await page.click('.question-popup .q-dismiss');
  await page.waitForFunction(
    () => !document.querySelector('.question-popup'),
    null, { timeout: 5_000, polling: 50 },
  );
  log('dismissed via × ✓');

  await page.waitForTimeout(200);
  await page.reload();
  await openChat(page);
  await page.waitForFunction(
    (id) => !!document.querySelector(`.question-popup[data-question-id="${id}"]`),
    QID, { timeout: 8_000, polling: 100 },
  ).catch(() => {
    throw new Error(
      `DISMISSED question ${QID} did not come back after reload — dismissal must not be treated as an answer ("Hide (the agent keeps waiting)")`,
    );
  });
  log('dismissed question still replayed after reload ✓');
}
