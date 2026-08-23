/**
 * In-memory mirror of in-flight turns. The plugin's source of truth
 * for what's happening BETWEEN /v1/responses POST receipt and the
 * matching lifecycle:end event — during which openclaw has NOT yet
 * persisted anything to the session jsonl (verified empirically:
 * 300ms after POST, items returns 0 rows; 2s after POST, items
 * returns the full transcript).
 *
 * Reads:
 *   /v1/conversations/{id}/items merges any active turn for the chat
 *   onto the durable jsonl history (ordered by timestamp). On session
 *   switch + return mid-flight, the user msg + emitted tool calls
 *   are visible immediately instead of disappearing until the agent
 *   finishes.
 *
 * Writes:
 *   - openTurn() at /v1/responses POST receipt (chatId + userMessage)
 *   - observeAgentEvent() captures stream:"tool" and stream:"assistant"
 *     events as they fire on the in-process bus
 *   - closeTurn() at lifecycle:end — durable jsonl is now authoritative,
 *     drop the buffer to free memory
 *
 * Key by runId — the gateway-assigned id chat.send returns. Cross-
 * referenced from chatId for the items-merge read path.
 *
 * NOT durable. Plugin restart drops everything. A turn that was
 * mid-flight at the moment of restart is dead anyway (the agent
 * runtime in openclaw can't continue after the gateway restarts);
 * the user has to resend. Crash-resilience for in-flight turns is
 * outside the supplemental store's scope.
 */

import { randomUUID } from 'node:crypto';

export class TurnBuffer {
  constructor() {
    // runId → { chatId, runId, userMessage, userMessageId, toolCalls,
    //          toolResults, assistantText, startedAt }
    this.byRunId = new Map();
    // chatId → Set<runId> for fast items-merge lookup. Multiple turns
    // per chat is unusual but possible (cron / scheduled secondary runs).
    this.byChatId = new Map();
  }

  /** Called from /v1/responses POST handler before chat.send.
   *  Returns the user-message id to use for the user_message envelope. */
  openTurn({ runId, chatId, userMessage, userMessageId, assistantMessageId, startedAt }) {
    const entry = {
      chatId,
      runId,
      userMessage,
      userMessageId: userMessageId || `umsg_${randomUUID()}`,
      toolCalls: [],          // [{callId, name, args, ts}]
      toolResults: [],        // [{callId, name, result, ts, isError}]
      assistantText: '',      // accumulated message-tool args.message
      // Stable id used in the reply_delta envelope emitted by
      // renderEnvelopes(). Passed in by /v1/responses (the same `msg_*`
      // id that streams via response.output_text.delta) so a
      // reconnected PWA's streaming bubble is keyed the same way as
      // subsequent live deltas.
      assistantMessageId: assistantMessageId || '',
      startedAt: startedAt ?? Date.now(),
    };
    this.byRunId.set(runId, entry);
    if (!this.byChatId.has(chatId)) this.byChatId.set(chatId, new Set());
    this.byChatId.get(chatId).add(runId);
    return entry;
  }

  /** Observe an AgentEventPayload. Updates the matching turn entry.
   *  Silent no-op if the runId isn't tracked (turn not opened via
   *  openTurn, or already closed). */
  observeAgentEvent(event) {
    const entry = this.byRunId.get(event?.runId);
    if (!entry) return;
    const { stream, data } = event;
    if (stream === 'tool' && data?.phase === 'start' && data.name === 'message'
        && typeof data.args?.message === 'string') {
      // The `message` tool's args.message IS the user-facing reply.
      // Append (handles multi-message turns).
      entry.assistantText = entry.assistantText
        ? `${entry.assistantText}\n\n${data.args.message}`
        : data.args.message;
    } else if (stream === 'tool' && data?.phase === 'start') {
      entry.toolCalls.push({
        callId: data.toolCallId ?? data.callId ?? '',
        name: data.name ?? '',
        args: data.args ?? data.arguments ?? {},
        ts: event.ts ?? Date.now(),
      });
    } else if (stream === 'tool' && data?.phase === 'result') {
      // Suppress message-tool results (matches the items mapper —
      // they're noise in the user-facing transcript).
      if (data.name === 'message') return;
      entry.toolResults.push({
        callId: data.toolCallId ?? data.callId ?? '',
        name: data.name ?? '',
        result: data.result ?? data.output ?? '',
        isError: data.isError === true,
        ts: event.ts ?? Date.now(),
      });
    } else if (stream === 'assistant' && typeof data?.text === 'string') {
      // Fallback: turns without a `message` tool call (rare — happens
      // when channel not configured). Use the raw assistant text.
      if (!entry.assistantText) entry.assistantText = data.text;
    }
  }

  closeTurn(runId) {
    const entry = this.byRunId.get(runId);
    if (!entry) return;
    this.byRunId.delete(runId);
    const set = this.byChatId.get(entry.chatId);
    if (set) {
      set.delete(runId);
      if (set.size === 0) this.byChatId.delete(entry.chatId);
    }
  }

  /** All active turns for a chat, oldest first by startedAt. Used by
   *  the items handler to fold in-flight state onto the durable read. */
  activeTurnsForChat(chatId) {
    const set = this.byChatId.get(chatId);
    if (!set) return [];
    const turns = [];
    for (const runId of set) {
      const t = this.byRunId.get(runId);
      if (t) turns.push(t);
    }
    turns.sort((a, b) => a.startedAt - b.startedAt);
    return turns;
  }

  /** Render a turn's accumulated state as live-SSE-shape envelopes.
   *  Replayed through the PWA's `backend.replayInflight()` path on
   *  mid-turn reconnect; the bubbles render as STREAMING (keyed by
   *  message_id), so subsequent live SSE deltas update the same
   *  bubble instead of forking a duplicate.
   *
   *  This replaces the older `renderItems` items-merge approach.
   *  Items merge produced finalized rows without `parley_id` on
   *  the in-flight assistant, which caused a visible double-render
   *  once live SSE deltas resumed. Envelope shape carries the
   *  message_id end-to-end.
   *
   *  Wire shape mirrors `proxy/parley/upstream.ts` ParleyEnvelope. */
  renderEnvelopes(turn) {
    const out = [];
    out.push({
      type: 'user_message',
      chat_id: turn.chatId,
      message_id: turn.userMessageId,
      text: turn.userMessage,
    });
    const events = [
      ...turn.toolCalls.map((c) => ({ kind: 'call', ...c })),
      ...turn.toolResults.map((r) => ({ kind: 'result', ...r })),
    ].sort((a, b) => a.ts - b.ts);
    for (const e of events) {
      if (e.kind === 'call') {
        out.push({
          type: 'tool_call',
          chat_id: turn.chatId,
          call_id: e.callId || '',
          tool_name: e.name || '',
          args: e.args,
        });
      } else {
        out.push({
          type: 'tool_result',
          chat_id: turn.chatId,
          call_id: e.callId || '',
          tool_name: e.name || '',
          result: e.result,
        });
      }
    }
    if (turn.assistantText && turn.assistantMessageId) {
      out.push({
        type: 'reply_delta',
        chat_id: turn.chatId,
        message_id: turn.assistantMessageId,
        text: turn.assistantText,
        edit: true,
      });
    }
    return out;
  }

  /** Render a turn's accumulated state as ConversationItem[] in
   *  timestamp order. Same shape the durable items handler returns —
   *  the caller merges by timestamp and the PWA sees one ordered
   *  transcript regardless of whether the rows are durable or
   *  in-flight.
   *
   *  Used by /v1/conversations/{id}/items after the durable read. */
  renderItems(turn, { startSeq = 1_000_000 } = {}) {
    // High seq base for in-flight items so they never collide with
    // durable seqs (which start at 0 and grow). The PWA dedups by
    // parley_id, so seq is just for ordering within the response.
    const out = [];
    let seq = startSeq;
    out.push({
      id: seq++,
      object: 'message',
      role: 'user',
      content: turn.userMessage,
      created_at: Math.floor(turn.startedAt / 1000),
      parley_id: turn.userMessageId,
    });
    // Tool calls + results interleaved by timestamp.
    const events = [
      ...turn.toolCalls.map((c) => ({ kind: 'call', ...c })),
      ...turn.toolResults.map((r) => ({ kind: 'result', ...r })),
    ].sort((a, b) => a.ts - b.ts);
    for (const e of events) {
      out.push({
        id: seq++,
        object: 'message',
        role: 'tool',
        content: e.kind === 'call' ? JSON.stringify({ name: e.name, args: e.args })
                                   : (typeof e.result === 'string' ? e.result : JSON.stringify(e.result)),
        created_at: Math.floor(e.ts / 1000),
        tool_name: e.name,
      });
    }
    // Streaming assistant text (if any). No final row yet — turn isn't
    // complete. Marked streaming so the PWA renders it as in-progress.
    if (turn.assistantText) {
      out.push({
        id: seq++,
        object: 'message',
        role: 'assistant',
        content: turn.assistantText,
        created_at: Math.floor(Date.now() / 1000),
        // No parley_id yet — the link write happens at turn close.
        // The PWA's reload-replay path will dedup against the live
        // SSE msg_id once the durable row materializes.
      });
    }
    return out;
  }
}
