"""Drawer window completeness — unread chats must never hide behind
the recency LIMIT.

Field bug 2026-07-08: an unread reply on a session at drawer position
72 was invisible in the 50-row sidebar, so the OS app badge (computed
from the FULL unread set by badge.ts) read 1 while the sidebar read 0
— permanently, with no way to find or clear it from the UI. The app
badge, the sidebar sum, and the sessions list must derive from the same
visible set, so ``_rows_with_unread_included`` force-includes chats
with unread state in the list regardless of the limit window.
"""

from __future__ import annotations

import sqlite3

import pytest

from ..parley_db import ParleyDB
from ..parley_route_conversations import (
    _rows_with_unread_included,
    invalidate_summaries_cache,
)
from ..parley_unread import invalidate_unread_cache


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "sidekick.db")
    yield db
    db.close()


@pytest.fixture
def state_db(tmp_path):
    path = tmp_path / "state.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            user_id TEXT,
            title TEXT,
            system_prompt TEXT,
            parent_session_id TEXT,
            started_at REAL NOT NULL
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_name TEXT,
            tool_call_id TEXT,
            tool_calls TEXT,
            timestamp REAL,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
        """
    )
    conn.commit()
    conn.close()
    return path


class FakeAdapter:
    def __init__(self, db, state_db_path):
        self._parley_db = db
        self._state_db_path = state_db_path


def _seed_chat(state_db, sid: str, chat_id: str, ts: float) -> None:
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, started_at) VALUES (?,?,?,?)",
        (sid, "sidekick", chat_id, ts),
    )
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)",
        (sid, "user", "hello", ts),
    )
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)",
        (sid, "assistant", "reply", ts + 1),
    )
    conn.commit()
    conn.close()


def test_unread_chat_beyond_limit_is_force_included(db, state_db):
    # Three chats by recency: old (unread!), mid, new. limit=2 would
    # naturally return only {new, mid} — the unread old chat must be
    # force-included anyway.
    invalidate_summaries_cache()
    invalidate_unread_cache()
    _seed_chat(state_db, "s-old", "chat-old", 1000.0)
    _seed_chat(state_db, "s-mid", "chat-mid", 2000.0)
    _seed_chat(state_db, "s-new", "chat-new", 3000.0)
    # old chat: last_read_at BEFORE its assistant reply → unread=1.
    db.exec(
        "INSERT INTO unread_state (chat_id, last_read_at, marked_unread) VALUES (?,?,0)",
        ("sidekick:chat-old", 1000.5),
    )
    # mid + new: fully read.
    for cid in ("chat-mid", "chat-new"):
        db.exec(
            "INSERT INTO unread_state (chat_id, last_read_at, marked_unread) VALUES (?,?,0)",
            (f"sidekick:{cid}", 9999.0),
        )

    adapter = FakeAdapter(db, state_db)
    rows = _rows_with_unread_included(adapter, ("sidekick",), 2)
    ids = [r[0] for r in rows]
    assert "chat-old" in ids, f"unread chat hidden by the window: {ids}"
    # Recency order preserved after the merge.
    assert ids.index("chat-new") < ids.index("chat-mid") < ids.index("chat-old")


def test_no_unread_means_plain_window(db, state_db):
    invalidate_summaries_cache()
    invalidate_unread_cache()
    _seed_chat(state_db, "s-a", "chat-a", 1000.0)
    _seed_chat(state_db, "s-b", "chat-b", 2000.0)
    _seed_chat(state_db, "s-c", "chat-c", 3000.0)
    for cid in ("chat-a", "chat-b", "chat-c"):
        db.exec(
            "INSERT INTO unread_state (chat_id, last_read_at, marked_unread) VALUES (?,?,0)",
            (f"sidekick:{cid}", 9999.0),
        )
    adapter = FakeAdapter(db, state_db)
    rows = _rows_with_unread_included(adapter, ("sidekick",), 2)
    assert [r[0] for r in rows] == ["chat-c", "chat-b"]


def test_marked_unread_also_force_included(db, state_db):
    # marked_unread (sticky) with no new messages must also surface.
    invalidate_summaries_cache()
    invalidate_unread_cache()
    _seed_chat(state_db, "s-old", "chat-old", 1000.0)
    _seed_chat(state_db, "s-mid", "chat-mid", 2000.0)
    _seed_chat(state_db, "s-new", "chat-new", 3000.0)
    db.exec(
        "INSERT INTO unread_state (chat_id, last_read_at, marked_unread) VALUES (?,?,1)",
        ("sidekick:chat-old", 9999.0),
    )
    for cid in ("chat-mid", "chat-new"):
        db.exec(
            "INSERT INTO unread_state (chat_id, last_read_at, marked_unread) VALUES (?,?,0)",
            (f"sidekick:{cid}", 9999.0),
        )
    adapter = FakeAdapter(db, state_db)
    rows = _rows_with_unread_included(adapter, ("sidekick",), 2)
    assert "chat-old" in [r[0] for r in rows]
