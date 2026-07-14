// ClaudeCodeUpstream — Claude Code (Agent SDK) as a sidekick backend.
//
// Implements the proxy's upstream contract (proxy/sidekick/upstream.ts
// UpstreamAgent) directly in-process: sendMessage is an async generator
// of sidekick envelopes, conversations map onto Agent SDK sessions, and
// the SDK's session storage backs list/items/delete. No /v1 HTTP hop —
// the wiring step hands an instance to the proxy where
// HTTPAgentUpstream sits today (see README "Wiring plan").
//
// Key design points (per the research doc, 2026-07-07):
//   * conversation key ↔ {session_id, cwd} — the PAIR, persisted
//     (SessionMap): session lookup is cwd-scoped and resume with a
//     mismatched cwd silently forks a fresh session.
//   * streaming-input mode, never one-shot -p: query() gets an
//     AsyncIterable prompt; barge-in = AbortSignal → query.interrupt().
//   * SDK, never CLI-scraping: sessions are read via listSessions /
//     getSessionMessages / deleteSession, not by parsing
//     ~/.claude/projects JSONL.
//   * approvals: canUseTool → agent_question envelope (kind:'approval',
//     expires_at:null) → POST /api/sidekick/questions/{id} →
//     answerQuestion() resolves the parked promise → allow/deny.
//   * display_doc: per-turn in-process MCP server (docShim.ts) pushes
//     doc_show into the live turn stream.
//
// The SDK module is constructor-injected (AgentSdk in sdkTypes.ts) so
// tests run against a fake and this file has zero hard dependency on
// the not-yet-installed @anthropic-ai/claude-agent-sdk package.

import { randomUUID } from 'node:crypto';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import type {
  ConversationItem,
  ConversationSummary,
  GatewayConversationSummary,
  CommandDef,
  SettingDef,
  SearchResult,
  UpstreamAgent,
} from '../../proxy/sidekick/upstream.ts';
import type {
  AgentSdk,
  SdkCanUseTool,
  SdkContentBlock,
  SdkMessage,
  SdkPermissionMode,
  SdkQueryOptions,
  SdkSessionMessage,
  SdkUserMessage,
} from './sdkTypes.ts';
import type { ClaudeCodeEnvelope } from './envelopes.ts';
import { AsyncQueue } from './asyncQueue.ts';
import { SessionMap } from './sessionMap.ts';
import { QuestionRegistry, DENY_CHOICE, isApproval } from './questions.ts';
import { buildDocServer, DOC_SERVER_NAME } from './docShim.ts';

// ── Config ───────────────────────────────────────────────────────────

export interface ClaudeCodeConfig {
  /** Project directory new chats run in. Every conversation is pinned
   *  to one cwd for its lifetime (sessions are cwd-scoped). */
  cwd: string;
  /** Absolute path prefixes chats may run under. When set, cwd (and any
   *  future per-chat cwd override) must live under one of them. */
  cwdAllowlist?: string[];
  /** Model alias forwarded to the SDK (omit = account default). */
  model?: string;
  /** 'remote' (default): canUseTool → agent_question round-trip to the
   *  PWA. 'auto': skip remote approvals and run with permissionMode
   *  (default 'acceptEdits' — the sane call-mode default on your own
   *  machine per the research doc). */
  approvals?: 'remote' | 'auto';
  /** Permission mode used when approvals === 'auto'. */
  permissionMode?: SdkPermissionMode;
  /** JSON file for the chat→session map. null = in-memory (tests). */
  persistPath?: string | null;
  /** Cap on agentic turns per user message (safety valve; omit = SDK default). */
  maxTurns?: number;
}

export interface ClaudeCodeUpstreamDeps {
  sdk: AgentSdk;
  config: ClaudeCodeConfig;
  now?: () => number;
}

/** Drawer ids for sessions that exist on disk but were never started
 *  from sidekick (created by the CLI directly). Selecting one resumes
 *  that session in place. */
const FOREIGN_CHAT_PREFIX = 'cc:';

const DEFAULT_PAGE_SIZE = 50;
const MAX_QUESTION_ARG_CHARS = 400;

// ── Per-turn translation state ───────────────────────────────────────

interface TurnState {
  chatId: string;
  messageId: string;
  assembled: string;
  sawDelta: boolean;
  sawFinal: boolean;
  wasNewSession: boolean;
  firstText: string;
  toolNames: Map<string, string>;
}

export class ClaudeCodeUpstream {
  private sdk: AgentSdk;
  private config: ClaudeCodeConfig;
  private now: () => number;
  private sessions: SessionMap;
  private questions = new QuestionRegistry();

  // Out-of-turn event channel (subscribeEvents): monotonic-id ring +
  // live subscriber queues, same replay semantics the proxy expects
  // from /v1/events (Last-Event-ID resume within one process life).
  private eventRing: Array<{ id: number; envelope: ClaudeCodeEnvelope }> = [];
  private eventSubscribers = new Set<AsyncQueue<{ id: number; envelope: ClaudeCodeEnvelope }>>();
  private lastEventId = 0;
  private static EVENT_RING_CAP = 128;

  constructor(deps: ClaudeCodeUpstreamDeps) {
    this.sdk = deps.sdk;
    this.config = deps.config;
    this.now = deps.now ?? Date.now;
    this.validateCwd(deps.config.cwd);
    this.sessions = new SessionMap(deps.config.persistPath ?? null);
  }

  /** The runtime protocol is a strict superset of UpstreamAgent (the
   *  envelope union additionally carries agent_question / doc_show,
   *  which the proxy's stream allowlist already accepts). This cast is
   *  the single acknowledged widening point. */
  asUpstreamAgent(): UpstreamAgent {
    return this as unknown as UpstreamAgent;
  }

  // ── sendMessage — the turn pipeline ────────────────────────────────

  async *sendMessage(
    chatId: string,
    text: string,
    opts: {
      signal?: AbortSignal;
      attachments?: unknown[];
      voice?: boolean;
      userMessageId?: string;
    } = {},
  ): AsyncIterable<ClaudeCodeEnvelope> {
    if (opts.attachments && opts.attachments.length > 0) {
      // v1 contract: attachments 400 (ABSTRACT_AGENT_PROTOCOL allows it).
      yield {
        type: 'error',
        chat_id: chatId,
        message: 'claude-code backend v1 does not accept attachments yet',
      };
      return;
    }

    const entry = this.resolveEntry(chatId);
    const userMessageId = opts.userMessageId ?? `umsg_${randomUUID()}`;
    const queue = new AsyncQueue<ClaudeCodeEnvelope>();
    const push = (env: ClaudeCodeEnvelope) => queue.push(env);

    const state: TurnState = {
      chatId,
      messageId: `msg_cc_${randomUUID().slice(0, 12)}`,
      assembled: '',
      sawDelta: false,
      sawFinal: false,
      wasNewSession: entry.sessionId == null,
      firstText: text,
      toolNames: new Map(),
    };

    const options: SdkQueryOptions = {
      cwd: entry.cwd,
      includePartialMessages: true,
      mcpServers: {
        [DOC_SERVER_NAME]: buildDocServer({ sdk: this.sdk, chatId, push, now: this.now }),
      },
    };
    if (entry.sessionId) options.resume = entry.sessionId;
    if (this.config.model) options.model = this.config.model;
    if (this.config.maxTurns != null) options.maxTurns = this.config.maxTurns;
    if ((this.config.approvals ?? 'remote') === 'remote') {
      options.permissionMode = 'default';
      options.canUseTool = this.makeCanUseTool(chatId, push);
    } else {
      options.permissionMode = this.config.permissionMode ?? 'acceptEdits';
    }

    const q = this.sdk.query({ prompt: singleUserTurn(text), options });
    const onAbort = () => {
      void Promise.resolve(q.interrupt()).catch(() => {});
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Pump: SDK messages → envelopes into the queue, interleaving with
    // whatever the side channels (canUseTool, display_doc) push.
    const pump = (async () => {
      try {
        for await (const msg of q) {
          this.translate(msg as SdkMessage, state, push);
        }
      } catch (e) {
        push({
          type: 'error',
          chat_id: chatId,
          message: `claude-code turn failed: ${(e as Error)?.message ?? String(e)}`,
        });
      } finally {
        // Never leave a canUseTool promise parked once the turn is
        // over — resolve null (→ deny) so the SDK unwinds.
        this.questions.cancelForChat(chatId);
        queue.end();
      }
    })();

    try {
      // Cross-device user bubble first (same contract as the hermes
      // plugin's _handle_responses emission), then a typing indicator.
      yield { type: 'user_message', chat_id: chatId, message_id: userMessageId, text };
      yield { type: 'typing', chat_id: chatId };
      for await (const env of queue) yield env;
      if (state.sawDelta && !state.sawFinal) {
        // Interrupted turn (barge-in): settle the streaming bubble.
        yield { type: 'reply_final', chat_id: chatId, message_id: state.messageId };
      }
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      await pump.catch(() => {});
    }
  }

  private makeCanUseTool(chatId: string, push: (env: ClaudeCodeEnvelope) => void): SdkCanUseTool {
    return async (toolName, input) => {
      const { envelope, answer } = this.questions.ask({
        chatId,
        kind: 'approval',
        question: approvalQuestion(toolName, input),
      });
      push(envelope);
      const ans = await answer;
      // {behavior} shape per the installed SDK .d.ts (0.3.209) — the
      // docs' {allow} form is a newer API this version doesn't export.
      if (ans == null) {
        return { behavior: 'deny', message: 'Denied: the turn ended before the user answered.' };
      }
      if (isApproval(ans.response)) return { behavior: 'allow' };
      const trimmed = ans.response.trim();
      const isPlainDeny = trimmed === DENY_CHOICE || /^(deny|denied|no|n)$/i.test(trimmed);
      return {
        behavior: 'deny',
        message: isPlainDeny ? 'Denied by user.' : `Denied by user: ${trimmed}`,
      };
    };
  }

  /** Resolve one pending approval/clarify question. The wiring step
   *  routes POST /api/sidekick/questions/{id} here for this backend.
   *  Returns false when the id is unknown/lapsed (→ 404, PWA renders
   *  the question as lapsed). */
  answerQuestion(questionId: string, response: string): boolean {
    return this.questions.answer(questionId, response);
  }

  // ── SDK message → envelope translation ─────────────────────────────

  private translate(msg: SdkMessage, state: TurnState, push: (env: ClaudeCodeEnvelope) => void): void {
    // Subagent-internal traffic stays out of the chat stream in v1.
    if ('parent_tool_use_id' in msg && msg.parent_tool_use_id) return;

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
          this.recordSession(state, msg.session_id, push);
        }
        return;
      }

      case 'stream_event': {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          const isFirst = !state.sawDelta;
          state.sawDelta = true;
          state.assembled += ev.delta.text;
          // Same delta protocol HTTPAgentUpstream emits: first frame is
          // the initial content, later frames carry the running total
          // with edit:true (PWA streamingDelta accepts cumulative-edit).
          push({
            type: 'reply_delta',
            chat_id: state.chatId,
            text: state.assembled,
            message_id: state.messageId,
            ...(isFirst ? {} : { edit: true }),
          });
        }
        return;
      }

      case 'assistant': {
        if (typeof msg.session_id === 'string') this.recordSession(state, msg.session_id, push);
        const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id && block.name) {
            state.toolNames.set(block.id, block.name);
            push({
              type: 'tool_call',
              chat_id: state.chatId,
              call_id: block.id,
              tool_name: block.name,
              args: block.input ?? {},
              started_at: new Date(this.now()).toISOString(),
            });
          }
          // Text blocks are intentionally NOT re-emitted here — the
          // stream_event deltas already carried them.
        }
        return;
      }

      case 'user': {
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            push({
              type: 'tool_result',
              chat_id: state.chatId,
              call_id: block.tool_use_id,
              tool_name: state.toolNames.get(block.tool_use_id) ?? '',
              result: normalizeToolContent(block.content),
            });
          }
        }
        return;
      }

      case 'result': {
        if (typeof msg.session_id === 'string') this.recordSession(state, msg.session_id, push);
        if (!state.sawDelta && typeof msg.result === 'string' && msg.result) {
          // Non-streaming path (includePartialMessages off / older CLI):
          // deliver the final text as a single delta before the final.
          state.assembled = msg.result;
          state.sawDelta = true;
          push({
            type: 'reply_delta',
            chat_id: state.chatId,
            text: msg.result,
            message_id: state.messageId,
          });
        }
        if (msg.is_error && !state.assembled) {
          push({
            type: 'error',
            chat_id: state.chatId,
            message: `claude-code result: ${msg.subtype}`,
          });
        }
        state.sawFinal = true;
        push({ type: 'reply_final', chat_id: state.chatId, message_id: state.messageId });
        return;
      }

      default:
        return; // tolerate unknown SDK message types
    }
  }

  private recordSession(state: TurnState, sessionId: string, push: (env: ClaudeCodeEnvelope) => void): void {
    const entry = this.sessions.get(state.chatId);
    if (!entry || entry.sessionId === sessionId) return;
    this.sessions.setSession(state.chatId, sessionId);
    if (state.wasNewSession) {
      const title = deriveTitle(state.firstText);
      this.sessions.setTitle(state.chatId, title);
      push({
        type: 'session_changed',
        chat_id: state.chatId,
        session_id: sessionId,
        title,
      });
    }
  }

  // ── Conversations API over SDK session storage ─────────────────────

  async listConversations(limit = DEFAULT_PAGE_SIZE): Promise<ConversationSummary[]> {
    const infos = await this.sdk.listSessions({ dir: this.config.cwd, limit });
    const rows: ConversationSummary[] = [];
    for (const info of infos) {
      const chatId = this.sessions.chatIdForSession(info.sessionId)
        ?? `${FOREIGN_CHAT_PREFIX}${info.sessionId}`;
      const entry = this.sessions.get(chatId);
      const title = entry?.title
        ?? info.customTitle
        ?? info.summary
        ?? info.firstPrompt
        ?? info.sessionId;
      const lastActive = Math.floor((info.lastModified ?? this.now()) / 1000);
      rows.push({
        id: chatId,
        object: 'conversation',
        created_at: Math.floor((info.createdAt ?? info.lastModified ?? this.now()) / 1000),
        metadata: {
          title,
          // Per-message counts require a transcript read per row —
          // deferred (v1.1); the drawer tolerates 0.
          message_count: 0,
          last_active_at: lastActive,
          first_user_message: info.firstPrompt ?? null,
          session_ids: info.sessionId,
        },
      });
    }
    rows.sort((a, b) => b.metadata.last_active_at - a.metadata.last_active_at);
    return rows.slice(0, limit);
  }

  async listGatewayConversations(): Promise<GatewayConversationSummary[] | null> {
    return null; // single-channel backend — proxy falls back to listConversations
  }

  async getMessages(
    chatId: string,
    opts: { limit?: number; before?: number; around?: string; after?: number } = {},
  ): Promise<{
    items: ConversationItem[];
    first_id: number | null;
    has_more: boolean;
    inflight: ClaudeCodeEnvelope[];
    target_found?: boolean;
    last_id?: number | null;
    has_more_newer?: boolean;
  }> {
    const entry = this.peekEntry(chatId);
    if (!entry || !entry.sessionId) {
      return { items: [], first_id: null, has_more: false, inflight: [] };
    }
    const raw = await this.sdk.getSessionMessages(entry.sessionId, { dir: entry.cwd });
    const all = sessionMessagesToItems(raw);
    const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
    let windowed = all;
    if (opts.before != null) windowed = all.filter((item) => item.id < (opts.before as number));
    const items = windowed.slice(Math.max(0, windowed.length - limit));
    const firstId = items.length > 0 ? items[0].id : null;
    const lastId = items.length > 0 ? items[items.length - 1].id : null;
    return {
      items,
      first_id: firstId,
      has_more: firstId != null && firstId > 1,
      inflight: [], // v1: no mid-turn replay buffer (see README deferred list)
      last_id: lastId,
      has_more_newer: lastId != null && all.length > 0 && lastId < all[all.length - 1].id,
    };
  }

  async deleteConversation(chatId: string): Promise<void> {
    const entry = this.peekEntry(chatId);
    if (entry?.sessionId) {
      try {
        await this.sdk.deleteSession(entry.sessionId, { dir: entry.cwd });
      } catch {
        // idempotent — already gone on disk is success
      }
    }
    this.sessions.delete(chatId);
  }

  async renameConversation(chatId: string, title: string): Promise<{ title: string }> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('title required');
    const entry = this.peekEntry(chatId);
    if (entry?.sessionId) {
      await this.sdk.renameSession(entry.sessionId, trimmed, { dir: entry.cwd });
      this.sessions.setTitle(chatId, trimmed);
      this.publishEvent({
        type: 'session_changed',
        chat_id: chatId,
        session_id: entry.sessionId,
        title: trimmed,
      });
    }
    return { title: trimmed };
  }

  // ── Out-of-turn events ─────────────────────────────────────────────

  private publishEvent(envelope: ClaudeCodeEnvelope): void {
    this.lastEventId += 1;
    const record = { id: this.lastEventId, envelope };
    this.eventRing.push(record);
    if (this.eventRing.length > ClaudeCodeUpstream.EVENT_RING_CAP) this.eventRing.shift();
    for (const sub of this.eventSubscribers) sub.push(record);
  }

  async *subscribeEvents(
    opts: { signal?: AbortSignal; lastEventId?: number } = {},
  ): AsyncIterable<{ id: number; envelope: ClaudeCodeEnvelope }> {
    const queue = new AsyncQueue<{ id: number; envelope: ClaudeCodeEnvelope }>();
    const from = opts.lastEventId ?? 0;
    for (const record of this.eventRing) {
      if (record.id > from) queue.push(record);
    }
    this.eventSubscribers.add(queue);
    const detach = () => {
      this.eventSubscribers.delete(queue);
      queue.end();
    };
    if (opts.signal) {
      if (opts.signal.aborted) detach();
      else opts.signal.addEventListener('abort', detach, { once: true });
    }
    try {
      for await (const record of queue) yield record;
    } finally {
      detach();
      if (opts.signal) opts.signal.removeEventListener('abort', detach);
    }
  }

  // ── Optional extensions — not implemented in v1 ────────────────────

  async healthcheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async getSettingsSchema(): Promise<SettingDef[] | null> {
    return null; // proxy hides the Agent settings group
  }

  async updateSetting(): Promise<SettingDef> {
    throw new Error('claude-code backend has no settings surface');
  }

  async listCommands(): Promise<CommandDef[] | null> {
    return null; // v1.1: map Query.supportedCommands() into the catalog
  }

  async searchConversations(): Promise<SearchResult | null> {
    return null; // proxy tells the PWA search is unavailable
  }

  // ── Chat-id / cwd plumbing ─────────────────────────────────────────

  /** Resolve without creating (reads: getMessages/delete/rename). */
  private peekEntry(chatId: string) {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;
    if (chatId.startsWith(FOREIGN_CHAT_PREFIX)) {
      // Adopt a CLI-born session the drawer surfaced.
      const sessionId = chatId.slice(FOREIGN_CHAT_PREFIX.length);
      const entry = this.sessions.ensure(chatId, this.config.cwd, this.now());
      this.sessions.setSession(chatId, sessionId);
      return this.sessions.get(chatId);
    }
    return undefined;
  }

  /** Resolve, creating a fresh chat entry when unknown (sendMessage). */
  private resolveEntry(chatId: string) {
    return this.peekEntry(chatId) ?? this.sessions.ensure(chatId, this.config.cwd, this.now());
  }

  private validateCwd(cwd: string): void {
    const allowlist = this.config.cwdAllowlist;
    if (!allowlist || allowlist.length === 0) return;
    const resolved = resolvePath(cwd);
    const ok = allowlist.some((prefix) => {
      const p = resolvePath(prefix);
      return resolved === p || resolved.startsWith(p + pathSep);
    });
    if (!ok) {
      throw new Error(`claude-code cwd ${resolved} is not under the configured allowlist`);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Streaming-input prompt carrying exactly one user turn. The iterable
 *  completing tells the SDK the turn's input is done; interruption
 *  still works via query.interrupt(). Long-lived multi-turn iterables
 *  (in-process queueing) are a v1.1 upgrade — see README. */
async function* singleUserTurn(text: string): AsyncIterable<SdkUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
  };
}

function approvalQuestion(toolName: string, input: Record<string, unknown>): string {
  let args = '';
  try {
    args = JSON.stringify(input);
  } catch {
    args = String(input);
  }
  if (args && args !== '{}') {
    if (args.length > MAX_QUESTION_ARG_CHARS) args = `${args.slice(0, MAX_QUESTION_ARG_CHARS)}…`;
    return `Claude Code wants to use ${toolName}\n${args}`;
  }
  return `Claude Code wants to use ${toolName}`;
}

function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine || 'New chat';
}

function normalizeToolContent(content: unknown): unknown {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is SdkContentBlock => !!b && typeof b === 'object')
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Flatten SDK session storage rows into OAI-shaped ConversationItems
 *  (ascending ids). Assistant tool_use blocks become the serialized
 *  tool_calls extension; tool_result blocks become role:'tool' rows —
 *  matching what the PWA's history rebuild expects from hermes. */
export function sessionMessagesToItems(raw: SdkSessionMessage[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const toolNames = new Map<string, string>();
  let nextId = 1;

  const pushItem = (item: Omit<ConversationItem, 'id' | 'object'>) => {
    items.push({ id: nextId++, object: 'message', ...item });
  };

  for (const row of raw) {
    if (row.parent_tool_use_id) continue; // subagent internals
    const payload = row.message as { role?: string; content?: unknown } | undefined;
    if (!payload) continue;
    const createdAt = readTimestampSeconds(row);

    if (row.type === 'assistant') {
      const blocks = Array.isArray(payload.content) ? (payload.content as SdkContentBlock[]) : [];
      const text = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');
      const toolUses = blocks.filter((b) => b.type === 'tool_use' && b.id && b.name);
      for (const tu of toolUses) toolNames.set(tu.id as string, tu.name as string);
      if (!text && toolUses.length === 0) continue;
      pushItem({
        role: 'assistant',
        content: text,
        created_at: createdAt,
        ...(toolUses.length > 0
          ? {
              tool_calls: JSON.stringify(
                toolUses.map((tu) => ({
                  id: tu.id,
                  type: 'function',
                  function: { name: tu.name, arguments: safeJson(tu.input) },
                })),
              ),
            }
          : {}),
      });
      continue;
    }

    // row.type === 'user': plain text and/or tool_result blocks.
    if (typeof payload.content === 'string') {
      if (payload.content.trim()) {
        pushItem({ role: 'user', content: payload.content, created_at: createdAt });
      }
      continue;
    }
    const blocks = Array.isArray(payload.content) ? (payload.content as SdkContentBlock[]) : [];
    const texts = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (texts.trim()) pushItem({ role: 'user', content: texts, created_at: createdAt });
    for (const block of blocks) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        pushItem({
          role: 'tool',
          content: String(normalizeToolContent(block.content)),
          created_at: createdAt,
          tool_name: toolNames.get(block.tool_use_id) ?? '',
          tool_call_id: block.tool_use_id,
        });
      }
    }
  }
  return items;
}

function readTimestampSeconds(row: SdkSessionMessage): number {
  const ts = (row as { timestamp?: unknown }).timestamp;
  if (typeof ts === 'number') return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 0; // JSONL rows without timestamps — PWA tolerates epoch 0
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}
