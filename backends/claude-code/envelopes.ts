// Envelope types for the claude-code backend.
//
// The union is imported type-only from the proxy's contract
// (proxy/parley/contract/envelopes.ts) so this backend can never drift
// from the shapes the proxy multiplexer consumes. agent_question and
// doc_show are part of that union (the local copies this file once kept
// were the third definition of those two shapes — 2026-10-26 audit).

import type { ParleyEnvelope } from '../../proxy/parley/contract/envelopes.ts';

export type { ParleyEnvelope };
export type AgentQuestionEnvelope = Extract<ParleyEnvelope, { type: 'agent_question' }>;
export type DocShowEnvelope = Extract<ParleyEnvelope, { type: 'doc_show' }>;
export type ClaudeCodeEnvelope = ParleyEnvelope;

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
