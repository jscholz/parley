from __future__ import annotations

import json
import sqlite3
import time

import pytest

from ..sidekick_db import SidekickDB
from .. import sidekick_state as state
from ..sidekick_unread import compute_unread


CHAT_ID = "c0a01ab1-bee2-4d5e-6f70-8090a0b0c0d0"


@pytest.fixture
def db(tmp_path):
    db = SidekickDB(tmp_path / "sidekick.db")
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


def _add_session(state_db, sid, chat_id=CHAT_ID, source="sidekick"):
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, system_prompt, "
        "parent_session_id, started_at) VALUES (?, ?, ?, ?, ?, ?)",
        (sid, source, chat_id, None, None, time.time()),
    )
    conn.commit()
    conn.close()


def _add_msg(state_db, sid, role, content, ts, tool_calls=None,
             tool_name=None, tool_call_id=None):
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, "
        "tool_call_id, tool_calls, timestamp) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, role, content, tool_name, tool_call_id, tool_calls, ts),
    )
    conn.commit()
    conn.close()


def test_unread_counts_envelope_only_reply_before_state_db_flush(db, state_db):
    """Agent emits a short "Checking." quick-ack reply on an off-screen
    chat. PWA upserts the activity row + bumps badge.incrementUnread,
    then refreshes from server via /api/sidekick/notifications/unread.
    The server-side compute_unread used to count state.db assistant rows
    ONLY — but the envelope just arrived; hermes hasn't post-turn-
    flushed yet, so state.db has nothing for this chat. compute_unread
    returned 0; badge.ts:109's auto-markAllRead fired and nuked the
    activity row as "stale." Full reply arrived later → state.db was
    flushed by then → badge bumped correctly. Hence the asymmetry:
    short reply silent, full reply badges.

    Contract: a final-status envelope assistant row (msg_links row with
    status='final', non-NULL tool_calls excluded) must count toward
    unread regardless of whether state.db has caught up yet. msg_links
    is the canonical source of truth for "what messages exist."
    """
    # No state.db session for this chat yet — agent hasn't flushed.
    # Envelope path has written the reply to msg_links.
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_pre_flush", "text": "Checking.",
    })
    unread = compute_unread(db=db, state_db_path=state_db, source="sidekick")
    chat_ids = [c["chat_id"] for c in unread["chats"]]
    assert f"sidekick:{CHAT_ID}" in chat_ids, \
        f"envelope-only chat must surface in unread set; got {chat_ids}"
    target = next(c for c in unread["chats"] if c["chat_id"] == f"sidekick:{CHAT_ID}")
    assert target["unread_count"] >= 1, \
        f"unread_count should be ≥1 for envelope-only reply, got {target['unread_count']}"
    assert unread["total"] >= 1


def test_unread_counts_final_replies_not_tool_call_activity(db, state_db):
    _add_session(state_db, "s1")
    tool_calls = json.dumps([
        {"id": "call_1", "function": {"name": "web_search", "arguments": "{}"}},
        {"id": "call_2", "function": {"name": "fetch", "arguments": "{}"}},
        {"id": "call_3", "function": {"name": "summarize", "arguments": "{}"}},
    ])
    _add_msg(state_db, "s1", "assistant", "", ts=1001.0, tool_calls=tool_calls)
    _add_msg(state_db, "s1", "tool", "result 1", ts=1002.0, tool_call_id="call_1")
    _add_msg(state_db, "s1", "tool", "result 2", ts=1003.0, tool_call_id="call_2")
    _add_msg(state_db, "s1", "tool", "result 3", ts=1004.0, tool_call_id="call_3")
    _add_msg(state_db, "s1", "assistant", "final answer", ts=1005.0)

    unread = compute_unread(db=db, state_db_path=state_db, source="sidekick")

    assert unread == {
        "chats": [{
            "chat_id": f"sidekick:{CHAT_ID}",
            "unread_count": 1,
            "marked_unread": False,
            "last_read_at": None,
        }],
        "total": 1,
    }


# ── Off-loop regression guard ────────────────────────────────────────
#
# `compute_unread` is structurally O(history) per chat — recursive-CTE
# state.db COUNT(*) per chat in a Python for-loop. It MUST NOT run on
# the asyncio loop thread. handle_unread (sidekick_routes.py) routes
# through ``run_in_sidekick_worker`` so the work lands in a bounded
# worker thread.
#
# History: 2026-06-23 — py-spy on the live gateway caught the main
# thread blocked inside compute_unread on EVERY sample during a PWA
# burst. The PWA polls /unread on every drawer-list refresh; with ~30
# chats including big ones (5000+ msgs), each poll stalled the loop
# for ~8s, which serialized every other handler into 8-25s tail
# latency. Fix landed in commit d10f62c.
#
# This test asserts handle_unread's bottleneck CALL into compute_unread
# happens off MainThread. Any future change that reverts to calling
# compute_unread directly from the coroutine will fail this test.


def test_handle_unread_routes_compute_off_the_loop_thread(db, state_db, monkeypatch):
    """The asyncio loop MUST NOT execute compute_unread inline — it does
    O(history)-per-chat SQL+Python work and blocks every other handler.

    Patch compute_unread to record threading.current_thread() and call
    handle_unread via the route handler. Assert the spy saw a worker
    thread (not MainThread). The semaphore wrapper in
    sidekick_perf_trace.run_in_sidekick_worker is the seam that
    guarantees this — the test fails if a future refactor inlines the
    call or otherwise bypasses the to_thread hop.
    """
    import asyncio
    import threading
    from unittest.mock import MagicMock

    from .. import sidekick_unread
    from .. import sidekick_routes

    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "assistant", "hello", ts=1000.0)

    captured_threads: list = []
    real_compute = sidekick_unread.compute_unread

    def spy(*args, **kwargs):
        captured_threads.append(threading.current_thread())
        return real_compute(*args, **kwargs)

    # The route imports compute_unread by name; patch the binding the
    # route actually resolves at call time.
    monkeypatch.setattr(sidekick_routes, "compute_unread", spy)

    # Minimal ctx + request stubs — handle_unread reads ctx.db +
    # ctx.state_db_path, ignores the request body, returns json.
    ctx = MagicMock()
    ctx.db = db
    ctx.state_db_path = state_db
    request = MagicMock()

    asyncio.run(sidekick_routes.handle_unread(ctx, request))

    assert len(captured_threads) == 1, (
        f"expected exactly one compute_unread call, got {len(captured_threads)}"
    )
    t = captured_threads[0]
    assert t.name != "MainThread", (
        "compute_unread ran on the asyncio loop's MainThread — this is "
        "the 2026-06-23 loop-block bug. handle_unread must route the "
        "call through run_in_sidekick_worker (or asyncio.to_thread) "
        f"so it lands in a worker thread. Got thread={t.name!r}."
    )
