"""Unit tests for ``parley_search`` — the hermes-side matching rules
behind ``/v1/conversations/search``.

The fixture mirrors hermes' real ``messages_fts`` trigger, which indexes
``content || ' ' || tool_name || ' ' || tool_calls`` for EVERY role, so
the tool-call-JSON leak the redesign fixes is reproduced faithfully
rather than assumed.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_user_id_queries import _load_plugin  # noqa: E402


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


@pytest.fixture(scope="module")
def ps(plugin):
    import importlib
    return importlib.import_module(f"{plugin.__name__}.parley_search")


_SCHEMA = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    title TEXT,
    system_prompt TEXT
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_name TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    timestamp REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE messages_fts USING fts5(content);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (
        new.id,
        COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '')
            || ' ' || COALESCE(new.tool_calls, '')
    );
END;
CREATE TABLE parley_msg_links (
    state_db_id INTEGER PRIMARY KEY,
    parley_id TEXT NOT NULL,
    kind TEXT
);
"""


@pytest.fixture
def state_db(tmp_path):
    db = tmp_path / "state.db"
    conn = sqlite3.connect(db)
    conn.executescript(_SCHEMA)
    conn.commit()
    conn.close()
    return db


def _session(db, sid, user_id, started, title=None, parent=None, source="parley"):
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, parent_session_id, started_at, title) "
        "VALUES (?, ?, ?, ?, ?, ?)", (sid, source, user_id, parent, started, title))
    conn.commit()
    conn.close()


def _msg(db, sid, role, content, ts, tool_calls=None, active=1, compacted=0):
    conn = sqlite3.connect(db)
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, compacted) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)", (sid, role, content, tool_calls, ts, active, compacted))
    conn.commit()
    conn.close()
    return cur.lastrowid


def _adapter(plugin, db):
    class _A(plugin.ParleyAdapter):
        pass
    a = _A.__new__(_A)
    a._state_db_path = db
    a._parley_db = None
    return a


def _search(plugin, ps, db, q, limit=20):
    from importlib import import_module
    conv = import_module(f"{plugin.__name__}.parley_route_conversations")
    conv.invalidate_summaries_cache()
    return ps.search_conversations(_adapter(plugin, db), q, limit, ("parley", "telegram"))


# ── pure helpers ─────────────────────────────────────────────────────

def test_parse_terms_lowercases_unquotes_and_strips_prefixes(ps):
    assert ps.parse_terms('Fix "R2 Cron" source:parley star*') == ["fix", "r2 cron", "parley", "star"]
    assert ps.parse_terms("   ") == []


def test_strip_envelope_skips_plumbing_and_peels_banners(ps):
    assert ps.strip_envelope("[CONTEXT COMPACTION — REFERENCE ONLY] summary…") is None
    assert ps.strip_envelope("[Your active task list was preserved] - [ ] x") is None
    assert ps.strip_envelope("") is None
    assert ps.strip_envelope(None) is None
    assert ps.strip_envelope(
        '[IMPORTANT: The user has invoked the "x" skill.]\n\nfix the cron please'
    ) == "fix the cron please"
    assert ps.strip_envelope(
        "[Akhil Raju | Slack user <@U07ABC>] can you  send\nthe address"
    ) == "can you send the address"
    # Plain prose that merely starts with a bracket is still text once
    # the bracketed bit is gone; nothing is lost that the user typed.
    assert ps.strip_envelope("[draft] tweak the copy") == "tweak the copy"


def test_excerpt_windows_around_first_match_with_shifted_ranges(ps):
    text = ("lorem ipsum " * 30) + "the cron failed here" + (" dolor sit" * 30)
    snippet, ranges = ps.excerpt(text, ["cron", "failed"], width=80)
    assert snippet.startswith("…") and snippet.endswith("…")
    for (s, e), term in zip(ranges, ["cron", "failed"]):
        assert snippet[s:e].lower() == term
    # Short text: whole thing, no ellipses.
    snippet, ranges = ps.excerpt("Fix the cron", ["cron"])
    assert snippet == "Fix the cron" and ranges == [[8, 12]]
    assert ps.excerpt("nothing here", ["cron"]) is None


def test_fts5_query_quotes_operator_tokens(ps):
    assert ps.fts5_query_for("nimb") == "nimb*"
    assert ps.fts5_query_for("smoke-search-marker") == '"smoke-search-marker"'
    assert ps.fts5_query_for('"exact phrase" pre*') == '"exact phrase" pre*'


# ── sessions: visible-name matching ──────────────────────────────────

def test_sessions_match_visible_name_not_message_bodies(plugin, ps, state_db):
    _session(state_db, "s1", "chat-a", 1000.0, title="Fix R2 investor calendar cron")
    _msg(state_db, "s1", "user", "please look at the calendar sync", 1001.0)
    _msg(state_db, "s1", "assistant", "done", 1002.0)
    _session(state_db, "s2", "chat-b", 2000.0, title="Daily recap")
    _msg(state_db, "s2", "user", "fix the cron job that failed", 2001.0)
    _msg(state_db, "s2", "assistant", "ok", 2002.0)

    sessions, hits = _search(plugin, ps, state_db, "fix cron")
    # Only the chat whose NAME contains both terms is a session hit…
    assert [s["id"] for s in sessions] == ["parley:chat-a"]
    assert sessions[0]["match"] == "title"
    assert sessions[0]["title"] == "Fix R2 investor calendar cron"
    assert sessions[0]["highlights"] == [[0, 3], [25, 29]]
    # …while the message in chat-b is a MESSAGE hit, not a session hit.
    assert [h["session_id"] for h in hits] == ["parley:chat-b"]
    assert hits[0]["snippet"] == "fix the cron job that failed"
    assert hits[0]["highlights"] == [[0, 3], [8, 12]]
    assert hits[0]["session_title"] == "Daily recap"


def test_untitled_chat_matches_on_its_first_message_label(plugin, ps, state_db):
    """The drawer shows the first user message when there is no title,
    so that string is the visible name and search matches it."""
    _session(state_db, "s1", "chat-a", 1000.0, title=None)
    _msg(state_db, "s1", "user", "Zephyr pipeline kickoff", 1001.0)
    _msg(state_db, "s1", "assistant", "starting", 1002.0)
    sessions, _ = _search(plugin, ps, state_db, "zephyr")
    assert [s["title"] for s in sessions] == ["Zephyr pipeline kickoff"]


def test_sessions_ordered_by_recency_and_capped(plugin, ps, state_db):
    for i in range(25):
        _session(state_db, f"s{i}", f"chat-{i}", 1000.0 + i, title=f"Cron thing {i}")
        _msg(state_db, f"s{i}", "user", "hi", 1000.0 + i)
    sessions, _ = _search(plugin, ps, state_db, "cron thing", limit=50)
    assert len(sessions) == ps.SESSIONS_MAX
    assert sessions[0]["id"] == "parley:chat-24"


# ── hits: content only, root-resolved ────────────────────────────────

def test_tool_call_json_never_surfaces_as_a_hit(plugin, ps, state_db):
    _session(state_db, "s1", "chat-a", 1000.0, title="Ops")
    # Assistant row with EMPTY content but a tool call whose arguments
    # contain the query — hermes' FTS trigger indexes that JSON.
    _msg(state_db, "s1", "assistant", "", 1001.0,
         tool_calls='[{"function": {"name": "cronjob", "arguments": "{\\"action\\": \\"fix cron\\"}"}}]')
    # Assistant row with real prose that mentions a different tool call
    # only inside its tool_calls column.
    _msg(state_db, "s1", "assistant", "I'll take a look.", 1002.0,
         tool_calls='[{"function": {"name": "terminal", "arguments": "fix cron"}}]')
    # Tool result row containing the query.
    _msg(state_db, "s1", "tool", '{"result": "fix cron done"}', 1003.0)
    _, hits = _search(plugin, ps, state_db, "fix cron")
    assert hits == []


def test_compaction_envelopes_are_skipped_and_banners_stripped(plugin, ps, state_db):
    _session(state_db, "s1", "chat-a", 1000.0, title="Ops")
    _msg(state_db, "s1", "user", "[CONTEXT COMPACTION — REFERENCE ONLY] we should fix cron", 1001.0)
    _msg(state_db, "s1", "user", "[Your active task list was preserved]\n- [ ] fix cron", 1002.0)
    _msg(state_db, "s1", "user", "[SYSTEM: You are running as a scheduled cron job.] fix cron daily", 1003.0)
    _, hits = _search(plugin, ps, state_db, "fix cron")
    assert [h["snippet"] for h in hits] == ["fix cron daily"]
    assert hits[0]["highlights"] == [[0, 3], [4, 8]]


def test_hits_in_rotated_child_sessions_resolve_to_the_root_chat(plugin, ps, state_db):
    _session(state_db, "root", "chat-a", 1000.0, title="Long chat")
    _session(state_db, "child", None, 2000.0, parent="root")
    _session(state_db, "grandchild", None, 3000.0, parent="child")
    _msg(state_db, "grandchild", "user", "remember to fix cron", 3001.0)
    _, hits = _search(plugin, ps, state_db, "fix cron")
    assert [h["session_id"] for h in hits] == ["parley:chat-a"]
    assert hits[0]["session_title"] == "Long chat"
    assert "None" not in hits[0]["session_id"]


def test_orphan_sessions_and_foreign_sources_are_dropped(plugin, ps, state_db):
    _session(state_db, "orphan", None, 1000.0)  # no user_id, no parent
    _msg(state_db, "orphan", "user", "fix cron", 1001.0)
    _session(state_db, "cli1", "cli-user", 1000.0, source="cli")
    _msg(state_db, "cli1", "user", "fix cron", 1001.0)
    _, hits = _search(plugin, ps, state_db, "fix cron")
    assert hits == []


def test_rewound_rows_hidden_compacted_rows_visible_once(plugin, ps, state_db):
    _session(state_db, "s1", "chat-a", 1000.0, title="Ops")
    live = _msg(state_db, "s1", "user", "fix cron tonight", 1001.0)
    # Compaction archived a byte-identical copy — one excerpt, not two.
    _msg(state_db, "s1", "user", "fix cron tonight", 1001.0, active=0, compacted=1)
    # A rewound (undone) row is invisible.
    _msg(state_db, "s1", "user", "fix cron yesterday", 999.0, active=0, compacted=0)
    _, hits = _search(plugin, ps, state_db, "fix cron")
    assert [(h["message_id"], h["snippet"]) for h in hits] == [(live, "fix cron tonight")]


def test_per_chat_cap_and_more_in_session(plugin, ps, state_db):
    _session(state_db, "s1", "chat-a", 1000.0, title="Busy")
    for i in range(6):
        _msg(state_db, "s1", "user", f"fix cron attempt {i}", 1001.0 + i)
    _session(state_db, "s2", "chat-b", 2000.0, title="Quiet")
    _msg(state_db, "s2", "user", "fix cron once", 2001.0)
    _, hits = _search(plugin, ps, state_db, "fix cron")
    by_chat = {}
    for h in hits:
        by_chat.setdefault(h["session_id"], []).append(h)
    assert len(by_chat["parley:chat-a"]) == ps.PER_CHAT_CAP
    assert by_chat["parley:chat-a"][0]["more_in_session"] == 3
    assert all(h["more_in_session"] == 0 for h in by_chat["parley:chat-a"][1:])
    assert len(by_chat["parley:chat-b"]) == 1
    assert by_chat["parley:chat-b"][0]["more_in_session"] == 0


def test_hit_requires_every_term_in_the_same_message(plugin, ps, state_db):
    _session(state_db, "s1", "chat-a", 1000.0, title="Ops")
    _msg(state_db, "s1", "user", "please fix it", 1001.0)
    _msg(state_db, "s1", "assistant", "the cron is fine", 1002.0)
    _, hits = _search(plugin, ps, state_db, "fix cron")
    assert hits == []


# ── id matches ───────────────────────────────────────────────────────

def test_session_id_fragment_is_a_badged_session_hit(plugin, ps, state_db):
    _session(state_db, "20260601_root", "chat-a", 1000.0, title="Root Chat")
    _session(state_db, "20260611_223425_98bd2b", None, 2000.0, parent="20260601_root")
    _msg(state_db, "20260601_root", "user", "hello", 1001.0)
    sessions, hits = _search(plugin, ps, state_db, "98bd2b")
    assert [(s["id"], s["match"], s["title"]) for s in sessions] == [("parley:chat-a", "id", "Root Chat")]
    assert hits == []


def test_id_match_does_not_duplicate_a_title_match(plugin, ps, state_db):
    _session(state_db, "abcd1234", "chat-a", 1000.0, title="abcd1234 planning")
    _msg(state_db, "abcd1234", "user", "hello", 1001.0)
    sessions, _ = _search(plugin, ps, state_db, "abcd1234")
    assert [s["match"] for s in sessions] == ["title"]


# ── robustness ───────────────────────────────────────────────────────

def test_bad_fts_syntax_degrades_to_sessions_only(plugin, ps, state_db):
    _session(state_db, "s1", "chat-a", 1000.0, title="OR gates")
    _msg(state_db, "s1", "user", "OR", 1001.0)
    sessions, hits = _search(plugin, ps, state_db, "OR")
    assert sessions and hits == []


def test_no_fts_table_returns_sessions_only(plugin, ps, tmp_path):
    db = tmp_path / "bare.db"
    conn = sqlite3.connect(db)
    conn.executescript(_SCHEMA.replace(
        "CREATE VIRTUAL TABLE messages_fts USING fts5(content);", "").split("CREATE TRIGGER")[0])
    conn.commit()
    conn.close()
    _session(db, "s1", "chat-a", 1000.0, title="Plain")
    sessions, hits = _search(plugin, ps, db, "plain")
    assert [s["title"] for s in sessions] == ["Plain"] and hits == []


def test_adapter_shims_delegate(plugin, ps, state_db):
    """The adapter keeps its old static helpers as thin shims."""
    assert plugin.ParleyAdapter._fts5_query_for("abc") == ps.fts5_query_for("abc")
    conn = sqlite3.connect(state_db)
    try:
        assert plugin.ParleyAdapter._session_id_matches(conn, "zzzz") == []
    finally:
        conn.close()
