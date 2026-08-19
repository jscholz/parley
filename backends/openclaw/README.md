# backends/openclaw

OpenClaw plugin that exposes the parley `/v1/*` HTTP+SSE contract.

Mirrors the responsibilities of `backends/hermes/plugin/__init__.py`
(the Python reference implementation against hermes-agent). Parley
proxy treats this plugin and the hermes plugin identically — it just
changes `PARLEY_PLATFORM_URL`.

**Status (2026-05-16):** full surface implemented. Drawer, transcript
replay, turn dispatch with SSE, out-of-band events, push, pins,
unread. Mid-flight session switches preserve user prompts via in-
process `TurnBuffer`. Cross-device push + unread + pin sync via SSE
envelopes (`unread_changed`, `pins_changed`).

## Install (dev, linked)

```bash
# 1. Ensure openclaw CLI is on PATH:
which openclaw

# 2. Link this directory into openclaw's profile:
openclaw --profile sk-integ plugins install ~/code/backends/openclaw --link

# 3. Start the gateway:
openclaw --profile sk-integ gateway run --port 8646 --dev --auth none --bind loopback

# 4. Verify:
curl http://127.0.0.1:8646/v1/health
# → {"ok":true,"status":"live","via":"parley-plugin"}
```

Point parley proxy at it via `PARLEY_PLATFORM_URL=http://127.0.0.1:8646`
in the proxy's `.env`.

## Why not in `parley/backends/openclaw/`?

Plugins are loaded by openclaw at startup from a path it knows about
(linked via `openclaw plugins install --link`). Keeping the plugin in
its own repo + dev-linked from openclaw's plugin profile keeps the
parley repo's `backends/` directory the protocol contract surface
(types + tests) without dragging openclaw's runtime as a dep.

## State (openclaw-specific)

Cross-reference: the [top-level parley README](https://github.com/jscholz/parley#api--state-surface)
has the cross-tier state map. This section is the openclaw plugin's
piece of it.

### Supplemental DB — `$OPENCLAW_STATE_DIR/parley.db`

Default `~/.openclaw-<profile>/parley.db`. Schema in `src/schema.sql`,
opened by `src/db.js`.

| Table | Key columns | Purpose |
|---|---|---|
| `messages` | id, chat_id, role, content, kind, tool_name, tool_call_id, agent_row_id, timestamps | Message cache + bridge to openclaw's native session ids. Mirrors hermes plugin's `msg_links` table. |
| `pins` | (chat_id, msg_id) → role, text, timestamps | Pinned messages per chat. Routes: `/v1/pins`. |
| `unread_state` | chat_id → last_read_at, marked_unread | Read pointer + sticky-unread flag. SSOT for badge + push eligibility. |
| `push_subscriptions` | endpoint → p256dh, auth, userAgent, timestamps | WebPush endpoints. |
| `push_mutes` | chat_id → muted_at | Per-chat push mute. |
| `push_prefs` | key → value_json | Global push prefs (quiet-hours, per-kind enables). |
| `vapid_keys` | id=1 (singleton CHECK) → public_key, private_key, subject | WebPush VAPID identity. Lazy-generated on first run if env vars unset. |
| `inflight` | envelope_id, chat_id, envelope_type, payload_json, timestamps | In-flight envelope buffer for recovery / healing. |
| `meta` | key → value | Schema version. |

### Reads from openclaw native data (direct file reads, not WS)

`src/openclaw-store.js` reads openclaw's session store directly from
disk — bypasses the gateway WS to avoid the device-pairing dance for
loopback-internal reads:

- **`{stateDir}/agents/{agentId}/sessions/sessions.json`** — session
  registry. Used by `listSessions()` → `/v1/conversations` (drawer
  list) and unread computation.
- **`{stateDir}/agents/{agentId}/sessions/{sessionId}.jsonl`** — per-
  session message log. Used by `readSessionMessages()` →
  `/v1/conversations/{id}/items` (transcript replay) and unread
  badge counting.

Rationale: the plugin and openclaw share a
filesystem, so direct reads are simpler than WS+auth. Reassess if the
schema stabilizes and we want robustness against openclaw internal
changes.

### In-memory state (per-process, lost on restart)

| Module | Field | Purpose |
|---|---|---|
| `src/turn-buffer.js` | `byRunId` Map | Active turns in flight (runId → {chatId, userMessage, toolCalls, toolResults, assistantText, startedAt}). Cleared on `lifecycle:end`. |
| `src/turn-buffer.js` | `byChatId` Map | Reverse lookup chatId → Set<runId> for items-merge. |
| `src/push-dispatch.js` | `EngagementState.lastSeenAt` | PWA visibility heartbeat per chat (chat_id → ms timestamp). 2s push-eligibility window. |
| `src/push-dispatch.js` | `TurnTextAccumulator.byRunId` | Accumulated message + narration text per turn for push payload (finalized on `lifecycle:end`). |

### Env vars + config

| Var | Used for | Default |
|---|---|---|
| `OPENCLAW_SK_PROFILE` | Agent profile name | `sk-integ` |
| `OPENCLAW_SK_AGENT` | Agent ID within profile | `dev` |
| `OPENCLAW_STATE_DIR` | Override openclaw state dir | `~/.openclaw-<profile>` |
| `OPENCLAW_GATEWAY_PORT` | Gateway WS port | `8646` |
| `PARLEY_VAPID_SUBJECT` | WebPush subject mailto | `mailto:admin@example.com` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | One-time bootstrap into `vapid_keys` table | Generated fresh if absent |

### Differences from the hermes plugin

Both plugins implement the same `/v1/*` contract and use the same
`parley.db` schema (modulo column-name conventions: JS plugin uses
camelCase in JS, snake_case in SQL; Python plugin uses snake_case
both sides). Differences:

- **Language + runtime**: JavaScript loaded by openclaw's plugin SDK
  (`definePluginEntry`, `api.registerHttpRoute`, `api.agent.events.
  registerAgentEventSubscription`); hermes plugin is Python loaded
  into the hermes-agent aiohttp process.
- **Native-store reads**: openclaw plugin reads `sessions.json` +
  `{sessionId}.jsonl` files directly. Hermes plugin queries
  `state.db` (sqlite) with recursive CTEs for compaction-rotated
  session chains.
- **Mid-flight observation**: openclaw turn buffer hooks the plugin
  SDK's agent-event subscription (`stream:tool`, `stream:assistant`,
  `lifecycle:end`); hermes turn buffer observes the SSE envelopes
  the gateway emits. Same shape, different source.
- **Inflight recovery**: openclaw plugin persists in-flight envelopes
  to the `inflight` table for recovery on restart; hermes plugin's
  in-flight state is purely in-memory (lost on restart, which is
  acceptable because hermes turn replay from `state.db` is fast).
- **VAPID bootstrap**: both plugins lazy-import env vars on first
  run, then persist to the `vapid_keys` table. Identical behavior.

## Roadmap

See [`docs/openclaw-backend-plan.md`](docs/openclaw-backend-plan.md)
for the full work breakdown + decision register.

Done (this branch):
1. `/v1/health` + drawer + transcript replay
2. `POST /v1/responses` SSE streaming
3. `GET /v1/events` out-of-band envelope subscription
4. Supplemental DB + plugin-owned push + pins + unread
5. In-process TurnBuffer + items merge (mid-flight session switches
   preserve user prompts)
6. Cross-device sync via `unread_changed` / `pins_changed` envelopes

Open:
- `/v1/gateway/conversations` (cross-platform drawer parity with
  hermes — telegram / whatsapp / slack alongside parley)
- `/v1/settings/*` (model picker — openclaw's model config is
  different from hermes's; needs adapter design)
- `/v1/commands`, `/v1/conversations/search` (optional)
- Realtime voice mode lift (Phase 2 — see
  [`docs/realtime-integration-design.md`](docs/realtime-integration-design.md))
