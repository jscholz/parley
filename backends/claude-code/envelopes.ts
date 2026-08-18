// Envelope types for the claude-code backend.
//
// The base union is imported type-only from the proxy's upstream contract
// (proxy/sidekick/upstream.ts) so this backend can never drift from the
// shapes the proxy multiplexer consumes. Two envelope types the runtime
// protocol already carries (stream.ts ALLOWED_TYPES includes both) are not
// yet in that TS union — agent_question (unified elicitation, 2026-07-13)
// and doc_show (Docs panel push) — so they're defined here and unioned in.
// The wiring step should add them to SidekickEnvelope in upstream.ts and
// delete the local copies (see README "Wiring plan").

import type { SidekickEnvelope } from '../../proxy/sidekick/upstream.ts';

export type { SidekickEnvelope };

/** Unified elicitation protocol (2026-07-13). Rendered by the PWA as a
 *  pop-up with choice buttons (+ free text); answered via
 *  POST /api/parley/questions/{question_id}. Mirrors the hermes
 *  plugin's send_clarify emission (backends/hermes/plugin/__init__.py). */
export interface AgentQuestionEnvelope {
  type: 'agent_question';
  chat_id: string;
  question_id: string;
  kind: 'approval' | 'clarify';
  question: string;
  choices: string[];
  allow_free_text: boolean;
  /** Epoch ms deadline driving the pop-up countdown; null = sticks until
   *  answered (approvals block the SDK turn indefinitely by design). */
  expires_at: number | null;
  urgent?: boolean;
}

/** Docs-panel push. Mirrors the hermes display_doc tool's emission
 *  (backends/hermes/plugin/sidekick_doc_tool.py). */
export interface DocShowEnvelope {
  type: 'doc_show';
  chat_id: string;
  title: string;
  content: string;
  format: string; // 'markdown' | 'html' | 'text'
  path: string;
  /** djb2 hex of the path — MUST mirror docStore.docIdFor in the PWA. */
  doc_id: string;
  displayed_at: number; // epoch ms, server clock
}

export type ClaudeCodeEnvelope = SidekickEnvelope | AgentQuestionEnvelope | DocShowEnvelope;

/** djb2 hex hash, mirroring the PWA's docStore.docIdFor and the hermes
 *  plugin's _doc_id_for — keeps doc_show dedup keys identical across
 *  backends. */
export function docIdFor(path: string, title: string): string {
  const key = path.trim() || `title:${title.trim().toLowerCase()}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}
