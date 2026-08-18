// /api/parley/sessions handlers — drawer list + per-chat delete.
// Both go through the agent contract (HTTP+SSE), which means the
// proxy doesn't reach into the upstream's filesystem (e.g. hermes's
// state.db / sessions.json / jsonl) anymore — the plugin owns that read.
//
//   GET    /api/parley/sessions          → drawer list
//   DELETE /api/parley/sessions/<chatId> → cascade delete
//   PATCH  /api/parley/sessions/<chatId> → rename (sets title server-side)
//
// Drawer-list behavior:
//   1. Probe `/v1/gateway/conversations` (gateway extension). A
//      multi-platform agent (e.g. hermes) implements it and returns
//      cross-source rows with `source` + `chat_type` in metadata.
//   2. On 404 (single-channel agent — stub, raw OAI third-party),
//      fall back to `/v1/conversations` and stamp `source: 'sidekick'`
//      on each row so the composer stays editable.

import { getUpstream } from './index.ts';
import {
  UpstreamHTTPError,
  type ConversationSummary,
  type GatewayConversationSummary,
  type UpstreamAgent,
} from './upstream.ts';
import { markUserTitled } from './userTitles.ts';

interface ParleySessionRow {
  chat_id: string;
  source: string;
  title: string;
  message_count: number;
  /** User-role message count. Drawer prefers "N turns" over the
   *  inflated raw `message_count` (which includes tool rows) when
   *  both turn_count + tool_count are present. */
  turn_count?: number;
  /** Tool-role message count. Pairs with `turn_count`. */
  tool_count?: number;
  last_active_at: string | null;
  created_at: string | null;
  /** Snippet of the first user message in this session, truncated to
   *  ~80 chars by the upstream. Lets the drawer fall back to a
   *  meaningful label when the agent hasn't generated a title yet
   *  (model error / blip / race). Null when no user message exists
   *  on disk yet. */
  first_user_message: string | null;
  /** Space-joined raw hermes session ids rolled up into this row,
   *  for session-id matching in the client filter. Optional. */
  session_ids?: string;
}

/** GET /api/parley/sessions
 *
 *  Returns: { sessions: [{ chat_id, source, title, message_count,
 *                          last_active_at, created_at,
 *                          first_user_message }] }
 *
 *  Order: most-recently-active first.
 *  Limit via ?limit=N (1..200, default 50).
 *
 *  No-token cases return an empty list (NOT 503) — the PWA can render
 *  its own IDB-backed drawer offline and would otherwise show an
 *  unhelpful disconnected-state toast for what's really an
 *  enrichment endpoint. */
export async function handleParleySessionsList(req, res) {
  const upstream = getUpstream();
  if (!upstream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [], unconfigured: true }));
    return;
  }
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));
  let rows: ParleySessionRow[] = [];
  try {
    const gateway = await upstream.listGatewayConversations(limit);
    if (gateway !== null) {
      rows = gateway.map(gatewayRowToParleyRow);
    } else {
      const channel = await upstream.listConversations(limit);
      rows = channel.map(channelRowToParleyRow);
    }
  } catch (e: any) {
    console.warn('[parley] sessions list failed:', e.message);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ sessions: rows }));
}

/** DELETE /api/parley/sessions/<chat_id>
 *
 *  Hard delete via the agent contract — the upstream cascades through
 *  its own state (state.db, sessions.json, jsonl, hindsight memory).
 *  Returns 200 on success, 503 if the platform isn't configured. */
export async function handleParleySessionDelete(req, res, chatId: string) {
  const upstream = getUpstream();
  if (!upstream) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'sidekick_platform_unconfigured' }));
    return;
  }
  // Same validator as history.ts — accepts cross-platform IDs
  // (whatsapp @lid / @s.whatsapp.net, telegram numeric, etc.) so
  // DELETE works on cross-platform sessions surfaced via the
  // gateway-conversations extension.
  if (!chatId || !/^[A-Za-z0-9._@:-]{1,128}$/.test(chatId)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid chat_id' }));
    return;
  }
  try {
    await upstream.deleteConversation(chatId);
  } catch (e: any) {
    console.warn(`[parley] delete failed for ${chatId}:`, e?.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message || 'upstream delete failed' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

/** PATCH /api/parley/sessions/<chat_id>
 *
 *  Body: `{ title: string }`. Forwards to the upstream's
 *  `PATCH /v1/conversations/{id}` which writes through to state.db
 *  and emits a `session_changed` envelope so other connected clients
 *  pick up the new title via `/v1/events`.
 *
 *  Mirrors the DELETE handler's shape: same chat_id validator, same
 *  503 when no upstream, same {ok:true,...} response envelope. */
export async function handleParleySessionRename(
  req, res, chatId: string,
) {
  const upstream = getUpstream();
  if (!upstream) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'sidekick_platform_unconfigured' }));
    return;
  }
  if (!chatId || !/^[A-Za-z0-9._@:-]{1,128}$/.test(chatId)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid chat_id' }));
    return;
  }
  // Read body. Same 1MB cap as messages.ts; titles are tiny so the
  // cap is mostly defensive.
  let raw = '';
  let aborted = false;
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 1 * 1024 * 1024) {
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
  const title = typeof body?.title === 'string' ? body.title : '';
  if (!title.trim()) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'title required' }));
    return;
  }
  try {
    const result = await upstream.renameConversation(chatId, title);
    // Remember that the USER named this chat (meeting-polish #25):
    // every manual rename from any parley client passes through
    // here, and the capture titling pipeline consults this marker so
    // it never clobbers a deliberate name. Best-effort — a marker
    // write failure must not fail the rename.
    try { await markUserTitled(chatId, result.title); } catch { /* marker is advisory */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, title: result.title }));
  } catch (e: any) {
    if (e instanceof UpstreamHTTPError) {
      // Forward the upstream's status + body verbatim so the PWA
      // surfaces validation errors (length cap, cross-source guard)
      // with the agent's wording rather than an opaque 500.
      res.writeHead(e.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(e.body ?? { error: 'rename failed' }));
      return;
    }
    console.warn(`[parley] rename failed for ${chatId}:`, e?.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message || 'upstream rename failed' }));
  }
}

/** Translate the agent's OAI-shape gateway row into the on-the-wire
 *  shape the PWA already expects. Plugin returns unix-second
 *  timestamps; we ISO-format them for parity with what the legacy
 *  filesystem-direct path used to send. */
function gatewayRowToParleyRow(
  row: GatewayConversationSummary,
): ParleySessionRow {
  const m = row.metadata;
  return {
    chat_id: row.id,
    source: m.source,
    title: m.title,
    message_count: m.message_count,
    turn_count: m.turn_count,
    tool_count: m.tool_count,
    last_active_at: m.last_active_at
      ? new Date(m.last_active_at * 1000).toISOString()
      : null,
    created_at: row.created_at
      ? new Date(row.created_at * 1000).toISOString()
      : null,
    first_user_message: m.first_user_message,
    session_ids: m.session_ids,
  };
}

/** Channel-only fallback: source defaults to 'sidekick' so the
 *  composer stays editable (`source !== 'sidekick'` => read-only,
 *  src/main.ts:2446). For single-channel agents (stub / raw OAI
 *  third-party / future openclaw-without-gateway), the agent IS the
 *  parley channel by definition. */
function channelRowToParleyRow(
  row: ConversationSummary,
): ParleySessionRow {
  const m = row.metadata;
  return {
    chat_id: row.id,
    source: 'sidekick',
    title: m.title,
    message_count: m.message_count,
    turn_count: m.turn_count,
    tool_count: m.tool_count,
    last_active_at: m.last_active_at
      ? new Date(m.last_active_at * 1000).toISOString()
      : null,
    created_at: row.created_at
      ? new Date(row.created_at * 1000).toISOString()
      : null,
    first_user_message: m.first_user_message,
    session_ids: m.session_ids,
  };
}
