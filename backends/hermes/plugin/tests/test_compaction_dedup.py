"""Unit tests for the items endpoint's compaction-injection filter.

Background: hermes' context-compaction creates a child session and
inserts a
synthesized "context-window seed" block at its head — a verbatim copy
of the user prompt that triggered compaction, plus replays of recent
assistant/tool rows, ending in a `[CONTEXT COMPACTION — REFERENCE
ONLY]` marker. The plugin's items endpoint walked the recursive
session-chain CTE and shipped ALL of these rows to the PWA, only
filtering the marker itself. Result: the user saw their original
prompt at the top (real, from parent) AND again near the end
(injection dupe in child) — plus replayed assistant/tool rows in
between. Incoherent transcript.

Fix lives in ``parley_route_items._items_by_user_id``: per child
session, find the LAST row with content starting with `[CONTEXT
COMPACTION`, drop that row AND every row in the same session with
``id <= marker_id`` (the seed block always sits at the head of the
child session, before any real new content).

These tests build a minimal fixture matching the production shape
and assert the filter holds.
"""

from __future__ import annotations

import importlib
import sqlite3
import sys
import time
import types
from pathlib import Path

import pytest


# ── plugin loader (mirror of test_user_id_queries.py) ────────────────


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
    """Real-name package import + eager-load route submodules so the
    items helper is accessible as plugin.parley_route_items."""
    _install_hermes_stubs()
    plugin_pkg = Path(__file__).resolve().parents[1]
    parent_dir = str(plugin_pkg.parent)
    if parent_dir not in sys.path:
        sys.path.insert(0, parent_dir)
    pkg = importlib.import_module(plugin_pkg.name)
    for sub in (
        "parley_ids", "parley_route_conversations",
        "parley_route_items", "parley_route_events",
        "parley_route_responses", "parley_route_settings",
    ):
        importlib.import_module(f"{plugin_pkg.name}.{sub}")
    return pkg


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


# ── state.db fixture: minimal schema mirroring hermes_state.py ──────


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
    tool_call_id TEXT,
    tool_calls TEXT,
    timestamp REAL NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
CREATE TABLE parley_msg_links (
    state_db_id INTEGER PRIMARY KEY,
    parley_id TEXT NOT NULL,
    kind TEXT
);
"""

# Parley prompt must exceed the recursive CTE's 200-char prefix-match
# floor so the child session is recognised as a compaction continuation
# (vs delegate sub-task). Mirrors hermes' actual parley system
# prompt scale.
PARLEY_PROMPT = "S" * 500


@pytest.fixture
def state_db(tmp_path):
    db = tmp_path / "state.db"
    conn = sqlite3.connect(db)
    conn.executescript(_SCHEMA_SQL)
    conn.commit()
    conn.close()
    return db


def _ins_session(db, sid, source, user_id, started_at, *,
                 parent=None, title=None, system_prompt=PARLEY_PROMPT):
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, parent_session_id, "
        "started_at, title, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, source, user_id, parent, started_at, title, system_prompt),
    )
    conn.commit()
    conn.close()


def _ins_msg(db, session_id, role, content, ts):
    conn = sqlite3.connect(db)
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) "
        "VALUES (?, ?, ?, ?)",
        (session_id, role, content, ts),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return new_id


def _make_adapter(plugin, state_db_path):
    """Bare instance — items helper only reads _state_db_path."""
    adapter = plugin.ParleyAdapter.__new__(plugin.ParleyAdapter)
    adapter._state_db_path = state_db_path
    return adapter


# ── the actual tests ─────────────────────────────────────────────────


def test_compaction_injection_block_filtered(plugin, state_db):
    """Production-shaped repro: a parent session with the user's
    original prompt + agent reply, then a child session whose head
    contains a verbatim user-prompt dupe + replayed assistant/tool
    rows + the [CONTEXT COMPACTION] marker, then real new content.
    Items endpoint must drop the injection block (and the marker)
    and return ONLY the parent-real rows + child-real rows."""
    chat = "chat-with-compaction"
    t0 = 1_700_000_000.0  # arbitrary base epoch
    _ins_session(state_db, "parent", "parley", chat, t0)
    # Parent session: real user prompt + real agent reply + tools.
    _ins_msg(state_db, "parent", "user",
             "Hey. I had a conversation with Oleg yesterday…", t0 + 1)
    _ins_msg(state_db, "parent", "assistant",
             "On it — I'll turn the sprawl into something usable.", t0 + 2)
    _ins_msg(state_db, "parent", "tool", "[tool result A]", t0 + 3)
    _ins_msg(state_db, "parent", "tool", "[tool result B]", t0 + 4)

    # Child compaction session — same chat_id semantics (user_id=NULL,
    # parent_session_id set, matching system_prompt prefix). All
    # injection rows share a single millisecond timestamp (hermes
    # writes them in one transaction).
    t_compact = t0 + 100.0
    _ins_session(state_db, "child", "parley", None, t_compact,
                 parent="parent")
    # Injection seed block: verbatim user-prompt dupe + replayed
    # assistant + replayed tools + marker.
    _ins_msg(state_db, "child", "user",
             "Hey. I had a conversation with Oleg yesterday…",
             t_compact + 0.001)
    _ins_msg(state_db, "child", "assistant",
             "On it — I'll turn the sprawl into something usable.",
             t_compact + 0.002)
    _ins_msg(state_db, "child", "tool", "[replayed tool result A]",
             t_compact + 0.003)
    _ins_msg(state_db, "child", "tool", "[replayed tool result B]",
             t_compact + 0.004)
    marker_id = _ins_msg(
        state_db, "child", "user",
        "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were …",
        t_compact + 0.005,
    )
    # REAL new content after the marker — the agent's next turn.
    new_assistant_id = _ins_msg(
        state_db, "child", "assistant",
        "Yep — one doc is written locally; the Notion sync got interrupted…",
        t_compact + 0.006,
    )
    new_tool_id = _ins_msg(
        state_db, "child", "tool",
        '{"bytes_written": 8526, "success": true}',
        t_compact + 0.007,
    )

    adapter = _make_adapter(plugin, state_db)
    result = plugin.parley_route_items._items_by_user_id(
        adapter, chat, "parley", 200, None,
    )
    assert result is not None
    items, _first_id, _has_more = result

    ids = [it["id"] for it in items]
    contents = [(it["id"], it["role"], it["content"][:50]) for it in items]

    # Marker itself must be gone.
    assert marker_id not in ids, (
        f"compaction marker (id={marker_id}) leaked into items response"
    )
    # The verbatim user-prompt dupe must be gone. The ONLY user row
    # containing the Oleg prompt should be the parent's real one.
    oleg_rows = [it for it in items
                 if it["content"].startswith("Hey. I had a conversation")]
    assert len(oleg_rows) == 1, (
        f"expected EXACTLY 1 Oleg prompt row (parent's real), "
        f"got {len(oleg_rows)}: {oleg_rows}"
    )
    # Replayed tool/assistant rows in the injection block must be gone.
    replayed = [it for it in items
                if "[replayed tool result" in it["content"]
                or "On it — I'll turn the sprawl" in it["content"]]
    # Parent's real "On it" should remain (1), child replay should not (0).
    on_it = [it for it in items if "On it — I'll turn the sprawl" in it["content"]]
    assert len(on_it) == 1, f"expected exactly 1 real 'On it' row, got {len(on_it)}"
    assert all("[replayed tool result" not in it["content"] for it in items), (
        "child-session replayed tool rows leaked into items response"
    )

    # Real new content after the marker MUST still be there.
    assert new_assistant_id in ids, "real post-marker assistant reply dropped"
    assert new_tool_id in ids, "real post-marker tool row dropped"


def test_no_compaction_marker_means_no_filtering(plugin, state_db):
    """If a child session has no `[CONTEXT COMPACTION` marker
    (e.g. a delegate sub-task that didn't go through compaction),
    leave its rows untouched. The recursive CTE's system_prompt
    prefix-match floor handles delegate filtering separately; this
    test guards the compaction filter from over-firing."""
    chat = "chat-no-compaction"
    t0 = 1_700_000_000.0
    _ins_session(state_db, "parent2", "parley", chat, t0)
    _ins_msg(state_db, "parent2", "user", "first parent message", t0 + 1)
    _ins_msg(state_db, "parent2", "assistant", "first parent reply", t0 + 2)

    # Child WITHOUT a [CONTEXT COMPACTION] marker — should be
    # treated as a normal continuation.
    _ins_session(state_db, "child2", "parley", None, t0 + 10,
                 parent="parent2")
    _ins_msg(state_db, "child2", "user", "real new user msg", t0 + 11)
    _ins_msg(state_db, "child2", "assistant", "real new reply", t0 + 12)

    adapter = _make_adapter(plugin, state_db)
    result = plugin.parley_route_items._items_by_user_id(
        adapter, chat, "parley", 200, None,
    )
    assert result is not None
    items, _first_id, _has_more = result
    contents_no_marker = [it["content"] for it in items]
    contents = contents_no_marker
    # All four messages must round-trip.
    assert "first parent message" in contents
    assert "first parent reply" in contents
    assert "real new user msg" in contents
    assert "real new reply" in contents


def test_multiple_compaction_events_filter_each(plugin, state_db):
    """A chat with TWO compaction events (parent → child → grandchild)
    must filter each child's seed block independently."""
    chat = "chat-double-compaction"
    t0 = 1_700_000_000.0
    _ins_session(state_db, "p", "parley", chat, t0)
    _ins_msg(state_db, "p", "user", "real-1 from parent", t0 + 1)
    _ins_msg(state_db, "p", "assistant", "real-A from parent", t0 + 2)

    # First child + its compaction block.
    _ins_session(state_db, "c1", "parley", None, t0 + 100, parent="p")
    _ins_msg(state_db, "c1", "user", "real-1 from parent", t0 + 100.001)  # dupe
    _ins_msg(state_db, "c1", "assistant", "real-A from parent", t0 + 100.002)
    _ins_msg(state_db, "c1", "user",
             "[CONTEXT COMPACTION] first compaction",
             t0 + 100.003)
    _ins_msg(state_db, "c1", "user", "real-2 from c1", t0 + 100.5)
    _ins_msg(state_db, "c1", "assistant", "real-B from c1", t0 + 100.6)

    # Second child compaction off c1.
    _ins_session(state_db, "c2", "parley", None, t0 + 200, parent="c1")
    _ins_msg(state_db, "c2", "user", "real-2 from c1", t0 + 200.001)  # dupe
    _ins_msg(state_db, "c2", "assistant", "real-B from c1", t0 + 200.002)
    _ins_msg(state_db, "c2", "user",
             "[CONTEXT COMPACTION] second compaction",
             t0 + 200.003)
    _ins_msg(state_db, "c2", "user", "real-3 from c2", t0 + 200.5)
    _ins_msg(state_db, "c2", "assistant", "real-C from c2", t0 + 200.6)

    adapter = _make_adapter(plugin, state_db)
    result = plugin.parley_route_items._items_by_user_id(
        adapter, chat, "parley", 200, None,
    )
    assert result is not None
    items, _first_id, _has_more = result
    contents = [it["content"] for it in items]

    # Each piece of real content appears EXACTLY once. The compaction
    # markers are gone. The dupes are gone.
    for marker in ("real-1 from parent", "real-A from parent",
                   "real-2 from c1", "real-B from c1",
                   "real-3 from c2", "real-C from c2"):
        count = sum(1 for c in contents if c == marker)
        assert count == 1, (
            f"expected exactly 1 occurrence of {marker!r}, got {count}"
        )
    assert not any(c.startswith("[CONTEXT COMPACTION") for c in contents)
