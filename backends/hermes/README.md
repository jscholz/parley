# Hermes backend

Parley + [hermes-agent](https://github.com/NousResearch/hermes-agent) —
the recommended path for full features (cross-platform drawer,
agent-declared model picker, openrouter-backed catalog).

## Layout

| Path | What |
|---|---|
| `plugin/__init__.py` | The hermes plugin. Exposes the agent contract (`/v1/responses`, `/v1/conversations*`, `/v1/events`) plus the optional `/v1/gateway/conversations` (cross-platform drawer) and `/v1/settings/*` (model picker) extensions. Loads into hermes-agent's process via the plugin loader. |
| `plugin/0001-add-parley-platform.patch` | One-time patch against hermes-core that registers `Platform.SIDEKICK`. Apply to your hermes install before first run. |
| `plugin/plugin.yaml` | Hermes plugin manifest. |
| `plugin/README.md` | Plugin-specific install + protocol notes. |
| `config.example.yaml` | Hermes-side config keys the plugin reads/writes — annotated subset of `~/.hermes/config.yaml`. |

## Install

```bash
# 1. Install hermes-agent itself per its docs:
#    https://github.com/NousResearch/hermes-agent

# 2. Apply the one-time hermes-core patch (registers Platform.SIDEKICK):
cd <your hermes-agent install>
patch -p1 < <parley-repo>/backends/hermes/plugin/0001-add-parley-platform.patch

# 3. Symlink the plugin into hermes's plugin search path:
ln -s "<parley-repo>/backends/hermes/plugin" ~/.hermes/plugins/parley

# 4. Set the shared bearer token on the hermes side:
echo "SIDEKICK_PLATFORM_TOKEN=$(openssl rand -hex 32)" >> ~/.hermes/.env

# 5. Enable BOTH parley toolsets in ~/.hermes/config.yaml.
#    hermes-parley = the auto-generated core-tools composite (file,
#    terminal, web, ...). parley = the plugin's own tools
#    (display_doc). The second entry must be explicit: hermes'
#    validate_toolset() has no auto-gen branch, so without it the
#    plugin's tools are silently dropped from sessions.
#      platform_toolsets:
#        parley:
#        - hermes-parley
#        - parley

# 6. Restart hermes-gateway to load the plugin.
systemctl --user restart hermes-gateway
```

Then in parley's `.env`:
```
PARLEY_PLATFORM_URL=http://127.0.0.1:8645
SIDEKICK_PLATFORM_TOKEN=<same token from ~/.hermes/.env>
```

## What hermes contributes

- **Drawer / replay / delete** — backed by hermes's state.db. The
  plugin's `/v1/conversations*` handlers translate state.db rows
  into the agent contract's row shape.
- **Cross-platform drawer** (`/v1/gateway/conversations`) — telegram,
  whatsapp, slack sessions surface alongside parley in the drawer
  with per-row source badges. Parley's composer goes read-only on
  non-parley rows (since you'd be hijacking another platform's
  thread).
- **Model picker** (`/v1/settings/*`) — the `model` setting wraps
  `~/.hermes/config.yaml`'s `model:` field plus the openrouter
  catalog. Updates write back to config.yaml via
  `hermes_cli.model_switch.switch_model(is_global=True)`. New
  conversations pick up the new model immediately; existing cached
  agents keep their model until evicted.
- **Tool calls** — `tool_call` / `tool_result` envelopes flow
  through to the PWA's activity row renderer.

## Config keys hermes-side

See `config.example.yaml` in this directory. Parley reads:
- `model:` (scalar or `model.default:`) — current model id, also
  the value parley's settings panel displays.
- `model.provider:`, `model.base_url:` — passed into `switch_model`
  when the user picks a new model.
- `providers:`, `custom_providers:`, `fallback_providers:` —
  hermes's own provider config. Parley doesn't write these but
  the model picker honors them.

Parley writes (only via the model picker):
- `model.default:` (or `model:` scalar form, depending on the
  shape already present).
- `model.provider:`, `model.base_url:` if `switch_model` resolves
  a different provider for the chosen model.

## State (hermes-specific)

Cross-reference: the [top-level README](../../README.md#api--state-surface)
has the cross-tier state map. This section is the hermes plugin's
piece of it.

### Supplemental DB — `$HERMES_STATE_DIR/parley.db`

Default `~/.hermes/parley.db`. Opened by `plugin/parley_db.py`
with thread-safe locking; CRUD lives in `plugin/parley_state.py`.

| Table | Key columns | Purpose |
|---|---|---|
| `msg_links` | `(chat_id, sidekick_id)` → `agent_row_id`, `kind` | Bridges PWA-minted `msg_*` ids to hermes state.db integer rows. `kind` column discriminates `cron` / `reminder` / `approval` / etc. so the PWA renders notification bubbles correctly on reload. |
| `pins` | `(chat_id, msg_id)` → role, text, timestamps | Pinned messages per chat. Routes: `/v1/pins`. |
| `unread_state` | `chat_id` → `last_read_at`, `marked_unread` | Read pointer + sticky-unread flag. The SSOT for badge + push eligibility. |
| `push_subscriptions` | `endpoint` → p256dh, auth, userAgent, timestamps | WebPush endpoints. |
| `push_mutes` | `chat_id` → `muted_at` | Per-chat push mute. |
| `push_prefs` | `key` → `value_json` | Global push prefs (quiet-hours, per-kind enables). |
| `vapid_keys` | id=1 (singleton) → public_key, private_key, subject | WebPush VAPID identity. Lazy-imported from env on first run. |
| `meta` | `key` → `value` | Schema version. |

### Reads from hermes `state.db` (read-only)

The plugin opens hermes's own sqlite store via a read-only URI
(`file:state_db_path?mode=ro`) — never writes. Used by:

- **`compute_unread()`** (`parley_unread.py`) — walks `sessions` +
  `messages`, counts assistant rows newer than each chat's
  `last_read_at`. Recursive CTE rolls up compaction-rotated child
  sessions under their root `user_id` (so a long chat that hermes
  has snapshotted into multiple session rows still presents as one
  chat with one count).
- **`_items_by_user_id()`** (`__init__.py`) — same recursive CTE
  for `/v1/conversations/{id}/items` transcript replay.
- **`_session_poll_loop()`** — watches the `sessions` table for
  `session_changed` events (title updates, compression rotations).
- **`_delete_session()`** — reads `sessions.json` + `sessions/{sid}.jsonl`
  from `state_db_path.parent/sessions/` for cascading delete.

### In-memory state (per-process, lost on restart)

Owned by the `ParleyAdapter` singleton in `plugin/__init__.py`:

| Field | Purpose |
|---|---|
| `_turn_buffer` (`TurnBuffer`) | Per-chat mid-flight transcript mirror (user msg + tool calls/results + assistant text) between POST receipt and `reply_final`. Merged into `/v1/conversations/{id}/items` so a mid-turn session switch shows the user prompt. |
| `_turn_queues` | Per-chat `asyncio.Queue` for `/v1/responses` SSE streaming. |
| `_event_subscribers` | Set of `asyncio.Queue` for `/v1/events` out-of-band fan-out. |
| `_event_replay_ring` | Bounded ring (256 entries) for SSE `Last-Event-ID` replay. |
| `_event_id_counter` | Monotonic sequence for envelope IDs. |
| `_session_state_cache` | `chat_id → (session_id, title)` — skips duplicate `session_changed` envelopes. |
| `_sid_to_chat_id_cache` | `session_id → chat_id` for tool-call hooks (populate-once per session). |
| `_inflight_tool_calls` | `call_id → (start_time, chat_id)` for telemetry timing. |
| `_push_dispatcher.engagement` | `EngagementState._last_seen` — `chat_id → ms_timestamp` (2s push-eligibility window). |

### Env vars

| Var | Used for | Default |
|---|---|---|
| `HERMES_STATE_DIR` | `parley.db` location | `~/.hermes` |
| `SIDEKICK_PLATFORM_TOKEN` | Bearer for `/v1/*` routes (fatal if missing) | — |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | One-time bootstrap into `vapid_keys` table (raw base64url, NOT PEM) | Generated fresh if absent on first run |
| `VAPID_SUBJECT` | WebPush subject line | `mailto:jscholz@reimaginerobotics.ai` |
| `PARLEY_PDF_*` | PDF rasterization knobs (DPI, max pages, timeout, max bytes) | 150 / 50 / 30s / 20MB |

The plugin does NOT read `~/.hermes/*.json` dotfiles. Push subs /
mutes / prefs that used to live there moved into `parley.db` in
the 2026-05 consolidation; the env-driven `VAPID_*` bootstrap is
the only "config from outside the DB" path remaining.

### Differences from the openclaw plugin

Both plugins implement the same `/v1/*` contract and use the same
`parley.db` schema. Differences:

- **Language**: hermes plugin is Python (loaded into hermes-agent's
  aiohttp process); openclaw plugin is JavaScript (loaded by
  openclaw's plugin SDK).
- **Native-store reads**: hermes plugin queries `state.db` (sqlite,
  recursive CTEs); openclaw plugin reads `sessions.json` +
  `{sessionId}.jsonl` files directly.
- **Mid-flight semantics**: hermes turn buffer fills as the agent
  emits SSE envelopes; openclaw turn buffer hooks the plugin SDK's
  agent-event subscription. Same shape, different source.
- **`msg_links.kind` discriminator**: hermes uses it for notification
  rendering; openclaw plugin uses native session-id paths. Both
  paths converge on the same PWA `kind` field.
