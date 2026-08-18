/**
 * Sidekick OpenClaw Plugin — entry point.
 *
 * Exposes the `/v1/*` OpenAI-Responses-style HTTP+SSE contract that the
 * sidekick proxy expects from any backend it talks to (see
 * `proxy/sidekick/upstream.ts:145-223` for the canonical
 * `UpstreamAgent` interface).
 *
 * Routes currently implemented:
 *   GET /v1/health                          — liveness check
 *   GET /health                             — same handler (proxy's
 *                                             legacy path; replaceExisting
 *                                             shadows openclaw's built-in
 *                                             /health which returns
 *                                             status='live' not 'ok').
 *   GET /v1/conversations?limit=N           — drawer list
 *   GET /v1/conversations/{id}/items?...    — transcript replay
 *
 * Still pending:
 *   POST /v1/responses          — dispatch a turn into openclaw's agent
 *   GET  /v1/events             — out-of-turn SSE (notifications, etc.)
 *   DELETE /v1/conversations/{id}
 *   PATCH  /v1/conversations/{id}  — rename
 *
 * Plain JS (no TypeScript). `openclaw plugins install --link` accepts
 * JS entry points directly; build chain stays minimal until the surface
 * justifies it.
 *
 * Reference: `backends/hermes/plugin/__init__.py` is the Python
 * implementation of the same contract against hermes-agent.
 */
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import {
  resolveStateDir,
  listSessions,
  readSessionMessages,
} from './src/openclaw-store.js';
import { toConversationSummary, toConversationItem, prefixChatId } from './src/mappers.js';
import { isDeliveryMirror } from './src/openclaw-store.js';
import { GatewayClient } from './src/gateway-client.js';
import { AgentEventBus } from './src/event-bus.js';
import { makeResponsesHandler } from './src/responses-handler.js';
import { makeEventsHandler } from './src/events-handler.js';
import { openDb, migrateLegacyDbFile } from './src/db.js';
import { upsertMessage, listMessagesForChat } from './src/messages.js';
import { PushDispatcher } from './src/push-dispatch.js';
import { registerPushRoutes } from './src/push-routes.js';
import { TurnBuffer } from './src/turn-buffer.js';
import { registerUnreadPinsRoutes } from './src/unread-pins-routes.js';
import { join } from 'node:path';

// Profile + agent are hardcoded for the sk-integ bring-up. Promote to
// plugin config schema once we have a second profile to support.
const PROFILE = process.env.OPENCLAW_SK_PROFILE || 'sk-integ';
const AGENT_ID = process.env.OPENCLAW_SK_AGENT || 'dev';

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseQuery(req) {
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams;
}

export default definePluginEntry({
  id: 'sidekick',
  name: 'Sidekick',
  description: 'Sidekick PWA backend — exposes /v1/* OpenAI-Responses contract.',
  register(api) {
    // ── Supplemental store (sidekick.db) ────────────────────────────
    // Maps our plugin-minted SSE-shape ids (msg_*) to openclaw's
    // native __openclaw.id values so /v1/conversations/{id}/items can
    // surface sidekick_id — which the PWA uses to dedup the inflight
    // cache against the history replay (without it, every reply
    // duplicates on reload). Schema is created lazily on first open.
    const stateDir = resolveStateDir({ profile: PROFILE });
    // parley.db (formerly sidekick.db) — legacy file renamed in place
    // on first open (see migrateLegacyDbFile).
    const dbPath = join(stateDir, 'parley.db');
    migrateLegacyDbFile(dbPath, join(stateDir, 'sidekick.db'));
    const db = openDb({ path: dbPath });

    // ── Gateway WS client + event bus (shared across handlers) ─────
    // Lazy-connect on first chat.send call. The agent event
    // subscription is registered eagerly so we never miss events for
    // turns we dispatch.
    const gatewayClient = new GatewayClient({ profile: process.env.OPENCLAW_SK_PROFILE || 'sk-integ' });
    const eventBus = new AgentEventBus();
    const pushDispatcher = new PushDispatcher({ db, eventBus });
    const turnBuffer = new TurnBuffer();
    api.agent.events.registerAgentEventSubscription({
      id: 'sidekick.responses.fanout',
      description: 'Routes agent events into per-runId queues for /v1/responses + /v1/events.',
      handle: (event) => eventBus.onEvent(event),
    });
    // Separate subscription: push dispatch + turn-buffer observation
    // must run for EVERY event regardless of who's claimed the
    // per-run queue. Otherwise an in-flight /v1/responses (which
    // claims the run) would starve push + the items-merge buffer.
    api.agent.events.registerAgentEventSubscription({
      id: 'sidekick.push.dispatch',
      description: 'Plugin-owned push dispatch: fires web-push on lifecycle:end.',
      handle: (event) => pushDispatcher.onAgentEvent(event),
    });
    api.agent.events.registerAgentEventSubscription({
      id: 'sidekick.turn-buffer',
      description: 'In-flight turn mirror — populates /items mid-turn until jsonl flushes.',
      handle: (event) => turnBuffer.observeAgentEvent(event),
    });

    // ── /v1/health (and bare /health shadow) ───────────────────────
    // The `via` field distinguishes plugin-served responses from
    // openclaw's built-in /health (which returns status='live'). The
    // sidekick proxy's healthcheck() looks for status==='ok'.
    const healthHandler = async (_req, res) => {
      sendJson(res, 200, { ok: true, status: 'ok', via: 'sidekick-plugin' });
      return true;
    };
    api.registerHttpRoute({ path: '/v1/health', auth: 'plugin', match: 'exact', handler: healthHandler });
    api.registerHttpRoute({ path: '/health', auth: 'plugin', match: 'exact', replaceExisting: true, handler: healthHandler });

    // ── Push notification management (plugin-owned storage + dispatch).
    registerPushRoutes(api, { db, dispatcher: pushDispatcher });
    // ── Unread state + pin sync (cross-device SSOT for badges/pins).
    registerUnreadPinsRoutes(api, { db, eventBus, agentId: AGENT_ID, profile: PROFILE });

    // ── 404 stubs for unimplemented optional routes ────────────────
    // The sidekick proxy probes these and falls back to defaults on
    // 404. Without explicit handlers, openclaw's catch-all serves the
    // dashboard HTML at 200, which breaks the proxy's JSON parser.
    // Replace with real handlers when implemented.
    const stub404 = async (_req, res) => {
      sendJson(res, 404, { error: 'not_implemented' });
      return true;
    };
    for (const path of [
      '/v1/gateway/conversations',
      '/v1/commands',
      '/v1/settings/schema',
      '/v1/conversations/search',
    ]) {
      api.registerHttpRoute({ path, auth: 'plugin', match: 'exact', handler: stub404 });
    }

    // ── GET /v1/events ─────────────────────────────────────────────
    // Long-lived SSE for out-of-turn envelopes. Proxy connects on
    // startup and listens forever.
    api.registerHttpRoute({
      path: '/v1/events',
      auth: 'plugin',
      match: 'exact',
      handler: makeEventsHandler({ eventBus }),
    });

    // ── POST /v1/responses ─────────────────────────────────────────
    // Turn dispatch + SSE response. Translates openclaw AgentEventPayload
    // → OAI Responses-API SSE shape the sidekick proxy expects.
    // After lifecycle:end the handler writes a (chat_id, msg_id,
    // openclaw_row_id) mapping into the supplemental DB so the
    // /v1/conversations/{id}/items handler can surface sidekick_id
    // and the PWA can dedup live bubbles against the reload replay.
    api.registerHttpRoute({
      path: '/v1/responses',
      auth: 'plugin',
      match: 'exact',
      handler: makeResponsesHandler({ gatewayClient, eventBus, db, turnBuffer }),
    });

    // ── /v1/conversations ──────────────────────────────────────────
    // Drawer list. Reads openclaw's sessions.json + each session's
    // jsonl to compute message_count + first_user_message. Filters
    // out openclaw's internal delivery-mirror duplicates.
    //
    // O(N) per chat to compute counts; fine for current volume. Cache
    // in the supplemental store once chat count gets unwieldy.
    api.registerHttpRoute({
      path: '/v1/conversations',
      auth: 'plugin',
      match: 'exact',
      handler: async (req, res) => {
        try {
          const stateDir = resolveStateDir({ profile: PROFILE });
          const sessions = listSessions({ stateDir, agentId: AGENT_ID });
          const limit = Math.max(1, Math.min(parseInt(parseQuery(req).get('limit') ?? '50', 10), 500));
          const rows = Object.entries(sessions)
            .map(([sessionKey, entry]) => {
              const messages = readSessionMessages({ stateDir, agentId: AGENT_ID, sessionId: entry.sessionId });
              return toConversationSummary({ sessionKey, entry, messages });
            })
            // Sort newest-first by last_active_at (sidekick drawer contract).
            .sort((a, b) => b.metadata.last_active_at - a.metadata.last_active_at)
            .slice(0, limit);
          sendJson(res, 200, { data: rows });
        } catch (err) {
          sendJson(res, 500, { error: 'list_conversations_failed', message: String(err?.message ?? err) });
        }
        return true;
      },
    });

    // ── DELETE/PATCH /v1/conversations/{id} ────────────────────────
    // DELETE cascades through openclaw's sessions.delete (transcript +
    // bindings). PATCH (rename) is a no-op stub for v0 — openclaw has
    // no native title column, and persisting titles in the
    // supplemental store can be added later.
    //
    // Both share the same path shape /v1/conversations/{id} (no
    // trailing /items), so the prefix handler below routes by method.

    // ── /v1/conversations/{id}/items ───────────────────────────────
    // Transcript replay. `id` is the sessionKey (e.g. "agent:dev:main").
    // Supports `limit` (default 200, cap 500) and `before` (created_at
    // cursor in unix seconds — over-fetches by 1 to compute has_more).
    //
    // Items are oldest-first (sidekick contract); delivery-mirror rows
    // filtered out; each row gets a seq-based integer id stable across
    // reads (jsonl is append-only).
    api.registerHttpRoute({
      path: '/v1/conversations/',
      auth: 'plugin',
      match: 'prefix',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          // DELETE / PATCH /v1/conversations/{id} (no /items suffix).
          const bareMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/?$/);
          if (bareMatch && (req.method === 'DELETE' || req.method === 'PATCH')) {
            // Incoming id may be PWA-form (sidekick:abc) or canonical
            // (agent:dev:sidekick:abc). Normalize to canonical for the
            // openclaw call.
            const incomingId = decodeURIComponent(bareMatch[1]);
            const sessionKey = prefixChatId(incomingId, AGENT_ID);
            if (req.method === 'DELETE') {
              try {
                await gatewayClient.call('sessions.delete', {
                  key: sessionKey, deleteTranscript: true,
                });
                sendJson(res, 200, { ok: true });
              } catch (err) {
                // Idempotent — already-gone errors return 200 to match
                // the proxy's `if (r.status === 404) return` contract.
                if (/not.found|unknown.session/i.test(String(err?.message ?? ''))) {
                  sendJson(res, 404, { error: 'conversation_not_found' });
                } else {
                  sendJson(res, 500, { error: 'delete_failed', message: String(err?.message ?? err) });
                }
              }
              return true;
            }
            // PATCH: rename. Openclaw has no native title — accept the
            // request and echo back so the PWA's UI flow completes,
            // but persistence is a no-op until we wire the supplemental
            // store. TODO: persist `title` in src/schema.sql `meta`
            // table keyed by chat_id, surface in toConversationSummary.
            let bodyRaw = '';
            for await (const chunk of req) bodyRaw += chunk;
            let body = {};
            try { body = JSON.parse(bodyRaw); } catch {}
            sendJson(res, 200, { title: body?.title ?? incomingId });
            return true;
          }

          // GET /v1/conversations/{id}/items (transcript replay).
          const m = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/items\/?$/);
          if (!m) return false;  // not us — let other handlers (or 404) handle
          // PWA may send either stripped (`sidekick:abc`) or canonical
          // (`agent:dev:sidekick:abc`) — normalize before store lookup.
          const incomingId = decodeURIComponent(m[1]);
          const sessionKey = prefixChatId(incomingId, AGENT_ID);

          const stateDir = resolveStateDir({ profile: PROFILE });
          const sessions = listSessions({ stateDir, agentId: AGENT_ID });
          const entry = sessions[sessionKey];
          if (!entry) {
            sendJson(res, 404, { error: 'conversation_not_found', id: incomingId });
            return true;
          }

          const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') ?? '200', 10), 500));
          const beforeRaw = url.searchParams.get('before');
          const before = beforeRaw ? parseInt(beforeRaw, 10) : null;

          const raw = readSessionMessages({ stateDir, agentId: AGENT_ID, sessionId: entry.sessionId });
          // Build openclaw_row_id → sidekick_id lookup from supplemental
          // store. Empty for chats with no linked rows (first-load case);
          // the items handler still serves correctly, just without dedup.
          const links = listMessagesForChat(db, { chat_id: incomingId, limit: 500 });
          const sidekickIdLookup = new Map();
          for (const row of links.items) {
            if (row.agent_row_id) sidekickIdLookup.set(row.agent_row_id, row.id);
          }

          // Structural narration drop. Openclaw's `message` tool
          // pattern emits reasoning narration alongside the actual
          // reply — narration can land before OR after the tool call,
          // and sometimes both. The user-facing reply lives in
          // args.message; the bare assistant-text rows are reasoning
          // that the live SSE stream suppresses.
          //
          // Algorithm: walk rows segmented by user-message turn
          // boundaries. For each turn, if it contains a `message`
          // toolCall (non-mirror), mark every plain-assistant-text
          // row in that turn as drop. (Multi-message turns retain
          // every toolCall row — only narration is dropped.)
          const dropNarrationIdxs = new Set();
          let turnStart = 0;
          for (let i = 0; i <= raw.length; i++) {
            const atBoundary = i === raw.length || raw[i].role === 'user';
            if (!atBoundary) continue;
            // Process the turn raw[turnStart..i-1].
            let hasMessageTool = false;
            const textOnlyIdxs = [];
            for (let j = turnStart; j < i; j++) {
              const m = raw[j];
              if (m.role !== 'assistant') continue;
              if (isDeliveryMirror(m)) continue;
              if (!Array.isArray(m.content)) continue;
              const onlyText = m.content.every((c) => c?.type === 'text');
              if (onlyText) {
                textOnlyIdxs.push(j);
              } else if (m.content.some((c) => c?.type === 'toolCall' && c?.name === 'message')) {
                hasMessageTool = true;
              }
            }
            if (hasMessageTool) {
              for (const j of textOnlyIdxs) dropNarrationIdxs.add(j);
            }
            turnStart = i + 1;   // skip the user row itself
          }

          // Filter mirrors + narration + cursor + map.
          let seq = 0;
          const all = [];
          for (let idx = 0; idx < raw.length; idx++) {
            const msg = raw[idx];
            if (isDeliveryMirror(msg)) continue;
            if (dropNarrationIdxs.has(idx)) continue;
            const item = toConversationItem({ msg, seq, sidekickIdLookup });
            seq++;
            if (!item) continue;
            if (before != null && item.created_at >= before) continue;
            all.push(item);
          }
          // ── In-flight turn → envelope-shape inflight field ──────
          // For any turn currently in flight on this chat, surface the
          // plugin's in-memory mirror as live-SSE-shape envelopes under
          // `inflight: [...]`. PWA's `backend.replayInflight()` replays
          // them through the same handlers the live SSE stream uses, so
          // a reconnected client sees STREAMING bubbles keyed by
          // message_id — and subsequent live deltas update the same
          // bubble instead of forking a duplicate.
          //
          // (Crack C of the 2026-05-17 turn-taking audit. Previously
          // we folded `renderItems` output into the durable `items`
          // array; that produced finalized rows without `sidekick_id`
          // on the in-flight assistant, causing visible double-renders
          // once live deltas resumed.)
          let inflightEnvelopes = [];
          if (turnBuffer) {
            const activeTurns = turnBuffer.activeTurnsForChat(incomingId);
            for (const turn of activeTurns) {
              inflightEnvelopes = inflightEnvelopes.concat(turnBuffer.renderEnvelopes(turn));
            }
          }

          // Over-fetch detection: client asked for `limit` newest-first
          // tail (with `before` cursor). Sidekick's getMessages always
          // returns oldest-first within the page; cursor logic above
          // already drops anything ≥ `before`. We just slice the tail.
          const has_more = all.length > limit;
          const items = has_more ? all.slice(all.length - limit) : all;
          sendJson(res, 200, {
            data: items,
            first_id: items.length > 0 ? items[0].id : null,
            has_more,
            ...(inflightEnvelopes.length > 0 ? { inflight: inflightEnvelopes } : {}),
          });
        } catch (err) {
          sendJson(res, 500, { error: 'get_messages_failed', message: String(err?.message ?? err) });
        }
        return true;
      },
    });
  },
});
