"""Chat delete must purge the chat's parley.db rows (2026-08-06 disk
audit): msg_links is the v3 transcript body store — before this cascade
leg, a deleted chat's bodies (tool results are the bulk) survived
forever in parley.db and rode every daily snapshot. Pins, unread,
activity, title and replay_dups rows ride the same cascade.

Failing-first: the msg_links/pins/unread/title assertions fail without
the new purge leg in delete_conversation_sync."""

import sqlite3
import time

import pytest


@pytest.fixture
def plugin():
    from backends.hermes import plugin as p  # noqa: WPS433
    return p


CHAT = "9f1c2d3e-aaaa-bbbb-cccc-0123456789ab"
OTHER = "0e0e0e0e-1111-2222-3333-444455556666"


def _state_db(tmp_path):
    path = tmp_path / "state.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, source TEXT, user_id TEXT,
            started_at REAL, title TEXT, system_prompt TEXT,
            parent_session_id TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
            role TEXT, content TEXT, timestamp REAL
        );
        """
    )
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, started_at) VALUES (?,?,?,?)",
        ("s-del", "sidekick", CHAT, time.time()),
    )
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, started_at) VALUES (?,?,?,?)",
        ("s-keep", "sidekick", OTHER, time.time()),
    )
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)",
        ("s-del", "user", "hello", time.time()),
    )
    conn.commit()
    conn.close()
    return path


def _seed_parley_rows(db, chat_id, tag):
    now = time.time()
    db.exec(
        "INSERT INTO msg_links (id, chat_id, role, content, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?)",
        (f"umsg_{tag}", chat_id, "user", f"body-{tag}", now, now),
    )
    db.exec(
        "INSERT INTO pins (chat_id, msg_id, role, text, timestamp, pinned_at) "
        "VALUES (?,?,?,?,?,?)",
        (chat_id, f"m-{tag}", "user", f"pin-{tag}", now, now),
    )
    db.exec(
        "INSERT INTO unread_state (chat_id, last_read_at, marked_unread) "
        "VALUES (?, ?, 1)",
        (chat_id, now),
    )
    db.exec(
        "INSERT INTO activity_items (id, chat_id, kind, title, body, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (f"act-{tag}", chat_id, "agent_reply", "t", "b", now),
    )
    db.exec(
        "INSERT INTO conversation_titles (source, chat_id, title, updated_at) "
        "VALUES ('sidekick',?,?,?)",
        (chat_id, f"title-{tag}", now),
    )


def _count(db, table, chat_id):
    row = db.fetchone(
        f"SELECT count(*) AS n FROM {table} WHERE chat_id = ?", (chat_id,),
    )
    return row["n"] if row is not None else 0


def test_delete_conversation_purges_parley_rows(plugin, tmp_path):
    from backends.hermes.plugin.parley_db import ParleyDB

    state_path = _state_db(tmp_path)
    db = ParleyDB(tmp_path / "sidekick.db")
    try:
        _seed_parley_rows(db, CHAT, "del")
        _seed_parley_rows(db, OTHER, "keep")

        class _Adapter:
            _state_db_path = state_path
            _parley_db = db

        from backends.hermes.plugin import parley_route_conversations as route_conv
        result = route_conv.delete_conversation_sync(_Adapter(), CHAT)
        assert result == "ok"

        for table in (
            "msg_links", "pins", "unread_state",
            "activity_items", "conversation_titles",
        ):
            assert _count(db, table, CHAT) == 0, (
                f"{table} rows for the deleted chat must be purged"
            )
            assert _count(db, table, OTHER) == 1, (
                f"{table} rows for OTHER chats must survive"
            )
    finally:
        db.close()
