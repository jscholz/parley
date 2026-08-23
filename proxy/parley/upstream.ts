// UpstreamAgent — the proxy's contract with whatever's behind it.
//
// Today: backends/hermes/plugin (in-process with hermes-agent, exposing /v1/*
// HTTP endpoints — see backends/hermes/plugin/__init__.py).
// Tomorrow: a stub agent (echo / gemini / ollama), or any third-party
// /v1/*-speaking server (OpenAI, Groq, Together, an Ollama OpenAI-compat
// proxy, the openclaw plugin via api.registerHttpRoute).
//
// One interface, one implementation. The PWA-facing routes in
// proxy/parley/{messages,sessions,history}.ts call into this.

// No imports — this module is self-contained so it can be reused
// across upstreams (backends/hermes/plugin, stub agent, etc.) without dragging
// in WS-specific machinery. Auth comes from env or constructor opts.

/** Parley envelope shape that the proxy's stream multiplexer consumes.
 *  Same shape as the legacy WS protocol — see backends/hermes/plugin/__init__.py
 *  module docstring for the canonical wire spec. */
export type ParleyEnvelope =
  | { type: 'reply_delta'; chat_id: string; text: string; message_id: string; edit?: boolean }
  | { type: 'reply_final'; chat_id: string; message_id: string }
  | { type: 'tool_call'; chat_id: string; call_id: string; tool_name: string; args: unknown; started_at?: string }
  | { type: 'tool_result'; chat_id: string; call_id: string; tool_name: string; result: unknown; duration_ms?: number }
  | { type: 'typing'; chat_id: string }
  | { type: 'image'; chat_id: string; url: string; caption?: string }
  | { type: 'notification'; chat_id: string; kind: string; content: string }
  | { type: 'session_changed'; chat_id: string; session_id: string; title: string }
  // Cross-device user-message broadcast. Emitted by the upstream as
  // soon as a /v1/responses POST lands, BEFORE the agent dispatches.
  // Other connected PWA tabs render the user bubble immediately; the
  // originating tab dedups against its optimistic bubble via
  // `message_id`. See backends/hermes/plugin/__init__.py
  // `_handle_responses` for the emission site.
  | { type: 'user_message'; chat_id: string; message_id: string; text: string }
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
  | { type: 'error'; chat_id: string; message: string; user_message_id?: string };

/** Drawer-list row, OAI Conversations API shape. */
export interface ConversationSummary {
  id: string;
  object: 'conversation';
  created_at: number;
  metadata: {
    title: string;
    message_count: number;
    /** User-role message count ("turns") — what the user thinks of as
     *  "how many times have I said something". Newer plugins emit this;
     *  optional for back-compat. Pairs with `tool_count` so the drawer
     *  can render "N turns · M tools" instead of the inflated raw msg
     *  count. */
    turn_count?: number;
    /** Tool-role message count. Pairs with `turn_count`. Optional. */
    tool_count?: number;
    last_active_at: number;
    first_user_message: string | null;
    /** Space-joined raw hermes session ids (root + rotated children)
     *  rolled up into this conversation, so the client's session
     *  filter can match a pasted session id. Optional — older
     *  plugins don't emit it. */
    session_ids?: string;
  };
}

/** Cross-platform drawer row from the optional `/v1/gateway/*`
 *  contract. Same shape as ConversationSummary plus `source` (telegram
 *  / slack / whatsapp / parley / …) and `chat_type` (dm / group)
 *  in metadata. Agents that aren't gateways don't implement the
 *  endpoint; the upstream returns null and the proxy falls back to
 *  the channel-only `/v1/conversations` view. */
export interface GatewayConversationSummary extends ConversationSummary {
  metadata: ConversationSummary['metadata'] & {
    source: string;
    chat_type: string;
  };
}

/** Slash-command catalog entry — agent-declared via /v1/commands.
 *  Surfaced in the PWA composer's autocomplete popover. The shape
 *  mirrors hermes_cli.commands.CommandDef (the upstream's single
 *  source of truth). Aliases stay on the canonical row — the PWA
 *  matches both names against the same entry. */
export interface CommandDef {
  name: string;
  description: string;
  category: string;
  aliases: string[];
  args_hint: string;
  subcommands: string[];
}

/** Agent-declared user-facing setting — see
 *  docs/ABSTRACT_AGENT_PROTOCOL.md "Optional settings extension". */
export interface SettingDef {
  id: string;
  label: string;
  description?: string;
  category?: string;
  type: 'enum' | 'slider' | 'toggle' | 'text' | 'string-list';
  /** Type matches `type`: string for enum/text, number for slider,
   *  boolean for toggle, string[] for string-list. */
  value: string | number | boolean | string[];
  options?: Array<{ value: string; label: string; description?: string }>;
  min?: number;
  max?: number;
  step?: number;
  /** Hint text inside the input (text + string-list types). */
  placeholder?: string;
}

/** Single transcript item, OAI shape (with optional parley extension). */
/** Cross-conversation FTS5 search hit, one per matching message. */
export interface SearchMessageHit {
  session_id: string;
  message_id: number;
  role: string;
  snippet: string;
  timestamp: number;
  session_title?: string;
  session_source?: string;
}

/** Session-grouped collapse over hits. Mirrors ConversationSummary so
 *  renderers can share code, but distinguished as a separate shape
 *  because search results carry no message_count / last_message_at by
 *  default — the upstream sets them only when it has the data cheap. */
export interface SearchSessionRow {
  id: string;
  source?: string | null;
  title?: string | null;
  snippet?: string | null;
  messageCount?: number | null;
  lastMessageAt?: number | null;
}

export interface SearchResult {
  sessions: SearchSessionRow[];
  hits: SearchMessageHit[];
}

export interface ConversationItem {
  id: number;
  object: 'message';
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  created_at: number;
  /** Parley extension: tool name for tool-role rows. Plumbed through
   *  the OAI item shape so the drawer's "agent activity" view can
   *  render the row with its tool label. Absent for non-tool rows. */
  tool_name?: string;
  /** Parley extension: tool_call_id on role='tool' rows — pairs the
   *  tool result back to the assistant's tool_call entry. Lets the
   *  PWA's history rebuild route this row through activityRow
   *  appendToolResult correctly. */
  tool_call_id?: string;
  /** Parley extension: serialized tool_calls JSON on role='assistant'
   *  rows that issued tool calls during their turn. PWA parses this
   *  to reconstruct the activity row's headers on history replay so
   *  post-reload renders look identical to live SSE. */
  tool_calls?: string;
  // Parley extension: SSE-shape id (umsg_X / msg_X) the plugin
  // emitted during the live turn that persisted this row. Recorded
  // by the plugin via parley.db msg_links and surfaced through the
  // history endpoint so reload-time dedup keys off the same id the
  // IDB cache stored. Absent for legacy rows, other-channel rows,
  // and tool / system rows.
  parley_id?: string;
  /** Parley extension: notification kind ('cron', 'reminder',
   *  'approval', etc.) when the row was persisted by the cron
   *  scheduler / background-task path. Plumbed through from
   *  parley.db msg_links.kind. State.db role stays 'assistant' (single
   *  source of truth — hermes' context loader sees these too, which
   *  is correct: the agent should know what cron output it produced).
   *  PWA reads this as the discriminator to render the row as a
   *  styled notification instead of a regular reply. Absent on
   *  user-typed turns + regular replies. */
  kind?: string;
}

export interface UpstreamAgent {
  /** Dispatch a turn. Returns an async iterable of parley envelopes
   *  that the caller fans into the persistent /api/parley/stream
   *  multiplexer. The iterable terminates when the upstream emits
   *  response.completed (or response.error). `attachments` is the
   *  PWA's collected payload (data:URL-encoded images / videos /
   *  documents); the upstream materializes them on its side. */
  sendMessage(
    chatId: string,
    text: string,
    opts?: {
      signal?: AbortSignal;
      attachments?: unknown[];
      voice?: boolean;
      /** Pre-minted user-message id from the PWA — propagated into the
       *  upstream's `user_message` broadcast envelope. Lets the
       *  originating device dedup against its optimistic user bubble.
       *  Omit and the upstream mints one (originating device just won't
       *  dedup against the broadcast — fine for single-device clients). */
      userMessageId?: string;
    },
  ): AsyncIterable<ParleyEnvelope>;

  /** Drawer list. Most-recent-first, bounded by `limit`. */
  listConversations(limit?: number): Promise<ConversationSummary[]>;

  /** Cross-platform drawer list — optional gateway extension.
   *  Returns null when the upstream doesn't implement
   *  `/v1/gateway/conversations` (single-channel agents — stub, raw OAI
   *  third-parties); the caller falls back to `listConversations`. */
  listGatewayConversations(limit?: number): Promise<GatewayConversationSummary[] | null>;

  /** Transcript replay. `inflight` carries live-SSE-shape envelopes
   *  from the plugin's TurnBuffer (only on the first page; empty
   *  array when no turn is active).
   *
   *  `around` returns a bounded window centered on the target (context
   *  above + below), and `after` pages forward (load-newer) from a
   *  cursor — both surface `last_id`/`has_more_newer` so the PWA knows
   *  whether the loaded run reaches the live tail. */
  getMessages(
    chatId: string,
    opts?: { limit?: number; before?: number; around?: string; after?: number },
  ): Promise<{ items: ConversationItem[]; first_id: number | null; has_more: boolean; inflight: ParleyEnvelope[]; target_found?: boolean; last_id?: number | null; has_more_newer?: boolean }>;

  /** Drawer delete. Cascades upstream (transcript + memory store). */
  deleteConversation(chatId: string): Promise<void>;

  /** Rename a conversation. Persists `title` server-side so other
   *  connected clients see the change via the agent's session_changed
   *  envelope. Throws UpstreamHTTPError on 4xx/5xx so the proxy can
   *  forward status+body to the PWA verbatim (validation errors flow
   *  back as 400 with a body the user-facing layer can surface). */
  renameConversation(chatId: string, title: string): Promise<{ title: string }>;

  /** Persistent SSE subscription for out-of-turn envelopes
   *  (notifications, session_changed for chats not currently in a
   *  /v1/responses turn, late tool events). The iterable runs until
   *  `signal` aborts or the connection drops. */
  subscribeEvents(opts?: { signal?: AbortSignal; lastEventId?: number }): AsyncIterable<{ id: number; envelope: ParleyEnvelope }>;

  /** Liveness check. */
  healthcheck(): Promise<{ ok: boolean }>;

  /** Optional settings extension — agent-declared knobs. Returns null
   *  when the upstream doesn't implement /v1/settings/* (404); the
   *  proxy surfaces 404 to the PWA so the "Agent" group hides. */
  getSettingsSchema(): Promise<SettingDef[] | null>;

  /** Update one setting. Returns the updated def. Throws on 4xx/5xx
   *  with the upstream's response body included on `.cause` so the
   *  proxy can pass status + body through to the PWA. */
  updateSetting(id: string, value: unknown): Promise<SettingDef>;

  /** Optional slash-command catalog. Returns null when the upstream
   *  doesn't implement /v1/commands (404); the proxy surfaces 404 to
   *  the PWA so the autocomplete popover stays disabled. */
  listCommands(): Promise<CommandDef[] | null>;

  /** Cross-conversation FTS5 search. Returns null when the upstream
   *  doesn't implement /v1/conversations/search (404); the proxy
   *  surfaces 404 so the PWA cmd+K palette knows search is unavailable.
   *  Wire shape mirrored on the PWA side as `SearchResult` in
   *  `src/proxyClientTypes.ts` — keep these in lockstep on schema changes. */
  searchConversations(q: string, limit?: number): Promise<SearchResult | null>;
}

/** Error thrown by HTTPAgentUpstream when the upstream returns a 4xx
 *  / 5xx and the proxy needs to forward that status verbatim (not
 *  collapse to 500). Currently used by updateSetting where the agent
 *  is the validator — invalid values come back as 400. */
export class UpstreamHTTPError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `upstream HTTP ${status}`);
    this.name = 'UpstreamHTTPError';
    this.status = status;
    this.body = body;
  }
}

// ────────────────────────────────────────────────────────────────────
// HTTPAgentUpstream — the production impl. Talks /v1/* HTTP+SSE.
// ────────────────────────────────────────────────────────────────────

const DEFAULT_URL = process.env.UPSTREAM_URL || 'http://127.0.0.1:8645';
// Fall back to the same shared secret the WS path uses; this lets
// backends/hermes/plugin auth both transports with one env var.
// PARLEY_/PARLEY_ fallback matches proxy/env.mjs (this module stays
// import-free by design, so the shim is inlined here).
const DEFAULT_AUTH = (
  process.env.UPSTREAM_TOKEN
  || process.env.PARLEY_PLATFORM_TOKEN
  || process.env.PARLEY_PLATFORM_TOKEN
  || ''
).trim();

export interface HTTPAgentUpstreamOpts {
  url?: string;
  token?: string;
}

export class HTTPAgentUpstream implements UpstreamAgent {
  private readonly url: string;
  private readonly token: string;

  constructor(opts: HTTPAgentUpstreamOpts = {}) {
    this.url = (opts.url || DEFAULT_URL).replace(/\/+$/, '');
    this.token = (opts.token || DEFAULT_AUTH).trim();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    return h;
  }

  async healthcheck(): Promise<{ ok: boolean }> {
    // Hit the plugin-served `/v1/health` path rather than the bare
    // `/health` (which on openclaw is the gateway's own built-in
    // route — passes even when the parley plugin failed to load).
    // Hermes plugin exposes both /health and /v1/health to the same
    // handler. Field bug 2026-05-15: pointed the proxy at openclaw
    // and the bare /health check passed even though the parley
    // plugin wasn't serving any /v1/* routes.
    try {
      const r = await fetch(`${this.url}/v1/health`, { headers: this.headers() });
      if (!r.ok) return { ok: false };
      const j: any = await r.json().catch(() => ({}));
      return { ok: j.status === 'ok' };
    } catch {
      return { ok: false };
    }
  }

  async listConversations(limit = 50): Promise<ConversationSummary[]> {
    const r = await fetch(
      `${this.url}/v1/conversations?limit=${limit}`,
      { headers: this.headers() },
    );
    if (!r.ok) throw new Error(`upstream listConversations: HTTP ${r.status}`);
    const j: any = await r.json();
    return Array.isArray(j?.data) ? j.data : [];
  }

  /** Probe the gateway extension. 404 = upstream is single-channel —
   *  return null so the caller falls back to listConversations. Other
   *  errors throw so transient outages don't silently degrade the
   *  drawer to channel-only. */
  async listGatewayConversations(
    limit = 50,
  ): Promise<GatewayConversationSummary[] | null> {
    const r = await fetch(
      `${this.url}/v1/gateway/conversations?limit=${limit}`,
      { headers: this.headers() },
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`upstream listGatewayConversations: HTTP ${r.status}`);
    const j: any = await r.json();
    return Array.isArray(j?.data) ? j.data : [];
  }

  async getMessages(
    chatId: string,
    opts: { limit?: number; before?: number; around?: string; after?: number } = {},
  ): Promise<{ items: ConversationItem[]; first_id: number | null; has_more: boolean; inflight: ParleyEnvelope[]; target_found?: boolean; last_id?: number | null; has_more_newer?: boolean }> {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.before != null) params.set('before', String(opts.before));
    if (opts.around != null) params.set('around', String(opts.around));
    if (opts.after != null) params.set('after', String(opts.after));
    const qs = params.toString();
    const r = await fetch(
      `${this.url}/v1/conversations/${encodeURIComponent(chatId)}/items${qs ? `?${qs}` : ''}`,
      { headers: this.headers() },
    );
    if (r.status === 404) {
      return { items: [], first_id: null, has_more: false, inflight: [] };
    }
    if (!r.ok) throw new Error(`upstream getMessages: HTTP ${r.status}`);
    const j: any = await r.json();
    // `inflight` carries live-SSE-shape envelopes from the plugin's
    // TurnBuffer (Crack C, 2026-05-17). The PWA's replayInflight() path
    // pipes them through the same handlers the live SSE stream uses, so
    // streaming bubbles render on mid-turn reconnect. Optional — older
    // plugins (or any current snapshot with no active turn) omit the
    // field, in which case we surface an empty array.
    return {
      items: Array.isArray(j?.data) ? j.data : [],
      first_id: j?.first_id ?? null,
      has_more: !!j?.has_more,
      inflight: Array.isArray(j?.inflight) ? j.inflight : [],
      ...(typeof j?.target_found === 'boolean' ? { target_found: j.target_found } : {}),
      ...(j?.last_id != null ? { last_id: j.last_id } : {}),
      ...(typeof j?.has_more_newer === 'boolean' ? { has_more_newer: j.has_more_newer } : {}),
    };
  }

  async listCommands(): Promise<CommandDef[] | null> {
    const r = await fetch(`${this.url}/v1/commands`, {
      headers: this.headers(),
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`upstream listCommands: HTTP ${r.status}`);
    const j: any = await r.json();
    return Array.isArray(j?.data) ? j.data : [];
  }

  async searchConversations(q: string, limit = 20): Promise<SearchResult | null> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    const r = await fetch(`${this.url}/v1/conversations/search?${params}`, {
      headers: this.headers(),
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`upstream searchConversations: HTTP ${r.status}`);
    const j: any = await r.json();
    return {
      sessions: Array.isArray(j?.sessions) ? j.sessions as SearchSessionRow[] : [],
      hits: Array.isArray(j?.hits) ? j.hits as SearchMessageHit[] : [],
    };
  }

  async getSettingsSchema(): Promise<SettingDef[] | null> {
    const r = await fetch(`${this.url}/v1/settings/schema`, {
      headers: this.headers(),
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`upstream getSettingsSchema: HTTP ${r.status}`);
    const j: any = await r.json();
    return Array.isArray(j?.data) ? j.data : [];
  }

  async updateSetting(id: string, value: unknown): Promise<SettingDef> {
    const r = await fetch(
      `${this.url}/v1/settings/${encodeURIComponent(id)}`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ value }),
      },
    );
    let body: any;
    try { body = await r.json(); } catch { body = null; }
    if (!r.ok) {
      // Pass status + body through so the proxy can mirror the
      // upstream's error envelope verbatim — particularly the
      // validation-error message that the PWA surfaces inline.
      throw new UpstreamHTTPError(r.status, body);
    }
    return body as SettingDef;
  }

  async deleteConversation(chatId: string): Promise<void> {
    const r = await fetch(
      `${this.url}/v1/conversations/${encodeURIComponent(chatId)}`,
      { method: 'DELETE', headers: this.headers() },
    );
    if (r.status === 404) return; // idempotent — already gone
    if (!r.ok) throw new Error(`upstream deleteConversation: HTTP ${r.status}`);
  }

  async renameConversation(
    chatId: string, title: string,
  ): Promise<{ title: string }> {
    const r = await fetch(
      `${this.url}/v1/conversations/${encodeURIComponent(chatId)}`,
      {
        method: 'PATCH',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ title }),
      },
    );
    let body: any;
    try { body = await r.json(); } catch { body = null; }
    if (!r.ok) {
      // Same status+body forwarding pattern as updateSetting — the
      // upstream is the validator (length cap, source restriction),
      // and a 400 should reach the PWA with its body intact.
      throw new UpstreamHTTPError(r.status, body);
    }
    return { title: typeof body?.title === 'string' ? body.title : title };
  }

  /** Translate a /v1/responses SSE stream into parley envelopes.
   *  Maintains per-turn assembled-text state to compute additive
   *  deltas (the multiplexer's reply_delta protocol expects either
   *  initial-content OR edit=true with running total — see the
   *  plugin's reply_delta emit logic). For the proxy → PWA leg we
   *  emit deltas as additive (each reply_delta's text is what to
   *  append; matches what the PWA already handles). */
  async *sendMessage(
    chatId: string,
    text: string,
    opts: {
      signal?: AbortSignal;
      attachments?: unknown[];
      voice?: boolean;
      userMessageId?: string;
    } = {},
  ): AsyncIterable<ParleyEnvelope> {
    // Plugins that implement the parley `attachments` extension on
    // /v1/responses materialize them server-side. Raw OAI-compat
    // upstreams ignore the field — additive, OAI tolerates unknown
    // body keys.
    //
    // user_message_id and voice ride `metadata` (OAI-blessed
    // Dict[str,str] extension point — every Responses-API server
    // accepts it; vanilla servers store-and-ignore unknown keys,
    // parley's plugin reads them out). Better than top-level
    // custom fields which strict servers may reject.
    //
    // attachments is structured (not Dict[str,str]); future work
    // restructures it to OAI's multimodal `input` content parts.
    // See backlog: "/v1/responses attachments → OAI multimodal input".
    const metadata: Record<string, string> = {};
    if (opts.userMessageId) metadata.user_message_id = opts.userMessageId;
    if (opts.voice) metadata.voice = 'true';
    const body: Record<string, unknown> = {
      conversation: chatId,
      input: text,
      stream: true,
    };
    if (opts.attachments && opts.attachments.length > 0) {
      body.attachments = opts.attachments;
    }
    if (Object.keys(metadata).length > 0) body.metadata = metadata;
    const r = await fetch(`${this.url}/v1/responses`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!r.ok || !r.body) {
      const errText = await r.text().catch(() => '');
      yield {
        type: 'error',
        chat_id: chatId,
        message: `upstream sendMessage HTTP ${r.status}: ${errText.slice(0, 240)}`,
        ...(opts.userMessageId ? { user_message_id: opts.userMessageId } : {}),
      };
      return;
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let assembled = '';
    let messageId: string | null = null;
    let closed = false;
    let terminalSeen = false;

    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by \n\n. Parse each complete frame.
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');

          let event = '';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
            // Other lines (id:, retry:) — we don't currently need them
            // on the per-turn /v1/responses stream.
          }
          if (!data) continue;

          let payload: any;
          try { payload = JSON.parse(data); } catch { continue; }

          for (const translated of translateOAIEvent(event, payload, chatId, {
            getAssembled: () => assembled,
            setAssembled: (v) => { assembled = v; },
            getMessageId: () => messageId,
            setMessageId: (v) => { messageId = v; },
          })) {
            // Keep failures addressable to the optimistic user send that
            // initiated the run. The PWA can then render/retry the correct
            // turn even if another message was sent before the failure.
            yield translated.type === 'error' && opts.userMessageId
              ? { ...translated, user_message_id: opts.userMessageId }
              : translated;
          }

          if (event === 'response.completed' || event === 'response.error') {
            terminalSeen = true;
            closed = true;
            break;
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    // A gateway restart / OOM can close the HTTP body cleanly at the TCP
    // layer without emitting response.error. Treat that as an interrupted
    // turn, not success; otherwise the proxy ends quietly and the PWA keeps
    // showing an in-flight operation forever.
    if (!terminalSeen && !opts.signal?.aborted) {
      yield {
        type: 'error',
        chat_id: chatId,
        message: 'upstream response stream ended before response.completed or response.error',
        ...(opts.userMessageId ? { user_message_id: opts.userMessageId } : {}),
      };
    }
  }

  /** Persistent SSE subscription. Reconnect-aware via Last-Event-ID. */
  async *subscribeEvents(
    opts: { signal?: AbortSignal; lastEventId?: number } = {},
  ): AsyncIterable<{ id: number; envelope: ParleyEnvelope }> {
    const headers = this.headers();
    if (opts.lastEventId != null) {
      headers['last-event-id'] = String(opts.lastEventId);
    }
    const r = await fetch(`${this.url}/v1/events`, {
      headers,
      signal: opts.signal,
    });
    if (!r.ok || !r.body) {
      throw new Error(`upstream subscribeEvents: HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');

          let id: number | null = null;
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('id:')) {
              const n = Number.parseInt(line.slice(3).trim(), 10);
              if (Number.isFinite(n)) id = n;
            } else if (line.startsWith('data:')) {
              data += line.slice(5).trim();
            }
          }
          if (!data || id == null) continue;
          let envelope: ParleyEnvelope | null = null;
          try { envelope = JSON.parse(data) as ParleyEnvelope; } catch { continue; }
          if (!envelope || typeof (envelope as any).type !== 'string') continue;
          yield { id, envelope };
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// OAI → parley envelope translator (private)
// ────────────────────────────────────────────────────────────────────

interface TranslatorState {
  getAssembled: () => string;
  setAssembled: (v: string) => void;
  getMessageId: () => string | null;
  setMessageId: (v: string) => void;
}

function* translateOAIEvent(
  event: string,
  payload: any,
  chatId: string,
  state: TranslatorState,
): Generator<ParleyEnvelope> {
  switch (event) {
    case 'response.in_progress':
      yield { type: 'typing', chat_id: chatId };
      return;

    case 'response.output_text.delta': {
      const delta = typeof payload?.delta === 'string' ? payload.delta : '';
      const itemId = typeof payload?.item_id === 'string' ? payload.item_id : null;
      if (itemId && state.getMessageId() == null) state.setMessageId(itemId);
      if (delta) {
        const messageId = state.getMessageId() ?? itemId ?? `msg_${chatId}`;
        state.setAssembled(state.getAssembled() + delta);
        // Emit additive reply_delta: text=accumulated, edit=true after first.
        // PWA's chat.streamingDelta accepts cumulative text via edit.
        const isFirst = state.getAssembled() === delta;
        yield {
          type: 'reply_delta',
          chat_id: chatId,
          text: state.getAssembled(),
          message_id: messageId,
          ...(isFirst ? {} : { edit: true }),
        };
      }
      return;
    }

    case 'response.completed': {
      const messageId = state.getMessageId() ?? `msg_${chatId}`;
      yield { type: 'reply_final', chat_id: chatId, message_id: messageId };
      return;
    }

    case 'response.output_item.added': {
      const item = payload?.item;
      if (item?.type === 'function_call') {
        let args: unknown = {};
        try { args = item.arguments ? JSON.parse(item.arguments) : {}; }
        catch { args = item.arguments ?? {}; }
        yield {
          type: 'tool_call',
          chat_id: chatId,
          call_id: item.id ?? '',
          tool_name: item.name ?? '',
          args,
        };
      }
      return;
    }

    case 'response.output_item.done': {
      const item = payload?.item;
      if (item?.type === 'function_call_output') {
        yield {
          type: 'tool_result',
          chat_id: chatId,
          call_id: item.call_id ?? '',
          tool_name: '',
          result: item.output ?? '',
        };
      }
      return;
    }

    case 'response.error': {
      const msg = payload?.error?.message ?? 'upstream error';
      yield { type: 'error', chat_id: chatId, message: String(msg) };
      return;
    }

    default:
      // Unknown event types — skip silently. The OAI Responses spec
      // explicitly says clients MUST tolerate unknown event types.
      return;
  }
}
