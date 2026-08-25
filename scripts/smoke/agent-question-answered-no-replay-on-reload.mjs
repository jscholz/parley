// Field bug (2026-08-24): Jonathan answers an `agent_question` pop-up,
// refreshes the PWA, and the SAME question pops again — repeatedly, on
// every refresh, until its TTL runs out.
//
// Why: `agent_question` rides the SSE replay ring like any other
// envelope, and the ONLY suppression the client had was expiry
// (questionPopup.show refuses questions past expires_at). A question
// answered two minutes into a sixty-minute TTL is still "live" by that
// test, so every reconnect replayed it and re-popped it. There was no
// notion of "already answered" anywhere — not in the ring, not on the
// client.
//
// Contract: once ANSWERED, a question never pops again — not on reload,
// not on reconnect. Companion:
// agent-question-unanswered-replays-on-reload asserts the other half
// (unanswered + DISMISSED questions must still come back), so the fix
// can't degenerate into "never replay questions".

import { waitForReady, openSidebar, clickRow, waitForDrawerQuiet, assert } from './lib.mjs';

export const NAME = 'agent-question-answered-no-replay-on-reload';
export const DESCRIPTION = 'an answered agent_question must NOT pop again after a PWA reload (ring replay of a settled question)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-q-answered-reload';
const QID = 'clarify_answered_reload';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT, {
    title: 'Answered question chat',
    messages: [{ role: 'user', content: 'AQ-SEED', parley_id: 'umsg_aq', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

async function openChat(page) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('AQ-SEED'),
    null, { timeout: 5_000, polling: 50 },
  );
}

export default async function run({ page, log, mock }) {
  await openChat(page);
  await waitForDrawerQuiet(page);

  // Capture the answer POST. Registered on the page, so it survives the
  // reload below along with the mock's own routes.
  const answers = [];
  await page.route('**/api/parley/questions/**', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const url = route.request().url();
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    answers.push({
      id: decodeURIComponent(url.split('/questions/')[1].split('?')[0]),
      response: body.response,
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  // A LONG TTL is the whole point — this is the field shape. Expiry
  // must not be what saves us here; the question is still very much
  // alive when we reload.
  mock.pushEnvelope({
    type: 'agent_question',
    chat_id: CHAT,
    question_id: QID,
    kind: 'clarify',
    question: 'Ship the nightly digest, or hold it for review?',
    choices: ['Ship it', 'Hold for review'],
    allow_free_text: true,
    expires_at: Date.now() + 60 * 60_000,
  });
  await page.waitForFunction(
    (id) => !!document.querySelector(`.question-popup[data-question-id="${id}"]`),
    QID, { timeout: 5_000, polling: 50 },
  );
  log('question popped ✓');

  // Answer it.
  await page.evaluate(() => {
    [...document.querySelectorAll('.question-popup .q-choice')]
      .find((b) => b.textContent === 'Ship it')?.click();
  });
  await page.waitForFunction(
    () => !document.querySelector('.question-popup'),
    null, { timeout: 5_000, polling: 50 },
  );
  assert(answers.length === 1 && answers[0].id === QID,
    `expected exactly one answer POST for ${QID}, got ${JSON.stringify(answers)}`);
  log(`answered "${answers[0].response}" ✓`);

  // ── Reload. The envelope is still sitting in the replay ring and the
  //    question is still 59 minutes from expiry. It must NOT come back.
  await page.waitForTimeout(200);  // let any persist flush
  await page.reload();
  await openChat(page);

  // Give the reconnect's ring replay time to land AND be processed.
  await page.waitForTimeout(1_500);
  const after = await page.evaluate((id) => ({
    answeredBack: !!document.querySelector(`.question-popup[data-question-id="${id}"]`),
    anyPopup: !!document.querySelector('.question-popup'),
  }), QID);
  assert(!after.answeredBack,
    `ANSWERED question ${QID} popped again after reload — the replay ring resurrected a settled question (the field bug)`);
  assert(!after.anyPopup,
    'no question pop-up at all should be on screen after reload — nothing was left unanswered');
  log('answered question stayed dead across the reload ✓');

  // Liveness control: the pop-up surface must still WORK after the
  // reload, otherwise the assertion above would pass for the wrong
  // reason (a dead question pipeline looks identical to a suppressed
  // question).
  mock.pushEnvelope({
    type: 'agent_question',
    chat_id: CHAT,
    question_id: 'clarify_probe_after_reload',
    kind: 'clarify',
    question: 'Probe: is the question surface alive?',
    choices: ['Yes'],
    allow_free_text: false,
    expires_at: Date.now() + 60_000,
  });
  await page.waitForFunction(
    () => !!document.querySelector('.question-popup[data-question-id="clarify_probe_after_reload"]'),
    null, { timeout: 5_000, polling: 50 },
  );
  log('post-reload probe question DID pop — suppression is targeted, not a broken pipeline ✓');
}
