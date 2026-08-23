# backends/claude-code — Claude Code as a parley backend (v1 skeleton)

Runs your existing Claude Code install as a parley agent via the
**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — no forks, no CLI
scraping, no protocol changes. Design per
`parley-claude-code-backend-research-2026-07-07.md` (hermes-agent-private
workspace docs).

**Status: standalone module + unit tests.** Compiles (strict tsc) and is
fully unit-tested against a faked SDK. NOT yet wired into the live proxy and
not yet run against the real SDK — see "Wiring plan" below for the exact
steps and files that touches.

## Architecture

```
PWA ──POST /api/parley/messages──▶ proxy dispatch (messages.ts)
                                        │ upstream.sendMessage(chatId, text)
                                        ▼
                        ClaudeCodeUpstream (adapter.ts)  ← in-process, no /v1 HTTP hop
                          │  sdk.query({ prompt: AsyncIterable, options })
                          ▼
                 @anthropic-ai/claude-agent-sdk  (manages the claude CLI subprocess)
                          │
                 ~/.claude/projects/<encoded-cwd>/<session>.jsonl  (session storage)
```

Unlike `backends/hermes` (HTTP `/v1/*` plugin) and `backends/stub` (HTTP
`/v1/*` server), this backend implements the proxy's **TypeScript upstream
contract directly** (`proxy/parley/upstream.ts` → `UpstreamAgent`):
`sendMessage` is an async generator of parley envelopes, so there is no
OAI-SSE translation layer at all. The proxy's dispatch (`messages.ts`),
stream multiplexer (`stream.ts`), and drawer/history handlers work unchanged.

### Module map

| File | Role |
|---|---|
| `adapter.ts` | `ClaudeCodeUpstream` — the upstream contract over the SDK; turn pipeline, envelope translation, conversations API |
| `sdkTypes.ts` | Structural mirror of the Agent SDK surface we consume + the injectable `AgentSdk` interface (tests fake it, wiring injects the real module) |
| `envelopes.ts` | Envelope types: re-exports the proxy's `ParleyEnvelope` union (type-only import — zero runtime coupling) + local `agent_question` / `doc_show` definitions; `docIdFor` (djb2, PWA-compatible) |
| `sessionMap.ts` | Persisted `chat_id → {sessionId, cwd}` map (JSON file, tmp+rename) |
| `questions.ts` | Pending-question registry: `canUseTool` ↔ `agent_question` ↔ `answerQuestion` |
| `docShim.ts` | Per-turn in-process MCP server exposing `display_doc` → `doc_show` envelope |
| `asyncQueue.ts` | Unbounded async queue — lets side channels (approvals, docs) interleave into the turn stream |
| `adapter.test.ts` | node:test suite, SDK faked (22 tests) |

### Session mapping (conversation key ↔ SDK session)

- A parley `chat_id` maps to the **pair** `{sessionId, cwd}`, persisted in
  a JSON file (`SessionMap`). Both halves matter: SDK session lookup is
  cwd-scoped, and resuming with a mismatched cwd silently forks a fresh
  session (claude-agent-sdk-python#555, claude-code#4926). Persistence
  avoids the precedent wrapper's restart-loses-sessions failure.
- First turn of a chat runs `query()` without `resume`; the `system/init`
  message's `session_id` is captured, stored, and announced via a
  `session_changed` envelope (title = first user message, truncated).
  Subsequent turns pass `resume: sessionId` with the same `cwd`.
- Sessions that exist on disk but were never started from parley (i.e.
  created by the CLI directly) appear in the drawer as `cc:<sessionId>` rows;
  opening one adopts it into the map and resumes it in place.

### Turn pipeline (sendMessage)

Streaming-input mode, per-turn `query()` + `resume` (never one-shot `-p`):

1. Emit `user_message` (cross-device bubble, PWA-minted id honored) and
   `typing`.
2. `sdk.query({ prompt: <AsyncIterable with one user message>, options })`
   with `includePartialMessages: true`; a pump translates SDK messages into
   envelopes on an internal `AsyncQueue` that the generator drains. Side
   channels (`canUseTool`, `display_doc`) push into the **same queue**, so
   `agent_question` / `doc_show` interleave into the live turn stream in
   order.
3. Translation: `stream_event` text deltas → `reply_delta` (first frame =
   initial content, later frames = running total with `edit: true` — the
   exact protocol `HTTPAgentUpstream` emits); assistant `tool_use` blocks →
   `tool_call`; user `tool_result` blocks → `tool_result` (tool name
   recovered from the pairing id); `result` → `reply_final` (with a
   full-text `reply_delta` fallback when no deltas streamed). Subagent
   traffic (`parent_tool_use_id` set) is filtered out in v1.
4. **Barge-in:** the dispatch `AbortSignal` maps to `query.interrupt()`; an
   interrupted turn still settles its streaming bubble with `reply_final`.

### Approvals (canUseTool → agent_question)

Default config runs `permissionMode: 'default'` + a `canUseTool` callback
(the headless default would otherwise *abort* the run on any unapproved
tool). The callback:

1. mints an `agent_question` envelope — `kind: 'approval'`,
   `choices: ['Allow', 'Deny']`, `allow_free_text: true`,
   `expires_at: null` (the SDK pauses indefinitely; the pop-up sticks until
   answered) — and pushes it into the live turn stream;
2. parks a promise in `QuestionRegistry`;
3. the PWA answers via `POST /api/parley/questions/{question_id}` →
   `ClaudeCodeUpstream.answerQuestion(id, response)` resolves it:
   allow-keywords → `{allow: true}`; "Deny"/deny-keywords →
   `{allow: false, message: 'Denied by user.'}`; any other free text →
   deny with that text as the message (deny-with-instructions, rides back
   to the model);
4. unknown/lapsed ids return `false` → route answers 404, PWA renders
   "question lapsed" (same semantics as hermes `/v1/questions/{id}`);
5. turn end/abort cancels parked questions (resolve → deny) so the SDK
   never hangs on an unanswerable prompt.

Set `approvals: 'auto'` to skip the round-trip and run with
`permissionMode` (default `acceptEdits` — the sane call-mode default on
your own machine).

### display_doc → doc_show

`docShim.ts` builds a tiny in-process MCP server (`parley.display_doc`)
**per turn**, closing over that turn's `chat_id` + queue — which is how a
tool call attributes itself to the right chat under concurrent turns. The
handler reads the file server-side (1 MB cap), pushes a `doc_show`
envelope (format by suffix, `doc_id` = djb2 of path — mirrors the PWA's
`docStore.docIdFor` and the hermes plugin), and returns a success payload
to the model. Cheap enough that it shipped in v1 rather than v1.1.

### Conversations API

| Upstream method | SDK primitive |
|---|---|
| `listConversations` | `listSessions({dir: cwd})` → drawer rows (mapped chat id or `cc:<sessionId>`) |
| `getMessages` | `getSessionMessages(sessionId, {dir})` → OAI `ConversationItem`s: assistant `tool_use` → serialized `tool_calls` extension, `tool_result` → `role:'tool'` rows with `tool_call_id`/`tool_name` — same shapes the PWA's history rebuild consumes from hermes. `before`/`limit` windowing over index ids |
| `deleteConversation` | `deleteSession` + map removal (idempotent) |
| `renameConversation` | `renameSession` + `session_changed` on the events channel |
| `subscribeEvents` | in-process ring (cap 128) + subscriber queues, `lastEventId` replay |
| `listGatewayConversations` / `getSettingsSchema` / `listCommands` / `searchConversations` | `null` — proxy falls back / hides the affected UI |

## Config

```ts
new ClaudeCodeUpstream({
  sdk,                                   // the @anthropic-ai/claude-agent-sdk module
  config: {
    cwd: '/home/me/code/myproject',      // project dir; chats pin to it for life
    cwdAllowlist: ['/home/me/code'],     // optional guard for future per-chat cwds
    model: 'claude-sonnet-5',            // optional; omit = account default
    approvals: 'remote',                 // 'remote' (canUseTool→PWA) | 'auto' (permissionMode)
    permissionMode: 'acceptEdits',       // used when approvals === 'auto'
    persistPath: '~/.parley/claude-code-sessions.json', // chat→session map
    maxTurns: 80,                        // optional safety valve
  },
});
```

## What works in v1 vs deferred

**v1 (this skeleton, unit-tested):** text turns with streaming deltas;
tool_call/tool_result visibility; session create/resume/persist;
list/items/delete/rename over SDK session storage; canUseTool approvals
round-trip (allow / deny / free-text deny); display_doc → doc_show;
barge-in via interrupt; cwd allowlist validation.

**Deferred (v1.1+):**
- **Real-SDK integration pass** — the SDK is faked in tests; first wiring
  session must verify `PermissionResult` shape (`{allow}` vs older
  `{behavior}`), `deleteSession` naming, and stream_event field fidelity
  against the installed package.
- **Attachments** (images) — v1 rejects with an error envelope; streaming
  input supports images, straightforward v2.
- **Long-lived query per chat** (in-process message queueing instead of
  per-turn resume) — per-turn resume is simpler and loses only mid-turn
  input queueing.
- **Inflight replay buffer** (`getMessages().inflight`) — mid-turn
  reconnect currently misses the streaming bubble until reply_final.
- **message_count / turn_count** in drawer rows (needs a transcript read
  per row).
- **Slash-command catalog** via `Query.supportedCommands()`.
- **Per-chat cwd selection** (allowlist is already enforced).
- **Multi-cwd session listing** (v1 lists the configured cwd only).
- **conversation_deleted / unread / pins / activity extensions** — those
  are plugin-HTTP endpoints (`/v1/unread`, `/v1/pins`, …) the proxy's
  delegate forwards to `UPSTREAM_URL`; with an in-process upstream they'll
  report unavailable and the PWA degrades gracefully. Deciding whether to
  give this backend a small HTTP shell for them is a wiring-time call.
- **Usage/cost surfacing** from ResultMessage.

## Wiring plan (exactly what the integration step touches)

Nothing here is wired yet. The steps, in order:

1. **Install the real SDK** (the one intentionally-deferred dependency):
   `npm install @anthropic-ai/claude-agent-sdk zod` (zod backs the
   `display_doc` input schema — replace `DISPLAY_DOC_INPUT_SCHEMA` in
   `docShim.ts` with `{ path: z.string(), title: z.string().optional() }`).
   Then reconcile `sdkTypes.ts` against the installed `.d.ts` (keep the
   `AgentSdk` indirection so tests stay SDK-free).
2. **`proxy/parley/upstream.ts`** — add `agent_question` and `doc_show`
   to the `ParleyEnvelope` union (runtime allowlist in `stream.ts`
   already carries both); delete the local copies in `envelopes.ts`.
3. **`proxy/parley/index.ts`** — `init()` grows a backend switch: when
   config selects claude-code (e.g. `backend: claude-code` in
   `parley.config.yaml` / `PARLEY_BACKEND=claude-code` + a
   `claude_code:` config block), construct
   `new ClaudeCodeUpstream({sdk: await import('@anthropic-ai/claude-agent-sdk'), config}).asUpstreamAgent()`
   instead of `HTTPAgentUpstream`.
4. **Question-answer route** — `server.ts` routes
   `POST /api/parley/questions/{id}` to
   `delegate.delegateQuestionAnswer`, which forwards to the plugin's
   `/v1/questions/{id}` over HTTP. Add a branch: if the active upstream
   exposes `answerQuestion` (this backend), call it directly and map
   `false → 404 {error: 'no pending question with that id'}`,
   `true → 200 {ok: true}`.
5. **Config plumbing** — teach the config loader the `claude_code` block
   (cwd, allowlist, model, approvals, persistPath) and document it in
   `example.parley.config.yaml`.
6. **Smoke** — live end-to-end pass against the real CLI: text turn, tool
   turn with an approval on a phone, doc push, barge-in in call mode.

## Running the tests

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  --test backends/claude-code/*.test.ts
```

22 tests; strip-only TS throughout (no enums, no parameter properties —
the test file dies at load otherwise).
