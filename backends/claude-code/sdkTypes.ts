// Local structural mirror of @anthropic-ai/claude-agent-sdk's documented
// TypeScript surface — ONLY the slice this backend consumes.
//
// Why a mirror and not the real package: this repo's package.json is shared
// and deliberately untouched by the claude-code backend skeleton. The
// adapter codes against the `AgentSdk` interface below (constructor-injected)
// so unit tests run against a fake and the wiring step swaps in the real
// module:
//
//     npm install @anthropic-ai/claude-agent-sdk zod
//     import * as sdk from '@anthropic-ai/claude-agent-sdk';
//     new ClaudeCodeUpstream({ sdk, config });
//
// Shapes were transcribed 2026-07-13 from the official TypeScript Agent SDK
// reference (code.claude.com/docs/en/agent-sdk/typescript). At wiring time,
// re-verify against the installed package's .d.ts — in particular
// PermissionResult (docs show `{ allow: boolean }`; older releases used
// `{ behavior: 'allow' | 'deny' }`) and deleteSession (verified present in
// @anthropic-ai/claude-agent-sdk 0.3.202 per the research doc, but absent
// from the docs page snapshot).

// ── Messages the query() stream yields ───────────────────────────────

/** Anthropic-API content block — loose mirror; we only discriminate on
 *  `type` and read the fields named here. */
export interface SdkContentBlock {
  type: string; // 'text' | 'tool_use' | 'tool_result' | 'thinking' | ...
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface SdkSystemMessage {
  type: 'system';
  subtype: string; // 'init' | ...
  session_id: string;
  [k: string]: unknown;
}

export interface SdkAssistantMessage {
  type: 'assistant';
  session_id: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  message: { role?: string; content: SdkContentBlock[] };
}

export interface SdkUserMessage {
  type: 'user';
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  message: { role: 'user'; content: string | SdkContentBlock[] };
}

/** Raw Anthropic streaming event, forwarded when includePartialMessages
 *  is set. We only consume content_block_delta / text_delta. */
export interface SdkStreamEvent {
  type: 'stream_event';
  session_id: string;
  parent_tool_use_id?: string | null;
  event: {
    type: string; // 'content_block_delta' | 'content_block_start' | ...
    delta?: { type: string; text?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
}

export interface SdkResultMessage {
  type: 'result';
  subtype: string; // 'success' | 'error_max_turns' | 'error_during_execution'
  session_id: string;
  is_error?: boolean;
  result?: string; // final text (success)
  usage?: unknown;
  total_cost_usd?: number;
  [k: string]: unknown;
}

export type SdkMessage =
  | SdkSystemMessage
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkStreamEvent
  | SdkResultMessage;

// ── Permissions ──────────────────────────────────────────────────────

export type SdkPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

/** RECONCILED against the installed .d.ts (0.3.209, wiring 2026-07-14):
 *  the shipped shape is `{behavior: 'allow'|'deny'}` — the docs' newer
 *  `{allow: boolean}` form is NOT what this SDK version exports. `deny`
 *  REQUIRES `message`. `null` declines to decide (default deny). */
export type SdkPermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    toolUseID?: string;
    agentID?: string;
    requestId?: string;
    [k: string]: unknown;
  },
) => Promise<SdkPermissionResult | null>;

// ── query() ──────────────────────────────────────────────────────────

/** Subset of Options this backend sets. The real type has ~50 more
 *  fields; unknown extras are tolerated by the SDK. */
export interface SdkQueryOptions {
  resume?: string;
  cwd?: string;
  model?: string;
  permissionMode?: SdkPermissionMode;
  canUseTool?: SdkCanUseTool;
  mcpServers?: Record<string, SdkMcpServerConfig>;
  includePartialMessages?: boolean;
  abortController?: AbortController;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  maxTurns?: number;
  env?: Record<string, string | undefined>;
  [k: string]: unknown;
}

/** The async-generator handle query() returns. We use the iterator and
 *  interrupt(); the real interface has many more control methods. */
export interface SdkQuery extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>;
  setPermissionMode?(mode: SdkPermissionMode): Promise<void>;
  close?(): void;
}

// ── Session storage functions ────────────────────────────────────────

export interface SdkSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number; // epoch ms
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  createdAt?: number; // epoch ms
}

export interface SdkSessionMessage {
  type: 'user' | 'assistant';
  uuid: string;
  session_id: string;
  message: unknown; // raw API message payload ({role, content})
  parent_tool_use_id?: string | null;
  parent_agent_id?: string | null;
}

// ── SDK-hosted MCP servers (custom tools) ────────────────────────────

export interface SdkToolDefinition {
  name: string;
  description: string;
  /** Real SDK: a Zod raw shape. Kept opaque here; the wiring step passes
   *  actual zod schemas (zod ships with the SDK install). */
  inputSchema: unknown;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<SdkCallToolResult>;
}

export interface SdkCallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

export interface SdkMcpServerConfig {
  type: string; // 'sdk' for in-process servers
  name?: string;
  instance?: unknown;
  [k: string]: unknown;
}

// ── The injectable module surface ────────────────────────────────────

/** Structural interface over the @anthropic-ai/claude-agent-sdk module.
 *  `import * as sdk from '@anthropic-ai/claude-agent-sdk'` satisfies this
 *  at wiring time; tests inject a fake. */
export interface AgentSdk {
  query(params: {
    prompt: string | AsyncIterable<SdkUserMessage>;
    options?: SdkQueryOptions;
  }): SdkQuery;

  listSessions(options?: {
    dir?: string;
    limit?: number;
    includeWorktrees?: boolean;
  }): Promise<SdkSessionInfo[]>;

  getSessionMessages(
    sessionId: string,
    options?: { dir?: string; limit?: number; offset?: number },
  ): Promise<SdkSessionMessage[]>;

  getSessionInfo?(
    sessionId: string,
    options?: { dir?: string },
  ): Promise<SdkSessionInfo | undefined>;

  renameSession(
    sessionId: string,
    title: string,
    options?: { dir?: string },
  ): Promise<void>;

  /** Verified in shipped 0.3.202 (research doc); re-check the .d.ts name
   *  at wiring time. */
  deleteSession(sessionId: string, options?: { dir?: string }): Promise<void>;

  tool(
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<SdkCallToolResult>,
    extras?: { annotations?: Record<string, unknown> },
  ): SdkToolDefinition;

  createSdkMcpServer(options: {
    name: string;
    version?: string;
    tools?: SdkToolDefinition[];
  }): SdkMcpServerConfig;
}
