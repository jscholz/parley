/**
 * POST /v1/responses — turn dispatch with streaming SSE response.
 *
 * Pipeline:
 *   1. Parse OAI Responses-API body → derive sessionKey + message.
 *   2. Claim a runId-keyed queue from the event bus.
 *   3. Call chat.send via the gateway WS client — returns { runId }.
 *   4. Drain events from the queue, translate to OAI Responses-API
 *      SSE events, write to the HTTP response.
 *   5. On lifecycle "end" (or error), emit response.completed and
 *      release the run.
 *
 * Event translation (openclaw AgentEventPayload → OAI SSE):
 *   stream="assistant", data.delta       → response.output_text.delta
 *   stream="lifecycle", data.phase="end" → response.completed
 *   stream="tool", data.phase="start"    → response.output_item.added
 *                                          (function_call type)
 *   stream="item", data.phase="end"      → response.output_item.done
 *                                          (function_call_output type)
 *   stream="error"                       → response.error
 *
 * Mirrors the hermes plugin's /v1/responses streaming path. See
 * `~/code/parley/backends/hermes/plugin/__init__.py` line 3105.
 */
import { randomUUID } from 'node:crypto';
import { prefixChatId } from './mappers.js';
import { upsertMessage } from './messages.js';
import { readSessionMessages, resolveStateDir, isDeliveryMirror, listSessions } from './openclaw-store.js';

const AGENT_ID = process.env.OPENCLAW_SK_AGENT || 'dev';
const PROFILE = process.env.OPENCLAW_SK_PROFILE || 'sk-integ';

const TURN_TIMEOUT_MS = 120_000;
const TOOL_RESULT_MAX_BYTES = 64 * 1024;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** Read the request body as utf-8 JSON. Returns null on parse error. */
async function readJsonBody(req, capBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > capBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

/** Pull the sessionKey + text out of the OAI Responses-API body.
 *  Tolerates both:
 *    - parley proxy shape: `{ input: "...", metadata: {chat_id: "..."} }`
 *    - openclaw-native shape: `{ input: [...], conversation: "agent:dev:main" }`
 *  Returns null when the body doesn't carry enough to dispatch. */
function parseResponsesBody(body) {
  if (!body || typeof body !== 'object') return null;
  // sessionKey: prefer explicit `conversation` (OAI standard),
  // fall back to `metadata.chat_id` (parley proxy ships it there).
  const sessionKey = body.conversation
    ?? body.metadata?.chat_id
    ?? null;
  if (!sessionKey) return null;
  // text: input can be a string OR an array of items. For arrays, find
  // the most-recent user-role message and pull its text.
  let text = null;
  if (typeof body.input === 'string') {
    text = body.input;
  } else if (Array.isArray(body.input)) {
    for (let i = body.input.length - 1; i >= 0; i--) {
      const item = body.input[i];
      if (item?.role === 'user') {
        if (typeof item.content === 'string') { text = item.content; break; }
        if (Array.isArray(item.content)) {
          const t = item.content.find((c) => c?.type === 'input_text' || c?.type === 'text')?.text;
          if (typeof t === 'string') { text = t; break; }
        }
      }
    }
  }
  if (typeof text !== 'string') return null;
  return {
    sessionKey,
    text,
    userMessageId: body.metadata?.user_message_id ?? null,
    voice: body.metadata?.voice === 'true',
    attachments: Array.isArray(body.attachments) ? body.attachments : null,
  };
}

/** Build the response.completed envelope. Mirrors hermes plugin's
 *  _build_response_envelope shape — the PWA's proxy expects this. */
function buildCompletedEnvelope({ responseId, messageId, createdAt, assembled }) {
  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    output: [
      {
        type: 'message',
        id: messageId,
        role: 'assistant',
        content: [{ type: 'output_text', text: assembled }],
      },
    ],
  };
}

/** Persist the link between our plugin-emitted SSE-shape msg_* id and
 *  openclaw's __openclaw.id for the assistant message that just landed.
 *
 *  Without this, /v1/conversations/{id}/items has no `sidekick_id` to
 *  surface, the PWA's inflight-cache bubble (keyed by msg_*) can't
 *  dedup against the reload-replay bubble (keyed by integer seq), and
 *  every reload shows duplicated assistant bubbles.
 *
 *  Heuristic: read the latest assistant rows from the jsonl and attach
 *  our msg_* to the most recent non-mirror assistant row that lands
 *  after `dispatchedAt`. Misses are silent (will just lose dedup, not
 *  corrupt data). */
/** Find the user-row that landed in the jsonl for this turn and link
 *  it to the userMessageId the plugin/PWA pre-minted. Lets /items
 *  emit `sidekick_id` for the durable user row → PWA dedups the
 *  optimistic bubble (msg_id=umsg_X) against the durable replay. */
function persistUserMessageLink({ db, sessionKey, chatId, userMessageId, dispatchedAt, logger }) {
  if (!userMessageId) return;
  try {
    const stateDir = resolveStateDir({ profile: PROFILE });
    const sessions = listSessions({ stateDir, agentId: AGENT_ID });
    const entry = sessions[sessionKey];
    if (!entry) return;
    const all = readSessionMessages({ stateDir, agentId: AGENT_ID, sessionId: entry.sessionId });
    // Most-recent USER row at-or-after dispatch time.
    let target = null;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      if (m.role !== 'user') continue;
      const ts = m.timestamp ?? (m.wrapperTs ? Date.parse(m.wrapperTs) : 0);
      if (ts < dispatchedAt - 1000) break;
      target = m;
      break;
    }
    if (!target?.wrapperId) return;
    // Best-effort content read (probably "[Sat ...] raw text").
    const contentStr = typeof target.content === 'string' ? target.content : '';
    upsertMessage(db, {
      id: userMessageId,
      chat_id: chatId,
      role: 'user',
      content: contentStr,
      status: 'final',
      agent_row_id: target.wrapperId,
    });
  } catch (err) {
    logger.warn?.(`[parley] user link write failed: ${err?.message ?? err}`);
  }
}

function persistMessageLink({ db, sessionKey, chatId, messageId, dispatchedAt, logger }) {
  try {
    const stateDir = resolveStateDir({ profile: PROFILE });
    // sessionKey is the canonical form (agent:dev:sidekick:abc); we
    // need the sessionId (uuid) to find the jsonl.
    const sessions = listSessions({ stateDir, agentId: AGENT_ID });
    const entry = sessions[sessionKey];
    if (!entry) { logger.warn?.(`[parley] link: no session for ${sessionKey}`); return; }
    const all = readSessionMessages({ stateDir, agentId: AGENT_ID, sessionId: entry.sessionId });
    // Find the assistant row this turn produced that the items handler
    // will render. Preference order:
    //   1. The row with a `message` tool call (the user-facing reply
    //      lives in args.message; items renders this as assistant text)
    //   2. A plain assistant-text row that ISN'T the codex narration
    //      ("Sending..." / "Replying casually...")
    // We scan from the newest backwards but only consider rows
    // timestamped at-or-after the dispatch.
    const dispatchedMs = dispatchedAt;
    let target = null;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      if (m.role !== 'assistant') continue;
      if (isDeliveryMirror(m)) continue;
      const ts = m.timestamp ?? (m.wrapperTs ? Date.parse(m.wrapperTs) : 0);
      if (ts < dispatchedMs - 1000) break;
      // Prefer toolCall (message tool); fall back to non-narration text.
      const hasMessageToolCall = Array.isArray(m.content) && m.content.some(
        (c) => c?.type === 'toolCall' && c?.name === 'message',
      );
      if (hasMessageToolCall) { target = m; break; }
      if (!target) target = m;   // candidate but keep scanning for tool row
    }
    if (!target) {
      logger.warn?.(`[parley] link: no target found for ${sessionKey}, all=${all.length}, dispatchedMs=${dispatchedMs}`);
      return;
    }
    // The jsonl wrapper carries a top-level `id` (uuid) per message —
    // we exposed it as `wrapperId` in readSessionMessages. That's
    // the stable cross-read key (chat.history's `__openclaw.id` is
    // computed at response time and not persisted to the jsonl).
    const openclawId = target?.wrapperId;
    if (!openclawId) { logger.warn?.(`[parley] link: target has no wrapperId`); return; }
    logger.info?.(`[parley] link write: ${chatId} ${messageId} -> openclaw ${openclawId}`);
    // Flatten content for storage. The supplemental row mainly serves
    // as the id-mapping table; the canonical content stays in openclaw's
    // jsonl. Use `agent_row_id` as the openclaw foreign key.
    let contentStr = '';
    if (typeof target.content === 'string') contentStr = target.content;
    else if (Array.isArray(target.content)) {
      contentStr = target.content.map(c => c?.text ?? '').filter(Boolean).join('\n');
    }
    upsertMessage(db, {
      id: messageId,
      chat_id: chatId,
      role: 'assistant',
      content: contentStr,
      status: 'final',
      agent_row_id: openclawId,
    });
  } catch (err) {
    logger.warn?.(`[parley.responses] link write failed: ${err?.message ?? err}`);
  }
}

export function makeResponsesHandler({ gatewayClient, eventBus, db, turnBuffer, logger = console }) {
  return async function handleResponses(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return true;
    }
    let body;
    try { body = await readJsonBody(req); }
    catch (err) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'body_too_large' }));
      return true;
    }
    const parsed = parseResponsesBody(body);
    if (!parsed) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request', message: 'expected {input, conversation|metadata.chat_id}' }));
      return true;
    }

    const responseId = `resp_${randomUUID()}`;
    const messageId = `msg_${randomUUID()}`;
    const createdAt = nowSeconds();
    const idempotencyKey = `sk-${randomUUID()}`;

    // SSE headers.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });

    const writeSse = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Open the SSE early with a response.created envelope so the proxy
    // can plumb the response_id back to the PWA before the agent has
    // emitted anything.
    writeSse('response.created', {
      type: 'response.created',
      response: { id: responseId, object: 'response', created_at: createdAt, status: 'in_progress' },
    });

    // Dispatch the turn. chat.send returns { runId, status:"started" }.
    let runId;
    // PWA mints `sidekick:<uuid>`; openclaw stores under
    // `agent:{agentId}:sidekick:<uuid>`. Normalize incoming chat ids
    // to canonical form before chat.send to keep the per-chat session
    // store consistent (so subsequent /v1/responses on the same chat
    // hit the same openclaw session, not a fresh one).
    const sessionKey = prefixChatId(parsed.sessionKey, AGENT_ID);
    try {
      const dispatch = await gatewayClient.chatSend({
        sessionKey,
        message: parsed.text,
        idempotencyKey,
        ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
      });
      runId = dispatch?.runId;
      if (!runId) throw new Error('chat.send returned no runId');

      // ── Turn buffer: open the in-flight turn ────────────────────
      // Plugin's source of truth for the in-flight slice until openclaw
      // flushes to jsonl at turn end. /v1/conversations/{id}/items
      // merges this onto the durable read so a session-switch + return
      // mid-flight still shows the user prompt + emitted tool rows.
      if (turnBuffer) {
        const userMessageId = parsed.userMessageId || `umsg_${randomUUID()}`;
        turnBuffer.openTurn({
          runId,
          chatId: parsed.sessionKey,
          userMessage: parsed.text,
          userMessageId,
          // Pass the stable assistant message_id minted above. Used by
          // turn-buffer's renderEnvelopes to emit a reply_delta envelope
          // with the same id the live SSE stream will use — keeps a
          // reconnected PWA's streaming bubble linked across reload.
          assistantMessageId: messageId,
          startedAt: Date.now(),
        });
        // Broadcast user_message to /v1/events subscribers — cross-
        // device sync for the user's prompt before the agent reply
        // lands. Carries the message_id the PWA pre-minted (or our
        // fresh one) so client-side optimistic bubbles can dedup.
        eventBus.pushEnvelope({
          type: 'user_message',
          chat_id: parsed.sessionKey,
          message_id: userMessageId,
          text: parsed.text,
        });
      }
    } catch (err) {
      writeSse('response.error', {
        type: 'response.error',
        error: { type: 'server_error', message: `dispatch failed: ${err?.message ?? err}` },
      });
      res.end();
      return true;
    }

    const run = eventBus.claimRun(runId);
    const abortHandler = () => {
      gatewayClient.chatAbort({ sessionKey, runId }).catch(() => {});
    };
    req.on('close', abortHandler);

    // Stream loop with overall timeout.
    let assembled = '';
    let outputIndex = 0;
    let contentIndex = 0;
    let completedEmitted = false;
    // Openclaw emits both:
    //  (a) the `message` tool call (args.message = user-facing reply)
    //  (b) a `stream:"assistant"` narration after (e.g. "Sending the
    //      exact one-word reply now.")
    // The narration is reasoning-style and confuses the bubble body
    // when (a) is also present. Track whether we surfaced the reply
    // via the message tool — if so, suppress subsequent assistant text.
    let messageToolReplied = false;
    let deadline = Date.now() + TURN_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        const eventPromise = run.next();
        const timeoutPromise = new Promise((r) => setTimeout(() => r('__timeout__'), deadline - Date.now()));
        const event = await Promise.race([eventPromise, timeoutPromise]);
        if (event === '__timeout__') {
          writeSse('response.error', {
            type: 'response.error',
            error: { type: 'server_error', message: 'turn timed out' },
          });
          break;
        }
        if (event === null) break;  // queue closed

        const { stream, data = {} } = event;
        // Skip codex_app_server.* internal lifecycle/item streams —
        // they're per-provider plumbing that duplicate the canonical
        // lifecycle/tool/item streams. Surfacing them would double the
        // events in the SSE stream.
        if (typeof stream === 'string' && stream.startsWith('codex_app_server.')) {
          continue;
        }
        if (stream === 'assistant') {
          // If the `message` tool already surfaced the user-facing
          // reply, drop subsequent assistant-stream narration —
          // surfacing it would concatenate "PING" + "Sending the
          // exact one-word reply now." as the bubble text.
          if (messageToolReplied) continue;
          // Openclaw emits non-incremental `data.text` (the full
          // assistant text once the turn ends — narration, not the
          // user-facing reply). Compute delta against assembled state.
          // The actual user-facing reply for openclaw comes through
          // the `message` tool's args.message — handled below.
          let deltaText = '';
          if (typeof data.delta === 'string') {
            deltaText = data.delta;
          } else if (typeof data.text === 'string' && data.text.startsWith(assembled)) {
            deltaText = data.text.slice(assembled.length);
          } else if (typeof data.text === 'string') {
            deltaText = data.text;
            contentIndex += 1;
            assembled = '';
          }
          if (deltaText) {
            writeSse('response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: messageId,
              output_index: outputIndex,
              content_index: contentIndex,
              delta: deltaText,
            });
            assembled += deltaText;
          }
        } else if (stream === 'tool' && data.phase === 'start') {
          // SPECIAL CASE: openclaw's `message` tool carries the
          // user-facing reply in `args.message`. Treat it as
          // assistant text (response.output_text.delta) so the PWA
          // renders it as the bubble body, not as a tool_call
          // panel. Mirrors openclaw's own delivery-mirror behaviour
          // (the .jsonl shows the message tool's content as
          // assistant role + delivery-mirror provider).
          if (data.name === 'message' && typeof data.args?.message === 'string') {
            const reply = data.args.message;
            writeSse('response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: messageId,
              output_index: outputIndex,
              content_index: contentIndex,
              delta: reply,
            });
            assembled += reply;
            messageToolReplied = true;
            continue;
          }
          outputIndex += 1;
          const args = data.args ?? data.arguments ?? data.input ?? {};
          const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
          writeSse('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: {
              type: 'function_call',
              id: data.toolCallId ?? data.callId ?? '',
              name: data.name ?? data.tool_name ?? '',
              arguments: argsStr,
            },
          });
        } else if (stream === 'tool' && data.phase === 'result') {
          // Suppress the result for the `message` tool — it's already
          // been surfaced as assistant text in the matching phase=start.
          if (data.name === 'message') continue;
          let resultOut;
          const out = data.result ?? data.output ?? '';
          // openclaw result shape: `{contentItems: [{type, text}], success}`
          // — flatten to text the PWA can render inline.
          let flat = out;
          if (out && typeof out === 'object' && Array.isArray(out.contentItems)) {
            flat = out.contentItems.map((c) => c?.text ?? '').filter(Boolean).join('\n');
          }
          if (typeof flat === 'string') {
            resultOut = flat.slice(0, TOOL_RESULT_MAX_BYTES);
          } else {
            try { resultOut = JSON.stringify(flat).slice(0, TOOL_RESULT_MAX_BYTES); }
            catch { resultOut = String(flat).slice(0, TOOL_RESULT_MAX_BYTES); }
          }
          writeSse('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: outputIndex,
            item: {
              type: 'function_call_output',
              call_id: data.toolCallId ?? data.callId ?? '',
              output: resultOut,
            },
          });
          outputIndex += 1;
          contentIndex = 0;
        } else if (stream === 'lifecycle' && data.phase === 'end') {
          // Persist the (chat_id, msg_id) → openclaw_row_id link
          // BEFORE emitting response.completed. Proxy turns that into
          // reply_final which the PWA acts on immediately — if persist
          // ran after, the PWA could reload (via next test step or user
          // action) and miss the sidekick_id for this turn's bubble.
          if (db) {
            persistMessageLink({
              db, sessionKey, chatId: parsed.sessionKey,
              messageId, dispatchedAt: createdAt * 1000, logger,
            });
            // ALSO link the user row so /items emits sidekick_id for
            // it — PWA's optimistic bubble (keyed by the pre-minted
            // userMessageId) then dedups against the durable replay.
            // Without this, reload after the turn shows TWO user
            // bubbles (optimistic + durable) for the same prompt.
            const turn = turnBuffer?.byRunId?.get(runId);
            if (turn?.userMessageId) {
              persistUserMessageLink({
                db, sessionKey, chatId: parsed.sessionKey,
                userMessageId: turn.userMessageId,
                dispatchedAt: createdAt * 1000, logger,
              });
            }
          }
          // Drop the in-flight turn buffer entry — openclaw's jsonl
          // is now authoritative for this turn. /items reads return
          // the durable rows directly; no need to keep the buffer.
          if (turnBuffer) turnBuffer.closeTurn(runId);
          writeSse('response.completed', {
            type: 'response.completed',
            response: buildCompletedEnvelope({ responseId, messageId, createdAt, assembled }),
          });
          completedEmitted = true;
          break;
        } else if (stream === 'error') {
          writeSse('response.error', {
            type: 'response.error',
            error: { type: 'server_error', message: data.message ?? 'agent error' },
          });
          break;
        }
        // Other streams (thinking, plan, compaction, command_output,
        // patch, approval) are out-of-turn-ish — silently skip so they
        // don't corrupt the in-turn stream. Surfacing them is a polish
        // pass once basic turn dispatch is solid.
      }
    } catch (err) {
      logger.warn?.(`[parley] /v1/responses error: ${err?.message ?? err}`);
      if (!completedEmitted) {
        writeSse('response.error', {
          type: 'response.error',
          error: { type: 'server_error', message: String(err?.message ?? err) },
        });
      }
    } finally {
      run.close();
      req.off('close', abortHandler);
      res.end();
    }
    return true;
  };
}
