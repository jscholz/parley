"""Items endpoint read path: state.db is the canonical body store,
parley.db.msg_links supplies sidekick_id / kind annotations.

Exercises ``list_messages_for_chat_with_state_db_source`` — the
default read path (``PARLEY_ITEMS_READ_FROM_STATE_DB`` defaults to
on). The fallback reader ``list_messages_for_chat`` (parley.db.
msg_links as the body store, used when the env flag is off) is
covered in test_items_endpoint_parley_db.py.

Why state.db is canonical for bodies: the older dual-body model
(envelope write-through to parley.db PLUS state.db backfill via
reconcile) could leave the same logical message stored twice when
reconcile's content-match failed — surfaced as duplicate bubbles in
the PWA as duplicate bubbles with mismatched timestamps. Reading
bodies from state.db only
eliminates the dupe class structurally; parley.db's role narrows to
linkage.
"""

from __future__ import annotations

import json
import sqlite3
import time

import pytest

from ..parley_db import ParleyDB
from .. import parley_state as state


CHAT_ID = "c0a01ab1-bee2-4d5e-6f70-8090a0b0c0d0"


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "sidekick.db")
    yield db
    db.close()


@pytest.fixture
def state_db(tmp_path):
    """Fake hermes state.db with sessions + messages tables."""
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


def _add_session(state_db, sid, chat_id=CHAT_ID, source="sidekick",
                 system_prompt=None, parent_session_id=None):
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, system_prompt, "
        "parent_session_id, started_at) VALUES (?, ?, ?, ?, ?, ?)",
        (sid, source, chat_id, system_prompt, parent_session_id, time.time()),
    )
    conn.commit()
    conn.close()


def _add_msg(state_db, sid, role, content, ts=None, tool_calls=None,
             tool_name=None, tool_call_id=None):
    conn = sqlite3.connect(str(state_db))
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, "
        "tool_call_id, tool_calls, timestamp) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, role, content, tool_name, tool_call_id, tool_calls,
         ts if ts is not None else time.time()),
    )
    msg_id = cur.lastrowid
    conn.commit()
    conn.close()
    return msg_id


# ── core wire shape ──────────────────────────────────────────────────


def test_reads_state_db_messages_in_chronological_order(db, state_db):
    """state.db is the canonical body store. The recursive CTE + sort
    must return messages in timestamp-ascending order."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "first", ts=1000.0)
    _add_msg(state_db, "s1", "assistant", "second", ts=1001.0)
    _add_msg(state_db, "s1", "user", "third", ts=1002.0)

    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )
    contents = [i["content"] for i in result["items"]]
    assert contents == ["first", "second", "third"]
    assert result["has_more"] is False


def test_surfaces_sidekick_id_when_link_exists(db, state_db):
    """parley.db.msg_links provides the sidekick_id annotation via
    its ``agent_row_id`` linkage to state.db.messages.id."""
    _add_session(state_db, "s1")
    state_msg_id = _add_msg(state_db, "s1", "assistant", "linked reply", ts=2000.0)
    state.upsert_msg_link(
        db, id="msg_real_xyz", chat_id=CHAT_ID, role="assistant",
        content="linked reply", agent_row_id=str(state_msg_id),
    )

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    assert len(items) == 1
    assert items[0]["sidekick_id"] == "msg_real_xyz"
    assert items[0]["content"] == "linked reply"


def test_handles_legacy_rows_with_no_link(db, state_db):
    """state.db rows without a parley.db.msg_links twin still surface
    — they just don't carry a sidekick_id. PWA falls back to integer-id
    keying for these (cross-channel / pre-write-through legacy rows)."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "legacy q", ts=1000.0)
    _add_msg(state_db, "s1", "assistant", "legacy a", ts=1001.0)

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    assert len(items) == 2
    assert all("sidekick_id" not in i for i in items)
    assert items[0]["content"] == "legacy q"
    assert items[1]["content"] == "legacy a"


def test_no_duplicate_rows_even_when_msg_links_has_extra_entries(db, state_db):
    """Reading bodies from state.db is structurally immune to the
    2026-05-19 dupe bug. Even if parley.db.msg_links has a row that
    doesn't correspond to a real state.db message (e.g. a stale row
    from a turn that got /retry'd out), the read path only returns one
    row per state.db.messages entry."""
    _add_session(state_db, "s1")
    state_msg_id = _add_msg(state_db, "s1", "assistant", "Hey — received.", ts=3000.0)
    # The "real" link.
    state.upsert_msg_link(
        db, id="msg_real_xyz", chat_id=CHAT_ID, role="assistant",
        content="Hey — received.", agent_row_id=str(state_msg_id),
    )
    # A stale or duplicate link with same content but no corresponding
    # state.db row (mimics what would have made the parley.db-body
    # reader render the message twice).
    state.upsert_msg_link(
        db, id="legacy:999", chat_id=CHAT_ID, role="assistant",
        content="Hey — received.", agent_row_id="999",
    )

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    assert len(items) == 1, (
        "reading from state.db returns one row per logical "
        f"message; got {len(items)} items: {items}"
    )
    assert items[0]["sidekick_id"] == "msg_real_xyz"


# ── tool calls (must surface from state.db side) ─────────────────────


def test_surfaces_tool_calls_from_state_db(db, state_db):
    """tool_calls JSON lives on state.db.messages. The read path
    surfaces it directly — PWA's parseToolCalls reads this for
    activity rows."""
    _add_session(state_db, "s1")
    tcalls = json.dumps(
        [{"id": "call_x", "function": {"name": "web_search", "arguments": "{}"}}]
    )
    _add_msg(state_db, "s1", "assistant", "", ts=1000.0, tool_calls=tcalls)
    _add_msg(state_db, "s1", "tool", "result data", ts=1001.0, tool_call_id="call_x")

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    assert len(items) == 2
    assistant = [i for i in items if i["role"] == "assistant"][0]
    parsed = json.loads(assistant["tool_calls"])
    assert parsed[0]["function"]["name"] == "web_search"
    tool_row = [i for i in items if i["role"] == "tool"][0]
    assert tool_row["tool_call_id"] == "call_x"


# ── kind annotation (notifications) ──────────────────────────────────


def test_surfaces_kind_from_msg_links(db, state_db):
    """msg_links.kind annotates notification-shaped rows so PWA
    renders them as notifications vs regular replies."""
    _add_session(state_db, "s1")
    state_msg_id = _add_msg(state_db, "s1", "assistant",
                            "Cronjob Response: ...", ts=4000.0)
    state.upsert_msg_link(
        db, id="notif_cron_1", chat_id=CHAT_ID, role="assistant",
        content="Cronjob Response: ...", agent_row_id=str(state_msg_id),
        kind="cron",
    )

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    assert len(items) == 1
    assert items[0]["kind"] == "cron"
    assert items[0]["sidekick_id"] == "notif_cron_1"


# ── pagination ──────────────────────────────────────────────────────


def test_pagination_limit_returns_recent_window_with_has_more(db, state_db):
    """No `before_id`, lots of rows → return the latest `limit` items
    with has_more=True. Cursor for the next page is the smallest id
    in the returned window."""
    _add_session(state_db, "s1")
    for i in range(20):
        _add_msg(state_db, "s1", "user", f"msg-{i}", ts=1000.0 + i)

    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", limit=5
    )
    assert len(result["items"]) == 5
    assert result["has_more"] is True
    # Latest 5: msg-15..msg-19
    assert [i["content"] for i in result["items"]] == [f"msg-{n}" for n in range(15, 20)]


def test_pagination_before_cursor_returns_older_window(db, state_db):
    """before_id is a state.db.messages.id cursor — older page."""
    _add_session(state_db, "s1")
    msg_ids = [_add_msg(state_db, "s1", "user", f"msg-{i}", ts=1000.0 + i)
               for i in range(20)]

    # Page through older history: cursor at msg-10's id.
    cursor = msg_ids[10]
    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", limit=5, before_id=cursor
    )
    contents = [i["content"] for i in result["items"]]
    # Older than msg-10 → msg-5..msg-9 (5 most recent BEFORE the cursor).
    assert contents == [f"msg-{n}" for n in range(5, 10)]
    assert result["has_more"] is True


# ── compaction CTE (parent_session_id rollup) ────────────────────────


def test_rolls_up_compacted_child_session_messages(db, state_db):
    """state.db compaction creates child sessions with user_id=NULL but
    parent_session_id pointing to the original. The recursive CTE
    walks the chain so child messages still surface under the chat_id."""
    parent_prompt = "x" * 250  # CTE requires >= 200 chars
    _add_session(state_db, "parent_s", system_prompt=parent_prompt)
    _add_session(state_db, "child_s", chat_id=None,
                 system_prompt=parent_prompt[:200] + "...",
                 parent_session_id="parent_s")
    _add_msg(state_db, "parent_s", "user", "old prompt", ts=1000.0)
    _add_msg(state_db, "parent_s", "assistant", "old reply", ts=1001.0)
    _add_msg(state_db, "child_s", "user", "new prompt in child", ts=2000.0)
    _add_msg(state_db, "child_s", "assistant", "new reply in child", ts=2001.0)

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    contents = [i["content"] for i in items]
    assert contents == [
        "old prompt", "old reply",
        "new prompt in child", "new reply in child",
    ]


def test_drops_compaction_seed_block(db, state_db):
    """The `[CONTEXT COMPACTION — REFERENCE ONLY]` marker + everything
    before it within a child session is the hermes-injected seed block.
    Must not surface to the PWA (verbatim user-prompt dupe avoidance)."""
    parent_prompt = "x" * 250
    _add_session(state_db, "parent_s", system_prompt=parent_prompt)
    _add_session(state_db, "child_s", chat_id=None,
                 system_prompt=parent_prompt[:200] + "...",
                 parent_session_id="parent_s")
    _add_msg(state_db, "parent_s", "user", "real prompt", ts=1000.0)
    _add_msg(state_db, "parent_s", "assistant", "real reply", ts=1001.0)
    # Child session's seed block — must be filtered.
    _add_msg(state_db, "child_s", "user", "real prompt", ts=1500.0)
    _add_msg(state_db, "child_s", "assistant", "real reply", ts=1500.0)
    _add_msg(state_db, "child_s", "user",
             "[CONTEXT COMPACTION — REFERENCE ONLY]", ts=1500.0)
    # Real continuation in child after the marker.
    _add_msg(state_db, "child_s", "user", "next real prompt", ts=2000.0)

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    contents = [i["content"] for i in items]
    assert contents == ["real prompt", "real reply", "next real prompt"]


def test_bounded_tail_skips_old_compaction_seed(db, state_db):
    """Bounded tail read of a compacted child session whose seed block is
    far older than the fetched window. The head-end aggregate runs (the
    window holds compaction-child rows) but must not mis-elide live
    continuation rows whose ids are above the marker, and the old seed
    block stays dropped."""
    parent_prompt = "x" * 250
    _add_session(state_db, "parent_s", system_prompt=parent_prompt)
    _add_session(state_db, "child_s", chat_id=None,
                 system_prompt=parent_prompt[:200] + "...",
                 parent_session_id="parent_s")
    _add_msg(state_db, "child_s", "user", "seed prompt", ts=1500.0)
    _add_msg(state_db, "child_s", "user",
             "[CONTEXT COMPACTION — REFERENCE ONLY]", ts=1500.0)
    for i in range(80):
        _add_msg(state_db, "child_s", "user", f"real-{i}", ts=2000.0 + i)

    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", limit=10
    )
    contents = [i["content"] for i in result["items"]]
    assert contents == [f"real-{n}" for n in range(70, 80)]
    assert "seed prompt" not in contents
    assert "[CONTEXT COMPACTION — REFERENCE ONLY]" not in contents
    assert result["has_more"] is True


def test_bounded_before_elides_seed_across_boundary(db, state_db):
    """Paging backward (before_id) into the compaction boundary still
    drops the seed block via the head-end aggregate — the oldest
    surviving row is the first real continuation, never the seed/marker."""
    parent_prompt = "x" * 250
    _add_session(state_db, "parent_s", system_prompt=parent_prompt)
    _add_session(state_db, "child_s", chat_id=None,
                 system_prompt=parent_prompt[:200] + "...",
                 parent_session_id="parent_s")
    _add_msg(state_db, "child_s", "user", "seed prompt", ts=1500.0)
    _add_msg(state_db, "child_s", "user",
             "[CONTEXT COMPACTION — REFERENCE ONLY]", ts=1500.0)
    cont = [_add_msg(state_db, "child_s", "user", f"real-{i}", ts=2000.0 + i)
            for i in range(10)]

    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", limit=20, before_id=cont[5]
    )
    contents = [i["content"] for i in result["items"]]
    assert contents == [f"real-{n}" for n in range(5)]
    assert "seed prompt" not in contents
    assert result["has_more"] is False


# ── 404-ish empty case ──────────────────────────────────────────────


def test_returns_empty_for_unknown_chat(db, state_db):
    """No session exists for the chat_id → empty result, has_more=False.
    Caller (route handler) turns this into a 404 when combined with
    no inflight envelopes."""
    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, "unknown-chat-id", "sidekick"
    )
    assert result == {"items": [], "first_id": None, "has_more": False}


def test_envelope_only_chat_still_surfaces_msg_links_rows(db, state_db):
    """Brand-new chats and mid-turn streaming chats have envelope-written
    rows in msg_links but NO
    state.db rows yet (hermes flushes state.db at end of turn). A pure
    state.db read returned ZERO messages for these chats → activity-row
    drill said "no longer has a session," pinned messages couldn't open,
    all live-edge interactions on fresh chats broke.

    Contract: when state.db has nothing for a chat but msg_links has
    envelope-written rows, the read path must SURFACE THOSE ROWS — the
    union of state.db + unlinked envelope writes is what the user
    actually has. Otherwise the items endpoint is a strict subset of
    reality and breaks any consumer that addresses messages within the
    envelope-to-flush window."""
    # Envelope wrote three rows to parley.db (envelope write-through).
    # State.db has nothing — agent hasn't post-turn-flushed yet.
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_fresh", "text": "kick off",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_fresh_1", "text": "Checking.",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_fresh_2", "text": "Done — answer is 42.",
    })
    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick",
    )
    contents = [it["content"] for it in result["items"]]
    sks = [it.get("sidekick_id") for it in result["items"]]
    assert "kick off" in contents, \
        "envelope-only user message must surface even when state.db has nothing"
    assert "Checking." in contents
    assert "Done — answer is 42." in contents
    assert "umsg_fresh" in sks
    assert "msg_fresh_1" in sks
    assert "msg_fresh_2" in sks


def test_returns_empty_when_state_db_missing(db, tmp_path):
    """state.db path doesn't exist on disk (fresh install, never used).
    Must return empty without raising."""
    missing = tmp_path / "does-not-exist.db"
    result = state.list_messages_for_chat_with_state_db_source(
        db, missing, CHAT_ID, "sidekick"
    )
    assert result == {"items": [], "first_id": None, "has_more": False}


# ── around-target deep drill (bounded window) ────────────────────────


def test_around_returns_bounded_window_centered_on_target(db, state_db):
    """The deep-drill window is BOUNDED on both sides (context above AND
    below the target) and does NOT run to the live tail — so the payload
    stays O(limit) for any depth. has_more / has_more_newer report the
    open boundaries the PWA bridges via scroll-up / scroll-down."""
    _add_session(state_db, "s1")
    msg_ids = [_add_msg(state_db, "s1", "user", f"m{i}", ts=1000.0 + i)
               for i in range(300)]

    # Target idx 150, limit=60 → ctx_before=max(20,40)=40,
    # ctx_after=max(10,20)=20 → window=[110:171] = m110..m170.
    result = state.list_messages_around_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", target=str(msg_ids[150]), limit=60
    )
    assert result["target_found"] is True
    contents = [i["content"] for i in result["items"]]
    assert "m150" in contents             # target present
    assert contents[0] == "m110"          # 40 rows of above-context
    assert contents[-1] == "m170"         # 20 rows below — NOT the tail
    assert result["has_more"] is True     # older history above the window
    assert result["has_more_newer"] is True   # newer history below it
    assert result["first_id"] == msg_ids[110]
    assert result["last_id"] == msg_ids[170]


def test_around_deep_target_payload_is_bounded_not_tail_contiguous(db, state_db):
    """The regression this rewrite fixes: a pin near the TOP of a long
    session must NOT pull back everything from the target to the tail
    (835 rows / 4.27 MB for [pitch deck] over the London link). The
    window is capped at ~limit rows regardless of how far the target is
    from the live tail."""
    _add_session(state_db, "s1")
    n = 3000
    msg_ids = [_add_msg(state_db, "s1", "user", f"m{i}", ts=1000.0 + i)
               for i in range(n)]

    # Target idx 1500 (deep middle), limit=60 → window ~61 rows, NOT ~1500.
    result = state.list_messages_around_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", target=str(msg_ids[1500]), limit=60
    )
    assert result["target_found"] is True
    assert len(result["items"]) <= 61     # bounded, not O(distance-to-tail)
    contents = [i["content"] for i in result["items"]]
    assert "m1500" in contents
    assert result["has_more"] is True
    assert result["has_more_newer"] is True


def test_around_matches_target_by_sidekick_id(db, state_db):
    """Pins/activity address messages by sidekick_id (msg_xxx), not the
    integer state.db id — the around lookup must match either."""
    _add_session(state_db, "s1")
    msg_ids = [_add_msg(state_db, "s1", "user", f"msg-{i}", ts=1000.0 + i)
               for i in range(30)]
    state.upsert_msg_link(
        db, id="msg_target_abc", chat_id=CHAT_ID, role="user",
        content="msg-7", agent_row_id=str(msg_ids[7]),
    )

    # limit=50 → ctx_before=max(20,33)=33, ctx_after=max(10,16)=16.
    # start=max(0,7-33)=0, end=min(30,7+16+1)=24 → window=[0:24].
    result = state.list_messages_around_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", target="msg_target_abc", limit=50
    )
    assert result["target_found"] is True
    contents = [i["content"] for i in result["items"]]
    assert "msg-7" in contents
    assert contents[0] == "msg-0"          # reached the head → no older
    assert result["has_more"] is False
    assert contents[-1] == "msg-23"        # bounded below — NOT the tail
    assert result["has_more_newer"] is True
    assert result["last_id"] == msg_ids[23]


def test_around_small_chat_fits_whole_window(db, state_db):
    """A chat smaller than the budget returns the whole transcript with
    both boundaries closed (has_more / has_more_newer both False)."""
    _add_session(state_db, "s1")
    msg_ids = [_add_msg(state_db, "s1", "user", f"m{i}", ts=1000.0 + i)
               for i in range(10)]
    result = state.list_messages_around_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", target=str(msg_ids[5]), limit=50
    )
    assert result["target_found"] is True
    assert [i["content"] for i in result["items"]] == [f"m{i}" for i in range(10)]
    assert result["has_more"] is False
    assert result["has_more_newer"] is False
    assert result["first_id"] == msg_ids[0]
    assert result["last_id"] == msg_ids[9]


def test_around_target_not_found_returns_flag_false(db, state_db):
    """Stale pin / wrong chat → target_found=False + empty list so the
    PWA falls back to its serial load-earlier drill."""
    _add_session(state_db, "s1")
    for i in range(10):
        _add_msg(state_db, "s1", "user", f"msg-{i}", ts=1000.0 + i)

    result = state.list_messages_around_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", target="msg_does_not_exist", limit=20
    )
    assert result["target_found"] is False
    assert result["items"] == []
    assert result["has_more"] is False
    assert result["has_more_newer"] is False


# ── load-newer (after cursor) ────────────────────────────────────────


def test_after_returns_newer_page_bounded(db, state_db):
    """The after cursor returns the OLDEST `limit` items newer than the
    cursor, with has_more_newer True when more remain before the tail."""
    _add_session(state_db, "s1")
    msg_ids = [_add_msg(state_db, "s1", "user", f"m{i}", ts=1000.0 + i)
               for i in range(100)]

    # After idx 40, limit=20 → m41..m60, more remain (m61..m99).
    result = state.list_messages_after_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", after_id=msg_ids[40], limit=20
    )
    contents = [i["content"] for i in result["items"]]
    assert contents[0] == "m41"
    assert contents[-1] == "m60"
    assert result["has_more_newer"] is True
    assert result["first_id"] == msg_ids[41]
    assert result["last_id"] == msg_ids[60]


def test_after_reaching_tail_closes_boundary(db, state_db):
    """When the after page reaches the live tail, has_more_newer is False
    so the PWA knows it's back at the live edge."""
    _add_session(state_db, "s1")
    msg_ids = [_add_msg(state_db, "s1", "user", f"m{i}", ts=1000.0 + i)
               for i in range(50)]
    result = state.list_messages_after_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", after_id=msg_ids[40], limit=20
    )
    contents = [i["content"] for i in result["items"]]
    assert contents[0] == "m41"
    assert contents[-1] == "m49"          # reached the tail
    assert result["has_more_newer"] is False
    assert result["last_id"] == msg_ids[49]


def test_after_result_carries_has_more_key(db, state_db):
    """Regression: the items route reads result["has_more"] unconditionally
    for EVERY branch (older-direction scroll-up affordance). The load-newer
    (after) result used to omit it → KeyError → 500 on every load-newer,
    which the tail-refresh path turned into a full transcript/turn outage.
    The key must be present (False here — older side is the around-window's
    job, not this page's)."""
    _add_session(state_db, "s1")
    msg_ids = [_add_msg(state_db, "s1", "user", f"m{i}", ts=1000.0 + i)
               for i in range(60)]
    result = state.list_messages_after_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", after_id=msg_ids[40], limit=20
    )
    assert "has_more" in result, "after-result must carry has_more (route reads it)"
    assert result["has_more"] is False


# ── mixed-id-space pagination cursors (field bug 2026-07-04) ──────────
#
# Items carry ids from TWO spaces: state.db rowids (small ints) and
# envelope-only rows keyed by created_at epoch-millis (~1.8e12). The
# merged sort key is (created_at, id) — but the after/before filters
# compared RAW ids across the spaces. Once a page's tail item was an
# envelope-only row, the PWA's delta cursor became an epoch id and
# `state_row.id > epoch` was False for every durable row FOREVER: new
# turns never reached the client, and the tail-merge dropped the rows
# it did have (field report: the agent's long reply vanished; only a
# full-page fetch flashed it back until the next delta killed it again).
# Cursors must be resolved to their (created_at, id) sort tuple and
# compared in sort-key space.

# Realistic wall-clock base: envelope-only ids are int(created_at*1000)
# and must land in the epoch-millis space (>= _ENVELOPE_CURSOR_THRESHOLD)
# like production rows do — toy timestamps would dodge the cursor
# resolver's space detection entirely.
BASE_TS = 1_783_000_000.0


def _add_envelope_row(db, sk_id, role, content, created_at, chat_id=CHAT_ID):
    """Unlinked envelope-only msg_links row with a controlled created_at
    (upsert stamps wall-clock now; cursor math needs deterministic times)."""
    state.upsert_msg_link(db, id=sk_id, chat_id=chat_id, role=role,
                          content=content)
    db.exec("UPDATE msg_links SET created_at = ?, updated_at = ? WHERE id = ?",
            (created_at, created_at, sk_id))


def test_after_cursor_on_envelope_row_still_returns_new_durable_rows(db, state_db):
    """The vanishing-long-reply shape: page tail = unlinked envelope row
    (epoch-ms id) → client deltas with after=<epoch id> → every NEW
    durable (state.db) row must still be returned."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "q1", ts=BASE_TS + 0.0)
    _add_msg(state_db, "s1", "assistant", "long reply", ts=BASE_TS + 200.0)
    _add_envelope_row(db, "tc:call_orphan", "tool", "orphan tool result",
                      BASE_TS + 300.0)

    page = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )
    epoch_cursor = int((BASE_TS + 300.0) * 1000)
    assert page["items"][-1]["id"] == epoch_cursor, \
        "seed sanity: envelope-only row is the page tail → epoch cursor"

    q2 = _add_msg(state_db, "s1", "user", "q2", ts=BASE_TS + 400.0)
    a2 = _add_msg(state_db, "s1", "assistant", "a2", ts=BASE_TS + 500.0)

    result = state.list_messages_after_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", after_id=epoch_cursor
    )
    got = [(it["id"], it["content"]) for it in result["items"]]
    assert got == [(q2, "q2"), (a2, "a2")], \
        "epoch after-cursor must return newer durable rows (and only those)"


def test_before_cursor_on_envelope_row_pages_older_not_newer(db, state_db):
    """Mirror bug on the scroll-up path: before=<epoch id> must page rows
    strictly OLDER in sort order — with a raw id compare every durable
    row (including NEWER ones) passed `id < epoch`."""
    _add_session(state_db, "s1")
    q1 = _add_msg(state_db, "s1", "user", "q1", ts=BASE_TS + 0.0)
    lr = _add_msg(state_db, "s1", "assistant", "long reply", ts=BASE_TS + 200.0)
    _add_envelope_row(db, "tc:call_orphan", "tool", "orphan tool result",
                      BASE_TS + 300.0)
    _add_msg(state_db, "s1", "user", "q2", ts=BASE_TS + 400.0)

    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", before_id=int((BASE_TS + 300.0) * 1000)
    )
    got = [(it["id"], it["content"]) for it in result["items"]]
    assert got == [(q1, "q1"), (lr, "long reply")], \
        "before= from an envelope cursor must exclude rows newer than the cursor"


def test_after_state_cursor_pages_through_same_second_batch(db, state_db):
    """Turn-end batch writes stamp MANY rows with the same timestamp; the
    after-cursor must keep making progress within the second via the id
    tie-break (the (created_at, id) sort's second component)."""
    _add_session(state_db, "s1")
    ids = [_add_msg(state_db, "s1", "assistant", f"m{i}", ts=2000.0)
           for i in range(6)]
    first = state.list_messages_after_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", after_id=ids[1], limit=2
    )
    assert [it["id"] for it in first["items"]] == [ids[2], ids[3]]
    assert first["has_more_newer"] is True
    second = state.list_messages_after_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", after_id=first["last_id"], limit=2
    )
    assert [it["id"] for it in second["items"]] == [ids[4], ids[5]]


def test_after_state_cursor_includes_same_second_envelope_rows(db, state_db):
    """An unlinked envelope row created in the same second as the cursor
    row sorts after it (epoch id > state id) and must be returned."""
    _add_session(state_db, "s1")
    a1 = _add_msg(state_db, "s1", "assistant", "a1", ts=BASE_TS)
    _add_envelope_row(db, "umsg_live", "user", "live send", BASE_TS + 0.5)

    result = state.list_messages_after_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", after_id=a1
    )
    assert [it.get("sidekick_id") for it in result["items"]] == ["umsg_live"]


def test_after_cursor_row_deleted_falls_back_to_id_compare(db, state_db):
    """Cursor row gone from state.db (deleted/compacted) and not
    epoch-shaped → sort key unresolvable → legacy raw-id compare, which
    is correct for pure-durable pages."""
    _add_session(state_db, "s1")
    a = _add_msg(state_db, "s1", "user", "old", ts=1000.0)
    b = _add_msg(state_db, "s1", "assistant", "kept", ts=1100.0)
    conn = sqlite3.connect(str(state_db))
    conn.execute("DELETE FROM messages WHERE id = ?", (a,))
    conn.commit()
    conn.close()
    result = state.list_messages_after_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", after_id=a
    )
    assert [it["id"] for it in result["items"]] == [b]
