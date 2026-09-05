# Abstract Agent Protocol

This document defines the contract that any agent backend must satisfy
to plug into parley. Parley (the PWA + proxy + audio bridge) is
agent-agnostic; it talks to a single endpoint:

    POST /v1/responses

Implementers include:

- **hermes-agent** — the reference implementation
  (`gateway/platforms/api_server.py:_handle_responses`).
- **openclaw** — historic, may return after a stability pass.
- **Third-party backends** — implementers reading only this document.

The protocol is OpenAI-compatible (a strict subset of the OpenAI
Responses API) so existing tooling slots in without translation. There
is **no mention** of WebRTC, Deepgram, parley UX behavior, or
microphone audio in this contract. Agents are pure text-in / text-out.

---

## Endpoint

```
POST /v1/responses
Content-Type: application/json
Authorization: Bearer <token>     (optional)
```

### Request body

| Field                    | Type             | Required | Description |
| ------------------------ | ---------------- | -------- | ----------- |
| `input`                  | `string \| array` | yes     | The user message. String for one-shot; array of `{role, content}` objects for explicit prompting. Parley sends a string. |
| `conversation`           | `string`         | no       | Stable session key. The backend MUST honor this as a chaining identifier — repeated calls with the same `conversation` continue the same logical thread, with prior turns visible to the agent. Parley uses `parley-<slug>` names (e.g. `parley-example-2026-04-26`). |
| `stream`                 | `boolean`        | no       | Default `false`. When `true`, the response is an SSE stream (see below). When `false`, the response is a single JSON object. Parley sends `true` for live conversation. |
| `previous_response_id`   | `string`         | no       | Alternative chaining mechanism — pass the `id` of the previous response. **Mutually exclusive with `conversation`.** |
| `instructions`           | `string`         | no       | System-prompt override for this turn. Parley does not currently send this. |
| `attachments`            | `array`          | no       | Optional inline attachments. **Backends that don't support attachments MUST return a 400 with a clear error message rather than silently dropping them.** Parley sends image / file attachments here when present. |
| `store`                  | `boolean`        | no       | Default `true`. When `true`, the backend persists the response for later GET / chaining. Backends that don't persist responses can ignore this. |

### Response — non-streaming (`stream: false`)

```json
{
  "id": "resp_<24 hex chars>",
  "object": "response",
  "status": "completed",
  "created_at": 1777203774,
  "model": "<implementation-defined>",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        { "type": "output_text", "text": "Hello, world!" }
      ]
    }
  ],
  "usage": {
    "input_tokens": 14587,
    "output_tokens": 5,
    "total_tokens": 14592
  }
}
```

The shape is OpenAI Responses API compatible. Tool-call items
(`{type: "function_call", ...}`) MAY appear in `output` for backends
that support tool use; parley renders them but does not require them.

### Response — streaming (`stream: true`)

`Content-Type: text/event-stream`. Frames follow the SSE convention:

```
event: <event-name>
data: <single-line JSON>

event: <event-name>
data: <single-line JSON>
```

#### Required events

| Event                        | When                        | Notes |
| ---------------------------- | --------------------------- | ----- |
| `response.output_text.delta` | Each text chunk             | `{type, item_id, output_index, content_index, delta, logprobs?}` — parley concatenates `delta`s into the visible reply. |
| `response.completed`         | Terminal event              | `{type, response: <full envelope as in non-streaming response>}`. **Backends MUST emit this exactly once at end-of-stream.** Parley / the audio bridge use it to end the assistant streaming bubble; absence yields a permanent thinking-cursor. |

#### Optional events

OpenAI-compatible backends may also emit `response.created`,
`response.in_progress`, `response.output_item.added`,
`response.output_text.done`, `response.output_item.done`, and the
function-call equivalents. Parley is tolerant of additional event
types and ignores any it doesn't render.

---

## Conversation chaining

A `conversation` name (e.g. `parley-example-2026-04-26`) is a stable
identifier for a multi-turn thread. The backend SHOULD:

1. On the first POST with a given `conversation`, treat it as a fresh
   thread.
2. Persist the response under that conversation.
3. On subsequent POSTs with the same `conversation`, prepend the prior
   thread's history to the LLM context.

`previous_response_id` is an alternative for stateless callers; pass
the `id` returned by the previous turn. The two mechanisms are
mutually exclusive — backends MUST return a 400 if both are supplied.

---

## Auth

A `Bearer <token>` header is optional; backends MAY require it.
Parley injects the configured token from its proxy when one is set.
The bridge does not authenticate to the agent directly — it goes
through the proxy and the proxy adds the token.

---

## Conversation lifecycle endpoints

The following endpoints exist alongside `POST /v1/responses` so a
parley deployment can populate its drawer (chat list), replay
transcripts on resume, and delete chats. Backends that don't
implement them MUST return `404` consistently — parley degrades
gracefully (drawer becomes IDB-cached only, deletes become local-
only). Backends that implement them MUST cascade through any
ancillary stores they own (hindsight memory, transcript jsonl,
search index) so a delete is durable across the whole agent.

The shape mirrors a subset of the OpenAI Conversations API. Field
names are normative; parley parses them by name.

### `GET /v1/conversations`

Returns the agent's list of conversations sorted most-recent-first.

**Query parameters:**

| Field   | Type    | Required | Description |
| ------- | ------- | -------- | ----------- |
| `limit` | integer | no       | 1..200, default 50. |

**Response (200):**

```json
{
  "object": "list",
  "data": [
    {
      "id": "<opaque conversation id>",
      "object": "conversation",
      "created_at": 1777203774,
      "metadata": {
        "title": "Trip planning",
        "message_count": 14,
        "last_active_at": 1777290174,
        "first_user_message": "let's plan the trip..."
      }
    }
  ]
}
```

**Field semantics in `metadata`:**

- `title` — human-readable label. Empty string is allowed; parley
  falls back to `first_user_message` for display.
- `message_count` — visible message count (excluding internal context-
  compaction rows). Zero for empty conversations.
- `last_active_at` — UNIX seconds of the most recent message. Drives
  the drawer sort order.
- `first_user_message` — first user-role message text, truncated to
  ≤ 80 chars. Optional. Parley uses this when `title` is empty.

`id` is opaque to parley; the backend MAY use the same value as the
`conversation` parameter passed to `POST /v1/responses`, or it MAY
mint distinct ids. Parley stores this verbatim for use on
subsequent `/v1/conversations/{id}/items` and `DELETE` calls.

`object: "conversation"` is informational; parley doesn't validate
the field but it SHOULD be present for OpenAI compatibility.

### `GET /v1/conversations/{id}/items`

Returns the message transcript for a conversation, oldest-first. Used
on resume to repaint the chat surface from server state.

**Path parameter:**

- `id` — the conversation id (URL-encoded if it contains special chars).

**Query parameters:**

| Field      | Type    | Required | Description |
| ---------- | ------- | -------- | ----------- |
| `limit`    | integer | no       | 1..500, default 200. |
| `before`   | string  | no       | Cursor for pagination — return items strictly before this id. Used by load-earlier on long transcripts. |

**Response (200):**

```json
{
  "object": "list",
  "data": [
    {
      "id": "msg_<opaque>",
      "object": "message",
      "role": "user" | "assistant" | "system",
      "content": "...",
      "created_at": 1777203774
    }
  ],
  "first_id": "msg_<opaque>",
  "has_more": false
}
```

`first_id` is the id of the oldest item in `data` (used for the next
`?before=` cursor). `has_more` is true when older items exist.

`content` is plain string for the simple case. The OpenAI Responses
API also supports a structured `content: [{type, text}]` shape; parley
accepts both — backends MAY emit either. For tool-call items the
content shape follows the same structure as the `output` array in
`response.completed` (see `POST /v1/responses` above).

Backends that compress or fork conversations (e.g. context-window
rotation) MUST traverse the fork chain server-side and return the
flattened, replayable transcript here. Parley does not walk forks.

**404** — unknown conversation id.

### `DELETE /v1/conversations/{id}`

Hard-delete a conversation and all data the agent stores against it.

**Required cascade:** the backend MUST delete:

1. The conversation row + transcript items.
2. Any external memory the agent has retained from this conversation
   (e.g. embeddings in a vector store, summarization caches).
3. Any filesystem artifacts (jsonl transcripts, etc.) keyed by this
   conversation id.

This is non-negotiable for privacy: parley exposes "Delete chat"
as a user-facing affordance and the user reasonably expects the
agent to forget. A delete that leaves memory traces is a privacy bug.

**Response (200):**

```json
{ "ok": true }
```

**Error responses:**

- `404` — unknown conversation id.
- `500` — partial failure (some cascade steps succeeded, some didn't).
  The response body SHOULD include an `error.message` describing
  which steps failed. Parley treats 500 as "do not remove the
  drawer entry" so the user can retry.

---

## Optional gateway extension — `/v1/gateway/*`

A second contract layered on top of the channel contract above.
Implementing it makes an agent a "gateway" — its state spans
multiple platforms and parley should surface them in a single
drawer with per-row source badges.

The extension is **strictly optional**. Single-channel agents leave
it unimplemented; parley probes, gets 404, and falls back to
`GET /v1/conversations` with `source: "parley"` stamped on each
row. Other failure codes propagate (transient outages must not
silently degrade the drawer to channel-only).

The namespace prefix `/v1/gateway/*` is reserved for this contract
so future gateway-shaped capabilities (e.g. `GET /v1/gateway/sources`,
cross-source delete) have a documented home and don't scatter as
optional flags on the channel endpoints. Parley squats on the
prefix; OAI doesn't use it.

### `GET /v1/gateway/conversations`

Cross-platform drawer list. Same OAI row shape as
`GET /v1/conversations`, plus `metadata.source` and
`metadata.chat_type`:

```json
{
  "object": "list",
  "data": [
    {
      "id": "telegram:1000000001",
      "object": "conversation",
      "created_at": 1777290174,
      "metadata": {
        "title": "Trip planning",
        "message_count": 14,
        "last_active_at": 1777290174,
        "first_user_message": "let's plan the trip...",
        "source": "telegram",
        "chat_type": "dm",
        "native_chat_id": "1000000001"
      }
    }
  ]
}
```

**Required `metadata` fields:** `source` (lowercase string —
`parley`, `telegram`, `slack`, `whatsapp`, etc.), `chat_type`
(`dm`, `group`, agent-defined). All other fields match
`/v1/conversations`.

**Query params:** `limit` (1..200, default 50). Most-recent-first
ordering required.

**Cross-platform send is NOT part of this extension.** Parley's
composer goes read-only when `source !== 'parley'`. Agents that
want bidirectional cross-platform messaging would extend further
(future: `POST /v1/gateway/responses?source=...`).

#### Multi-identity rule for `id` (CRITICAL for plugin authors)

`ConversationSummary.id` is **globally unique** — that's the contract
parley consumes. The drawer keys per-row state on it, click
handling assumes one LI per `id`, and resume/delete URLs route by it.

When a backend natively keys sessions on a compound `(source,
native_chat_id)` (multi-channel gateways: hermes, openclaw, anything
that aggregates Slack + Telegram + WhatsApp + … under one agent),
**plugins MUST encode the compound into the contract's `id`**.
Convention:

```
id = "${source}:${native_chat_id}"
```

Surface the platform-native identifier separately as
`metadata.native_chat_id` so clients that need to display or
correlate it (badges, debug overlays) still have access. Per-chat
URL handlers (`/v1/conversations/{id}/items`, DELETE, send dispatch)
decode the prefix server-side to disambiguate source.

**Why this matters:** when the same `native_chat_id` appears under
two sources (e.g. a parley test session whose chat_id happens to
collide with a WhatsApp `@lid`), exposing `id := native_chat_id`
silently violates uniqueness. The drawer renders two LIs sharing
`data-chat-id`, click activates both, and history fetch — having
nothing else to disambiguate by — picks one source arbitrarily and
returns the wrong session's content. Single-platform backends
(stub, openai-compat third-parties) where source is constant get
the same encoding for free; the prefix is a no-op disambiguator.

The reference plugin (`backends/hermes/plugin/__init__.py`,
`_format_gateway_id` / `_parse_gateway_id`) shows the pattern.
Frontend treats `id` as opaque, so plugins can change the encoding
later (e.g. introduce a separator escape) without a frontend change.

---

## Optional settings extension — `/v1/settings/*`

Lets the agent declare its own user-facing knobs and have parley
render them generically in the Settings panel. Replaces the
pre-refactor pattern of hardcoding agent-owned options (e.g. the
model picker) into the PWA — which made every cross-agent setting
a frontend change.

The extension is **strictly optional**. Agents that don't expose
settings return 404 on the schema endpoint; the PWA hides the
"Agent" settings group. Single-purpose agents (the in-tree stub)
typically leave it unimplemented or return an empty list.

Settings owned by the PWA itself (theme, hotkeys, mic device, TTS
voice) stay in the local UI and are NOT part of this contract —
the schema is for **agent-owned** settings only.

### `GET /v1/settings/schema`

Lists the settings the agent supports. The PWA fetches this when
the Settings panel opens (and on close, to surface drift caused
by other clients changing the same agent state).

**Response (200):**

```json
{
  "object": "list",
  "data": [
    {
      "id": "model",
      "label": "Model",
      "description": "LLM used for replies",
      "category": "Agent",
      "type": "enum",
      "value": "anthropic/claude-opus-4-6",
      "options": [
        { "value": "anthropic/claude-opus-4-6", "label": "Claude Opus 4.6" },
        { "value": "google/gemini-3-flash-preview", "label": "Gemini 3 Flash" }
      ]
    }
  ]
}
```

**Setting fields:**

- `id` (string, required) — opaque identifier, also the URL fragment
  on the write endpoint. `[a-z0-9_]+` recommended.
- `label` (string, required) — short user-facing label (`"Model"`).
- `description` (string, optional) — hint text rendered next to /
  beneath the input.
- `category` (string, optional) — group key for the UI. Defaults to
  `"Agent"`. Same string across multiple settings groups them.
- `type` (string, required) — one of:
  - `enum` — dropdown. `options[]` required.
  - `slider` — numeric range. `min`, `max`, `step` required.
  - `toggle` — boolean.
  - `text` — free-form string.
  - `string-list` — list of free-form strings (chip UI). The PWA
    POSTs the entire updated list on each add/remove.
- `value` — current value. Type matches `type`: string for
  `enum`/`text`, number for `slider`, boolean for `toggle`,
  `string[]` for `string-list`.
- `options[]` (enum only, required) — `{value, label, description?}`.
- `min`, `max`, `step` (slider only, required).
- `placeholder` (text/string-list only, optional) — hint text in
  the input box.

**Response (404):** Agent doesn't implement the extension. Parley
hides the "Agent" settings group entirely.

### `POST /v1/settings/{id}`

Update one setting. Body is `{"value": <new>}` matching the
declared `type`.

**Request:**

```json
{ "value": "anthropic/claude-opus-4-6" }
```

**Response (200):** the updated `SettingDef` (same shape as one
entry in `GET /v1/settings/schema`'s `data[]`). Returning the full
def lets the agent surface side-effects — e.g. setting a model that
caps `max_tokens` lower than its current value can return a
secondary `max_tokens` setting in a follow-up panel refresh.

```json
{
  "id": "model",
  "label": "Model",
  "type": "enum",
  "value": "anthropic/claude-opus-4-6",
  "options": [...]
}
```

**Error responses:**

- `400` — value doesn't match the declared `type` (e.g. string sent
  to a slider, value not in `options[]` for an enum).
- `404` — unknown setting id.
- `500` — server-side failure applying the change. The PWA reverts
  the optimistic UI state and surfaces the error.

**Idempotency:** same value re-submitted is a no-op (still 200).

**Validation is the agent's job.** The proxy forwards verbatim; if
the agent doesn't validate, malformed values land in agent state.

---

## Optional scheduled-jobs extension — `/v1/jobs/*`

Lets an agent that runs scheduled work (cron-style jobs, reminders,
recurring syncs) expose those jobs so parley can render a **Cron**
section in Settings: what is scheduled, when it last ran and how it
went, where it reports to, which model it uses, plus pause/resume, a
manual run, and a redirect of its delivery target. The agent owns the
job list, the option catalogs AND validation; parley is a thin
renderer and never encodes agent-specific concepts (hermes' cron store
is one implementation; a reminders service is another).

Strictly optional: agents without a scheduler return 404 on
`GET /v1/jobs` and parley shows "This agent does not expose scheduled
jobs." in the Cron section.

### `GET /v1/jobs`

**Response (200):**

```json
{
  "object": "list",
  "data": [
    {
      "id": "c06b4603e054",
      "name": "Press radar — daily briefing",
      "schedule": "45 3 * * *",
      "enabled": true,
      "state": "scheduled",
      "next_run_at": "2026-09-06T03:45:00+01:00",
      "last_run_at": "2026-09-05T03:45:12+01:00",
      "last_status": "ok",
      "last_error": null,
      "prompt": "Collect overnight press mentions…",
      "deliver": "parley:c31cd523-15fa-4758-822b-c1159b595b1c",
      "model": "",
      "provider": "",
      "skills": ["gog"],
      "origin": { "platform": "parley", "chat_id": "e50f5646-…", "label": "parley:e50f5646" }
    }
  ],
  "options": {
    "deliver": [
      { "value": "origin", "label": "Origin chat (where the job was created)", "group": "Routing" },
      { "value": "local",  "label": "Save only — no delivery", "group": "Routing" },
      { "value": "parley:c31cd523-…", "label": "Press radar", "group": "Parley chats" }
    ],
    "model": [
      { "value": "", "label": "Follow default (gpt-6-astra via openai-codex)", "group": "Default" },
      { "value": "gpt-5.6-sol", "label": "GPT-5.6 Sol", "group": "OpenAI Codex" }
    ]
  },
  "default_model": "gpt-6-astra via openai-codex"
}
```

**Job fields:**

- `id` (string, required) — opaque, `[A-Za-z0-9_-]{1,64}`; the URL
  fragment on the write endpoints.
- `name`, `schedule` (strings) — display only. `schedule` is whatever
  the agent shows its users (cron expression, "every 2h", …).
- `enabled` (bool) and `state` (string) — `state` is free-form but the
  UI recognises `scheduled`, `paused`, `running`, `error`, `done`.
- `next_run_at`, `last_run_at` (ISO-8601 or null); `last_status`,
  `last_error` (strings or null). A non-null `last_error` renders as a
  red line under the job.
- `prompt` (string) — what the job does; the agent may truncate.
- `deliver` (string) — where results go. Must be one of the
  `options.deliver[].value`s, or an agent-accepted target the agent
  ALSO lists (agents should always include a job's current value so
  the picker can show the truth).
- `model` (string) — `""` when the job follows the agent's default;
  otherwise a pinned model id present in `options.model`.
- `origin` (object or null) — `{platform, chat_id, label}` of the chat
  the job was created from. When `platform` is `"parley"` the UI
  deep-links to it (`?chat=<chat_id>`), likewise for a `deliver` value
  of the form `parley:<chat_id>`.

`options.deliver` / `options.model` follow the settings-extension
option shape (`value`, `label`, optional `group` → `<optgroup>`).

### `POST /v1/jobs/{id}`

Body: any subset of `{ "enabled": bool, "deliver": string, "model": string }`
(`"model": ""` clears a pin). Returns the updated job object (200).
`404` when the id is unknown; `400` with `{"error":{"type":
"invalid_request_error","message":…}}` when the agent rejects a value
— parley reverts the control and shows the message.

### `POST /v1/jobs/{id}/run`

Queue the job to run at the agent's next opportunity (results deliver
through the agent's normal path). Returns the updated job (200).

### `DELETE /v1/jobs/{id}`

Remove the job permanently. Returns `{"deleted": true, "id": …}` (200)
or `404`. Parley asks the user to confirm before calling this.

### `GET /v1/jobs/{id}/runs?limit=N`

Recent executions, newest first: `{"object":"list","data":[{"id",
"status","source","claimed_at","started_at","finished_at","error"}]}`.
Optional; parley tolerates 404.

Reference implementation: `backends/hermes/plugin/parley_route_jobs.py`
over hermes' `cron.jobs` store (the same store `hermes cron …` and the
hermes dashboard mutate). Proxy forwarders: `proxy/parley/jobs.ts`
(`/api/parley/jobs*`). Renderer: `src/cronSettings.ts`.

## Optional health extension — `/v1/health/*`

Lets the agent expose its own health checks so parley can render a
**Health** section in Settings: each check's latest report, when it ran,
its worst status, and a "Run now" button. The agent owns the check
list, the reports and how a check is re-run; parley only renders.

Strictly optional: agents without health checks return 404 on
`GET /v1/health` and the section says so.

### `GET /v1/health`

```json
{ "object": "list", "data": [
  { "id": "hermes", "name": "hermes health", "worst": "FAIL",
    "last_run_at": "2026-09-05T07:11:34+00:00",
    "report": "🔴 hermes health — galatea — …\nFAIL hindsight_llm — …\nOK   gateway — …",
    "can_run": true, "counts": { "fail": 1, "warn": 2, "ok": 15 } }
] }
```

- `id` — `[a-z0-9_-]{1,32}`, the URL fragment on the run endpoint.
- `worst` — `OK` | `WARN` | `FAIL` | `CRASHED` | `UNKNOWN`.
- `report` — plain text; lines starting with `FAIL `, `WARN `, `OK ` are
  colour-coded by the UI, everything else renders verbatim.
- `can_run` — whether `POST …/run` is available for this check.

### `POST /v1/health/{id}/run`

Re-run the check synchronously (may take minutes) and return the fresh
check object. `400` when the check is read-only or timed out, `404` for
an unknown id.

Reference implementation: `backends/hermes/plugin/parley_route_health.py`
reads the digest state written by hermes-agent-private's
`scripts/lib/health.sh` (`<name>.last-run`, `<name>.report.txt`) and
re-runs the configured scripts with `--no-alert`
(`PARLEY_HEALTH_STATE_DIR`, `PARLEY_HEALTH_RUNNERS`).

## Errors

Errors use the OpenAI shape:

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error" | "authentication_error" | ...,
    "code": "..."     // optional
  }
}
```

HTTP status codes:

- 400 — validation
- 401 — auth
- 404 — unknown endpoint or response id
- 500 — unhandled server error

---

## Reference implementation

Hermes-agent's [`gateway/platforms/api_server.py`](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py)
implements this contract. Search for `_handle_responses` (the
non-streaming + streaming entrypoint) and the `response.completed`
SSE writer for the exact event shape. Implementers should treat this
as the canonical reference.
