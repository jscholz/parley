/**
 * GET /v1/events — long-lived SSE for out-of-turn envelopes.
 *
 * Parley proxy connects on startup and listens forever; envelopes
 * for chats that don't have an active /v1/responses turn ride this
 * channel (notifications, session_changed, late tool events,
 * cross-platform incoming messages, errors).
 *
 * Reference shape: `~/code/parley/backends/hermes/plugin/__init__.py`
 * `_handle_events` (line 3293). Wire format:
 *
 *   retry: 1000\n\n
 *   id: <eid>\nevent: <envelope.type>\ndata: <envelope JSON>\n\n
 *
 * `Last-Event-ID` header for replay support — TODO once we have a
 * bounded replay ring (currently no events backlog; we start fresh
 * on each connect).
 *
 * v0 scope (this commit):
 *   - Hold connection open so the proxy is satisfied.
 *   - Drain `eventBus.globalIterator` for events without a claimed run.
 *   - Translate the few translatable agent-event shapes into parley
 *     envelopes (assistant text → reply_delta + reply_final).
 *   - Drop anything else silently. Out-of-turn cron / notification /
 *     session_changed integration lands in follow-up commits once we
 *     surface the openclaw scheduler + multi-channel paths.
 */

let eventSeq = 0;
function nextEventId() { eventSeq += 1; return eventSeq; }

export function makeEventsHandler({ eventBus, logger = console }) {
  return async function handleEvents(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 1000\n\n');

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    const writeEvent = (envelope) => {
      const eid = nextEventId();
      res.write(`id: ${eid}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`);
    };

    try {
      // Per-chat state for unclaimed assistant text — coalesces deltas
      // into reply_delta + reply_final so the PWA can render a
      // cron/scheduled-turn bubble. message_id is minted here since
      // openclaw doesn't carry an SSE-shape id for out-of-turn runs.
      const replyState = new Map();   // runId → { messageId, chatId, assembled }

      for await (const event of eventBus.globalIterator({ signal: abort.signal })) {
        if (!event) break;
        // pushEnvelope() sentinel: a pre-translated parley envelope
        // injected by /v1/responses (user_message broadcast) or other
        // out-of-band emitters. Pass through verbatim.
        if (event.__envelope) {
          writeEvent(event.__envelope);
          continue;
        }
        const { stream, data = {}, runId, sessionKey } = event;
        const chatId = sessionKey ?? data?.sessionKey;
        if (!chatId) continue;

        if (stream === 'assistant' && typeof data.text === 'string') {
          let state = replyState.get(runId);
          if (!state) {
            state = {
              messageId: `notif_${runId}`,
              chatId,
              assembled: '',
            };
            replyState.set(runId, state);
          }
          // Openclaw assistant text is full-form, not delta — diff
          // against running state.
          let deltaText = '';
          if (data.text.startsWith(state.assembled)) {
            deltaText = data.text.slice(state.assembled.length);
          } else {
            deltaText = data.text;   // non-additive — replace
            state.assembled = '';
          }
          if (deltaText) {
            writeEvent({
              type: 'reply_delta',
              chat_id: chatId,
              text: state.assembled + deltaText,
              message_id: state.messageId,
              edit: state.assembled.length > 0,
            });
            state.assembled += deltaText;
          }
        } else if (stream === 'tool' && data.phase === 'start'
                   && data.name === 'message'
                   && typeof data.args?.message === 'string') {
          // Out-of-turn `message`-tool reply (cron, scheduled work).
          let state = replyState.get(runId);
          if (!state) {
            state = { messageId: `notif_${runId}`, chatId, assembled: '' };
            replyState.set(runId, state);
          }
          state.assembled += data.args.message;
          writeEvent({
            type: 'reply_delta',
            chat_id: chatId,
            text: state.assembled,
            message_id: state.messageId,
            edit: false,
          });
        } else if (stream === 'lifecycle' && data.phase === 'end') {
          const state = replyState.get(runId);
          if (state) {
            writeEvent({
              type: 'reply_final',
              chat_id: chatId,
              message_id: state.messageId,
            });
            replyState.delete(runId);
          }
        }
        // Drop everything else for now: thinking, plan, item-stream,
        // command_output, patch, approval, codex_app_server.* —
        // surfacing these requires bespoke parley envelopes
        // (notifications, approval prompts) we'll add as we discover
        // the user-facing need.
      }
    } catch (err) {
      logger.warn?.(`[parley] /v1/events error: ${err?.message ?? err}`);
    } finally {
      try { res.end(); } catch {}
    }
    return true;
  };
}
