# Parley supplemental store — schema draft

**Status:** approved; implementation complete.

**Context:** part of the openclaw-integration work. See
`openclaw-backend-plan.md` for the broader plan + decision register.
The architecture audit identified state-layer sprawl across ~25 stores
as the load-bearing source of session/notification/pin flakiness.
This doc describes the consolidated schema.

## Goals

1. **Single source-of-truth for parley-owned state.** Pins,
   notifications, mutes, push subscriptions, prefs, inflight
   envelopes — one SQLite file per backend. The proxy reads/writes
   through the plugin; the plugin owns the schema.
2. **Decoupled from hermes/openclaw schemas.** This store lives
   alongside (not inside) the agent runtime's state. Plugin manages
   migrations; agent runtime is unaware of these tables.
3. **Same shape on both backends.** Hermes plugin and openclaw plugin
   both implement the same schema + read/write helpers. Proxy is
   uniform across both. Migration to a future third backend is "port
   the helpers, schema is given."
4. **Fix today's flakiness.** Persistent inflight (vs ephemeral
   in-memory) kills the "send → switch → switch back → message gone"
   class. Cross-device pin/unread sync becomes free. Tool-row reload
   replay is no longer a thing.

## Non-goals

- Touching hermes `state.db.messages` schema. The parley plugin
  reads from `messages` for transcript replay; it does not write
  there. The new parley store is a separate database file.
- Replacing the hermes state.db for transcript content. That stays
  authoritative for messages. The supplemental store augments.
- Per-user multi-tenancy. Today it's single-user. Schema is shaped
  so adding a `user_id` column later is mechanical, but not built
  in v1.

## File location

- Hermes plugin: `~/.hermes/parley.db` (alongside `state.db`)
- OpenClaw plugin: `~/.openclaw-sk-integ/parley.db` (or whatever
  the profile state dir resolves to)
- Each plugin opens its own file; no cross-runtime sharing. If the
  user runs both hermes AND openclaw, they have two stores. (That's
  fine — chats are scoped to a backend anyway.)

## Tables

```sql
-- ── Schema version (single-row meta) ──────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Row example: ('schema_version', '1')

-- ── Messages (parley-owned augmentation) ────────────────────────
-- Mirrors a subset of state.db.messages, plus the discriminator
-- columns parley needs that hermes' core table doesn't carry.
-- For hermes plugin: write-through on every reply_delta/reply_final
-- the proxy emits, so the supplemental store IS the source of truth
-- for "what bubbles exist in this chat" from the parley PWA's
-- perspective. State.db continues to be authoritative for the LLM
-- context loop.
--
-- Why duplicate state.db.messages: the persistent-inflight problem
-- needs message rows to exist BEFORE hermes' post-turn flush. State.db
-- lags the live stream by seconds to minutes. The supplemental store
-- captures the row at envelope-emit time, before state.db sees it.
CREATE TABLE IF NOT EXISTS messages (
  -- Stable id: SSE-shape string (umsg_*, msg_*, notif_*). NEVER an
  -- integer auto-increment — that forces consumers to dedup against
  -- two id spaces. The plugin mints these at emit time; state.db's
  -- integer id is in a SEPARATE column for traceability.
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  -- 'user' | 'assistant' | 'tool' | 'system'. NOT 'notification' —
  -- notifications are persisted with role='assistant' and discriminated
  -- via `kind` (see below). This mirrors the 2026-05-15 decision in
  -- the hermes plugin so a future merge with state.db is uniform.
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  -- Notification / cron / approval / etc. discriminator. NULL for
  -- regular replies. PWA reads this to pick the renderer.
  kind TEXT,
  -- Tool-row metadata. NULL for non-tool rows.
  tool_name TEXT,
  tool_call_id TEXT,
  -- Wall-clock timestamps. created_at = when the envelope was
  -- emitted; updated_at = last modification (text edit, finalization).
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  -- Lifecycle: 'streaming' (in flight), 'final' (reply_final fired),
  -- 'cancelled' (user aborted). 'final' is terminal.
  status TEXT NOT NULL DEFAULT 'final',
  -- Cross-link to the agent runtime's row (when known). Hermes
  -- writes its integer id here after the post-turn flush. NULL
  -- until linked. OpenClaw equivalent TBD per its session model.
  agent_row_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_agent_row ON messages(agent_row_id);

-- ── Pins ──────────────────────────────────────────────────────────
-- Cross-device pinned messages. Today these live in client IDB
-- (device-local, no sync). Moving to plugin store gives sync for
-- free across all devices the user opens the PWA on.
CREATE TABLE IF NOT EXISTS pins (
  chat_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  timestamp REAL NOT NULL,
  pinned_at REAL NOT NULL,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_pins_pinned_at ON pins(pinned_at DESC);

-- ── Unread tracking ───────────────────────────────────────────────
-- Per-chat unread counters + sticky "marked-unread" state. Cross-
-- device shared so badge counts agree across iPhone PWA + macOS
-- PWA. `last_read_at` is when the user most recently FOCUSED this
-- chat; any envelope with created_at > last_read_at counts as
-- unread.
CREATE TABLE IF NOT EXISTS unread (
  chat_id TEXT PRIMARY KEY,
  last_read_at REAL,
  marked_unread INTEGER NOT NULL DEFAULT 0  -- bool, sticky
);

-- ── Push subscriptions ────────────────────────────────────────────
-- Web Push endpoints + VAPID keys per device. Today
-- ~/.parley/notifications/push-subscriptions.json. Move into the
-- plugin store so backups are unified.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at REAL NOT NULL,
  last_used_at REAL
);

-- ── Push mutes ────────────────────────────────────────────────────
-- Per-chat push mute flags. Today
-- ~/.parley/notifications/push-mutes.json.
CREATE TABLE IF NOT EXISTS push_mutes (
  chat_id TEXT PRIMARY KEY,
  muted_at REAL NOT NULL
);

-- ── Push prefs (kv) ───────────────────────────────────────────────
-- Quiet hours, kind filters, etc. Today
-- ~/.parley/notifications/push-prefs.json.
CREATE TABLE IF NOT EXISTS push_prefs (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
-- Rows like ('quiet_hours', '{"enabled":false,"start":"22:00","end":"07:00"}')
-- and ('kinds', '{"agent_reply":true,"notification":true}').

-- ── Inflight envelopes ────────────────────────────────────────────
-- Replaces the proxy's in-memory inflight cache. Every envelope the
-- proxy fans out gets recorded here; the heal pass on chat-open
-- reads from this table to reconstruct in-flight state. Bounded
-- retention via the cleanup query at the end of each turn:
--   DELETE FROM inflight WHERE chat_id = ? AND created_at < final_ts
CREATE TABLE IF NOT EXISTS inflight (
  envelope_id TEXT PRIMARY KEY,  -- mint at emit time
  chat_id TEXT NOT NULL,
  envelope_type TEXT NOT NULL,   -- reply_delta, tool_call, etc.
  payload_json TEXT NOT NULL,
  created_at REAL NOT NULL,
  -- When the related message row was finalized. NULL while in flight.
  finalized_at REAL,
  -- The supplemental-store message_id this envelope contributes to
  -- (for in-turn envelopes that build up to a single bubble).
  message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_inflight_chat ON inflight(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inflight_message ON inflight(message_id);
```

## Decisions to confirm

1. **One file or many.** Single SQLite file (`parley.db`) with all
   tables vs separate files per concern (pins.db / inflight.db /
   etc.). Recommend single file — simpler backup, single connection,
   transactional cross-table writes possible. Tradeoff: schema
   migrations affect everything at once.

2. **Message id space.** All ids are SSE-shape strings — `umsg_*`
   for user, `msg_*` for assistant, `notif_*` for notifications,
   `sk-*` for parley-adapter-emitted. The agent runtime's integer
   id (hermes' state.db row id) goes in a separate
   `agent_row_id` column for traceability. No integer auto-increment
   on `messages.id` — that forces consumers to dedup against two
   id spaces, which is the current source of `parley_msg_links`
   complexity.

3. **Inflight retention policy.** Three options:
   - (a) Delete on reply_final (current in-memory grace-period model)
   - (b) Keep forever, query never reaches it for finalized rows
   - (c) Keep for N hours, garbage-collect by created_at
   Recommend (b) initially — disk is cheap, the heal logic just
   joins on `finalized_at IS NULL` for "what's actually in flight."
   Storage cost: ~1KB/envelope × ~100 envelopes/day × 365 days =
   36 MB/year. Trivial.

4. **Four tiers of state ownership**:
   - **Tier 1 — Agent runtime authoritative.** `state.db.messages`
     for transcript content. Hermes' / openclaw's native store.
     Parley plugin reads, doesn't write.
   - **Tier 2 — Parley supplemental DB authoritative.** Pins,
     unread, push (subscriptions / mutes / prefs), inflight
     envelopes, kind discriminators, scroll positions if we ever
     want them synced. Single source of truth, the source the
     PWA reconciles against.
   - **Tier 3 — Client IDB cache.** Mirror of tiers 1+2 for
     offline-first paint. Includes the transcript HTML snapshot
     (rendered DOM cached for fast restore), plus locally-cached
     copies of session list, pins, etc. Backend update → IDB cache
     reconcile on next fetch.
   - **Tier 4 — Truly device-local.** State no other device should
     ever see: which chat is currently focused, composer textarea
     content. These are session-scoped UX, not data.

   Cut line is sharper than "would another device want to see
   this?" — the answer is "almost everything is sync-worthy except
   the local UX cursor (which chat, composer text)." That's Tier 4.
   Everything else lives at Tier 1 or 2 with IDB as a cache layer.

5. **Hermes plugin write timing.** Two viable patterns:
   - (a) Write to supplemental store INSIDE
     `_safe_send_envelope` synchronously, BEFORE the fan-out. The
     row exists by the time the SSE arrives at the proxy.
   - (b) Write asynchronously via a queue, eventual consistency.
   Recommend (a) — sync write keeps the dedup invariant clean. SQLite
   writes at this volume are microseconds.

6. **Existing data migration.** Pin store + push files have user
   state. Need a one-shot migration on first plugin start that
   reads the existing JSON files / IDB → writes into the new SQLite
   → marks done in `meta`. Could be in a follow-up commit; not
   blocking the schema design.

## What this DOESN'T solve yet

- **Tool-row reload duplication.**
  Tool envelopes need dedup ids the heal loop catches. The
  supplemental store puts them in `inflight` table; the renderer
  needs to query "what tool rows have agent_row_id linked OR are
  finalized" instead of "what's been broadcast this session." That's
  a render-side change once the table exists.
- **Cross-device unread reconciliation.** Schema supports it (single
  source for `last_read_at`); the PWA + dispatch logic needs to ack
  reads to the server. That's a follow-up wire change.

## Implementation sequence (proposed)

1. Schema + open/migrate helper in the parley-openclaw-plugin.
   Same helper module gets copied (or extracted to a shared package)
   into hermes plugin.
2. `/v1/conversations` + `/v1/conversations/{id}/items` reading from
   `messages` table. For hermes, the existing UNION with state.db
   messages stays during the transition; for openclaw, the
   supplemental store IS the truth.
3. `POST /v1/responses` writing to `inflight` + `messages` as
   envelopes emit. Drives the openclaw turn dispatch.
4. Migrate pins / push files into the supplemental store on hermes
   plugin (preserving existing user data). Parley PWA gains
   cross-device pin sync as a side effect.
5. Reassess in-memory inflight cache in the proxy. With persistent
   store backing it, the cache can shrink to "session-scoped fan-out
   buffer" or be eliminated entirely.
