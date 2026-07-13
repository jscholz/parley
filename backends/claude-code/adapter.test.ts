// Unit tests for the claude-code backend adapter, with the Agent SDK
// faked (sdkTypes.AgentSdk). Run:
//
//   node --experimental-strip-types --test backends/claude-code/*.test.ts
//
// STRIP-ONLY TS: no enums, no constructor parameter properties, no
// namespaces anywhere in this file or its imports — the whole file
// aborts at load otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCodeUpstream } from './adapter.ts';
import { SessionMap } from './sessionMap.ts';
import type {
  AgentSdk,
  SdkMessage,
  SdkPermissionResult,
  SdkQueryOptions,
  SdkSessionInfo,
  SdkSessionMessage,
  SdkToolDefinition,
  SdkUserMessage,
} from './sdkTypes.ts';
import type { ClaudeCodeEnvelope, AgentQuestionEnvelope, DocShowEnvelope } from './envelopes.ts';

// ── SDK message builders ─────────────────────────────────────────────

const SID = 'sess-0001';

function init(sessionId = SID): SdkMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId };
}

function delta(text: string, sessionId = SID): SdkMessage {
  return {
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  };
}

function assistantToolUse(id: string, name: string, input: unknown, sessionId = SID): SdkMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}

function userToolResult(toolUseId: string, text: string, sessionId = SID): SdkMessage {
  return {
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }],
    },
  };
}

function resultMsg(text: string, sessionId = SID): SdkMessage {
  return { type: 'result', subtype: 'success', session_id: sessionId, result: text };
}

// ── Fake SDK ─────────────────────────────────────────────────────────

interface TurnCtx {
  prompt: string | AsyncIterable<SdkUserMessage>;
  options: SdkQueryOptions;
}

type TurnImpl = (ctx: TurnCtx) => AsyncGenerator<SdkMessage, void, void>;

class FakeSdk implements AgentSdk {
  turnImpl: TurnImpl;
  sessions: SdkSessionInfo[] = [];
  sessionMessages: Record<string, SdkSessionMessage[]> = {};
  queryOptions: SdkQueryOptions[] = [];
  deleted: Array<{ sessionId: string; dir?: string }> = [];
  renamed: Array<{ sessionId: string; title: string }> = [];
  interrupted = 0;

  constructor(turnImpl?: TurnImpl) {
    this.turnImpl = turnImpl ?? async function* () {};
  }

  query(params: { prompt: string | AsyncIterable<SdkUserMessage>; options?: SdkQueryOptions }) {
    const options = params.options ?? {};
    this.queryOptions.push(options);
    const gen = this.turnImpl({ prompt: params.prompt, options });
    return {
      [Symbol.asyncIterator]: () => gen,
      interrupt: async () => {
        this.interrupted += 1;
      },
    };
  }

  async listSessions(): Promise<SdkSessionInfo[]> {
    return this.sessions;
  }

  async getSessionMessages(sessionId: string): Promise<SdkSessionMessage[]> {
    return this.sessionMessages[sessionId] ?? [];
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    this.renamed.push({ sessionId, title });
  }

  async deleteSession(sessionId: string, options?: { dir?: string }): Promise<void> {
    this.deleted.push({ sessionId, dir: options?.dir });
    this.sessions = this.sessions.filter((s) => s.sessionId !== sessionId);
  }

  tool(
    name: string,
    description: string,
    inputSchema: unknown,
    handler: SdkToolDefinition['handler'],
  ): SdkToolDefinition {
    return { name, description, inputSchema, handler };
  }

  createSdkMcpServer(options: { name: string; version?: string; tools?: SdkToolDefinition[] }) {
    return { type: 'sdk', name: options.name, instance: { tools: options.tools ?? [] } };
  }
}

function makeAdapter(sdk: FakeSdk, extra: Record<string, unknown> = {}) {
  return new ClaudeCodeUpstream({
    sdk,
    config: { cwd: '/tmp/proj', persistPath: null, ...extra },
  });
}

async function collect(
  iter: AsyncIterable<ClaudeCodeEnvelope>,
  onEnvelope?: (env: ClaudeCodeEnvelope) => void | Promise<void>,
): Promise<ClaudeCodeEnvelope[]> {
  const out: ClaudeCodeEnvelope[] = [];
  for await (const env of iter) {
    out.push(env);
    if (onEnvelope) await onEnvelope(env);
  }
  return out;
}

function types(envs: ClaudeCodeEnvelope[]): string[] {
  return envs.map((e) => e.type);
}

// ── Text turn ────────────────────────────────────────────────────────

test('text turn: user_message → typing → session_changed → cumulative deltas → final', async () => {
  const sdk = new FakeSdk(async function* () {
    yield init();
    yield delta('Hello');
    yield delta(' world');
    yield resultMsg('Hello world');
  });
  const adapter = makeAdapter(sdk);

  const envs = await collect(adapter.sendMessage('chatA', 'hi there', { userMessageId: 'umsg_x' }));

  assert.deepEqual(types(envs), [
    'user_message',
    'typing',
    'session_changed',
    'reply_delta',
    'reply_delta',
    'reply_final',
  ]);

  const [userMsg, , sessionChanged, d1, d2, fin] = envs as Array<Record<string, unknown>>;
  assert.equal(userMsg.message_id, 'umsg_x');
  assert.equal(userMsg.text, 'hi there');
  assert.equal(sessionChanged.session_id, SID);
  assert.equal(sessionChanged.title, 'hi there');

  // Delta protocol: first frame = initial content (no edit), later
  // frames = running total with edit:true — same as HTTPAgentUpstream.
  assert.equal(d1.text, 'Hello');
  assert.equal(d1.edit, undefined);
  assert.equal(d2.text, 'Hello world');
  assert.equal(d2.edit, true);
  assert.equal(d1.message_id, d2.message_id);
  assert.equal(fin.message_id, d1.message_id);
});

test('second turn on the same chat resumes the recorded session in the same cwd', async () => {
  const sdk = new FakeSdk(async function* () {
    yield init();
    yield resultMsg('ok');
  });
  const adapter = makeAdapter(sdk);

  await collect(adapter.sendMessage('chatA', 'first'));
  await collect(adapter.sendMessage('chatA', 'second'));

  assert.equal(sdk.queryOptions.length, 2);
  assert.equal(sdk.queryOptions[0].resume, undefined); // fresh chat
  assert.equal(sdk.queryOptions[1].resume, SID);       // resumed
  assert.equal(sdk.queryOptions[1].cwd, '/tmp/proj');  // cwd rides with the session
});

test('non-streaming result (no deltas) still yields one full reply_delta before final', async () => {
  const sdk = new FakeSdk(async function* () {
    yield init();
    yield resultMsg('full answer');
  });
  const adapter = makeAdapter(sdk);

  const envs = await collect(adapter.sendMessage('chatB', 'q'));
  const deltas = envs.filter((e) => e.type === 'reply_delta') as Array<Record<string, unknown>>;
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].text, 'full answer');
  assert.equal(types(envs).at(-1), 'reply_final');
});

// ── Tool turn ────────────────────────────────────────────────────────

test('tool turn: tool_call and tool_result envelopes with paired ids', async () => {
  const sdk = new FakeSdk(async function* () {
    yield init();
    yield assistantToolUse('toolu_1', 'Bash', { command: 'ls' });
    yield userToolResult('toolu_1', 'file.txt');
    yield delta('Listed one file.');
    yield resultMsg('Listed one file.');
  });
  const adapter = makeAdapter(sdk);

  const envs = await collect(adapter.sendMessage('chatA', 'list files'));
  const call = envs.find((e) => e.type === 'tool_call') as Record<string, unknown>;
  const result = envs.find((e) => e.type === 'tool_result') as Record<string, unknown>;

  assert.ok(call, 'tool_call emitted');
  assert.equal(call.call_id, 'toolu_1');
  assert.equal(call.tool_name, 'Bash');
  assert.deepEqual(call.args, { command: 'ls' });

  assert.ok(result, 'tool_result emitted');
  assert.equal(result.call_id, 'toolu_1');
  assert.equal(result.tool_name, 'Bash'); // name recovered from the tool_use
  assert.equal(result.result, 'file.txt');

  // tool_call must precede tool_result, both inside the turn stream.
  assert.ok(envs.indexOf(call as ClaudeCodeEnvelope) < envs.indexOf(result as ClaudeCodeEnvelope));
});

// ── canUseTool → agent_question round-trip ───────────────────────────

function approvalSdk(record: Array<SdkPermissionResult | null>): FakeSdk {
  return new FakeSdk(async function* (ctx) {
    yield init();
    assert.equal(typeof ctx.options.canUseTool, 'function', 'canUseTool wired');
    const verdict = await ctx.options.canUseTool!(
      'Bash',
      { command: 'rm -rf build' },
      { signal: new AbortController().signal, toolUseID: 'toolu_9', requestId: 'req_1' },
    );
    record.push(verdict);
    if (verdict && verdict.allow) {
      yield delta('ran it');
      yield resultMsg('ran it');
    } else {
      yield delta('skipped it');
      yield resultMsg('skipped it');
    }
  });
}

test('approval round-trip: agent_question mid-turn, answer Allow resolves canUseTool to allow', async () => {
  const verdicts: Array<SdkPermissionResult | null> = [];
  const sdk = approvalSdk(verdicts);
  const adapter = makeAdapter(sdk);

  let question: AgentQuestionEnvelope | null = null;
  const envs = await collect(adapter.sendMessage('chatA', 'clean the build dir'), (env) => {
    if (env.type === 'agent_question') {
      question = env as AgentQuestionEnvelope;
      // The PWA answers via POST /api/sidekick/questions/{id}; the
      // route lands here.
      const resolved = adapter.answerQuestion(question.question_id, 'Allow');
      assert.equal(resolved, true);
    }
  });

  assert.ok(question, 'agent_question emitted');
  const q = question as AgentQuestionEnvelope;
  assert.equal(q.kind, 'approval');
  assert.equal(q.expires_at, null); // sticks until answered
  assert.equal(q.allow_free_text, true);
  assert.deepEqual(q.choices, ['Allow', 'Deny']);
  assert.match(q.question, /Bash/);
  assert.match(q.question, /rm -rf build/);

  assert.deepEqual(verdicts, [{ allow: true }]);
  // The question rode the turn stream BETWEEN typing and the deltas.
  const seq = types(envs);
  assert.ok(seq.indexOf('agent_question') > seq.indexOf('typing'));
  assert.ok(seq.indexOf('agent_question') < seq.indexOf('reply_delta'));
  const lastDelta = envs.filter((e) => e.type === 'reply_delta').at(-1) as Record<string, unknown>;
  assert.equal(lastDelta.text, 'ran it');
});

test('approval round-trip: answer Deny resolves canUseTool to deny', async () => {
  const verdicts: Array<SdkPermissionResult | null> = [];
  const sdk = approvalSdk(verdicts);
  const adapter = makeAdapter(sdk);

  await collect(adapter.sendMessage('chatA', 'clean the build dir'), (env) => {
    if (env.type === 'agent_question') {
      adapter.answerQuestion((env as AgentQuestionEnvelope).question_id, 'Deny');
    }
  });

  assert.equal(verdicts.length, 1);
  assert.deepEqual(verdicts[0], { allow: false, message: 'Denied by user.' });
});

test('free-text answer becomes a deny carrying the text back to the model', async () => {
  const verdicts: Array<SdkPermissionResult | null> = [];
  const sdk = approvalSdk(verdicts);
  const adapter = makeAdapter(sdk);

  await collect(adapter.sendMessage('chatA', 'clean it'), (env) => {
    if (env.type === 'agent_question') {
      adapter.answerQuestion((env as AgentQuestionEnvelope).question_id, 'use /tmp/scratch instead');
    }
  });

  assert.deepEqual(verdicts, [
    { allow: false, message: 'Denied by user: use /tmp/scratch instead' },
  ]);
});

test('answerQuestion on an unknown/lapsed id returns false (route → 404)', () => {
  const adapter = makeAdapter(new FakeSdk());
  assert.equal(adapter.answerQuestion('ccq_nope', 'Allow'), false);
});

test('approvals: "auto" runs with permissionMode and no canUseTool', async () => {
  const sdk = new FakeSdk(async function* () {
    yield init();
    yield resultMsg('done');
  });
  const adapter = makeAdapter(sdk, { approvals: 'auto' });
  await collect(adapter.sendMessage('chatA', 'go'));
  assert.equal(sdk.queryOptions[0].permissionMode, 'acceptEdits');
  assert.equal(sdk.queryOptions[0].canUseTool, undefined);
});

// ── display_doc → doc_show ───────────────────────────────────────────

test('display_doc MCP tool pushes a doc_show envelope into the live turn stream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-doc-'));
  const docPath = join(dir, 'notes.md');
  writeFileSync(docPath, '# Notes\nhello');
  try {
    const sdk = new FakeSdk(async function* (ctx) {
      yield init();
      // Simulate the model calling the injected sidekick.display_doc tool.
      const server = ctx.options.mcpServers?.sidekick as { instance?: { tools: SdkToolDefinition[] } };
      const displayDoc = server?.instance?.tools.find((t) => t.name === 'display_doc');
      assert.ok(displayDoc, 'display_doc registered on the per-turn MCP server');
      const res = await displayDoc!.handler({ path: docPath }, {});
      assert.notEqual(res.isError, true);
      yield delta('Opened the doc.');
      yield resultMsg('Opened the doc.');
    });
    const adapter = makeAdapter(sdk);

    const envs = await collect(adapter.sendMessage('chatA', 'show me the notes'));
    const doc = envs.find((e) => e.type === 'doc_show') as DocShowEnvelope | undefined;
    assert.ok(doc, 'doc_show emitted');
    assert.equal(doc!.chat_id, 'chatA');
    assert.equal(doc!.title, 'notes.md');
    assert.equal(doc!.format, 'markdown');
    assert.equal(doc!.content, '# Notes\nhello');
    assert.equal(typeof doc!.doc_id, 'string');
    // Rode the stream before the reply settled.
    assert.ok(types(envs).indexOf('doc_show') < types(envs).indexOf('reply_final'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Conversations API mapping ────────────────────────────────────────

test('listConversations maps SDK sessions to drawer rows; unmapped sessions get cc: ids', async () => {
  const sdk = new FakeSdk(async function* () {
    yield init('sess-mapped');
    yield resultMsg('ok', 'sess-mapped');
  });
  const adapter = makeAdapter(sdk);
  await collect(adapter.sendMessage('chatA', 'map me')); // binds chatA → sess-mapped

  sdk.sessions = [
    {
      sessionId: 'sess-mapped',
      summary: 'sdk summary',
      lastModified: 1_700_000_100_000,
      createdAt: 1_700_000_000_000,
      firstPrompt: 'map me',
    },
    {
      sessionId: 'sess-foreign',
      summary: 'started from the CLI',
      lastModified: 1_700_000_200_000,
      firstPrompt: 'cli prompt',
    },
  ];

  const rows = await adapter.listConversations();
  assert.equal(rows.length, 2);
  // Sorted most-recent-first.
  assert.equal(rows[0].id, 'cc:sess-foreign');
  assert.equal(rows[0].metadata.title, 'started from the CLI');
  assert.equal(rows[0].metadata.first_user_message, 'cli prompt');
  assert.equal(rows[1].id, 'chatA');
  assert.equal(rows[1].metadata.title, 'map me'); // sidekick-derived title wins
  assert.equal(rows[1].metadata.session_ids, 'sess-mapped');
  assert.equal(rows[1].created_at, 1_700_000_000);
  assert.equal(rows[1].object, 'conversation');
});

test('deleteConversation deletes the SDK session and drops the mapping', async () => {
  const sdk = new FakeSdk(async function* () {
    yield init('sess-del');
    yield resultMsg('ok', 'sess-del');
  });
  const adapter = makeAdapter(sdk);
  await collect(adapter.sendMessage('chatDel', 'x'));
  sdk.sessions = [{ sessionId: 'sess-del', summary: 's', lastModified: 1 }];

  await adapter.deleteConversation('chatDel');
  assert.deepEqual(sdk.deleted, [{ sessionId: 'sess-del', dir: '/tmp/proj' }]);
  assert.equal((await adapter.listConversations()).length, 0);
  // A later turn on the same chat starts a fresh session (no resume).
  await collect(adapter.sendMessage('chatDel', 'again'));
  assert.equal(sdk.queryOptions.at(-1)!.resume, undefined);
});

test('deleteConversation on an unknown chat is a no-op (idempotent)', async () => {
  const adapter = makeAdapter(new FakeSdk());
  await adapter.deleteConversation('never-seen');
});

test('getMessages maps SDK transcript rows to ConversationItems (text, tool_calls, tool rows)', async () => {
  const sdk = new FakeSdk(async function* () {
    yield init('sess-hist');
    yield resultMsg('ok', 'sess-hist');
  });
  const adapter = makeAdapter(sdk);
  await collect(adapter.sendMessage('chatH', 'seed'));

  sdk.sessionMessages['sess-hist'] = [
    {
      type: 'user',
      uuid: 'u1',
      session_id: 'sess-hist',
      message: { role: 'user', content: 'run the tests' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      session_id: 'sess-hist',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running them now.' },
          { type: 'tool_use', id: 'toolu_5', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      session_id: 'sess-hist',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_5', content: '10 passed' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'a2',
      session_id: 'sess-hist',
      message: { role: 'assistant', content: [{ type: 'text', text: 'All green.' }] },
    },
  ];

  const page = await adapter.getMessages('chatH');
  assert.equal(page.items.length, 4);
  assert.deepEqual(page.items.map((i) => i.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(page.items[0].content, 'run the tests');
  assert.equal(page.items[1].content, 'Running them now.');
  const toolCalls = JSON.parse(page.items[1].tool_calls as string);
  assert.equal(toolCalls[0].function.name, 'Bash');
  assert.equal(page.items[2].tool_call_id, 'toolu_5');
  assert.equal(page.items[2].tool_name, 'Bash');
  assert.equal(page.items[2].content, '10 passed');
  assert.equal(page.first_id, 1);
  assert.equal(page.has_more, false);
  assert.deepEqual(page.inflight, []);

  // before/limit windowing pages backwards.
  const older = await adapter.getMessages('chatH', { limit: 2, before: 4 });
  assert.deepEqual(older.items.map((i) => i.id), [2, 3]);
  assert.equal(older.has_more, true);
});

test('getMessages for an unknown chat returns the empty shape', async () => {
  const adapter = makeAdapter(new FakeSdk());
  const page = await adapter.getMessages('nope');
  assert.deepEqual(page, { items: [], first_id: null, has_more: false, inflight: [] });
});

// ── Barge-in / abort ─────────────────────────────────────────────────

test('abort signal interrupts the SDK query and settles the streaming bubble', async () => {
  const ctrl = new AbortController();
  const sdk = new FakeSdk(async function* () {
    yield init();
    yield delta('partial ans');
    ctrl.abort(); // user barged in mid-stream
    // Real SDK ends the stream shortly after interrupt(); the fake just stops.
  });
  const adapter = makeAdapter(sdk);

  const envs = await collect(adapter.sendMessage('chatA', 'long task', { signal: ctrl.signal }));
  assert.equal(sdk.interrupted, 1);
  // No result message arrived, but the bubble still gets a reply_final.
  assert.equal(types(envs).at(-1), 'reply_final');
});

// ── Misc contract surface ────────────────────────────────────────────

test('optional extensions return null / ok per the upstream contract', async () => {
  const adapter = makeAdapter(new FakeSdk());
  assert.equal(await adapter.listGatewayConversations(), null);
  assert.equal(await adapter.getSettingsSchema(), null);
  assert.equal(await adapter.listCommands(), null);
  assert.equal(await adapter.searchConversations(), null);
  assert.deepEqual(await adapter.healthcheck(), { ok: true });
});

test('renameConversation renames via the SDK and emits session_changed on the events channel', async () => {
  const sdk = new FakeSdk(async function* () {
    yield init('sess-ren');
    yield resultMsg('ok', 'sess-ren');
  });
  const adapter = makeAdapter(sdk);
  await collect(adapter.sendMessage('chatR', 'seed'));

  const ctrl = new AbortController();
  const received: Array<{ id: number; envelope: ClaudeCodeEnvelope }> = [];
  const sub = (async () => {
    for await (const rec of adapter.subscribeEvents({ signal: ctrl.signal })) {
      received.push(rec);
      break;
    }
  })();

  const res = await adapter.renameConversation('chatR', '  My repo chat ');
  assert.equal(res.title, 'My repo chat');
  assert.deepEqual(sdk.renamed, [{ sessionId: 'sess-ren', title: 'My repo chat' }]);

  await sub;
  ctrl.abort();
  assert.equal(received.length, 1);
  assert.equal(received[0].envelope.type, 'session_changed');
});

test('cwd allowlist rejects a cwd outside the configured prefixes', () => {
  assert.throws(
    () =>
      new ClaudeCodeUpstream({
        sdk: new FakeSdk(),
        config: { cwd: '/etc', cwdAllowlist: ['/home/user/code'], persistPath: null },
      }),
    /allowlist/,
  );
});

test('attachments are rejected with an error envelope (v1 contract)', async () => {
  const adapter = makeAdapter(new FakeSdk());
  const envs = await collect(
    adapter.sendMessage('chatA', 'look at this', { attachments: [{ kind: 'image' }] }),
  );
  assert.deepEqual(types(envs), ['error']);
});

// ── SessionMap persistence ───────────────────────────────────────────

test('SessionMap persists chat→{sessionId,cwd} across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-map-'));
  const path = join(dir, 'sessions.json');
  try {
    const a = new SessionMap(path);
    a.ensure('chatA', '/tmp/proj', 123);
    a.setSession('chatA', 'sess-42');
    a.setTitle('chatA', 'Hello');

    const b = new SessionMap(path); // fresh instance = simulated restart
    const entry = b.get('chatA');
    assert.ok(entry);
    assert.equal(entry!.sessionId, 'sess-42');
    assert.equal(entry!.cwd, '/tmp/proj');
    assert.equal(entry!.title, 'Hello');
    assert.equal(b.chatIdForSession('sess-42'), 'chatA');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionMap tolerates a corrupt persist file (starts empty, does not throw)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-map-'));
  const path = join(dir, 'sessions.json');
  try {
    writeFileSync(path, '{not json');
    const m = new SessionMap(path);
    assert.equal(m.entries().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
