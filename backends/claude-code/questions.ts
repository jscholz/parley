// Pending-question registry — the bridge between the SDK's canUseTool
// callback and the PWA's agent_question pop-up.
//
// Flow: canUseTool fires mid-turn → ask() mints an agent_question
// envelope (kind:'approval', expires_at:null — sticks until answered)
// and parks a resolver → the envelope rides the turn stream to the PWA
// → the user taps a choice → POST /api/sidekick/questions/{id} lands on
// ClaudeCodeUpstream.answerQuestion() → answer() resolves the parked
// promise → canUseTool returns allow/deny to the SDK and the run
// continues.
//
// answer() returns false for unknown/lapsed ids — the route surfaces
// that as 404 ("question lapsed"), matching the hermes plugin's
// /v1/questions/{id} semantics.

import { randomUUID } from 'node:crypto';
import type { AgentQuestionEnvelope } from './envelopes.ts';

export const APPROVE_CHOICE = 'Allow';
export const DENY_CHOICE = 'Deny';

export interface QuestionAnswer {
  /** Raw response string from the PWA ({"response": "..."}). */
  response: string;
}

interface PendingQuestion {
  chatId: string;
  resolve: (answer: QuestionAnswer | null) => void;
}

export interface AskResult {
  envelope: AgentQuestionEnvelope;
  /** Resolves with the user's answer, or null if the turn ended /
   *  aborted before anyone answered. */
  answer: Promise<QuestionAnswer | null>;
}

export class QuestionRegistry {
  private pending = new Map<string, PendingQuestion>();

  ask(opts: {
    chatId: string;
    kind: 'approval' | 'clarify';
    question: string;
    choices?: string[];
    allowFreeText?: boolean;
    expiresAt?: number | null;
  }): AskResult {
    const questionId = `ccq_${randomUUID()}`;
    const envelope: AgentQuestionEnvelope = {
      type: 'agent_question',
      chat_id: opts.chatId,
      question_id: questionId,
      kind: opts.kind,
      question: opts.question,
      choices: opts.choices ?? [APPROVE_CHOICE, DENY_CHOICE],
      allow_free_text: opts.allowFreeText ?? true,
      expires_at: opts.expiresAt ?? null,
      urgent: true,
    };
    const answer = new Promise<QuestionAnswer | null>((resolve) => {
      this.pending.set(questionId, { chatId: opts.chatId, resolve });
    });
    return { envelope, answer };
  }

  /** Resolve a pending question. Returns false when the id is unknown —
   *  answered elsewhere, expired, or never ours (route → 404). */
  answer(questionId: string, response: string): boolean {
    const entry = this.pending.get(questionId);
    if (!entry) return false;
    this.pending.delete(questionId);
    entry.resolve({ response });
    return true;
  }

  /** Cancel every question parked for a chat (turn ended / aborted /
   *  errored). Parked canUseTool promises resolve null → deny, so the
   *  SDK never hangs on a question nobody can answer anymore. */
  cancelForChat(chatId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.chatId !== chatId) continue;
      this.pending.delete(id);
      entry.resolve(null);
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

/** Map a free-form answer onto the approval verdict. Choice taps send
 *  the choice text verbatim; typed answers get keyword-matched, and
 *  anything else is a deny whose text rides back to the model as the
 *  deny message (cheap "deny with instructions"). */
export function isApproval(response: string): boolean {
  return /^(allow|approve|approved|yes|y|ok|okay|sure|go ahead)$/i.test(response.trim());
}
