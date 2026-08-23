-- Parley supplemental store schema.
--
-- Implements the design signed off 2026-05-15 in
-- ../docs/parley-supplemental-store-schema.md.
-- Read that doc for rationale on each table + column.
--
-- This file is loaded at plugin startup; CREATE IF NOT EXISTS makes
-- it idempotent. Schema version is recorded in the `meta` table so
-- future migrations can detect their starting point.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Messages — parley-owned augmentation of state.db.messages.
-- Written at envelope-emit time (sync, before SSE fan-out) so the
-- supplemental store is the source of truth from the moment a bubble
-- exists, NOT after the agent runtime's post-turn flush.
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,    -- SSE-shape string (umsg_*, msg_*, notif_*, sk-*)
  chat_id       TEXT NOT NULL,
  role          TEXT NOT NULL,       -- 'user' | 'assistant' | 'tool' | 'system'
  content       TEXT NOT NULL,
  kind          TEXT,                -- 'cron' | 'reminder' | 'approval' | NULL
  tool_name     TEXT,
  tool_call_id  TEXT,
  created_at    REAL NOT NULL,
  updated_at    REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'final',  -- 'streaming' | 'final' | 'cancelled'
  agent_row_id  TEXT                 -- agent runtime's row id when known
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_agent_row ON messages(agent_row_id);

CREATE TABLE IF NOT EXISTS pins (
  chat_id    TEXT NOT NULL,
  msg_id     TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  timestamp  REAL NOT NULL,
  pinned_at  REAL NOT NULL,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_pins_pinned_at ON pins(pinned_at DESC);

CREATE TABLE IF NOT EXISTS activity_items (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  REAL NOT NULL,
  urgent      INTEGER NOT NULL DEFAULT 0,
  read        INTEGER NOT NULL DEFAULT 0,
  message_id  TEXT,
  resolved    TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_items_created ON activity_items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_items_chat ON activity_items(chat_id, created_at DESC);

-- Per-chat read pointer. Single source of truth for the unified
-- unread + app-badge + push consistency model. Everything derives:
--   - sidebar badge for chat X = count of push-eligible events in X
--     with timestamp > last_read_at[X]
--   - app badge = sum of those per-chat counts
--   - push notification = fires on agent event when not engaged +
--     not muted + subscribers exist — same event that bumps the
--     implicit unread count
-- Cross-device sync via the `unread_changed` envelope on /v1/events.
CREATE TABLE IF NOT EXISTS unread_state (
  chat_id        TEXT PRIMARY KEY,
  last_read_at   REAL,                       -- when this chat was last viewed by ANY device
  marked_unread  INTEGER NOT NULL DEFAULT 0  -- bool, WhatsApp-style sticky
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint      TEXT PRIMARY KEY,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    REAL NOT NULL,
  last_used_at  REAL
);

CREATE TABLE IF NOT EXISTS push_mutes (
  chat_id   TEXT PRIMARY KEY,
  muted_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS push_prefs (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL
);

-- VAPID keypair — the plugin's Web Push application-server identity.
-- Single row enforced by CHECK; generated lazily on first init if
-- missing. Public half is exposed to PWA via /v1/push/vapid-public-key;
-- private half signs every web-push request. Subject is the contact
-- mailto: per RFC 8292.
CREATE TABLE IF NOT EXISTS vapid_keys (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  public_key   TEXT NOT NULL,
  private_key  TEXT NOT NULL,
  subject      TEXT NOT NULL,
  created_at   REAL NOT NULL
);

-- Inflight envelopes — persistent replacement for the proxy's
-- in-memory cache. Bounded by `finalized_at IS NULL` rather than
-- deletion; the heal logic queries "what's actually in flight" via
-- that filter. Cheap to keep (~36 MB/year).
CREATE TABLE IF NOT EXISTS inflight (
  envelope_id    TEXT PRIMARY KEY,
  chat_id        TEXT NOT NULL,
  envelope_type  TEXT NOT NULL,    -- 'reply_delta', 'tool_call', etc.
  payload_json   TEXT NOT NULL,
  created_at     REAL NOT NULL,
  finalized_at   REAL,             -- NULL while in flight
  message_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_inflight_chat ON inflight(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inflight_message ON inflight(message_id);
CREATE INDEX IF NOT EXISTS idx_inflight_unfinalized ON inflight(chat_id, finalized_at)
  WHERE finalized_at IS NULL;
