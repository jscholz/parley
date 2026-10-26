/**
 * @fileoverview THE envelope contract between the upstream agent, the
 * proxy, and the PWA — one definition, checked in three places.
 *
 * Why this file exists (2026-10-26 coupling audit, docs/
 * PARLEY_HERMES_COUPLING_AUDIT.md §1.2): the set of stream envelope
 * types was written down in seven places that disagreed — the plugin's
 * emit sites, `upstream.ts`'s union, `stream.ts`'s hand-maintained
 * FANOUT allow-list, `src/transcript/types.ts`'s mirror, the PWA's
 * EventSource subscription list, `backends/claude-code/envelopes.ts`,
 * and the protocol doc. Two envelopes the plugin publishes (`job_run`,
 * `activity_changed`) were silently dropped by the proxy for months
 * because nothing checked that plugin-emitted ⊆ fanned-out ⊆ handled.
 *
 * Rules:
 *   - `ParleyEnvelope` is the only union. `upstream.ts` and the PWA's
 *     `src/transcript/types.ts` re-export it type-only (the PWA bundle
 *     never runtime-imports proxy code).
 *   - `UPSTREAM_ENVELOPE_TYPES` / `PROXY_ENVELOPE_TYPES` are the runtime
 *     lists. `stream.ts` derives its fan-out set from them; a type that
 *     is in the union but not in a list fails `tsc` (see the exhaustive
 *     check at the bottom), so adding a variant forces the decision.
 *   - The plugin declares the types it emits in
 *     `backends/hermes/plugin/parley_envelopes.py`; the PWA declares what
 *     it subscribes to in `src/envelopeTypes.ts`. The contract test
 *     (`proxy/parley/__tests__/contract-envelopes.test.ts`) pins
 *     plugin ⊆ upstream list, and upstream ∪ proxy == PWA subscriptions.
 *
 * No imports — this module must stay dependency-free so every layer can
 * read it without dragging anything else in.
 */

/** Durable copy of what the user attached to a turn (user-upload lane). */
export interface EnvelopeAttachment {
  idx?: number;
  url: string;
  mimeType: string;
  fileName?: string;
  size?: number;
  /** Storage governance swept the file (Settings › Storage). */
  purged?: boolean;
}

export type ParleyEnvelope =
  // ── In-turn stream (ride `/v1/responses` or `/v1/events`) ──────────
  /** Cumulative reply text so far. `interim` marks a holding/heartbeat
   *  send that keeps the turn open (not the final answer). */
  | { type: 'reply_delta'; chat_id: string; text: string; message_id: string; edit?: boolean; interim?: boolean }
  | { type: 'reply_final'; chat_id: string; message_id: string; text?: string; interim?: boolean }
  | { type: 'tool_call'; chat_id: string; call_id: string; tool_name: string; args: unknown; started_at?: string }
  | { type: 'tool_result'; chat_id: string; call_id: string; tool_name: string; result: unknown; duration_ms?: number }
  | { type: 'typing'; chat_id: string }
  /** Ephemeral working indicator. The hermes plugin converts the gateway's
   *  "⏳ Working — N min — iteration i/n, tool" heartbeat into this (keyed
   *  `status_<chat>`), so it renders as the turn-status line, never a
   *  bubble. Not persisted; ignored on ring replay. */
  | { type: 'status'; chat_id: string; message_id?: string; text?: string; state?: 'working' | 'done'; ts?: number }
  // hermes' processing bracket (plugin on_processing_start/complete).
  // turn_id pairs them; user_message_id names the bubble to mark.
  | { type: 'turn_start'; chat_id: string; turn_id: string; user_message_id?: string }
  | { type: 'turn_end'; chat_id: string; turn_id: string; user_message_id?: string;
      outcome: 'success' | 'failure' | 'cancelled'; replied?: boolean; active_turns?: number }
  | { type: 'image'; chat_id: string; url: string; caption?: string }
  /** Out-of-turn agent output (cron, reminders, approvals, background
   *  tasks). `kind` discriminates; approvals also carry the parsed
   *  `command` / `reason` so no layer has to re-parse the prose. */
  | { type: 'notification'; chat_id: string; kind: string; content: string; text?: string;
      parley_id?: string; command?: string; reason?: string; title?: string; should_push?: boolean }
  | { type: 'session_changed'; chat_id: string; session_id: string; title: string }
  // Cross-device user-message broadcast. Emitted by the upstream as
  // soon as a /v1/responses POST lands, BEFORE the agent dispatches.
  // Other connected PWA tabs render the user bubble immediately; the
  // originating tab dedups against its optimistic bubble via
  // `message_id`.
  | { type: 'user_message'; chat_id: string; message_id: string; text: string; attachments?: EnvelopeAttachment[] }
  | { type: 'error'; chat_id: string; message: string; user_message_id?: string }
  // ── Out-of-turn, upstream-owned (ride `/v1/events`) ────────────────
  // Unified elicitation (2026-07-13): the agent is blocked on a user
  // answer. hermes emits these for clarify; the claude-code backend
  // for canUseTool approvals. The PWA renders a pop-up; answers ride
  // POST /api/parley/questions/{id}. expires_at null = sticks until
  // answered.
  | {
      type: 'agent_question'; chat_id: string; question_id: string;
      kind: string; question: string; choices?: string[];
      allow_free_text?: boolean; expires_at?: number | null; urgent?: boolean;
    }
  // display_doc → Docs shelf push (hermes plugin + claude-code MCP shim).
  | {
      type: 'doc_show'; chat_id: string; title: string; content: string;
      format?: string; path?: string; doc_id?: string;
      displayed_at?: number; source?: string; capture_id?: string;
    }
  // Cross-device SSOT sync: one device hit /seen, /mark, pin/unpin,
  // activity resolve/seen, or deleted a chat — other devices re-fetch
  // the canonical state instead of waiting for foreground.
  | { type: 'unread_changed'; chat_id: string; cause?: string }
  | { type: 'pins_changed'; chat_id: string; cause?: string; msg_id?: string }
  /** `chat_id` is `'*'` when the change is not chat-scoped (clear all). */
  | { type: 'activity_changed'; chat_id: string; cause?: string; item_id?: string; kind?: string }
  | { type: 'conversation_deleted'; chat_id: string; source?: string }
  /** A scheduled job's run changed state. `chat_id` is where the job
   *  reports (or the `'cron'` placeholder) — NOT used for routing. */
  | { type: 'job_run'; chat_id: string; job_id: string; job_name?: string; run: Record<string, unknown> }
  // ── Proxy-owned (never cross the upstream boundary) ────────────────
  /** Docs shelf (proxy docShelf.ts): the open set changed on another
   *  device — fetch the merged shelf. */
  | { type: 'doc_shelf_changed'; chat_id: string; version?: number; by?: string }
  /** Meeting capture (proxy capture.ts): lifecycle state for
   *  cross-device pills/lists, and the external-trigger control plane. */
  | { type: 'capture_changed'; chat_id: string; [k: string]: unknown }
  | { type: 'capture_control'; chat_id: string; [k: string]: unknown };

export type EnvelopeType = ParleyEnvelope['type'];

/** Types an upstream agent may publish (in-turn stream or `/v1/events`).
 *  The hermes plugin's `parley_envelopes.ENVELOPE_TYPES` must be a
 *  subset; the contract test enforces it. */
export const UPSTREAM_ENVELOPE_TYPES = [
  'reply_delta', 'reply_final', 'tool_call', 'tool_result', 'typing', 'status',
  'turn_start', 'turn_end', 'image', 'notification', 'session_changed',
  'user_message', 'error', 'agent_question', 'doc_show',
  'unread_changed', 'pins_changed', 'activity_changed', 'conversation_deleted',
  'job_run',
] as const satisfies readonly EnvelopeType[];

/** Upstream-side types no backend emits directly: the proxy's OAI
 *  translator (upstream.ts) synthesises them from the `/v1/responses`
 *  stream (`response.error` → `error`). Listed so the contract test can
 *  tell "no backend declares this" from "translator-owned". */
export const TRANSLATOR_ENVELOPE_TYPES = ['error'] as const satisfies readonly EnvelopeType[];

/** Types the proxy itself originates. */
export const PROXY_ENVELOPE_TYPES = [
  'doc_shelf_changed', 'capture_changed', 'capture_control',
] as const satisfies readonly EnvelopeType[];

/** Everything the proxy fans out to PWA tabs = everything the PWA must
 *  subscribe to. Derived, never hand-maintained. */
export const ENVELOPE_TYPES = [...UPSTREAM_ENVELOPE_TYPES, ...PROXY_ENVELOPE_TYPES] as const;

export function isEnvelopeType(t: unknown): t is EnvelopeType {
  return typeof t === 'string' && (ENVELOPE_TYPES as readonly string[]).includes(t);
}

// Exhaustiveness: every union variant must appear in exactly one list.
// Adding a variant to `ParleyEnvelope` without listing it fails here.
type Listed = (typeof ENVELOPE_TYPES)[number];
type Missing = Exclude<EnvelopeType, Listed>;
const _everyVariantListed: Missing extends never ? true : Missing = true;
void _everyVariantListed;
