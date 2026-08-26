from __future__ import annotations

import json
import sqlite3
import time

import pytest

from ..parley_db import ParleyDB
from .. import parley_state as state
from ..parley_unread import compute_unread


CHAT_ID = "c0a01ab1-bee2-4d5e-6f70-8090a0b0c0d0"


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "parley.db")
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


def _add_session(state_db, sid, chat_id=CHAT_ID, source="parley"):
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
    then refreshes from server via /api/parley/notifications/unread.
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

    2026-07-20 (BUG A ghost-chat scoping): the chat universe is now
    scoped to chats the conversations route serves — state.db sessions
    with a user_id. The chat's SESSION row therefore must exist (it
    does in the field scenario: the user has been talking in the chat);
    only its MESSAGE rows lag the envelope. The essential contract —
    envelope rows count before the state.db message flush — is
    unchanged and still asserted below.
    """
    # Session exists; hermes hasn't flushed the reply's MESSAGE row yet.
    # Envelope path has written the reply to msg_links.
    _add_session(state_db, "s1")
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_pre_flush", "text": "Checking.",
    })
    unread = compute_unread(db=db, state_db_path=state_db, source="parley")
    chat_ids = [c["chat_id"] for c in unread["chats"]]
    assert f"parley:{CHAT_ID}" in chat_ids, \
        f"envelope-only chat must surface in unread set; got {chat_ids}"
    target = next(c for c in unread["chats"] if c["chat_id"] == f"parley:{CHAT_ID}")
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

    unread = compute_unread(db=db, state_db_path=state_db, source="parley")

    assert unread == {
        "chats": [{
            "chat_id": f"parley:{CHAT_ID}",
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
# the asyncio loop thread. handle_unread (parley_routes.py) routes
# through ``run_in_parley_worker`` so the work lands in a bounded
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
    parley_perf_trace.run_in_parley_worker is the seam that
    guarantees this — the test fails if a future refactor inlines the
    call or otherwise bypasses the to_thread hop.
    """
    import asyncio
    import threading
    from unittest.mock import MagicMock

    from .. import parley_unread
    from .. import parley_routes

    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "assistant", "hello", ts=1000.0)

    captured_threads: list = []
    real_compute = parley_unread.compute_unread

    def spy(*args, **kwargs):
        captured_threads.append(threading.current_thread())
        return real_compute(*args, **kwargs)

    # The route imports compute_unread by name; patch the binding the
    # route actually resolves at call time.
    monkeypatch.setattr(parley_routes, "compute_unread", spy)

    # Minimal ctx + request stubs — handle_unread reads ctx.db +
    # ctx.state_db_path, ignores the request body, returns json.
    ctx = MagicMock()
    ctx.db = db
    ctx.state_db_path = state_db
    request = MagicMock()

    asyncio.run(parley_routes.handle_unread(ctx, request))

    assert len(captured_threads) == 1, (
        f"expected exactly one compute_unread call, got {len(captured_threads)}"
    )
    t = captured_threads[0]
    assert t.name != "MainThread", (
        "compute_unread ran on the asyncio loop's MainThread — this is "
        "the 2026-06-23 loop-block bug. handle_unread must route the "
        "call through run_in_parley_worker (or asyncio.to_thread) "
        f"so it lands in a worker thread. Got thread={t.name!r}."
    )


def test_compute_unread_ttl_cache_collapses_repeat_calls(db, state_db):
    """The PWA polls /unread on every drawer refresh — multiple calls
    per second under burst load. compute_unread is O(N×M) so without
    a cache the worker pool saturates and other handlers queue.

    A second call within the TTL window must hit the cache and return
    near-instantly. This test seeds enough data to make a non-cached
    call meaningfully slower than a noise floor, then asserts the
    second call is dramatically faster (ratio > 10x). Catches future
    refactors that accidentally bypass the cache layer.
    """
    import time as _t
    _add_session(state_db, "s1")
    # Seed 200 messages — enough that a fresh CTE+scan is well above
    # the noise floor (typically 5-20ms in tests) but small enough to
    # keep the test fast.
    for i in range(200):
        _add_msg(state_db, "s1", "user" if i % 2 == 0 else "assistant",
                 f"m{i}", ts=1000.0 + i)
    # First call — uncached, runs the full CTE+scan.
    t0 = _t.monotonic()
    first = compute_unread(db=db, state_db_path=state_db, source="parley")
    dt_uncached = _t.monotonic() - t0
    # Second call — should hit the TTL cache.
    t0 = _t.monotonic()
    second = compute_unread(db=db, state_db_path=state_db, source="parley")
    dt_cached = _t.monotonic() - t0
    # Same result either way.
    assert first == second
    # The cached path must be dramatically faster. We pick a 10x ratio
    # to leave headroom for CI noise; an actual cache hit is 1000x+
    # faster in practice.
    assert dt_cached * 10 < dt_uncached, (
        f"compute_unread cache didn't engage: uncached={dt_uncached*1000:.2f}ms "
        f"cached={dt_cached*1000:.2f}ms (expected cached < uncached/10)"
    )


def test_compute_unread_batches_state_queries(db, state_db):
    """Perf-regression guard. compute_unread MUST scale sub-linearly
    in chat count — the 2026-06-23 rewrite batches all per-chat
    queries into one ``VALUES``-driven CTE join, so adding 50 chats
    doesn't multiply the call cost. Pre-rewrite, the same workload
    took ~9 seconds on the live data (one recursive-CTE COUNT per
    chat in a Python loop, ~150ms each × 60+ chats).

    Seed 50 separate chats, then assert one uncached call returns
    correct counts AND completes in well under a generous wall-time
    bound. Catches a future refactor that accidentally re-introduces
    the per-chat loop.
    """
    # Seed 50 chats, each with one assistant row that should count
    # as unread (no last_read_at pointer set).
    for i in range(50):
        sid = f"s_{i}"
        chat_i = f"chat-{i:03d}"
        _add_session(state_db, sid, chat_id=chat_i)
        _add_msg(state_db, sid, "assistant", f"reply-{i}", ts=1000.0 + i)
    import time as _t
    t0 = _t.monotonic()
    result = compute_unread(db=db, state_db_path=state_db, source="parley")
    dt = _t.monotonic() - t0
    # Correctness: each chat has 1 unread assistant row → total 50.
    assert result["total"] == 50, (
        f"expected total=50, got {result['total']} "
        f"(chats={len(result['chats'])})"
    )
    # Perf: 50 chats × 1 row each should run in <500ms even on a
    # slow CI worker. The pre-rewrite per-chat-loop was ~150ms per
    # chat = ~7.5s; we cap at 500ms to catch a regression even in
    # a noisy environment. Production data (170 chats × thousands
    # of rows) runs the rewritten path in ~2s.
    assert dt < 0.5, (
        f"compute_unread on 50 small chats took {dt*1000:.0f}ms — "
        f"expected <500ms with the batch-query rewrite. A regression "
        f"to the per-chat loop would cost ~7-9s on this seed."
    )


def test_compute_unread_cache_invalidation_after_mark_seen(db, state_db):
    """Mutation paths (mark_seen, set_marked) MUST invalidate the
    cache, otherwise the post-mutation /unread poll would serve stale
    counts for up to the TTL — visible to the user as a sidebar badge
    that doesn't clear when they click into a chat.
    """
    from ..parley_unread import invalidate_unread_cache
    chat_id_prefixed = f"parley:{CHAT_ID}"
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "assistant", "unread reply", ts=1000.0)
    # Prime the cache with an "unread > 0" snapshot.
    first = compute_unread(db=db, state_db_path=state_db, source="parley")
    assert first["total"] >= 1
    # Mark seen + invalidate (mirrors what handle_unread_seen does).
    state.mark_seen(db, chat_id_prefixed, now=2000.0)
    invalidate_unread_cache()
    # Next compute_unread must reflect the mark_seen (not return the
    # stale "unread > 0" snapshot from the cache).
    second = compute_unread(db=db, state_db_path=state_db, source="parley")
    assert second["total"] == 0, (
        f"cache wasn't invalidated after mark_seen — still seeing "
        f"stale unread total={second['total']}"
    )


# ── Invalidation hygiene (2026-08-26 200%-CPU diagnosis) ─────────────
#
# The record_envelope write-through used to call invalidate_unread_cache
# on EVERY envelope — including every streaming reply_delta — so during
# any turn the compute_unread cache was permanently cold and each
# /unread poll re-ran the full multi-second scan (two executor threads
# sat in _compute_unread_uncached continuously; gateway idle CPU
# ~200%, "5-30s replies" field report). The gate now flushes only for
# persisted envelopes that can actually change an unread count.


def test_envelope_affects_unread_type_gate():
    """Only reply_final and notification produce role='assistant'
    status='final' rows (the only rows the unread queries count), so
    only those types may flush the cache. Everything else — streaming
    deltas, typing, tool envelopes, user messages, transient UI
    signals — must NOT."""
    from ..parley_unread import envelope_affects_unread

    assert envelope_affects_unread("reply_final") is True
    assert envelope_affects_unread("notification") is True
    for etype in ("reply_delta", "typing", "user_message", "tool_call",
                  "tool_result", "session_changed", "error", "image",
                  "unread_changed", "", None):
        assert envelope_affects_unread(etype) is False, (
            f"envelope type {etype!r} must not invalidate the unread "
            f"cache — it cannot change an assistant-final row count"
        )


def _minimal_adapter(db):
    """ParleyAdapter shell with just the attrs the write-through path
    touches. object.__new__ skips __init__ (which wires the full
    gateway adapter surface — irrelevant to the persistence gate)."""
    from .. import ParleyAdapter

    adapter = object.__new__(ParleyAdapter)
    adapter._parley_db = db
    adapter._session_rows_cache = ("sentinel", [])  # type: ignore[assignment]
    return adapter


def test_writethrough_invalidates_only_for_unread_affecting_envelopes(db, monkeypatch):
    """Regression guard for the reply_delta invalidation storm: a
    streaming turn emits dozens of reply_delta envelopes per second;
    each one clearing the cache forces a full recompute per /unread
    poll. Assert the write-through flushes the cache exactly for the
    persisted unread-affecting envelopes (reply_final, notification)
    and NEVER for deltas / typing / tool traffic / user messages."""
    from .. import parley_unread

    adapter = _minimal_adapter(db)
    calls: list = []
    monkeypatch.setattr(
        parley_unread, "invalidate_unread_cache",
        lambda source=None: calls.append(source),
    )

    def send(env):
        adapter._record_envelope_writethrough(env, env.get("type"))

    # A realistic turn: user message, typing, a tool round-trip, a
    # burst of streaming deltas — none of these may flush the cache.
    send({"type": "user_message", "chat_id": CHAT_ID, "message_id": "um1",
          "text": "hi"})
    send({"type": "typing", "chat_id": CHAT_ID})
    send({"type": "tool_call", "chat_id": CHAT_ID, "call_id": "c1",
          "tool_name": "web_search", "args": {}})
    send({"type": "tool_result", "chat_id": CHAT_ID, "call_id": "c1",
          "result": "ok"})
    for i in range(25):
        send({"type": "reply_delta", "chat_id": CHAT_ID,
              "message_id": "m1", "text": "chunk" * (i + 1)})
    assert calls == [], (
        f"non-unread-affecting envelopes flushed the cache "
        f"{len(calls)} time(s) — this is the 2026-08-26 invalidation "
        f"storm (every reply_delta forced a full recompute per poll)"
    )
    # Session-rows cache untouched too (same storm, other executor).
    assert adapter._session_rows_cache is not None

    # reply_final persists an assistant-final row → exactly one flush,
    # of both caches.
    send({"type": "reply_final", "chat_id": CHAT_ID, "message_id": "m1",
          "text": "final text"})
    assert len(calls) == 1
    assert adapter._session_rows_cache is None

    # notification persists an assistant-final row → flush.
    adapter._session_rows_cache = ("sentinel", [])  # re-prime
    send({"type": "notification", "chat_id": CHAT_ID,
          "message_id": "n1", "content": "cron says hi"})
    assert len(calls) == 2
    assert adapter._session_rows_cache is None

    # A reply_final that record_envelope REJECTS (no message_id → no
    # row persisted) must not flush either: nothing changed on disk.
    adapter._session_rows_cache = ("sentinel", [])
    send({"type": "reply_final", "chat_id": CHAT_ID, "text": "orphan"})
    assert len(calls) == 2, "unpersisted reply_final flushed the cache"
    assert adapter._session_rows_cache is not None


# ── Session-rows poll cache (2026-08-26 200%-CPU diagnosis) ──────────
#
# _read_session_rows ran its recursive-CTE query uncached at every
# 1.5s poll tick — 4.3s per call on the live state.db, i.e. the
# poller's executor thread was busy 100% of the time. The rows are now
# TTL-cached with event-driven flush (turn end, rename, delete).


@pytest.fixture
def poller_state_db(tmp_path):
    """state.db shaped for _read_session_rows (needs title column)."""
    path = tmp_path / "poller_state.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            user_id TEXT,
            system_prompt TEXT,
            parent_session_id TEXT,
            started_at REAL NOT NULL,
            title TEXT
        );
        """
    )
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, started_at, title) "
        "VALUES ('s1', 'parley', ?, 1000.0, 'first title')",
        (CHAT_ID,),
    )
    conn.commit()
    conn.close()
    return path


def _poller_adapter(state_db_path):
    from .. import ParleyAdapter

    adapter = object.__new__(ParleyAdapter)
    adapter._state_db_path = state_db_path
    adapter._session_rows_cache = None
    adapter._sid_to_chat_id_cache = {}
    return adapter


def _insert_session(state_db_path, sid, title, started_at):
    conn = sqlite3.connect(str(state_db_path))
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, started_at, title) "
        "VALUES (?, 'parley', ?, ?, ?)",
        (sid, CHAT_ID, started_at, title),
    )
    conn.commit()
    conn.close()


def test_read_session_rows_serves_from_cache_within_ttl(poller_state_db):
    """Within the TTL, repeat poll ticks must serve the cached rows —
    the underlying query must not re-run. Asserted behaviorally: a
    state.db change made after the first read is invisible to a
    second read inside the TTL window."""
    adapter = _poller_adapter(poller_state_db)
    first = adapter._read_session_rows()
    assert first == [(CHAT_ID, "s1", "first title")]
    # Rotate the session behind the cache's back.
    _insert_session(poller_state_db, "s2", "second title", 2000.0)
    second = adapter._read_session_rows()
    assert second == first, (
        "cache miss within TTL — _read_session_rows re-ran the query "
        "(the 2026-08-26 diagnosis had it running back-to-back at "
        "every 1.5s tick)"
    )


def test_read_session_rows_cache_flush_serves_fresh_rows(poller_state_db):
    """invalidate_session_rows_cache (called on turn end / rename /
    delete) must make the very next poll tick re-read state.db."""
    adapter = _poller_adapter(poller_state_db)
    assert adapter._read_session_rows() == [(CHAT_ID, "s1", "first title")]
    _insert_session(poller_state_db, "s2", "second title", 2000.0)
    adapter.invalidate_session_rows_cache()
    fresh = adapter._read_session_rows()
    assert fresh == [(CHAT_ID, "s2", "second title")], (
        f"post-flush read served stale rows: {fresh}"
    )
    # The opportunistic sid→chat_id refresh must reflect the new row.
    assert adapter._sid_to_chat_id_cache == {"s2": CHAT_ID}
