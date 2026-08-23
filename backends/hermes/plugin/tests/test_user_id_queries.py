"""Unit tests for the user_id-keyed read path in the parley plugin.

Covers ``ParleyAdapter._summaries_by_user_id`` and
``ParleyAdapter._items_by_user_id`` against an in-temp-file SQLite
state.db that mirrors hermes-agent's schema.

What we exercise:

  * Drawer aggregate produces one row per (user_id, source) pair
    even when a chat has rotated through multiple session_ids.
  * History walks across rotated sessions for the same user_id —
    this is the core regression from the auto-reset bug where the
    old recursive parent_session_id CTE missed messages that lived
    in a session_reset-rotated session.
  * Source filter discriminates: telegram chat_id "1000000001" and
    a synthetic parley chat_id "1000000001" do NOT cross-contaminate
    even though they share the user_id string.
  * Sources allow-list controls which platforms appear in the drawer.
  * Index migration is idempotent (runs cleanly twice).

The plugin's hermes imports are stubbed exactly the same way as
``test_pdf_rasterize.py`` so we can construct the adapter without
the hermes runtime.
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
import types
import time
from pathlib import Path

import pytest


# ── plugin loader (mirror of test_pdf_rasterize.py setup) ────────────

def _install_hermes_stubs() -> None:
    if "gateway" not in sys.modules:
        gateway = types.ModuleType("gateway")
        sys.modules["gateway"] = gateway

    if "gateway.config" not in sys.modules:
        cfg = types.ModuleType("gateway.config")

        class _Platform:
            PARLEY = "parley"

        class _PlatformConfig:
            pass

        cfg.Platform = _Platform
        cfg.PlatformConfig = _PlatformConfig
        sys.modules["gateway.config"] = cfg

    if "gateway.platforms" not in sys.modules:
        sys.modules["gateway.platforms"] = types.ModuleType("gateway.platforms")

    if "gateway.platforms.base" not in sys.modules:
        base = types.ModuleType("gateway.platforms.base")

        class _BasePlatformAdapter:
            pass

        class _MessageEvent:
            pass

        class _MessageType:
            TEXT = "text"

        class _SendResult:
            pass

        base.BasePlatformAdapter = _BasePlatformAdapter
        base.MessageEvent = _MessageEvent
        base.MessageType = _MessageType
        base.SendResult = _SendResult
        sys.modules["gateway.platforms.base"] = base


def _load_plugin():
    """Import the parley plugin under its real package name so the
    package's relative imports (`.parley_ids`,
    `.parley_route_conversations`, ...) resolve. The earlier
    ``spec_from_file_location`` loader minted a fake module name and
    Python's relative-import machinery couldn't resolve siblings
    against it — the test file errored at collection from the
    ``ff9a70b`` extraction onward. Eager-load the route submodules
    too so tests can access them as ``plugin.parley_route_*``."""
    _install_hermes_stubs()
    plugin_pkg = Path(__file__).resolve().parents[1]
    parent_dir = str(plugin_pkg.parent)
    if parent_dir not in sys.path:
        sys.path.insert(0, parent_dir)
    pkg_name = plugin_pkg.name
    pkg = importlib.import_module(pkg_name)
    for sub in (
        "parley_ids",
        "parley_route_conversations",
        "parley_route_items",
        "parley_route_events",
        "parley_route_responses",
        "parley_route_settings",
    ):
        importlib.import_module(f"{pkg_name}.{sub}")
    return pkg


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


# ── state.db fixture: hand-rolled minimal schema ────────────────────

# We don't import hermes-agent's schema — instead, we replicate the
# subset the plugin reads. (The real upstream schema has many more
# columns we don't use: token counts, billing, etc.) This keeps the
# test independent of upstream version drift.
_SCHEMA_SQL = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    title TEXT,
    system_prompt TEXT
);
CREATE INDEX idx_sessions_source ON sessions(source);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_name TEXT,
    -- 2026-05-17 tool-history rebuild columns. role='tool' rows
    -- carry tool_call_id pairing back to the assistant row that
    -- issued the call. Assistant rows that orchestrated calls
    -- store the JSON-encoded OpenAI-shape array here.
    tool_call_id TEXT,
    tool_calls TEXT,
    timestamp REAL NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);

CREATE TABLE parley_msg_links (
    state_db_id INTEGER PRIMARY KEY,
    parley_id TEXT NOT NULL,
    -- 2026-05-14 notification-persistence extension: cron output /
    -- background results / scheduled reminders / approvals all flow
    -- as notification envelopes, and the items endpoint surfaces this
    -- as the row's discriminator (PWA renders the row as a styled
    -- notification instead of a regular reply). NULL for ordinary
    -- user-typed turns + regular replies.
    kind TEXT
);
"""


@pytest.fixture
def state_db(tmp_path):
    """Build a fresh state.db for each test."""
    db = tmp_path / "state.db"
    conn = sqlite3.connect(db)
    conn.executescript(_SCHEMA_SQL)
    conn.commit()
    conn.close()
    return db


def _insert_session(
    db: Path, sid: str, source: str, user_id: str, started_at: float,
    title: str | None = None, parent: str | None = None,
    system_prompt: str | None = None,
) -> None:
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, parent_session_id, "
        "started_at, title, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, source, user_id, parent, started_at, title, system_prompt),
    )
    conn.commit()
    conn.close()


def _insert_message(
    db: Path, session_id: str, role: str, content: str, ts: float,
    tool_name: str | None = None,
) -> int:
    conn = sqlite3.connect(db)
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, timestamp) "
        "VALUES (?, ?, ?, ?, ?)",
        (session_id, role, content, tool_name, ts),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return new_id


def _make_adapter(plugin, state_db_path: Path):
    """Construct an adapter without going through __init__ (which
    needs PlatformConfig). We only exercise pure read methods, so
    bypassing the constructor is fine.

    The state.db query helpers (`_summaries_by_user_id`,
    `_items_by_user_id`, `delete_conversation_sync`,
    `rename_conversation_sync`) live as FREE functions on the route
    submodules — they take ``adapter`` as their first arg. Bind
    them as adapter methods here as a test-side ergonomic wrapper
    so the existing test bodies read naturally; production code
    calls the free functions directly via the route modules."""
    _route_conv = plugin.parley_route_conversations
    _route_items = plugin.parley_route_items

    class _TestAdapter(plugin.ParleyAdapter):
        def _summaries_by_user_id(self, sources, limit):
            return _route_conv._summaries_by_user_id(self, sources, limit)

        def _items_by_user_id(self, chat_id, source, limit, before_id):
            return _route_items._items_by_user_id(
                self, chat_id, source, limit, before_id,
            )

        def _delete_conversation_sync(self, chat_id, source="parley"):
            return _route_conv.delete_conversation_sync(self, chat_id, source)

        def _rename_conversation_sync(self, chat_id, source, title):
            return _route_conv.rename_conversation_sync(
                self, chat_id, source, title,
            )

    adapter = _TestAdapter.__new__(_TestAdapter)
    adapter._state_db_path = state_db_path
    adapter._parley_db = None
    return adapter


# ── tests ────────────────────────────────────────────────────────────


def test_drawer_aggregate_one_row_per_user_id(plugin, state_db):
    """Two sessions for the same user_id+source aggregate into one
    drawer row with summed message_count, latest title, oldest
    created_at, latest last_active_at, and first user message."""
    chat = "709fdd42-7d8c-4105-a1ce-977f3b56e77e"
    # Older session (Series A)
    _insert_session(state_db, "20260430_old", "parley", chat, 1000.0,
                    title="Series A Pitch Deck")
    _insert_message(state_db, "20260430_old", "user", "draft me a pitch deck for series A", 1001.0)
    for i in range(36):
        _insert_message(state_db, "20260430_old", "assistant", f"reply {i}", 1002.0 + i)
    # Newer session (Collaborative scratchpad) — auto-reset, no parent
    _insert_session(state_db, "20260501_new", "parley", chat, 2000.0,
                    title="Collaborative Pitch Deck")
    for i in range(28):
        _insert_message(state_db, "20260501_new", "user" if i == 0 else "assistant",
                        f"new {i}", 2001.0 + i)

    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("parley",), 50)

    assert len(rows) == 1
    (chat_id, source, chat_type, title, mcount, _turn, _tool,
     last_active, created, first, _sids) = rows[0]
    assert chat_id == chat
    assert source == "parley"
    assert chat_type == "dm"
    # Title comes from the LATEST session
    assert title == "Collaborative Pitch Deck"
    # Total message_count across BOTH sessions
    assert mcount == 37 + 28
    # created_at is the OLDEST started_at
    assert created == 1000.0
    # last_active is the latest message timestamp
    assert last_active == 2001.0 + 27
    # first_user_message is the earliest user message in the chat
    assert first == "draft me a pitch deck for series A"


def test_history_walks_rotated_sessions(plugin, state_db):
    """The history fetch sees messages from BOTH rotated sessions
    even though the older one has no parent_session_id (session_reset
    case, not compression). This is the core regression fix."""
    chat = "709fdd42-7d8c-4105-a1ce-977f3b56e77e"
    _insert_session(state_db, "old", "parley", chat, 1000.0, title="Old")
    _insert_message(state_db, "old", "user", "first message", 1001.0)
    _insert_message(state_db, "old", "assistant", "first reply", 1002.0)
    # Auto-reset rotates: brand new session, parent=NULL
    _insert_session(state_db, "new", "parley", chat, 2000.0, title="New")
    _insert_message(state_db, "new", "user", "second message", 2001.0)
    _insert_message(state_db, "new", "assistant", "second reply", 2002.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._items_by_user_id(chat, "parley", 200, None)
    assert result is not None
    items, _first_id, has_more = result
    assert has_more is False
    contents = [m["content"] for m in items]
    assert contents == ["first message", "first reply", "second message", "second reply"]


def test_source_filter_discriminates_collisions(plugin, state_db):
    """A telegram numeric chat_id and a (synthetic) parley chat_id
    that happen to share the same string don't cross-contaminate."""
    same_id = "1000000001"
    _insert_session(state_db, "tg", "telegram", same_id, 1000.0, title="TG")
    _insert_message(state_db, "tg", "user", "telegram-only", 1001.0)
    _insert_session(state_db, "sk", "parley", same_id, 2000.0, title="SK")
    _insert_message(state_db, "sk", "user", "parley-only", 2001.0)

    adapter = _make_adapter(plugin, state_db)

    # History side: each (user_id, source) returns its own messages.
    tg = adapter._items_by_user_id(same_id, "telegram", 200, None)
    sk = adapter._items_by_user_id(same_id, "parley", 200, None)
    assert tg is not None and sk is not None
    assert [m["content"] for m in tg[0]] == ["telegram-only"]
    assert [m["content"] for m in sk[0]] == ["parley-only"]

    # Drawer side: with a single source filter, only that source row appears.
    rows_sk_only = adapter._summaries_by_user_id(("parley",), 50)
    assert len(rows_sk_only) == 1
    assert rows_sk_only[0][0] == same_id
    assert rows_sk_only[0][1] == "parley"

    # With both sources, BOTH rows appear (one per source).
    rows_both = adapter._summaries_by_user_id(("parley", "telegram"), 50)
    sources_returned = sorted(r[1] for r in rows_both if r[0] == same_id)
    assert sources_returned == ["parley", "telegram"]


def test_drawer_sources_allowlist(plugin, state_db):
    """Sources NOT in the allow-list are filtered out."""
    _insert_session(state_db, "tg", "telegram", "tg_chat", 1000.0, title="TG")
    _insert_message(state_db, "tg", "user", "hi", 1001.0)
    _insert_session(state_db, "sk", "parley", "sk_chat", 2000.0, title="SK")
    _insert_message(state_db, "sk", "user", "hi", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    rows_sk_only = adapter._summaries_by_user_id(("parley",), 50)
    assert [r[0] for r in rows_sk_only] == ["sk_chat"]

    rows_both = adapter._summaries_by_user_id(("parley", "telegram"), 50)
    assert sorted(r[0] for r in rows_both) == ["sk_chat", "tg_chat"]


def test_history_before_id_pagination(plugin, state_db):
    """before_id cursor returns only older messages."""
    _insert_session(state_db, "s1", "parley", "u", 1000.0, title="t")
    ids = []
    for i in range(10):
        ids.append(_insert_message(state_db, "s1", "user", f"m{i}", 1001.0 + i))

    adapter = _make_adapter(plugin, state_db)
    # Fetch latest 5 (no cursor)
    result = adapter._items_by_user_id("u", "parley", 5, None)
    assert result is not None
    items, first_id, has_more = result
    assert [m["content"] for m in items] == ["m5", "m6", "m7", "m8", "m9"]
    assert has_more is True
    # Page back from first_id
    result2 = adapter._items_by_user_id("u", "parley", 5, first_id)
    assert result2 is not None
    items2, _, has_more2 = result2
    assert [m["content"] for m in items2] == ["m0", "m1", "m2", "m3", "m4"]
    assert has_more2 is True  # exactly `limit` returned


def test_history_no_match_returns_none(plugin, state_db):
    adapter = _make_adapter(plugin, state_db)
    assert adapter._items_by_user_id("nonexistent", "parley", 50, None) is None


def test_history_skips_context_compaction_rows(plugin, state_db):
    _insert_session(state_db, "s1", "parley", "u", 1000.0)
    _insert_message(state_db, "s1", "user", "real", 1001.0)
    _insert_message(state_db, "s1", "system", "[CONTEXT COMPACTION] internal", 1002.0)
    _insert_message(state_db, "s1", "assistant", "real reply", 1003.0)
    adapter = _make_adapter(plugin, state_db)
    result = adapter._items_by_user_id("u", "parley", 50, None)
    assert result is not None
    items, _, _ = result
    assert [m["content"] for m in items] == ["real", "real reply"]


def test_drawer_orders_by_last_active_desc(plugin, state_db):
    _insert_session(state_db, "old", "parley", "old_chat", 1000.0, title="O")
    _insert_message(state_db, "old", "user", "old", 1001.0)
    _insert_session(state_db, "new", "parley", "new_chat", 2000.0, title="N")
    _insert_message(state_db, "new", "user", "new", 2001.0)
    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("parley",), 50)
    assert [r[0] for r in rows] == ["new_chat", "old_chat"]


def test_drawer_includes_compression_forks_via_user_id(plugin, state_db):
    """parent_session_id chains (compression case) ALSO inherit user_id,
    so they're already covered by the (user_id, source) GROUP BY.
    Counts include both the root and the fork."""
    _insert_session(state_db, "root", "parley", "u", 1000.0, title="root")
    _insert_message(state_db, "root", "user", "rooted", 1001.0)
    _insert_session(state_db, "fork", "parley", "u", 2000.0, title="fork",
                    parent="root")
    _insert_message(state_db, "fork", "user", "forked", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("parley",), 50)
    assert len(rows) == 1
    chat_id, _src, _ctype, title, mcount, _turn, _tool, last_active, created, _first, _sids = rows[0]
    assert chat_id == "u"
    assert title == "fork"  # latest started_at
    assert mcount == 2
    assert created == 1000.0
    assert last_active == 2001.0


_PARLEY_PROMPT = (
    "# SOUL.md - Who You Are (Clawdian)\n\n"
    "## Core Truths\n\n"
    "**Be concise by default.** Skip preamble.\n\n"
    "## Voice\n\n"
    "Direct. Honest about limits. Push back on plausible-sounding "
    "ideas that don't have evidence behind them. Distinguish what "
    "you know from what you're inferring."
)
assert len(_PARLEY_PROMPT) >= 200, "fixture must exceed prefix-match threshold"
_HERMES_DEFAULT_PROMPT = (
    "You are Hermes Agent, an intelligent AI assistant created by "
    "Nous Research. You help with various tasks including coding, "
    "analysis, research, and creative work. You have access to tools "
    "for file system, web search, and more."
)
assert len(_HERMES_DEFAULT_PROMPT) >= 200, "fixture must exceed threshold for negative test"


def test_drawer_rolls_up_compacted_null_user_id_child(plugin, state_db):
    """Hermes compaction creates child sessions with user_id=NULL,
    breaking the upstream contract that "rotated sessions inherit
    user_id."
    The recursive CTE walks parent_session_id chains so the child's
    messages get rolled up under the root's user_id — BUT only if
    the child's system_prompt matches the parent's (compaction
    continuations inherit the prompt; delegate sub-tasks use the
    default hermes-agent prompt and are excluded).

    Pre-CTE: drawer query filters WHERE user_id IS NOT NULL → child
    invisible → mcount=2 only (root's messages). Drawer-list shows
    a chat that's "missing" the compacted continuation.

    Post-CTE: child resolves to root_user_id via parent chain →
    mcount=5 (both root + child). Drawer-list shows the full chat."""
    _insert_session(state_db, "root", "parley", "u", 1000.0, title="root",
                    system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "root", "user", "before compaction", 1001.0)
    _insert_message(state_db, "root", "assistant", "reply 1", 1002.0)
    # Compacted child — user_id IS NULL (the broken upstream
    # invariant) but system_prompt MATCHES the root (compaction
    # continuation inherits the prompt).
    _insert_session(state_db, "compacted", "parley", None, 2000.0,
                    title="root #2", parent="root",
                    system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "compacted", "user", "post compaction", 2001.0)
    _insert_message(state_db, "compacted", "assistant", "reply 2", 2002.0)
    _insert_message(state_db, "compacted", "assistant", "reply 3", 2003.0)

    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("parley",), 50)
    assert len(rows) == 1
    chat_id, _src, _ctype, title, mcount, _turn, _tool, last_active, created, _first, _sids = rows[0]
    assert chat_id == "u"
    assert title == "root #2"  # latest started_at wins
    assert mcount == 5  # 2 root + 3 compacted child
    assert created == 1000.0
    assert last_active == 2003.0


def test_drawer_excludes_delegate_subtask_with_different_prompt(plugin, state_db):
    """The system_prompt gate prevents over-inclusion: delegate
    sub-task sessions (hermes-agent uses these when the agent calls
    `delegate_tool` for sub-work) ALSO have parent_session_id and
    user_id=NULL, but use the DEFAULT hermes-agent system_prompt
    instead of inheriting the parent's. Their messages must NOT
    roll up into the drawer's user-facing message_count.

    Without the prompt gate the drawer can inflate message_count
    significantly by including unrelated delegate sub-task messages."""
    _insert_session(state_db, "root", "parley", "u", 1000.0, title="root",
                    system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "root", "user", "user msg", 1001.0)
    _insert_message(state_db, "root", "assistant", "reply", 1002.0)
    # Delegate sub-task — parent=root, user_id=NULL, but DIFFERENT
    # system_prompt (default hermes-agent persona). Should NOT roll up.
    _insert_session(state_db, "delegate", "parley", None, 2000.0,
                    parent="root", system_prompt=_HERMES_DEFAULT_PROMPT)
    for i in range(10):
        _insert_message(state_db, "delegate", "assistant", f"delegate msg {i}",
                        2001.0 + i)

    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("parley",), 50)
    assert len(rows) == 1
    _chat_id, _src, _ctype, _title, mcount, _turn, _tool, _last, _created, _first, _sids = rows[0]
    assert mcount == 2, (
        f"delegate sub-task messages must not be counted; expected 2 "
        f"(root only), got {mcount}"
    )


def test_history_walks_compacted_null_user_id_child(plugin, state_db):
    """Twin of the drawer test for `_items_by_user_id`: transcript
    fetch must return messages from BOTH the root and compacted
    child sessions when the child has user_id=NULL AND a matching
    system_prompt. Pre-CTE: only root's messages appear. Post-CTE: both."""
    _insert_session(state_db, "root", "parley", "u", 1000.0,
                    system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "root", "user", "root msg 1", 1001.0)
    _insert_message(state_db, "root", "assistant", "root reply 1", 1002.0)
    _insert_session(state_db, "compacted", "parley", None, 2000.0,
                    parent="root", system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "compacted", "user", "child msg 1", 2001.0)
    _insert_message(state_db, "compacted", "assistant", "child reply 1", 2002.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._items_by_user_id("u", "parley", 200, None)
    assert result is not None
    items, _first_id, _has_more = result
    assert len(items) == 4
    contents = [it["content"] for it in items]
    assert contents == ["root msg 1", "root reply 1", "child msg 1", "child reply 1"]


def test_history_excludes_delegate_subtask_messages(plugin, state_db):
    """Same as the drawer test, for the history-fetch path: a
    delegate sub-task with a different system_prompt is reachable
    via parent_session_id but its messages are NOT user-visible
    transcript content. The CTE's system_prompt gate excludes them."""
    _insert_session(state_db, "root", "parley", "u", 1000.0,
                    system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "root", "user", "user msg", 1001.0)
    _insert_session(state_db, "delegate", "parley", None, 2000.0,
                    parent="root", system_prompt=_HERMES_DEFAULT_PROMPT)
    _insert_message(state_db, "delegate", "assistant", "delegate work", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._items_by_user_id("u", "parley", 200, None)
    assert result is not None
    items, _first_id, _has_more = result
    contents = [it["content"] for it in items]
    assert contents == ["user msg"], (
        f"delegate messages must be excluded from transcript; got {contents}"
    )


def test_history_walks_multi_level_compaction_chain(plugin, state_db):
    """Compaction can rotate multiple times. The CTE must walk the
    full parent_session_id chain, not just one level. All links in
    the chain must carry a matching system_prompt to count."""
    _insert_session(state_db, "root", "parley", "u", 1000.0,
                    system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "root", "user", "root msg", 1001.0)
    _insert_session(state_db, "child1", "parley", None, 2000.0, parent="root",
                    system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "child1", "user", "child1 msg", 2001.0)
    _insert_session(state_db, "child2", "parley", None, 3000.0, parent="child1",
                    system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "child2", "user", "child2 msg", 3001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._items_by_user_id("u", "parley", 200, None)
    assert result is not None
    items, _first_id, _has_more = result
    contents = [it["content"] for it in items]
    assert contents == ["root msg", "child1 msg", "child2 msg"]


def test_drawer_accepts_compacted_child_with_appended_prompt(plugin, state_db):
    """Real hermes compaction APPENDS context summary to the
    inherited system_prompt rather than copying byte-for-byte:

      Root system_prompt:        "# SOUL.md - ... [22532 chars]"
      Compacted child prompt:    "# SOUL.md - ... [22532 chars][101 chars of context]"

    The CTE must roll up children whose system_prompt STARTS WITH
    the root's, not just exact-match (compaction appends a context
    summary suffix to the base prompt)."""
    _insert_session(state_db, "root", "parley", "u", 1000.0,
                    system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "root", "user", "before", 1001.0)
    _insert_session(state_db, "compacted", "parley", None, 2000.0,
                    parent="root",
                    system_prompt=_PARLEY_PROMPT + "\n\n[CONTEXT SUMMARY: ...]")
    _insert_message(state_db, "compacted", "user", "after", 2001.0)
    _insert_message(state_db, "compacted", "assistant", "ok", 2002.0)

    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("parley",), 50)
    assert len(rows) == 1
    _chat_id, _src, _ctype, _title, mcount, _turn, _tool, _last, _created, _first, _sids = rows[0]
    assert mcount == 3, (
        f"compaction child with appended prompt must be rolled up "
        f"(prefix-match); got mcount={mcount}"
    )

    # Same expectation for history fetch.
    result = adapter._items_by_user_id("u", "parley", 200, None)
    assert result is not None
    items, _first_id, _has_more = result
    assert [it["content"] for it in items] == ["before", "after", "ok"]


def test_index_migration_idempotent(plugin, state_db):
    """Running the index migration twice is a no-op."""
    adapter = _make_adapter(plugin, state_db)
    adapter._ensure_state_db_indexes()
    adapter._ensure_state_db_indexes()
    # Verify the index actually exists
    conn = sqlite3.connect(state_db)
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
        ("idx_sessions_user_id_source",),
    )
    assert cur.fetchone() is not None
    conn.close()


def test_drawer_first_user_message_truncated_to_80_chars(plugin, state_db):
    long_msg = "x" * 200
    _insert_session(state_db, "s1", "parley", "u", 1000.0)
    _insert_message(state_db, "s1", "user", long_msg, 1001.0)
    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("parley",), 50)
    assert len(rows) == 1
    # Index 9 = first_user_truncated in the 11-tuple shape
    # (chat_id, source, chat_type, title, message_count, turn_count,
    #  tool_count, last_active_at, created_at, first_user_message,
    #  session_ids).
    first_user = rows[0][9]
    assert first_user is not None
    assert len(first_user) == 80


def test_drawer_excludes_null_user_id_sessions(plugin, state_db):
    """Sessions with NULL user_id (legacy / non-platform sessions)
    should not appear in the drawer."""
    _insert_session(state_db, "s1", "parley", None, 1000.0, title="orphan")
    _insert_message(state_db, "s1", "user", "hi", 1001.0)
    _insert_session(state_db, "s2", "parley", "u", 2000.0, title="real")
    _insert_message(state_db, "s2", "user", "hi", 2001.0)
    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("parley",), 50)
    assert [r[0] for r in rows] == ["u"]


def test_drawer_session_ids_includes_rotated_children(plugin, state_db):
    """The drawer row carries a space-joined list of EVERY hermes
    session id that rolls up into it (root + compacted children), so
    the client's session filter can match a pasted raw session id —
    including a rotated child's id, which is exactly what the user
    pastes from agent output (field bug 2026-06-11: a rotated child's
    id matched nothing in the Filter Sessions box)."""
    _insert_session(state_db, "20260601_root", "parley", "u", 1000.0,
                    system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "20260601_root", "user", "hi", 1001.0)
    _insert_session(state_db, "20260611_223425_98bd2b", "parley", None,
                    2000.0, parent="20260601_root",
                    system_prompt=_PARLEY_PROMPT)
    _insert_message(state_db, "20260611_223425_98bd2b", "user", "more", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("parley",), 50)
    assert len(rows) == 1
    session_ids = rows[0][10]
    ids = set(session_ids.split(" "))
    assert ids == {"20260601_root", "20260611_223425_98bd2b"}


# ── _session_id_matches (cmd+K search by raw session id) ─────────────


def _id_matches(plugin, state_db, q):
    conn = sqlite3.connect(state_db)
    try:
        return plugin.ParleyAdapter._session_id_matches(conn, q)
    finally:
        conn.close()


def test_session_id_search_resolves_null_user_id_child(plugin, state_db):
    """Searching a rotated child's session id (user_id=NULL) resolves
    to the ROOT conversation's (chat_id, source) by walking
    parent_session_id — the exact field-bug case."""
    _insert_session(state_db, "20260601_root", "parley", "u", 1000.0,
                    title="Root Chat")
    _insert_session(state_db, "20260611_223425_98bd2b", "parley", None,
                    2000.0, parent="20260601_root")

    rows = _id_matches(plugin, state_db, "20260611_223425_98bd2b")
    assert rows == [("u", "parley", "Root Chat")]
    # Fragment of the id matches too (substring semantics).
    rows = _id_matches(plugin, state_db, "98bd2b")
    assert rows == [("u", "parley", "Root Chat")]


def test_session_id_search_escapes_like_underscore(plugin, state_db):
    """`_` in the query is a literal underscore, not a LIKE
    single-char wildcard. "2026x611" must NOT match "20260611_x"
    via an unescaped `_` in a query like "2026_611"."""
    _insert_session(state_db, "20260611_abc", "parley", "u1", 1000.0,
                    title="T")
    rows = _id_matches(plugin, state_db, "0611_abc")
    assert [(r[0]) for r in rows] == ["u1"]
    # Underscore must not act as a wildcard: "0611Xabc" has no
    # underscore at that position and must not match.
    assert _id_matches(plugin, state_db, "0611Xabc") == []


def test_session_id_search_skips_non_id_queries(plugin, state_db):
    """Multi-word, short, and non-alnum queries skip the id pass."""
    _insert_session(state_db, "20260611_abc", "parley", "u1", 1000.0)
    assert _id_matches(plugin, state_db, "two words") == []
    assert _id_matches(plugin, state_db, "ab") == []
    assert _id_matches(plugin, state_db, "foo-bar") == []


def test_session_id_search_dedupes_multiple_children(plugin, state_db):
    """Two rotated children of the same root resolving to the same
    chat collapse to one result row."""
    _insert_session(state_db, "20260601_root", "parley", "u", 1000.0,
                    title="Root")
    _insert_session(state_db, "20260611_aaa", "parley", None, 2000.0,
                    parent="20260601_root")
    _insert_session(state_db, "20260611_bbb", "parley", None, 3000.0,
                    parent="20260601_root")
    rows = _id_matches(plugin, state_db, "20260611")
    assert rows == [("u", "parley", "Root")]


# ── Gateway id encoding (contract uniqueness across sources) ─────────


def test_format_gateway_id_round_trip(plugin):
    """Encode/decode round-trip preserves source and chat_id, including
    chat_ids with `@` and other platform-shaped characters."""
    cases = [
        ("parley", "709fdd42-7d8c-4105-a1ce-977f3b56e77e"),
        ("whatsapp", "199999999999999@lid"),
        ("whatsapp", "15551234567@s.whatsapp.net"),
        ("telegram", "1000000001"),
    ]
    for source, chat_id in cases:
        encoded = plugin._format_gateway_id(source, chat_id)
        parsed_source, parsed_chat = plugin._parse_gateway_id(encoded)
        assert parsed_source == source
        assert parsed_chat == chat_id


def test_parse_gateway_id_rejects_unknown_prefix(plugin):
    """A bare chat_id (no prefix) returns (None, id_str). A string with
    a colon whose prefix is NOT a known source is also treated as bare —
    defensive against future chat_id formats containing colons."""
    assert plugin._parse_gateway_id("199999999999999@lid") == (None, "199999999999999@lid")
    assert plugin._parse_gateway_id("notasource:something") == (None, "notasource:something")


def test_gateway_id_unique_for_cross_source_chat_id_collision(plugin, state_db):
    """The smoking-gun regression: two sessions sharing user_id but
    differing in source must produce DISTINCT gateway ids when the
    drawer aggregate is encoded for the on-the-wire response. Before
    this fix, both rows emitted `id = chat_id` and the frontend
    rendered two LIs with the same `data-chat-id` (click activated
    both, history fetched the wrong one)."""
    same_id = "199999999999999@lid"
    _insert_session(state_db, "wa", "whatsapp", same_id, 1000.0, title="WhatsApp thread")
    _insert_message(state_db, "wa", "user", "voice memo", 1001.0)
    _insert_session(state_db, "sk", "parley", same_id, 2000.0, title="Barge in test")
    _insert_message(state_db, "sk", "user", "cookies?", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("parley", "whatsapp"), 50)
    assert len(rows) == 2
    encoded_ids = [plugin._format_gateway_id(src, cid) for cid, src, *_ in rows]
    assert len(set(encoded_ids)) == 2
    assert "parley:199999999999999@lid" in encoded_ids
    assert "whatsapp:199999999999999@lid" in encoded_ids


def test_delete_conversation_sync_source_aware(plugin, state_db):
    """Deleting `(whatsapp, chat_id)` must scrub the whatsapp session
    rows ONLY — not the parley rows that share the same user_id.
    Previously _delete_conversation_sync hardcoded source=parley
    and would silently delete the wrong rows for cross-source
    collisions."""
    same_id = "199999999999999@lid"
    _insert_session(state_db, "wa", "whatsapp", same_id, 1000.0, title="WA")
    _insert_message(state_db, "wa", "user", "wa-msg", 1001.0)
    _insert_session(state_db, "sk", "parley", same_id, 2000.0, title="SK")
    _insert_message(state_db, "sk", "user", "sk-msg", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._delete_conversation_sync(same_id, "whatsapp")
    assert result == "ok"

    # Whatsapp session gone, parley session intact.
    conn = sqlite3.connect(state_db)
    rows = conn.execute(
        "SELECT id, source FROM sessions WHERE user_id = ?", (same_id,),
    ).fetchall()
    conn.close()
    assert sorted(rows) == [("sk", "parley")]


def test_delete_conversation_sync_default_source_back_compat(plugin, state_db):
    """Calling _delete_conversation_sync without a source still defaults
    to SIDEKICK_SOURCE — preserves behavior for any legacy un-prefixed
    delete callers."""
    _insert_session(state_db, "sk", "parley", "u", 1000.0, title="SK")
    _insert_message(state_db, "sk", "user", "hi", 1001.0)
    adapter = _make_adapter(plugin, state_db)
    result = adapter._delete_conversation_sync("u")
    assert result == "ok"


# ── Rename (PATCH /v1/conversations/{id}) ────────────────────────────


def test_rename_conversation_sync_updates_title(plugin, state_db):
    """Happy path: PATCH-driven rename rewrites sessions.title for the
    `(source, user_id)` pair and is visible via the drawer aggregate."""
    chat = "709fdd42-7d8c-4105-a1ce-977f3b56e77e"
    _insert_session(state_db, "s1", "parley", chat, 1000.0, title="auto-title")
    _insert_message(state_db, "s1", "user", "hi", 1001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(chat, "parley", "Bug bash")
    assert result == "ok"

    # Verify state.db was actually written.
    conn = sqlite3.connect(state_db)
    rows = conn.execute(
        "SELECT title FROM sessions WHERE user_id = ? AND source = ?",
        (chat, "parley"),
    ).fetchall()
    conn.close()
    assert rows == [("Bug bash",)]

    # And the drawer surfaces the new title via _summaries_by_user_id.
    drawer = adapter._summaries_by_user_id(("parley",), 50)
    assert len(drawer) == 1
    assert drawer[0][3] == "Bug bash"


def test_rename_conversation_sync_updates_only_latest_session(plugin, state_db):
    """A chat with rotated sessions (compression / auto-reset) only
    has the LATEST row's title updated. We can't rewrite all rotated
    rows to the same title because hermes-agent's real schema has a
    partial UNIQUE INDEX on ``sessions(title) WHERE title IS NOT
    NULL``; the drawer's ``_summaries_by_user_id`` picks the latest
    title via ``ORDER BY started_at DESC LIMIT 1`` so this is the
    row that surfaces in the UI."""
    chat = "u"
    _insert_session(state_db, "old", "parley", chat, 1000.0, title="old-auto")
    _insert_message(state_db, "old", "user", "msg1", 1001.0)
    _insert_session(state_db, "new", "parley", chat, 2000.0, title="new-auto")
    _insert_message(state_db, "new", "user", "msg2", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(chat, "parley", "Renamed")
    assert result == "ok"

    conn = sqlite3.connect(state_db)
    rows = conn.execute(
        "SELECT id, title FROM sessions WHERE user_id = ? AND source = ?"
        " ORDER BY id",
        (chat, "parley"),
    ).fetchall()
    conn.close()
    # Only the latest (started_at=2000) row is updated.
    assert rows == [("new", "Renamed"), ("old", "old-auto")]

    # Drawer surfaces the updated title regardless.
    drawer = adapter._summaries_by_user_id(("parley",), 50)
    assert len(drawer) == 1
    assert drawer[0][3] == "Renamed"


def test_rename_conversation_sync_title_conflict(plugin, state_db):
    """If another session already holds this title, return
    'title_conflict' (route surfaces 409). Models the partial UNIQUE
    INDEX in hermes-agent's real schema."""
    # Build a state.db with the same partial UNIQUE INDEX hermes-agent
    # ships. The base fixture omits it because most tests don't need
    # it; we add it here so the rename helper's pre-check actually
    # has a competitor to find.
    conn = sqlite3.connect(state_db)
    conn.execute(
        "CREATE UNIQUE INDEX idx_sessions_title_unique "
        "ON sessions(title) WHERE title IS NOT NULL"
    )
    conn.commit()
    conn.close()

    _insert_session(state_db, "a", "parley", "chat-a", 1000.0, title="Series A")
    _insert_message(state_db, "a", "user", "hi", 1001.0)
    _insert_session(state_db, "b", "parley", "chat-b", 2000.0, title="Series B")
    _insert_message(state_db, "b", "user", "hi", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync("chat-b", "parley", "Series A")
    assert result == "title_conflict"

    # Original row untouched.
    conn = sqlite3.connect(state_db)
    rows = conn.execute(
        "SELECT id, title FROM sessions ORDER BY id",
    ).fetchall()
    conn.close()
    assert rows == [("a", "Series A"), ("b", "Series B")]


def test_rename_conversation_sync_clears_stale_sibling_title(plugin, state_db):
    """Same chat_id has a STALE sibling rotation row holding the requested
    title — clear it and proceed. Models the hermes session-compression
    case where the user renamed pre-rotation; the new latest row should
    inherit the name without a 409. Drawer only ever surfaces the latest,
    so the sibling losing its title is invisible to the user.
    """
    conn = sqlite3.connect(state_db)
    conn.execute(
        "CREATE UNIQUE INDEX idx_sessions_title_unique "
        "ON sessions(title) WHERE title IS NOT NULL"
    )
    conn.commit()
    conn.close()

    chat = "chat-rotated"
    # Pre-rotation row that holds the user's name.
    _insert_session(state_db, "s_old", "parley", chat, 1000.0, title="[audio test]")
    _insert_message(state_db, "s_old", "user", "hi", 1001.0)
    # Post-rotation row, auto-titled to something else, currently latest.
    _insert_session(state_db, "s_new", "parley", chat, 2000.0, title="Repeating the Number 38")
    _insert_message(state_db, "s_new", "user", "hi", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(chat, "parley", "[audio test]")
    assert result == "ok"

    conn = sqlite3.connect(state_db)
    rows = dict(conn.execute("SELECT id, title FROM sessions").fetchall())
    conn.close()
    # Latest row took the name; old sibling cleared.
    assert rows["s_new"] == "[audio test]"
    assert rows["s_old"] is None


def test_rename_conversation_sync_targets_latest_continuation(plugin, state_db):
    """Compression continuations can have user_id=NULL and inherit the
    Parley chat through parent_session_id. Rename must update the latest
    continuation row, because that is the title the drawer displays.
    """
    conn = sqlite3.connect(state_db)
    conn.execute(
        "CREATE UNIQUE INDEX idx_sessions_title_unique "
        "ON sessions(title) WHERE title IS NOT NULL"
    )
    conn.commit()
    conn.close()

    chat = "chat-compressed"
    prompt = "Parley prompt " * 30
    _insert_session(
        state_db, "root", "parley", chat, 1000.0,
        title="pitch deck v10+", system_prompt=prompt,
    )
    _insert_message(state_db, "root", "user", "hi", 1001.0)
    _insert_session(
        state_db, "child", "parley", None, 2000.0,
        title="SpaceX Starship Launch Outcome #2", parent="root",
        system_prompt=prompt,
    )
    _insert_message(state_db, "child", "user", "follow-up", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(chat, "parley", "pitch deck v10+")
    assert result == "ok"

    conn = sqlite3.connect(state_db)
    rows = dict(conn.execute("SELECT id, title FROM sessions").fetchall())
    conn.close()
    assert rows["child"] == "pitch deck v10+"
    assert rows["root"] is None

    drawer = adapter._summaries_by_user_id(("parley",), 50)
    assert len(drawer) == 1
    assert drawer[0][3] == "pitch deck v10+"


def test_parley_title_override_wins_over_latest_continuation(plugin, state_db, tmp_path):
    """User-provided Parley titles are chat-level UI state and should
    override whatever Hermes auto-titles the latest compressed session.
    """
    chat = "chat-title-override"
    prompt = "Parley prompt " * 30
    _insert_session(
        state_db, "root", "parley", chat, 1000.0,
        title="User Name", system_prompt=prompt,
    )
    _insert_message(state_db, "root", "user", "hi", 1001.0)
    _insert_session(
        state_db, "child", "parley", None, 2000.0,
        title="Compression Auto Title", parent="root", system_prompt=prompt,
    )
    _insert_message(state_db, "child", "user", "follow-up", 2001.0)

    sdb_mod = importlib.import_module(f"{plugin.__name__}.parley_db")
    adapter = _make_adapter(plugin, state_db)
    adapter._parley_db = sdb_mod.ParleyDB(tmp_path / "parley.db")
    adapter._parley_db.exec(
        "INSERT INTO conversation_titles (source, chat_id, title, updated_at) VALUES (?, ?, ?, ?)",
        ("parley", chat, "User Name", 3000.0),
    )

    drawer = adapter._summaries_by_user_id(("parley",), 50)
    assert len(drawer) == 1
    assert drawer[0][3] == "User Name"


def test_rename_conversation_sync_idempotent_same_title(plugin, state_db):
    """Renaming to the title the row already has is a no-op success,
    NOT a conflict — the latest row matches its own title."""
    chat = "u"
    _insert_session(state_db, "s1", "parley", chat, 1000.0, title="Existing")
    _insert_message(state_db, "s1", "user", "hi", 1001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(chat, "parley", "Existing")
    assert result == "ok"


def test_rename_conversation_sync_not_found(plugin, state_db):
    """No session for `(source, user_id)` → 'not_found' (route
    surfaces 404)."""
    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(
        "nonexistent", "parley", "Whatever",
    )
    assert result == "not_found"


def test_rename_conversation_sync_source_isolation(plugin, state_db):
    """Renaming `(parley, chat_id)` doesn't touch a `(whatsapp,
    chat_id)` row that happens to share the same user_id string."""
    same_id = "199999999999999@lid"
    _insert_session(state_db, "wa", "whatsapp", same_id, 1000.0, title="WA-orig")
    _insert_message(state_db, "wa", "user", "wa", 1001.0)
    _insert_session(state_db, "sk", "parley", same_id, 2000.0, title="SK-orig")
    _insert_message(state_db, "sk", "user", "sk", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(same_id, "parley", "SK-new")
    assert result == "ok"

    conn = sqlite3.connect(state_db)
    rows = conn.execute(
        "SELECT id, source, title FROM sessions WHERE user_id = ?"
        " ORDER BY id",
        (same_id,),
    ).fetchall()
    conn.close()
    assert rows == [
        ("sk", "parley", "SK-new"),
        ("wa", "whatsapp", "WA-orig"),
    ]


def test_session_title_max_len_constant(plugin):
    """Document the cap so a future bump doesn't silently lose data.
    Constant moved into parley_route_conversations alongside its
    consumers (the rename + delete sync paths) in the 2026-05-17
    refactor; the package-root re-export is gone."""
    assert plugin.parley_route_conversations.SESSION_TITLE_MAX_LEN == 200
