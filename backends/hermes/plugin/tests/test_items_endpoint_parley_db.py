"""parley.db-backed items reader + state.db reconciliation.

Covers ``list_messages_for_chat`` (the body-store reader used when
``PARLEY_ITEMS_READ_FROM_STATE_DB`` is off) and the
``reconcile_from_state_db`` linker, which runs on every read
regardless of which body source is active. The state.db-canonical
reader is covered in test_items_endpoint_state_db_source.py.

Pins down:
  - list_messages_for_chat returns the wire shape (id, role, content,
    created_at, parley_id, kind/tool_name/tool_call_id when set)
  - Pagination by rowid (before cursor + first_id)
  - reconcile_from_state_db pulls state.db rows missing from
    parley.db, idempotent on second call
  - The content-fingerprint + order-fallback linker attaches
    agent_row_id to envelope-written rows
  - Orphan-drop self-heal when state.db rows disappear (delete/retry)
  - Empty-everywhere → returns empty (and the route turns that into
    404 when no session existed; tested separately at the route layer)

Doesn't exercise the route handler directly — that lives in
test_user_id_queries.py. This file covers the *storage +
reconciliation* contract that the route delegates to.
"""

from __future__ import annotations

import sqlite3
import time

import pytest

from ..parley_db import ParleyDB
from .. import parley_state as state


CHAT_ID = "c0a01ab1-2b3c-4d5e-6f70-8090a0b0c0d0"


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "parley.db")
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


def _add_session(state_db, sid, chat_id=CHAT_ID, source="parley"):
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, started_at) VALUES (?, ?, ?, ?)",
        (sid, source, chat_id, time.time()),
    )
    conn.commit()
    conn.close()


def _add_msg(state_db, sid, role, content, ts=None, tool_calls=None, tool_name=None, tool_call_id=None):
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, tool_call_id, tool_calls, timestamp) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, role, content, tool_name, tool_call_id, tool_calls, ts if ts is not None else time.time()),
    )
    conn.commit()
    conn.close()


# ── tool_calls propagation (fix for "(unknown)" tool names) ───────────


def test_reconcile_propagates_tool_calls_from_state_db(db, state_db):
    """state.db's assistant row carries tool_calls JSON (OpenAI shape).
    Reconcile must propagate it so PWA projection's parseToolCalls can
    show real tool names + args (was '(unknown)' before the fix)."""
    import json as _json
    _add_session(state_db, "s1")
    tcalls = _json.dumps([
        {"id": "call_x", "function": {"name": "web_search", "arguments": '{"q":"openclaw"}'}},
    ])
    _add_msg(state_db, "s1", "user", "search please", 1000.0)
    _add_msg(state_db, "s1", "assistant", "", 1001.0, tool_calls=tcalls)
    _add_msg(state_db, "s1", "tool", "results: [...]", 1002.0, tool_call_id="call_x")
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    items = state.list_messages_for_chat(db, CHAT_ID)["items"]
    assistant_items = [i for i in items if i["role"] == "assistant"]
    assert len(assistant_items) == 1
    assert assistant_items[0]["tool_calls"] is not None
    parsed = _json.loads(assistant_items[0]["tool_calls"])
    assert parsed[0]["function"]["name"] == "web_search"


def test_tool_calls_heal_for_already_reconciled_legacy_rows(db, state_db):
    """Existing deployments have legacy: rows from before the tool_calls
    column was added (NULL there). A subsequent reconcile must heal
    them by pulling tool_calls from state.db without re-inserting.

    tool_calls heal is a one-time migration concern — once the column
    is populated it stays populated. The fast-path's no-drift skip
    (added 2026-06-23) doesn't run the heal sweep, so the periodic
    full sweep is the right surface for it. This test forces the
    full pass explicitly via ``force_full=True`` to exercise the heal."""
    import json as _json
    _add_session(state_db, "s1")
    tcalls = _json.dumps([
        {"id": "call_y", "function": {"name": "fetch", "arguments": "{}"}},
    ])
    _add_msg(state_db, "s1", "assistant", "", 1000.0, tool_calls=tcalls)
    # Simulate the prior-version legacy: row (tool_calls NULL).
    state.upsert_msg_link(
        db, id="legacy:1", chat_id=CHAT_ID, role="assistant",
        content="", agent_row_id="1",
    )
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley", force_full=True)
    row = db.fetchone(
        "SELECT tool_calls FROM msg_links WHERE id='legacy:1'"
    )
    assert row["tool_calls"] is not None
    assert "fetch" in row["tool_calls"]


# ── wire shape ────────────────────────────────────────────────────────


def test_list_messages_for_chat_returns_wire_shape(db):
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_1", "text": "hi",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_1", "text": "hello back",
    })
    result = state.list_messages_for_chat(db, CHAT_ID)
    items = result["items"]
    assert len(items) == 2
    # User bubble
    assert items[0]["parley_id"] == "umsg_1"
    assert items[0]["role"] == "user"
    assert items[0]["content"] == "hi"
    assert items[0]["object"] == "message"
    assert isinstance(items[0]["id"], int)  # rowid cursor
    assert items[0]["created_at"] > 0
    # Assistant bubble
    assert items[1]["parley_id"] == "msg_1"
    assert items[1]["role"] == "assistant"
    assert items[1]["content"] == "hello back"


def test_tool_rows_carry_tool_metadata(db):
    state.record_envelope(db, {
        "type": "tool_call", "chat_id": CHAT_ID,
        "call_id": "c1", "tool_name": "search", "args": {"q": "x"},
    })
    state.record_envelope(db, {
        "type": "tool_result", "chat_id": CHAT_ID,
        "call_id": "c1", "tool_name": "search", "result": "results",
    })
    items = state.list_messages_for_chat(db, CHAT_ID)["items"]
    assert len(items) == 2
    assert items[0]["tool_name"] == "search"
    assert items[0]["tool_call_id"] == "c1"
    assert items[1]["tool_name"] == "search"


def test_notification_carries_kind(db):
    state.record_envelope(db, {
        "type": "notification", "chat_id": CHAT_ID,
        "message_id": "notif_1", "kind": "cron", "content": "tick",
    })
    items = state.list_messages_for_chat(db, CHAT_ID)["items"]
    assert items[0]["kind"] == "cron"


# ── pagination ────────────────────────────────────────────────────────


def test_recent_envelope_not_hidden_behind_legacy_backfill(db, state_db):
    """Envelope-write happens at envelope-emit time → row at rowid N
    with created_at=NOW. Then a hard refresh triggers reconcile,
    which backfills many historic rows from state.db. Those rows are
    inserted in state.db-id order — NOT chronological — so they
    occupy higher rowids. Pagination by rowid would hide the fresh
    envelope row behind the backfill.

    Correct behavior: pagination by created_at, so the fresh envelope
    row (timestamp NOW) is in the most-recent window regardless of
    rowid.
    """
    # Step 1: simulate the just-sent message landing via envelope write.
    fresh_ts = 1779182521.0  # represents a "just sent" timestamp
    state.upsert_msg_link(
        db, id="umsg_fresh", chat_id=CHAT_ID, role="user",
        content="my just-sent message",
    )
    # Force the created_at to "now-ish" to simulate the envelope-write.
    db.exec(
        "UPDATE msg_links SET created_at=?, updated_at=? WHERE id=?",
        (fresh_ts, fresh_ts, "umsg_fresh"),
    )

    # Step 2: simulate reconcile backfilling 622 historic rows from
    # state.db, all with EARLIER timestamps but inserted AFTER (so
    # higher rowids).
    _add_session(state_db, "s1")
    base_ts = 1779000000.0
    for i in range(250):
        _add_msg(state_db, "s1", "user", f"historic msg {i}", base_ts + i)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")

    # Now: parley.db has 251 rows. The fresh row's rowid is LOW
    # (inserted first), the historic rows' rowids are HIGH.
    fresh_row = db.fetchone(
        "SELECT rowid FROM msg_links WHERE id='umsg_fresh'"
    )
    historic_max = db.fetchone(
        "SELECT MAX(rowid) AS m FROM msg_links WHERE id LIKE 'legacy:%'"
    )
    assert fresh_row["rowid"] < historic_max["m"]  # rowid order is wrong

    # Step 3: items endpoint behavior. Pagination by created_at
    # means the fresh row (timestamp = today) is in the recent window.
    result = state.list_messages_for_chat(db, CHAT_ID, limit=100)
    sks = [i["parley_id"] for i in result["items"]]
    assert "umsg_fresh" in sks, \
        f"Fresh envelope row missing from recent window. Got: {sks[:5]}..."
    # It should be the LAST item (most recent by created_at).
    assert result["items"][-1]["parley_id"] == "umsg_fresh"


def test_pagination_first_page(db):
    for i in range(5):
        state.record_envelope(db, {
            "type": "user_message", "chat_id": CHAT_ID,
            "message_id": f"umsg_{i}", "text": f"msg {i}",
        })
    result = state.list_messages_for_chat(db, CHAT_ID, limit=3)
    # First page (before=None) returns most-recent `limit` items.
    assert len(result["items"]) == 3
    assert result["has_more"] is True
    sks = [i["parley_id"] for i in result["items"]]
    assert sks == ["umsg_2", "umsg_3", "umsg_4"]
    assert result["first_id"] == result["items"][0]["id"]


def test_pagination_load_earlier(db):
    for i in range(5):
        state.record_envelope(db, {
            "type": "user_message", "chat_id": CHAT_ID,
            "message_id": f"umsg_{i}", "text": f"msg {i}",
        })
    first_page = state.list_messages_for_chat(db, CHAT_ID, limit=3)
    cursor = first_page["first_id"]
    earlier = state.list_messages_for_chat(db, CHAT_ID, limit=10, before_rowid=cursor)
    sks = [i["parley_id"] for i in earlier["items"]]
    assert sks == ["umsg_0", "umsg_1"]
    assert earlier["has_more"] is False


# ── reconciliation ────────────────────────────────────────────────────


def test_reconcile_pulls_state_db_rows_missing_from_parley_db(db, state_db):
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "from state.db", 1000.0)
    _add_msg(state_db, "s1", "assistant", "reply from state.db", 1001.0)
    n = state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    assert n == 2
    items = state.list_messages_for_chat(db, CHAT_ID)["items"]
    sks = [i["parley_id"] for i in items]
    assert all(s.startswith("legacy:") for s in sks)
    contents = [i["content"] for i in items]
    assert "from state.db" in contents
    assert "reply from state.db" in contents


def test_reconcile_is_idempotent(db, state_db):
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "msg", 1000.0)
    first = state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    assert first == 1
    second = state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    assert second == 0


def test_reconcile_skips_rows_already_linked(db, state_db):
    """Rows envelope-written with agent_row_id set don't get duplicated."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "hello", 1000.0)
    # Pretend the linker already attached this row.
    state.upsert_msg_link(
        db, id="umsg_real", chat_id=CHAT_ID, role="user",
        content="hello", agent_row_id="1",
    )
    n = state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    assert n == 0
    items = state.list_messages_for_chat(db, CHAT_ID)["items"]
    assert len(items) == 1
    assert items[0]["parley_id"] == "umsg_real"


def test_reconcile_drops_compaction_seed_rows(db, state_db):
    """The [CONTEXT COMPACTION] marker injected by hermes when minting a
    child session never reaches parley.db."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "real prompt", 1000.0)
    _add_msg(state_db, "s1", "system", "[CONTEXT COMPACTION] internal seed", 1001.0)
    _add_msg(state_db, "s1", "assistant", "real reply", 1002.0)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    items = state.list_messages_for_chat(db, CHAT_ID)["items"]
    contents = [i["content"] for i in items]
    assert "real prompt" in contents
    assert "real reply" in contents
    assert not any(c.startswith("[CONTEXT COMPACTION") for c in contents)


def test_reconcile_when_state_db_missing_is_noop(db, tmp_path):
    """Missing state.db file → reconcile returns 0, doesn't raise."""
    fake = tmp_path / "nonexistent.db"
    n = state.reconcile_from_state_db(db, fake, CHAT_ID, "parley")
    assert n == 0


# ── content-fingerprint linker ────────────────────────────────────────


def test_linker_attaches_agent_row_id_by_content_match(db, state_db):
    """Envelope-written row (NULL agent_row_id) gets linked to its
    state.db twin via content + role match."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "Hey there", 1000.0)
    _add_msg(state_db, "s1", "assistant", "Hello back", 1001.0)
    # Pre-existing envelope-written rows from envelope write-through.
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_link1", "text": "Hey there",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_link1", "text": "Hello back",
    })
    # Before reconcile: agent_row_id NULL on both.
    rows = state.list_msg_links_for_chat(db, CHAT_ID)
    assert all(r["agentRowId"] is None for r in rows)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    rows = state.list_msg_links_for_chat(db, CHAT_ID)
    # Both rows now have agent_row_id pointing at their state.db twin.
    by_id = {r["id"]: r["agentRowId"] for r in rows}
    assert by_id["umsg_link1"] == "1"
    assert by_id["msg_link1"] == "2"
    # No legacy: rows added — content matched, nothing left to insert.
    sks = [r["id"] for r in rows]
    assert not any(s.startswith("legacy:") for s in sks)


def test_linker_idempotent_no_extra_changes_on_second_call(db, state_db):
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "ping", 1000.0)
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_idem", "text": "ping",
    })
    first = state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    second = state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    assert first == 1  # one link
    assert second == 0
    rows = state.list_msg_links_for_chat(db, CHAT_ID)
    assert len(rows) == 1
    assert rows[0]["agentRowId"] == "1"


def test_linker_handles_duplicate_content_in_order(db, state_db):
    """Two state.db rows with identical user content match two
    envelope-written rows with the same content, in id-ASC order."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "ok", 1000.0)
    _add_msg(state_db, "s1", "assistant", "reply 1", 1001.0)
    _add_msg(state_db, "s1", "user", "ok", 1002.0)
    _add_msg(state_db, "s1", "assistant", "reply 2", 1003.0)
    # Two user envelopes with same text, distinct msg_ids
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_a", "text": "ok",
    })
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_b", "text": "ok",
    })
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    rows = {r["id"]: r["agentRowId"] for r in state.list_msg_links_for_chat(db, CHAT_ID)}
    # umsg_a (recorded first) → state.db row 1 (first "ok")
    # umsg_b (recorded second) → state.db row 3 (second "ok")
    assert rows["umsg_a"] == "1"
    assert rows["umsg_b"] == "3"


def test_linker_leaves_unmatched_row_null(db, state_db):
    """Envelope row with no state.db twin (state.db lag, or row never
    persisted) keeps agent_row_id NULL. No crash."""
    _add_session(state_db, "s1")
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_orphan", "text": "no twin in state.db",
    })
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    rows = state.list_msg_links_for_chat(db, CHAT_ID)
    assert len(rows) == 1
    assert rows[0]["agentRowId"] is None
    assert rows[0]["id"] == "umsg_orphan"


def test_linker_order_fallback_under_content_drift(db, state_db):
    """When content fingerprint match fails (whitespace drift, hermes-
    side post-edit, empty-final-reply path), order-fallback within
    (chat, role) pairs envelope rows with state.db rows in append-only
    sequence. Added 2026-05-29 — closes the class where
    Pass 2 would otherwise insert a parallel `legacy:<state_id>` row.
    """
    _add_session(state_db, "s1")
    # State.db has hermes' normalized content (trailing newline stripped
    # vs envelope's accumulated streaming text + a literal whitespace
    # divergence). Each envelope still has a unique parley_id.
    _add_msg(state_db, "s1", "user", "kick off the job", 1000.0)
    _add_msg(state_db, "s1", "assistant", "On it.\nWill report back.", 1001.0)
    _add_msg(state_db, "s1", "user", "great", 1002.0)
    _add_msg(state_db, "s1", "assistant", "Done.", 1003.0)
    # Envelope rows have drift: assistant 1 has an extra trailing space,
    # user 2 has an em-dash variant. Direct (role, content) match fails.
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_drift_1", "text": "kick off the job ",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_drift_1", "text": "On it.\nWill report back. ",
    })
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_drift_2", "text": "great!",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_drift_2", "text": "Done!",
    })
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    by_id = {r["id"]: r["agentRowId"] for r in state.list_msg_links_for_chat(db, CHAT_ID)}
    # All four envelopes link via order-fallback (append-only sequence
    # within role). No parallel `legacy:` rows.
    assert by_id["umsg_drift_1"] == "1"
    assert by_id["msg_drift_1"] == "2"
    assert by_id["umsg_drift_2"] == "3"
    assert by_id["msg_drift_2"] == "4"
    sks = list(by_id.keys())
    assert not any(s.startswith("legacy:") for s in sks), \
        f"order-fallback should have linked all rows; got `legacy:` insertions: {sks}"


def test_linker_order_fallback_preserves_role_separation(db, state_db):
    """Order-fallback pairs strictly within (chat, role). A user
    envelope cannot accidentally link to an assistant state.db row
    even if their relative ordering aligns."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "X", 1000.0)        # state.db id=1
    _add_msg(state_db, "s1", "assistant", "Y", 1001.0)   # state.db id=2
    # Both envelope contents drift; only one of each role; order-
    # fallback must pair u→user-row and a→assistant-row, not swap.
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_role", "text": "X-drift",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_role", "text": "Y-drift",
    })
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    by_id = {r["id"]: r["agentRowId"] for r in state.list_msg_links_for_chat(db, CHAT_ID)}
    assert by_id["umsg_role"] == "1"     # user envelope → user state.db row
    assert by_id["msg_role"] == "2"      # assistant envelope → assistant state.db row


def test_linker_order_fallback_skips_tool_rows(db, state_db):
    """role='tool' is intentionally NOT covered by order-fallback:
    parley writes two tool msg_links rows per call (tc:* + tr:*) but
    state.db has only one (the result). Order-fallback on tool would
    mis-pair the call envelope to the result row."""
    _add_session(state_db, "s1")
    _add_msg(
        state_db, "s1", "tool", "result payload", 1000.0,
        tool_name="t", tool_call_id="call_zz",
    )
    # Pre-record the tool_call envelope WITHOUT recording the tool_result
    # (so content-match doesn't claim the state.db row first).
    state.record_envelope(db, {
        "type": "tool_call", "chat_id": CHAT_ID,
        "call_id": "call_zz", "tool_name": "t", "args": {},
    })
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    by_id = {r["id"]: r["agentRowId"] for r in state.list_msg_links_for_chat(db, CHAT_ID)}
    # tc:* row must NOT be linked by order-fallback (would be wrong;
    # state.db row is the tool RESULT, not the call). Pass 2 inserts
    # `legacy:1` for the orphaned state.db tool row.
    assert by_id.get("tc:call_zz") is None
    legacy_keys = [k for k in by_id if k.startswith("legacy:")]
    assert legacy_keys == ["legacy:1"]


def test_linker_skips_state_db_row_already_claimed(db, state_db):
    """A state.db row that's the target of a prior link doesn't get
    re-claimed for a second unlinked parley.db row with the same
    content."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "shared text", 1000.0)
    state.upsert_msg_link(
        db, id="umsg_already_linked", chat_id=CHAT_ID, role="user",
        content="shared text", agent_row_id="1",
    )
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_dup", "text": "shared text",
    })
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    rows = {r["id"]: r["agentRowId"] for r in state.list_msg_links_for_chat(db, CHAT_ID)}
    assert rows["umsg_already_linked"] == "1"
    # umsg_dup couldn't claim id=1 (already claimed); no other state.db
    # row matches; stays NULL.
    assert rows["umsg_dup"] is None


# ── bidirectional self-heal (orphan-drop) ─────────────────────────────


def test_fast_path_skips_full_scan_on_no_drift(db, state_db):
    """Perf regression guard: reconcile must NOT do the full state.db
    fetch when there's no drift. Setup links rows, then calls reconcile
    a SECOND time — fast-path must hit, bail immediately, no work done.
    Compares wall-time to a heavy-state.db chat seeded with 500 rows;
    the no-drift second call must complete in a small fraction of the
    first-call time.
    """
    _add_session(state_db, "s1")
    # Big enough that a full scan + python list-comp is meaningfully
    # slower than a LIMIT-1 fast-path check.
    n_rows = 500
    for i in range(n_rows):
        _add_msg(state_db, "s1", "user" if i % 2 == 0 else "assistant",
                 f"m{i}", ts=1000.0 + i)
    for i in range(n_rows):
        state.upsert_msg_link(
            db, id=f"legacy:{i+1}", chat_id=CHAT_ID,
            role="user" if i % 2 == 0 else "assistant",
            content=f"m{i}", agent_row_id=str(i + 1),
        )
    # First reconcile: nothing to do (everything already linked) — but
    # under the OLD code path this still walked all 500 rows. Time it
    # with the OLD path forced.
    import time as _t
    t0 = _t.monotonic()
    n_forced = state.reconcile_from_state_db(
        db, state_db, CHAT_ID, "parley", force_full=True,
    )
    dt_full = _t.monotonic() - t0
    assert n_forced == 0
    # Second reconcile: same no-drift state, but with the fast-path.
    t0 = _t.monotonic()
    n_fast = state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    dt_fast = _t.monotonic() - t0
    assert n_fast == 0
    # Fast-path must be DRAMATICALLY faster than the full pass. We
    # don't pin to an absolute number (CI noise), just to a ratio that
    # is impossible if the fast-path didn't fire.
    assert dt_fast < dt_full / 3, (
        f"fast-path didn't engage: full={dt_full*1000:.1f}ms "
        f"fast={dt_fast*1000:.1f}ms (expected fast < full/3)"
    )


def test_orphan_drop_when_state_db_session_deleted(db, state_db):
    """Parley.db rows linked to state.db ids that no longer exist
    get dropped. Models an explicit session delete or 90-day prune."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "before delete", 1000.0)
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_predel", "text": "before delete",
    })
    # First reconcile: linker attaches agent_row_id=1.
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    assert state.list_msg_links_for_chat(db, CHAT_ID)[0]["agentRowId"] == "1"
    # Simulate hermes-side session delete: row 1 gone from state.db.
    conn = sqlite3.connect(str(state_db))
    conn.execute("DELETE FROM messages WHERE id = 1")
    conn.commit()
    conn.close()
    # Reconcile again: orphan dropped.
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    rows = state.list_msg_links_for_chat(db, CHAT_ID)
    assert rows == []


def test_orphan_drop_handles_retry_rewrite(db, state_db):
    """`/retry` deletes all rows in a session and reinserts the new
    transcript with new ids. Old envelope-linked rows are orphans;
    new state.db rows arrive as legacy: inserts."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "original prompt", 1000.0)
    _add_msg(state_db, "s1", "assistant", "original reply", 1001.0)
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_retry", "text": "original prompt",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_retry", "text": "original reply",
    })
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    # Simulate /retry: state.db DELETE+REINSERT replaces both rows.
    conn = sqlite3.connect(str(state_db))
    conn.execute("DELETE FROM messages WHERE session_id = 's1'")
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
        ("s1", "user", "retried prompt", 2000.0),
    )
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
        ("s1", "assistant", "retried reply", 2001.0),
    )
    conn.commit()
    conn.close()
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    items = state.list_messages_for_chat(db, CHAT_ID)["items"]
    contents = [i["content"] for i in items]
    assert contents == ["retried prompt", "retried reply"]
    sks = [i["parley_id"] for i in items]
    assert all(s.startswith("legacy:") for s in sks)


def test_orphan_drop_preserves_unlinked_envelope_rows(db, state_db):
    """A row with NULL agent_row_id is in-flight (envelope written,
    state.db hasn't flushed yet OR linker hasn't matched). MUST NOT
    be dropped as an orphan."""
    _add_session(state_db, "s1")
    # state.db has zero rows yet — brand-new chat post-restart.
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_inflight", "text": "just sent",
    })
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    rows = state.list_msg_links_for_chat(db, CHAT_ID)
    assert len(rows) == 1
    assert rows[0]["id"] == "umsg_inflight"
    assert rows[0]["agentRowId"] is None


def test_orphan_drop_skipped_when_state_db_unreachable(db, tmp_path):
    """A locked or missing state.db must NOT trigger orphan drops —
    that'd wipe legitimate rows on a transient sqlite hiccup."""
    # Pre-populate parley.db with a linked row.
    state.upsert_msg_link(
        db, id="umsg_safe", chat_id=CHAT_ID, role="user",
        content="not gone", agent_row_id="42",
    )
    fake = tmp_path / "missing.db"
    n = state.reconcile_from_state_db(db, fake, CHAT_ID, "parley")
    assert n == 0
    rows = state.list_msg_links_for_chat(db, CHAT_ID)
    # Row preserved despite reconcile not being able to confirm
    # state.db has its twin.
    assert len(rows) == 1
    assert rows[0]["id"] == "umsg_safe"


def test_orphan_drop_partial_session_mutation(db, state_db):
    """Mix: some rows still valid, some orphaned. Only orphans drop."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "kept row", 1000.0)
    _add_msg(state_db, "s1", "user", "to be deleted", 1001.0)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    assert len(state.list_msg_links_for_chat(db, CHAT_ID)) == 2
    # Delete row id=2 only.
    conn = sqlite3.connect(str(state_db))
    conn.execute("DELETE FROM messages WHERE id = 2")
    conn.commit()
    conn.close()
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    items = state.list_messages_for_chat(db, CHAT_ID)["items"]
    assert len(items) == 1
    assert items[0]["content"] == "kept row"


def test_reconcile_walks_compaction_child_sessions(db, state_db):
    """Recursive CTE picks up rows from a compaction child session
    whose user_id is NULL but whose parent_session_id chain rolls
    up to the requested chat_id."""
    long_prompt = "x" * 250  # > 200 chars, matches the CTE join condition
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, system_prompt, parent_session_id, started_at) "
        "VALUES (?, ?, ?, ?, NULL, ?)",
        ("root", "parley", CHAT_ID, long_prompt, 1000.0),
    )
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, system_prompt, parent_session_id, started_at) "
        "VALUES (?, ?, NULL, ?, ?, ?)",
        ("child", "parley", long_prompt, "root", 1100.0),
    )
    conn.commit()
    conn.close()
    _add_msg(state_db, "root", "user", "before compaction", 1000.0)
    _add_msg(state_db, "child", "user", "after compaction", 1100.0)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley")
    items = state.list_messages_for_chat(db, CHAT_ID)["items"]
    contents = [i["content"] for i in items]
    assert "before compaction" in contents
    assert "after compaction" in contents
