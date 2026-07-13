// Unified elicitation protocol (2026-07-13, task: hermes 0.18 clarify
// gap): an `agent_question` envelope renders a pop-up with choice
// buttons + a countdown tied to expires_at; tapping a choice POSTs the
// answer to /api/sidekick/questions/{id}; an already-expired question
// never pops (ring replays of dead prompts); expiry flips the pop-up
// to a visible EXPIRED state instead of silently vanishing.
//
// Field incident this prevents: the agent blocked invisibly for 58
// minutes on a clarify question sidekick never rendered.

import { waitForReady, openSidebar, clickRow, waitForDrawerQuiet } from './lib.mjs';

export const NAME = 'agent-question-popup';
export const DESCRIPTION = 'agent_question envelope → pop-up with choices + countdown; answer POSTs to /questions/{id}; expired questions refuse/flip visibly';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-q-chat';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT, {
    title: 'Question chat',
    messages: [{ role: 'user', content: 'Q-SEED', sidekick_id: 'umsg_q', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('Q-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);

  // Capture answers the PWA POSTs.
  const answers = [];
  await page.route('**/api/sidekick/questions/**', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const url = route.request().url();
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    answers.push({ id: decodeURIComponent(url.split('/questions/')[1].split('?')[0]), response: body.response });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  // ── 1. Live clarify question → pop-up with buttons + countdown ────
  mock.pushEnvelope({
    type: 'agent_question',
    chat_id: CHAT,
    question_id: 'clarify_smoke_1',
    kind: 'clarify',
    question: 'Auto-post nightly as jonbot, or generate a draft?',
    choices: ['Auto-post nightly', 'Nightly draft for me'],
    allow_free_text: true,
    expires_at: Date.now() + 60_000,
  });
  await page.waitForFunction(
    () => !!document.querySelector('.question-popup[data-question-id="clarify_smoke_1"]'),
    null, { timeout: 5000, polling: 50 },
  );
  const shape = await page.evaluate(() => {
    const p = document.querySelector('.question-popup');
    return {
      question: p?.querySelector('.q-body')?.textContent || '',
      buttons: [...(p?.querySelectorAll('.q-choice') || [])].map((b) => b.textContent),
      countdown: p?.querySelector('.q-countdown')?.textContent || '',
      hasFreeText: !!p?.querySelector('.q-freetext'),
    };
  });
  if (!shape.question.includes('jonbot')) throw new Error('question text missing from pop-up');
  if (!shape.buttons.includes('Auto-post nightly')) throw new Error(`choice buttons missing: ${JSON.stringify(shape.buttons)}`);
  if (!/\d+(s|m)/.test(shape.countdown)) throw new Error(`countdown not rendering: "${shape.countdown}"`);
  if (!shape.hasFreeText) throw new Error('free-text input missing on allow_free_text question');
  log(`pop-up rendered: ${shape.buttons.length} choices + free text + countdown "${shape.countdown}"`);

  // Tap a choice → answer POSTs → pop-up closes.
  await page.evaluate(() => {
    [...document.querySelectorAll('.question-popup .q-choice')]
      .find((b) => b.textContent === 'Nightly draft for me')?.click();
  });
  await page.waitForFunction(() => !document.querySelector('.question-popup'), null, { timeout: 5000, polling: 50 });
  if (answers.length !== 1 || answers[0].id !== 'clarify_smoke_1' || answers[0].response !== 'Nightly draft for me') {
    throw new Error(`answer not delivered correctly: ${JSON.stringify(answers)}`);
  }
  log('choice tap POSTed the answer and closed the pop-up');

  // ── 2. Already-expired question never pops (dead ring replay) ─────
  mock.pushEnvelope({
    type: 'agent_question', chat_id: CHAT, question_id: 'clarify_dead',
    kind: 'clarify', question: 'stale?', choices: [], allow_free_text: true,
    expires_at: Date.now() - 5_000,
  });
  await new Promise((r) => setTimeout(r, 800));
  if (await page.evaluate(() => !!document.querySelector('.question-popup'))) {
    throw new Error('already-expired question rendered a pop-up (dead ring replay must be refused)');
  }
  log('expired question refused');

  // ── 3. Expiry mid-display flips to a visible EXPIRED state ────────
  mock.pushEnvelope({
    type: 'agent_question', chat_id: CHAT, question_id: 'clarify_short',
    kind: 'clarify', question: 'quick one?', choices: ['A', 'B'],
    allow_free_text: true, expires_at: Date.now() + 2_500,
  });
  await page.waitForFunction(
    () => !!document.querySelector('.question-popup[data-question-id="clarify_short"]'),
    null, { timeout: 5000, polling: 50 },
  );
  await page.waitForFunction(
    () => document.querySelector('.question-popup')?.classList.contains('expired'),
    null, { timeout: 8000, polling: 100 },
  );
  const expired = await page.evaluate(() => ({
    disabled: [...document.querySelectorAll('.question-popup .q-choice')].every((b) => b.disabled),
    note: document.querySelector('.question-popup .q-countdown')?.textContent || '',
  }));
  if (!expired.disabled) throw new Error('expired pop-up left its buttons enabled');
  if (!/expired|stopped waiting|closed/i.test(expired.note)) throw new Error(`no visible expiry note: "${expired.note}"`);
  log('mid-display expiry flipped to visible EXPIRED state with disabled actions');

  // ── 4. Approval kind → default /approve + /deny buttons that send
  //      through the normal chat path ─────────────────────────────────
  mock.pushEnvelope({
    type: 'agent_question', chat_id: CHAT, question_id: 'approval_1',
    kind: 'approval', question: 'Dangerous command requires approval: rm -rf /tmp/x',
    choices: [], allow_free_text: false,
    expires_at: Date.now() + 60_000,
  });
  await page.waitForFunction(
    () => !!document.querySelector('.question-popup[data-question-id="approval_1"]'),
    null, { timeout: 5000, polling: 50 },
  );
  await page.evaluate(() => {
    [...document.querySelectorAll('.question-popup .q-choice')]
      .find((b) => b.textContent === '/approve')?.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  const approved = mock.getChat(CHAT)?.messages.some((m) => (m.content || '') === '/approve');
  if (!approved) throw new Error('approval button did not send /approve through the chat path');
  if (await page.evaluate(() => !!document.querySelector('.question-popup'))) {
    throw new Error('approval pop-up did not close after answering');
  }
  log('approval kind: /approve rode the normal addressed send path');
}
