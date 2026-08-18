/**
 * Openclaw native shapes → parley UpstreamAgent shapes.
 *
 * Reference for target shapes:
 *   proxy/parley/upstream.ts
 *     - ConversationSummary (line 38)
 *     - ConversationItem    (line 126)
 *
 * Openclaw native shape reference:
 *   src/gateway/server-methods/sessions.ts (sessions.list)
 *   src/gateway/server-methods/chat.ts     (chat.history)
 */
import { firstUserMessageText, isDeliveryMirror } from './openclaw-store.js';

/** Strip the openclaw `agent:{agentId}:` prefix from a session key
 *  so PWA-minted chat ids (e.g. `sidekick:<uuid>`) roundtrip stably.
 *
 *  Why: when the PWA POSTs /v1/responses with `conversation:"sidekick:abc"`,
 *  openclaw normalizes that to `agent:dev:parley:abc` and returns it
 *  in subsequent sessions.list calls. Without normalization, the PWA's
 *  IDB row keyed by `sidekick:abc` doesn't match the server-returned
 *  `agent:dev:parley:abc`, so the drawer shows two rows for one chat
 *  (which breaks continuity on subsequent sends).
 *
 *  Reverse normalization (`prefixChatId`) is idempotent — openclaw's
 *  chat.send accepts both the bare slot and the full canonical key,
 *  so accepting either from the PWA is safe. */
export function stripChatIdPrefix(sessionKey, agentId = 'dev') {
  const prefix = `agent:${agentId}:`;
  return sessionKey.startsWith(prefix) ? sessionKey.slice(prefix.length) : sessionKey;
}

/** Inverse: build the openclaw canonical session key from a PWA chat id.
 *  Used when looking up by id in stores keyed by full canonical key. */
export function prefixChatId(chatId, agentId = 'dev') {
  const prefix = `agent:${agentId}:`;
  return chatId.startsWith(prefix) ? chatId : `${prefix}${chatId}`;
}

/** Convert a single openclaw sessions.json entry + its messages into
 *  the parley ConversationSummary shape.
 *
 *  We compute message_count + first_user_message by reading the full
 *  message log. That's O(n) per chat at drawer-load time — acceptable
 *  for small chat counts; revisit with a cached index in the
 *  supplemental store when chat count grows. */
export function toConversationSummary({ sessionKey, entry, messages, agentId = 'dev' }) {
  const filtered = messages.filter((m) => !isDeliveryMirror(m));
  const firstUser = firstUserMessageText(filtered);
  // Openclaw has no native title field. Prefer a snippet of the first
  // user message (mirrors what hermes does for whatsapp/telegram drawer
  // rows when no explicit chat title is set) — strips the leading
  // parley timestamp wrapper so the snippet doesn't waste row real
  // estate. Falls back to the stripped chat id only when no user
  // message has landed yet.
  const titleSnippet = firstUser ? extractTitleSnippet(firstUser) : '';
  const strippedId = stripChatIdPrefix(sessionKey, agentId);
  return {
    id: strippedId,
    object: 'conversation',
    // sessions.json carries ms timestamps; parley expects seconds.
    created_at: Math.floor((entry.sessionStartedAt ?? entry.updatedAt) / 1000),
    metadata: {
      title: titleSnippet || strippedId,
      message_count: filtered.length,
      last_active_at: Math.floor(entry.updatedAt / 1000),
      first_user_message: firstUser,
    },
  };
}

/** Strip the leading `[Sat 2026-05-16 09:35 GMT+1] ` timestamp wrapper
 *  the parley PWA prepends to every user message, then truncate. The
 *  resulting snippet reads like a natural chat title. */
function extractTitleSnippet(userText, maxLen = 60) {
  let s = userText.replace(/^\[[^\]]+\]\s*/, '').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trimEnd() + '…';
  return s;
}

/** Convert one openclaw message row to a parley ConversationItem.
 *  `seq` is the row index (0-based within the filtered list) — used as
 *  the integer `id` the PWA dedups against. Openclaw doesn't expose a
 *  globally-monotonic id, but per-chat seq is stable across reads (the
 *  jsonl file is append-only) which is what the PWA actually needs.
 *
 *  Returns null for rows that don't render as messages (e.g. system
 *  rows that the PWA filters out anyway; cleaner to drop here). */
export function toConversationItem({ msg, seq, sidekickIdLookup }) {
  // SPECIAL CASE: openclaw uses a `message` tool to deliver the
  // user-facing reply text (args.message). Render it as assistant
  // text rather than a tool_call row so the reload replay matches
  // what /v1/responses streamed live (see responses-handler.js).
  // Without this, every reload re-renders the message-tool args as
  // a raw JSON tool block AND the codex narration as a separate
  // assistant bubble — both wrong.
  const messageToolReply = extractMessageToolReply(msg);
  if (messageToolReply) {
    const openclawId = msg?.wrapperId;
    const sidekickId = openclawId && sidekickIdLookup ? sidekickIdLookup.get(openclawId) : undefined;
    return {
      id: seq,
      object: 'message',
      role: 'assistant',
      content: messageToolReply,
      created_at: Math.floor((msg.timestamp ?? Date.parse(msg.wrapperTs)) / 1000),
      ...(sidekickId ? { sidekick_id: sidekickId } : {}),
    };
  }
  const role = mapRole(msg);
  if (!role) return null;
  const { content, toolName } = flattenContent(msg);
  // sidekick_id mapping: looked up by openclaw's jsonl wrapper id
  // (msg.wrapperId), which is the stable per-message uuid we stored
  // as agent_row_id at /v1/responses lifecycle:end. PWA uses sidekick_id
  // to dedup the inflight-cached bubble against this reload replay —
  // without it every reload duplicates assistant bubbles.
  const openclawId = msg?.wrapperId;
  const sidekickId = openclawId && sidekickIdLookup ? sidekickIdLookup.get(openclawId) : undefined;
  return {
    id: seq,
    object: 'message',
    role,
    content,
    created_at: Math.floor((msg.timestamp ?? Date.parse(msg.wrapperTs)) / 1000),
    ...(toolName ? { tool_name: toolName } : {}),
    ...(sidekickId ? { sidekick_id: sidekickId } : {}),
  };
}

/** Return the args.message text if this row is an assistant with a
 *  single message-tool call, else null. The user-facing reply lives
 *  in the tool args; render it as assistant text. */
function extractMessageToolReply(msg) {
  if (msg.role !== 'assistant') return null;
  if (!Array.isArray(msg.content)) return null;
  const toolCalls = msg.content.filter((c) => c?.type === 'toolCall');
  if (toolCalls.length === 0) return null;
  // Concatenate any message-tool args (handles multi-message turns).
  const texts = [];
  for (const tc of toolCalls) {
    if (tc?.name !== 'message') continue;
    const argText = (tc.arguments ?? tc.input ?? {})?.message;
    if (typeof argText === 'string' && argText.length > 0) texts.push(argText);
  }
  return texts.length > 0 ? texts.join('\n\n') : null;
}

/** Map openclaw role → parley role. Parley uses 'tool' for both
 *  tool calls and tool results; openclaw separates assistant(toolCall)
 *  from a top-level toolResult row. We surface assistant(toolCall) as
 *  role='tool' because that's how the PWA renders tool activity. */
function mapRole(msg) {
  if (msg.role === 'user') return 'user';
  if (msg.role === 'toolResult') return 'tool';
  if (msg.role === 'system') return 'system';
  if (msg.role === 'assistant') {
    if (Array.isArray(msg.content) && msg.content.every((c) => c?.type === 'toolCall')) {
      return 'tool';
    }
    return 'assistant';
  }
  return null;
}

/** Strip the `[Sat 2026-05-16 14:00 GMT+1] ` timestamp wrapper that
 *  openclaw's chat.send injects into user messages before handing
 *  them to the agent (`injectTimestamp` in
 *  `src/gateway/server-methods/agent-timestamp.ts` in the openclaw gateway).
 *  The durable form carries it; the PWA's optimistic bubble + the
 *  in-flight turn buffer use the raw text. Without stripping in
 *  items output, a reload after the turn shows TWO user bubbles
 *  (the optimistic raw-text one + the timestamped durable one). */
function stripUserTimestampWrapper(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/^\[[^\]]+(?:GMT|UTC)[^\]]*\]\s*/, '');
}

/** Collapse openclaw's content[] array into a single content string
 *  the PWA can render. Tool calls become a JSON-serialized payload
 *  (mirrors what backends/hermes/plugin emits for tool rows); tool
 *  results pass through the result text. */
function flattenContent(msg) {
  if (typeof msg.content === 'string') {
    const stripped = msg.role === 'user'
      ? stripUserTimestampWrapper(msg.content)
      : msg.content;
    return { content: stripped, toolName: null };
  }
  if (!Array.isArray(msg.content)) return { content: '', toolName: null };
  const texts = [];
  let toolName = null;
  for (const part of msg.content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
    } else if (part.type === 'toolCall') {
      toolName ??= part.name ?? null;
      // Surface the call payload so the PWA can render args inline
      // (the OAI ConversationItem shape carries args inside content).
      texts.push(JSON.stringify({ name: part.name, args: part.arguments ?? part.input }));
    } else if (part.type === 'toolResult') {
      toolName ??= part.toolName ?? part.name ?? null;
      const txt = typeof part.content === 'string' ? part.content
                : typeof part.text === 'string' ? part.text
                : JSON.stringify(part.content);
      texts.push(txt);
    }
  }
  return { content: texts.join('\n'), toolName };
}
