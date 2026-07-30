"""Supplemental sqlite for sidekick-shaped state — push subs, mutes,
prefs, VAPID keys, pins, unread state, and the message store.

Mirrors the openclaw plugin's ``src/schema.sql`` so the two backends
expose an identical /v1/* contract. Per-backend isolation: openclaw
stores at ``~/.openclaw-sk-integ/sidekick.db``; hermes stores at
``$HERMES_STATE_DIR/sidekick.db`` (default ``~/.hermes/sidekick.db``).

# Architecture — sidekick.db as the message store

This file is the **canonical local store for messages the sidekick PWA
renders.** Hermes' own ``state.db`` remains the LLM-context substrate
(turn limits, compaction, etc.); sidekick.db is the UI-facing view that
the items endpoint reads from. The two are decoupled so hermes-core can
evolve its schema without breaking the PWA.

## The ``messages`` table (today still named ``msg_links`` — rename
queued, see Phase 2 below)

- **Primary key** is the SSE-shape id (``umsg_*``, ``msg_*``,
  ``notif_*``, ``sk-*``). NEVER an integer auto-increment — that forces
  consumers to dedup against two id spaces. The plugin mints these at
  envelope-emit time.
- ``agent_row_id`` is a nullable cross-link to ``state.db.messages.id``.
  Populated by the linker (content-fingerprint match, in Phase 2) or
  left NULL — purely traceability metadata, not load-bearing for any
  read.
- ``content`` is the full message text. Yes, this duplicates state.db's
  content column. This is the **deliberate pattern** the design memo
  ``hosts/cortex/sidekick-supplemental-store-schema.md`` called for,
  matching what iMessage / Slack / WhatsApp do
  for the same problem: one local store keyed by a stable UI id with
  full content, server is sync substrate not content cache.
- ``status`` is ``streaming`` during a turn, ``final`` after reply_final,
  ``cancelled`` if the user aborted.

## Why duplicate state.db.messages content

Hermes is effectively append-only at the row level: no UPDATE on
content, no per-row DELETE. The only mutations
are **whole-session ops** (``/retry``, ``/undo``, ``/compress`` →
delete+reinsert all rows in session; explicit session delete; 90-day
prune). These trigger a session_changed envelope which the heal path
hooks (Phase 4 below).

Bug-driven drift (a sidekick.db write-path bug producing a row that
disagrees with state.db) is mitigated by:

1. **Smoke tests** asserting ``COUNT(*) state.db == COUNT(*) sidekick.db``
   per session after each turn flow.
2. **Self-heal on session_changed** — bidirectional reconciliation:
   missing rows pulled from state.db into sidekick.db; orphan rows
   (sidekick.db has, state.db doesn't, agent_row_id NOT NULL) removed.
   Logs on every heal event so write-path bugs surface in production.
3. **Admin audit command** (``sidekick-audit``) for deep dives.

The duplicated-content design has STRICTLY BETTER bug surface than
the alternative JOIN-based hybrid (state.db owns content, sidekick.db
owns metadata, items endpoint JOINs): the duplication design's bugs
are trivially countable (per-session row count check); the hybrid's
bugs are silent NULL content in JOIN results that ship without warning.

# Migration phasing

**Phase 1 — Write-through + smoke.** ``_safe_send_envelope``
calls into ``sidekick_state.record_envelope`` which upserts the row to
``msg_links`` (renamed to ``messages`` in Phase 2). Items endpoint
still reads from state.db; sidekick.db rows accumulate alongside but
aren't read yet. Smokes assert the write path is sound.

**Phase 2 — Items endpoint switch.** Rewrite
``sidekick_route_items.handle_get_items`` to read from sidekick.db
instead of state.db. Rename ``msg_links`` → ``messages``. Delete
the legacy ``sidekick_msg_links`` table on state.db plus
``_write_msg_links_after_turn`` + ``_capture_msg_high_water_mark``.

**Phase 3 — Linker.** Content-fingerprint match of sidekick.db rows
against state.db rows to populate ``agent_row_id``. Runs on each
``reply_final``. Best-effort; failure just leaves agent_row_id NULL.

**Phase 4 — Self-heal on session_changed.** Bidirectional drift
reconciliation. ``state.db`` rows missing from sidekick.db get pulled
in (minted as ``legacy:<state_id>`` keys); orphan sidekick.db rows
(``agent_row_id`` set but state.db row gone — i.e. /retry, /undo,
/compress, delete, prune happened) get dropped.

**Phase 5 — Openclaw parity.** Port self-heal + drift smoke to the
openclaw plugin. (Openclaw's write path is already correct; only the
defensive heal needs adding.)

Each phase lands as its own commit with its own smoke. The current
phase shipped is recorded in the ``meta`` table under
``sidekick_db_phase``.
"""

import os
import sqlite3
import threading
from pathlib import Path


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS msg_links (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  kind          TEXT,
  tool_name     TEXT,
  tool_call_id  TEXT,
  -- tool_calls JSON: for assistant rows that orchestrate tool calls,
  -- holds the OpenAI Responses-API-shape
  -- array — `[{ id, function: { name, arguments } }, ...]`. The PWA
  -- projection reads this to populate tool-row names + args on
  -- reload; without it, reconciled chats render as "(unknown)".
  tool_calls    TEXT,
  created_at    REAL NOT NULL,
  updated_at    REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'final',
  agent_row_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_links_chat ON msg_links(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_links_agent ON msg_links(agent_row_id);
-- Idempotent migration: ALTER TABLE in sqlite is forgiving when the
-- column already exists (it'd raise; we catch in Python).

-- Provable compaction-replay duplicate rows in state.db, detected by
-- reconcile's full pass (see sidekick_state.
-- _classify_replay_duplicate_state_ids). hermes-core's in-place
-- compaction re-appends the whole rebuilt context into the SAME
-- session on the next turn-end flush (field 2026-07-15/16); the v2
-- read path filters its bounded window against this set so the
-- duplicate copies never render, even when the ORIGINAL row falls
-- outside the window the read fetched. Rows here are advisory-only:
-- a stale entry (state row since deleted) is harmless, and reconcile
-- re-syncs the set for a chat on every full pass.
CREATE TABLE IF NOT EXISTS replay_dups (
  chat_id       TEXT NOT NULL,
  agent_row_id  TEXT NOT NULL,   -- state.db.messages.id (stringified)
  detected_at   REAL NOT NULL,
  PRIMARY KEY (chat_id, agent_row_id)
);

-- ── Transcript v3 — turn-end deterministic linker tables ─────────────
-- The turn linker (sidekick_turn_linker.py) records its
-- envelope↔state.db-row decisions here. Phase 1 ran them DARK
-- (soak-compared against the content reconcile's opinions, never
-- touching msg_links). Since Phase 4 (SIDEKICK_RECONCILE_RETIRED,
-- 2026-07-30) the linker is the real link writer for migrated chats:
-- turn-close claims stamp msg_links.agent_row_id (and mint the
-- orchestration legacy:<id> twins), so these tables are the durable
-- provenance of every write-time link — the stamp precedence check
-- ("never overwrite another linker claim") and Phase 5's divergence
-- monitor (claimed-but-unrepresented detection) both read them. For
-- UNMARKED chats the linker is still dark and reconcile stays
-- authoritative.
--
-- turn_links: one row per state.db message row claimed by an observed
-- turn. msg_id is the envelope-space id (umsg_*/msg_*/tr:<call_id>) or
-- NULL for assistant tool-orchestration rows (no envelope exists for
-- those; comparison treats reconcile's legacy:<id> twin as agreement).
-- method ∈ {user, tool_call_id, orchestration, final}.
CREATE TABLE IF NOT EXISTS turn_links (
  chat_id       TEXT NOT NULL,
  msg_id        TEXT,
  agent_row_id  TEXT NOT NULL,
  turn_id       TEXT NOT NULL,
  method        TEXT NOT NULL,
  created_at    REAL NOT NULL,
  PRIMARY KEY (chat_id, agent_row_id)
);
CREATE INDEX IF NOT EXISTS idx_turn_links_turn ON turn_links(chat_id, turn_id);

-- turn_observations: one row per observed turn WINDOW — the state.db
-- id range (hwm_open, hwm_close] captured between dispatch and
-- reply_final. turn_id is the turn's user_message_id (umsg_*), the
-- notification id (notif_*) for background windows, or gap:<lo>-<hi>
-- for rows that appeared with no observing turn (plugin down /
-- terminal use). status ∈ {open, closed, aborted, background,
-- unobserved}. flags is a JSON object: {"flags": [...],
-- "unclaimed": {agent_row_id: reason}, "inactive_ids": [...],
-- "prelinked_ids": [...], "cmd": bool, "gap": [lo, hi]}.
-- inactive_ids snapshots which window rows had messages.active=0 at
-- capture time (the lighter representation vs a column per link;
-- Phase 3's read path needs it to honor hermes-core's soft deletes).
CREATE TABLE IF NOT EXISTS turn_observations (
  chat_id        TEXT NOT NULL,
  turn_id        TEXT NOT NULL,
  hwm_open       INTEGER NOT NULL,
  hwm_close      INTEGER,
  count_at_open  INTEGER,
  status         TEXT NOT NULL,
  flags          TEXT,
  env_count      INTEGER,
  row_count      INTEGER,
  claimed        INTEGER,
  unclaimed      INTEGER,
  created_at     REAL NOT NULL,
  closed_at      REAL,
  PRIMARY KEY (chat_id, turn_id)
);

-- ── Transcript v3 Phase 2 — backfill + chat migration marker ─────────
-- chat_migrations: one durable row per chat whose pre-write-through
-- history has been imported into msg_links (every live state.db chain
-- row linked or legacy:<id>-imported) and healed of pre-fix
-- orchestration mislinks. Phase 3's read flip (SIDEKICK_ITEMS_V3)
-- serves sidekick.db bodies ONLY for chats holding a row at the
-- current schema_version — see sidekick_chat_migration.py for the
-- mint criteria ("cleanly"). stats is the JSON audit snapshot taken
-- at mint time (state_rows/linked/unresolved/mislinks_healed/…).
CREATE TABLE IF NOT EXISTS chat_migrations (
  chat_id         TEXT PRIMARY KEY,
  migrated_at     REAL NOT NULL,
  schema_version  INTEGER NOT NULL,
  stats           TEXT
);

-- linker_compare_state: durable per-chat compared-through mark
-- (turn_observations.closed_at watermark) for the Phase-1 soak sweep.
-- The in-memory _compare_hwm dies with the process, so every gateway
-- restart re-swept full history and re-WARNed already-judged stale
-- links forever (2026-07-28 re-soak forensics — the standing
-- diverge=0 alert bar was unusable).
CREATE TABLE IF NOT EXISTS linker_compare_state (
  chat_id           TEXT PRIMARY KEY,
  compared_through  REAL NOT NULL
);

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

CREATE TABLE IF NOT EXISTS conversation_titles (
  source      TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  updated_at  REAL NOT NULL,
  PRIMARY KEY (source, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_titles_updated ON conversation_titles(updated_at DESC);

CREATE TABLE IF NOT EXISTS unread_state (
  chat_id        TEXT PRIMARY KEY,
  last_read_at   REAL,
  marked_unread  INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS vapid_keys (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  public_key   TEXT NOT NULL,
  private_key  TEXT NOT NULL,
  subject      TEXT NOT NULL,
  created_at   REAL NOT NULL
);

-- Synced user settings (cross-device). Distinct from push_prefs (which
-- is the push dispatcher's own key/value store): this is the PWA's
-- user-facing settings surface — STT key-terms today, the YAML-backed
-- settings (theme, agentActivity, voice, …) as the migration proceeds.
-- One row per setting; `value` is a JSON blob so a key can hold a
-- scalar, an object, or a list (key-terms = a JSON array under one key).
CREATE TABLE IF NOT EXISTS user_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  REAL NOT NULL
);
"""


# ── Test-isolation guard ───────────────────────────────────────────────
#
# Field incident 2026-07: live push_prefs rows were corrupted during a
# dev/test session running against the production instance — days of
# silently-dropped pushes. Belt-and-braces: any process that sets
# SIDEKICK_TEST_GUARD (the pytest conftest does, unconditionally)
# refuses to open a sidekick DB inside the real state directories.
# Tests operate on tmp paths exclusively; a fixture or helper that
# accidentally resolves to ~/.hermes fails LOUDLY at open, before any
# write can land.

_GUARDED_STATE_DIRS = (".hermes", ".sidekick", ".openclaw-sk-integ")


def _assert_not_live_db_under_test_guard(path: Path) -> None:
    if not os.environ.get("SIDEKICK_TEST_GUARD"):
        return
    try:
        resolved = Path(path).expanduser().resolve()
        home = Path.home().resolve()
    except Exception:  # pragma: no cover — unresolvable paths can't hit live dirs
        return
    for name in _GUARDED_STATE_DIRS:
        guarded = home / name
        if resolved == guarded or guarded in resolved.parents:
            raise RuntimeError(
                f"SIDEKICK_TEST_GUARD is set but SidekickDB path {resolved} "
                f"resolves inside the live state dir {guarded}. Tests must "
                "use tmp paths — refusing to open the production DB."
            )


# Thread-safe shared connection. sqlite3 in Python is locked across
# threads by default unless `check_same_thread=False` is passed; we
# add an explicit lock so concurrent route handlers (aiohttp worker
# pool) don't trip on the GIL race. Write throughput is low (handful
# of ops per turn) so a single lock is fine.
class SidekickDB:
    def __init__(self, path: Path):
        _assert_not_live_db_under_test_guard(path)
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        # Idempotent column adds for forward migrations. SQLite has no
        # IF NOT EXISTS on ALTER TABLE ADD COLUMN, so we swallow the
        # "duplicate column" error.
        for stmt in [
            "ALTER TABLE msg_links ADD COLUMN tool_calls TEXT",
        ]:
            try:
                self._conn.execute(stmt)
            except sqlite3.OperationalError as exc:
                if "duplicate column" not in str(exc).lower():
                    raise

    def exec(self, sql: str, params=()) -> sqlite3.Cursor:
        """Run a write/query under the lock. Use `fetch*` on the cursor."""
        with self._lock:
            return self._conn.execute(sql, params)

    def fetchone(self, sql: str, params=()):
        with self._lock:
            return self._conn.execute(sql, params).fetchone()

    def fetchall(self, sql: str, params=()):
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def close(self):
        with self._lock:
            self._conn.close()


def open_sidekick_db(state_dir: str | None = None) -> SidekickDB:
    """Open (or create) the sidekick supplemental DB.

    `state_dir` defaults to ``$HERMES_STATE_DIR`` or ``~/.hermes``.
    """
    if not state_dir:
        state_dir = os.environ.get("HERMES_STATE_DIR") or os.path.expanduser("~/.hermes")
    path = Path(state_dir) / "sidekick.db"
    return SidekickDB(path)
