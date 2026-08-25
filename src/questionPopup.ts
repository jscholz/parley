/**
 * @fileoverview Agent-question pop-up — the ONE surface for the unified
 * elicitation protocol (2026-07-13): the agent is blocked on a user
 * answer and says so, visibly, until the offer expires.
 *
 * Driven by `agent_question` envelopes:
 *   { question_id, chat_id, kind: 'approval'|'clarify',
 *     question, choices[], allow_free_text, expires_at|null }
 *
 * Answer paths by kind:
 *   - clarify  → POST /api/parley/questions/{id} {response} — resolves
 *     the blocking tools.clarify_gateway entry the agent thread waits on.
 *     Typing in the chat ALSO answers it (gateway text-intercept), so a
 *     dismissed pop-up isn't a dead end — the hint line says so.
 *   - approval → sends '/approve' | '/deny' through the normal command
 *     path (approvals resolve via hermes's own flow, not the questions
 *     route).
 *
 * Lifetime (Jonathan's spec): the pop-up STICKS until `expires_at`
 * elapses, with a live countdown; at expiry it flips to a visibly-dead
 * EXPIRED state for a few seconds instead of silently vanishing — a
 * dead approval should look dead, not evaporate ("/approve → No pending
 * command", field 2026-07-13). `expires_at: null` sticks until answered
 * or dismissed (the future claude-code canUseTool mapping).
 *
 * Backend-agnostic by construction: everything the popup needs rides
 * the envelope; nothing here imports a backend.
 */

import { diag } from './util/log.ts';
import { apiUrl } from './apiBase.ts';

export interface AgentQuestion {
  question_id: string;
  chat_id: string;
  kind: 'approval' | 'clarify' | string;
  question: string;
  choices?: string[];
  allow_free_text?: boolean;
  expires_at?: number | null;
}

/** Wired by main.ts: routes approval answers through the normal
 *  addressed send path ('/approve' etc. into the question's chat). */
let sendCommandCb: ((text: string, chatId: string) => void) | null = null;

export function init(opts: { sendCommand: (text: string, chatId: string) => void }): void {
  sendCommandCb = opts.sendCommand;
}

let rootEl: HTMLElement | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let current: AgentQuestion | null = null;

// ── Answered-question memory (field bug 2026-08-24) ───────────────────
//
// `agent_question` rides the proxy's SSE replay ring, and expiry used
// to be the ONLY thing that stopped a replay from popping. A question
// answered two minutes into a sixty-minute TTL therefore came back on
// every single refresh. The proxy now retires answered questions from
// the ring (stream.ts resolveQuestion) — that's the real, cross-device
// fix. This local memory is the second layer, for the answer paths the
// proxy CANNOT observe:
//   - approvals, which resolve inside the backend via '/approve' on
//     the normal command path — no /questions POST ever reaches the
//     proxy, so the ring keeps the envelope;
//   - the gateway text-intercept (typing the answer in the chat).
//
// localStorage, not memory: the whole point is surviving a reload.
// Bounded ring of ids, oldest-first eviction.
//
// DISMISSED questions must NOT be recorded. The × button's tooltip is
// "Hide (the agent keeps waiting)" — hiding is not answering, and a
// dismissed question is SUPPOSED to come back.
const ANSWERED_KEY = 'parley.answeredQuestions';
const ANSWERED_CAP = 200;

function readAnswered(): string[] {
  try {
    const raw = localStorage.getItem(ANSWERED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch { return []; }  // private mode / corrupt value
}

/** Record a question id as ANSWERED so no replay of it ever pops again
 *  on this device. Idempotent; a repeat answer refreshes recency. */
function markAnswered(questionId: string): void {
  if (!questionId) return;
  try {
    const ids = readAnswered().filter((id) => id !== questionId);
    ids.push(questionId);
    localStorage.setItem(
      ANSWERED_KEY,
      JSON.stringify(ids.slice(Math.max(0, ids.length - ANSWERED_CAP))),
    );
  } catch { /* private mode — the proxy-side ring still covers us */ }
}

function isAnswered(questionId: string): boolean {
  return readAnswered().includes(questionId);
}

/** Test-only: forget every recorded answer. */
export function __resetAnsweredForTest(): void {
  try { localStorage.removeItem(ANSWERED_KEY); } catch { /* private mode */ }
}

function teardown(): void {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  rootEl?.remove();
  rootEl = null;
  current = null;
}

function fmtRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 90) return `${Math.ceil(s / 60)}m`;
  return `${s}s`;
}

async function answerClarify(q: AgentQuestion, response: string): Promise<void> {
  try {
    const r = await fetch(apiUrl(`/api/parley/questions/${encodeURIComponent(q.question_id)}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response }),
    });
    if (r.status === 404) {
      // Lapsed underneath us — show the dead state briefly.
      markExpired('This question has lapsed — the agent moved on.');
      return;
    }
    markAnswered(q.question_id);
    teardown();
  } catch (e: any) {
    diag(`[question] answer failed: ${e?.message || e}`);
    markExpired('Could not deliver the answer — reply in chat instead.');
  }
}

function markExpired(note?: string): void {
  if (!rootEl) return;
  rootEl.classList.add('expired');
  rootEl.querySelectorAll('button.q-choice, .q-freetext').forEach((el) => {
    (el as HTMLButtonElement).disabled = true;
    el.classList.add('disabled');
  });
  const cd = rootEl.querySelector('.q-countdown');
  if (cd) cd.textContent = note || 'Expired';
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  setTimeout(() => teardown(), 6000);
}

/** Show (or replace) the pop-up for an agent question. Skips questions
 *  that are already past their expiry (ring replays after the fact) and
 *  questions this device has already ANSWERED (ring replays of a
 *  still-live-but-settled question — the refresh-resurrects-answered-
 *  question bug). */
export function show(q: AgentQuestion): void {
  if (!q?.question_id || !q?.question) return;
  if (typeof q.expires_at === 'number' && q.expires_at <= Date.now()) {
    diag(`[question] ${q.question_id} already expired — not showing`);
    return;
  }
  if (isAnswered(q.question_id)) {
    diag(`[question] ${q.question_id} already answered — not showing`);
    return;
  }
  teardown();
  current = q;

  const root = document.createElement('div');
  root.className = 'question-popup';
  root.setAttribute('data-question-id', q.question_id);

  const head = document.createElement('div');
  head.className = 'q-head';
  const label = document.createElement('span');
  label.className = 'q-kind';
  label.textContent = q.kind === 'approval' ? '⚠️ Approval needed' : '❓ The agent is asking';
  const countdown = document.createElement('span');
  countdown.className = 'q-countdown';
  head.append(label, countdown);

  const body = document.createElement('div');
  body.className = 'q-body';
  body.textContent = q.question;

  const actions = document.createElement('div');
  actions.className = 'q-actions';

  const answer = (text: string) => {
    if (!current) return;
    if (q.kind === 'approval') {
      sendCommandCb?.(text, q.chat_id);
      // Approvals resolve inside the backend, so the proxy never sees a
      // /questions POST and can't retire the envelope from its ring.
      // This local record is the ONLY thing standing between the user
      // and the same approval popping again on next refresh.
      markAnswered(q.question_id);
      teardown();
    } else {
      void answerClarify(q, text);
    }
  };

  const choices = q.kind === 'approval' && (!q.choices || q.choices.length === 0)
    ? ['/approve', '/deny']
    : (q.choices || []);
  for (const c of choices) {
    const btn = document.createElement('button');
    btn.className = 'q-choice';
    btn.textContent = c;
    btn.onclick = () => answer(c);
    actions.appendChild(btn);
  }

  const freeRow = document.createElement('div');
  if (q.allow_free_text !== false && q.kind !== 'approval') {
    freeRow.className = 'q-free-row';
    const input = document.createElement('input');
    input.className = 'q-freetext';
    input.placeholder = 'Type an answer…';
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter' && input.value.trim()) answer(input.value.trim());
    };
    const send = document.createElement('button');
    send.className = 'q-choice q-free-send';
    send.textContent = 'Answer';
    send.onclick = () => { if (input.value.trim()) answer(input.value.trim()); };
    freeRow.append(input, send);
  }

  const hint = document.createElement('div');
  hint.className = 'q-hint';
  hint.textContent = q.kind === 'approval'
    ? 'Expires when the approval window closes.'
    : 'Replying in the chat also answers this.';

  const dismiss = document.createElement('button');
  dismiss.className = 'q-dismiss';
  dismiss.title = 'Hide (the agent keeps waiting)';
  dismiss.textContent = '×';
  dismiss.onclick = () => teardown();

  root.append(dismiss, head, body, actions);
  if (freeRow.className) root.append(freeRow);
  root.append(hint);
  document.body.appendChild(root);
  rootEl = root;

  if (typeof q.expires_at === 'number') {
    const tick = () => {
      const left = (q.expires_at as number) - Date.now();
      if (left <= 0) {
        markExpired(q.kind === 'approval'
          ? 'Approval window closed — the agent moved on.'
          : 'Expired — the agent stopped waiting.');
        return;
      }
      countdown.textContent = fmtRemaining(left);
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  } else {
    countdown.textContent = '';
  }
}

/** The chat's own send box answered a pending clarify (gateway
 *  text-intercept) — drop the pop-up so it doesn't outlive the
 *  question. Called from the send path. */
export function noteUserSentText(chatId: string): void {
  if (current && current.kind !== 'approval' && current.chat_id === chatId) {
    // The text-intercept ANSWERED it (the gateway hands the typed text
    // to the blocked clarify call), so this is an answer, not a
    // dismissal — record it or the ring replays it on next reload.
    markAnswered(current.question_id);
    teardown();
  }
}
