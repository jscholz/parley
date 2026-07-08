// POST /api/sidekick/messages — forward a chat turn to the upstream
// agent. Fire-and-forget: returns 202 immediately; reply envelopes
// (reply_delta, reply_final, image, typing, notification,
// session_changed) flow back through the persistent
// /api/sidekick/stream SSE channel.
//
// Request body (JSON):
//   { chat_id: string, text: string, attachments?: any[],
//     voice?: boolean, user_message_id?: string }
//
// Response (202): { ok: true, message_id: string }
//
// `user_message_id` is the PWA-pre-minted id used as the dedup key for
// the upstream's `user_message` cross-device broadcast envelope. The
// originating device's optimistic user bubble shares this id; on the
// broadcast roundtrip it no-ops the dedup. Other devices see it for
// the first time and render fresh. Optional — server mints one when
// absent (originating device just won't dedup; fine for legacy/single
// device callers).
//
// Wire path:
//   PWA → POST /api/sidekick/messages
//                ↓ (this handler)
//   upstream.sendMessage → POST /v1/responses (stream:true)
//                ↓ (SSE)
//   reply_delta / reply_final / tool_* envelopes → pushEnvelope
//                ↓
//   stream.ts SSE multiplexer fan-out on /api/sidekick/stream
//
// Why fire-and-forget vs per-POST SSE: agents emit multiple bubbles
// per turn (bootstrap nudges, the actual reply, possibly tool-result-
// as-text). The persistent stream channel decouples turn lifecycle
// from connection lifecycle and matches how telegram/slack/signal
// adapters work today.

import { getUpstream } from './index.ts';
import { pushEnvelope } from './stream.ts';
import type { UpstreamAgent } from './upstream.ts';

// Phone photos easily blow past 1 MB once base64-encoded inside the
// JSON envelope (a 4 MB JPEG → ~5.4 MB base64 → +~10% JSON quoting).
// Bumped to 50 MB to cover any reasonable single-image attachment;
// should match the upstream plugin's body-size limit (e.g. aiohttp
// client_max_size in backends/hermes/plugin) so the limits don't
// disagree silently end-to-end.
const MAX_BODY_BYTES = 50 * 1024 * 1024;

function newMessageId(): string {
  return `sk-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleSidekickMessage(req, res) {
  const upstream = getUpstream();
  if (!upstream) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'sidekick_platform_unconfigured',
      detail: 'Upstream not initialized — proxy boot likely failed.',
    }));
    return;
  }

  // Read + parse body. Cap to avoid pathological clients.
  let raw = '';
  let aborted = false;
  req.on('data', (c) => {
    raw += c;
    if (raw.length > MAX_BODY_BYTES) {
      aborted = true;
      req.destroy();
    }
  });
  req.on('error', () => { aborted = true; });

  await new Promise<void>((resolve) => {
    req.on('end', () => resolve());
    req.on('close', () => resolve());
  });

  if (aborted) {
    console.warn(
      `[sidekick] /api/sidekick/messages aborted: body > ${MAX_BODY_BYTES} bytes ` +
      `(saw ${raw.length}). If this is a legitimate large attachment, raise MAX_BODY_BYTES ` +
      `here AND the upstream plugin's body-size limit.`
    );
    if (!res.headersSent) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'request body too large' }));
    }
    return;
  }

  let body: any;
  try { body = JSON.parse(raw); }
  catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }
  const chatId = typeof body?.chat_id === 'string' ? body.chat_id.trim() : '';
  const text = typeof body?.text === 'string' ? body.text : '';
  const attachments = Array.isArray(body?.attachments) ? body.attachments : undefined;
  const voice = body?.voice === true;
  const userMessageId = typeof body?.user_message_id === 'string' && body.user_message_id
    ? body.user_message_id : undefined;
  if (!chatId) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'chat_id required' }));
    return;
  }
  if (!text && !attachments?.length) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'text or attachments required' }));
    return;
  }

  // Forward attachments via the sidekick extension to /v1/responses
  // (additive `attachments` field on the request body — see plugin's
  // `_handle_responses`). The plugin materializes the data:URL
  // payloads to tempfiles and populates MessageEvent.media_urls so
  // the upstream's vision tools can read them; raw OAI third-party
  // upstreams ignore the unknown field.
  const messageId = newMessageId();
  // Diagnostic: messages typed into the PWA may not reach state.db
  // despite the optimistic bubble showing as sent (state.db ends up
  // with the chat row but 0 messages, gateway logs show only GET
  // history — no /v1/responses POST). Surface every step of the
  // dispatch so a repro can pin where in the pipeline the message
  // gets dropped.
  console.log(
    `[sidekick:messages] POST chat=${chatId} ` +
    `text=${JSON.stringify(text.slice(0, 80))} ` +
    `userMsgId=${userMessageId || '(none)'} ` +
    `attachCount=${attachments?.length || 0}`,
  );
  void dispatchTurnViaUpstream(upstream, chatId, text, attachments, voice, userMessageId);
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, message_id: messageId }));
}

/** Internal (non-HTTP) message dispatch — the same upstream send path
 *  a user's composer message rides, callable by other proxy modules.
 *  Capture uses it for the "📼 Recording started" line and the
 *  post-meeting ingest turn (capture plan §3.3): the message lands as
 *  a normal turn on ANY backend — hermes, Claude Code, stub — which is
 *  the whole backend-neutrality trick. Fire-and-forget; returns false
 *  when the upstream isn't initialized (caller decides whether that's
 *  worth surfacing). */
export function dispatchInternalMessage(chatId: string, text: string): boolean {
  const upstream = getUpstream();
  if (!upstream || !chatId || !text) return false;
  void dispatchTurnViaUpstream(upstream, chatId, text);
  return true;
}

async function dispatchTurnViaUpstream(
  upstream: UpstreamAgent,
  chatId: string,
  text: string,
  attachments?: unknown[],
  voice?: boolean,
  userMessageId?: string,
): Promise<void> {
  const t0 = Date.now();
  let envelopeCount = 0;
  console.log(`[sidekick:dispatch] start chat=${chatId}`);
  try {
    for await (const envelope of upstream.sendMessage(chatId, text, {
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(voice ? { voice: true } : {}),
      ...(userMessageId ? { userMessageId } : {}),
    })) {
      envelopeCount += 1;
      const envType = (envelope as any).type;
      console.log(
        `[sidekick:dispatch] +${Date.now() - t0}ms envelope #${envelopeCount} ` +
        `type=${envType} chat=${chatId}`,
      );
      // pushEnvelope funnels into both the SSE multiplexer AND the
      // inflight cache — see its docstring. The cache lets a mid-turn
      // switch-away client replay on switch-back; reply_final drops
      // the cache as state.db becomes canonical.
      pushEnvelope(envelope);
    }
    console.log(
      `[sidekick:dispatch] end chat=${chatId} ` +
      `envelopeCount=${envelopeCount} elapsed=${Date.now() - t0}ms`,
    );
  } catch (e: any) {
    console.error(
      `[sidekick:dispatch] FAILED chat=${chatId} ` +
      `envelopeCount=${envelopeCount} elapsed=${Date.now() - t0}ms ` +
      `err=${e?.message || String(e)}`,
    );
    pushEnvelope({
      type: 'error',
      chat_id: chatId,
      message: `upstream dispatch failed: ${e?.message || String(e)}`,
    });
  }
}
