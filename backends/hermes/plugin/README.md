# Parley hermes plugin

Hermes platform adapter that turns parley (PWA + Node proxy) into a
peer of telegram / slack / signal — a gateway-managed chat surface where
hermes owns the `chat_id → session_id` mapping natively.

The adapter exposes the abstract agent contract over HTTP+SSE
(`/v1/responses`, `/v1/conversations*`, `/v1/events`, plus the
parley gateway extension `/v1/gateway/conversations`,
`/v1/settings/*`, `/v1/commands`). See the parley repo's
[`docs/ABSTRACT_AGENT_PROTOCOL.md`](../../../docs/ABSTRACT_AGENT_PROTOCOL.md)
for the canonical reference.

This directory contains the **plugin source**. Installing it is opt-in.

The module docstring at the top of `__init__.py` is the authoritative
envelope catalogue + adapter surface reference. Read it before
modifying the plugin.

## Highlights

- Owns the `chat_id → session_id` resolution against hermes' state.db.
  Sessions rotate (compression, manual `/reset`); the read path walks
  rotations transparently so the drawer + transcript stay coherent.
- Emits the cross-device `user_message` broadcast on every
  `POST /v1/responses` so other connected PWA tabs render the user's
  bubble immediately. PWA's pre-minted `user_message_id` is the
  dedup key for the originating tab.
- Persists agent-declared settings (`/v1/settings/*`) back to
  `~/.hermes/config.yaml` under the `sidekick:` namespace so changes
  survive restarts and agree across CLI + PWA.
- Slash-command catalog (`/v1/commands`) wraps the hermes-cli
  registry; categories `cli_only` are filtered out (PWA can't
  exercise terminal affordances).
- Cross-platform drawer (`/v1/gateway/conversations`) — telegram /
  slack / whatsapp sessions surface alongside parley's own with a
  source badge.

## Files

| File | Purpose |
|------|---------|
| `__init__.py` | The adapter — `BasePlatformAdapter` subclass + aiohttp HTTP server speaking the agent contract. The plugin loader walks `<plugin-dir>/__init__.py`. |
| `parley_db.py` | Supplemental sqlite (`~/.hermes/parley.db`). **Read the top-of-file design block** for the message-store architecture. |
| `parley_state.py` | All CRUD against `parley.db` — push subs, mutes, prefs, VAPID, pins, unread, msg_links. Plus `record_envelope()` (write-through) + `reconcile_from_state_db()` (linker + self-heal). |
| `parley_route_items.py` | `GET /v1/conversations/{id}/items` — reads from parley.db, opportunistically reconciles from state.db on enter. |
| `parley_route_*.py` | Other route handlers (responses, events, conversations, settings, push). |
| `parley_dispatcher.py` | Plugin-owned web-push dispatch (engagement gate, kind toggles, body shaping). |
| `parley_turn_buffer.py` | In-memory mid-turn buffer for mid-flight reload (transient). |
| `plugin.yaml` | Hermes plugin manifest. |
| `0001-add-parley-platform.patch` | Required `hermes-agent` patch (see below). |

## Message store (`~/.hermes/parley.db`)

The PWA's transcript is rendered from parley.db, not state.db.
State.db is hermes' LLM-context substrate; parley.db is the UI-facing
view. They're kept in sync by:

1. **Write-through** on every persisted envelope (`user_message`,
   `reply_delta`, `reply_final`, `tool_call`, `tool_result`,
   `notification`) — `_safe_send_envelope` → `record_envelope()`.
   Rows are keyed by the SSE-shape id (`umsg_*`, `msg_*`, `tc:*`,
   `tr:*`, `notif_*`).
2. **Opportunistic reconciliation** every items-endpoint request
   (`reconcile_from_state_db`):
   - Link pass: content-fingerprint match populates `agent_row_id`
   - Insert pass: state.db rows missing from parley.db get added
     as `legacy:<state_id>` (chats predating the migration)
   - Orphan-drop pass: parley.db rows linked to vanished state.db
     rows (i.e. `/retry`, `/undo`, `/compress`, delete, prune
     happened) get removed
3. **Self-healing**: orphan + insert passes run on every items read,
   so whole-session mutations recover on the next PWA poll. The heal
   logs `[parley] heal chat=… links=N inserted=N dropped=N` —
   non-zero in the journal means a write-path bug or a hermes-side
   session mutation just happened.

### Failure modes

- **state.db unreachable**: reconcile returns 0, orphan drops are
  skipped (defensive — a transient sqlite hiccup must not wipe rows).
- **Linker can't match by content**: row's `agent_row_id` stays NULL,
  it's never an orphan candidate. Self-corrects when state.db catches
  up + content match succeeds.
- **Bug in the write path**: smoke tests catch it (see
  `tests/test_envelope_writethrough.py` and
  `tests/test_items_endpoint_parley_db.py`). Production drift
  surfaces as `legacy:<id>` rows in parley.db that should have
  been envelope-written.

### Schema migration log

| Phase | When | What |
|-------|------|------|
| 1 | 2026-05-19 | Write-through hook added in `_safe_send_envelope` |
| 2 | 2026-05-19 | Items endpoint switched to parley.db reads |
| 3 | 2026-05-19 | Content-fingerprint linker (replaces `_write_msg_links_after_turn`) |
| 4 | 2026-05-19 | Bidirectional self-heal on every reconcile |
| Cleanup | 2026-05-19 | Legacy `_write_msg_links_after_turn`, `_capture_msg_high_water_mark` callers removed |
| Cleanup-2 | 2026-05-19 | Legacy method bodies deleted, `parley_msg_links` state.db side-table CREATE removed. Rollback target: git history at `a7d6c17`. |
| 5 (pending) | TBD | Openclaw parity — port self-heal pattern to openclaw's jsonl substrate |

## Install

Hermes' plugin loader doesn't currently support registering a new
platform adapter via `PluginContext` (the API exposes hooks, tools, slash
commands, etc — not platform registration). Until upstream issue
[hermes-agent#3823](https://github.com/.../issues/3823) lands, the
adapter must be registered by patching the gateway directly. The plugin
files still load through the normal plugin loader; only the
`Platform.SIDEKICK` enum + `_create_adapter` factory branch live in the
patch.

```bash
# 1. Patch hermes-agent.
cd <your hermes-agent install>
patch -p1 < <path-to-this-dir>/0001-add-parley-platform.patch

# 2. Install the plugin (symlink so edits in the parley repo land
#    immediately in ~/.hermes/plugins/ without a re-copy).
rm -rf ~/.hermes/plugins/parley
ln -s <path-to-this-dir> ~/.hermes/plugins/parley

# 3. Enable in ~/.hermes/config.yaml:
#    plugins:
#      enabled:
#        - parley

# 4. Auth token + (optional) port in ~/.hermes/.env:
echo "SIDEKICK_PLATFORM_TOKEN=$(openssl rand -hex 32)" >> ~/.hermes/.env
# echo 'PARLEY_PLATFORM_PORT=8645' >> ~/.hermes/.env  # default

# 5. Restart the gateway.
```

The same `SIDEKICK_PLATFORM_TOKEN` value goes into the parley proxy
config so the proxy's WebSocket client can authenticate.

## Smoke test

With the plugin running, in another terminal:

```bash
SIDEKICK_PLATFORM_TOKEN=<the-token> python3 wscat-test.py \
    --chat-id test-conv-1 \
    --text "count to 5"
```

Expected: a `hello` envelope, then streaming `reply_delta` envelopes,
then `reply_final`.

## Wire protocol

HTTP+SSE on `:8645` (default; configurable via
`PARLEY_PLATFORM_PORT`). Endpoints listed in the top-level
[`README.md`](../../../README.md) endpoint inventory; full details
in the module docstring at the top of `__init__.py`.

Auth: `Authorization: Bearer <SIDEKICK_PLATFORM_TOKEN>` on every
request. Same token goes into the parley proxy's
`SIDEKICK_PLATFORM_TOKEN` env so the proxy can authenticate as a
client.

## Known limitations

* `reply_to` threading is ignored on outbound — parley has no thread
  primitive in the PWA today.
