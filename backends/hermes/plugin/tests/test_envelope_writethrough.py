"""Envelope write-through to the parley.db message store.

Asserts every persisted envelope type (`user_message`, `reply_delta`,
`reply_final`, `tool_call`, `tool_result`, `notification`) lands as a
row in parley.db's message store at envelope-emit time, with the
right id / role / content / status. Non-persisted types (`typing`,
`session_changed`, etc.) must NOT produce a row.

These tests pin down the **write contract** the items endpoint relies
on. If a future commit breaks the write path, items will silently lose
rows; the smokes here catch that class deterministically.
"""

from __future__ import annotations

import pytest

from ..parley_db import ParleyDB
from .. import parley_state as state


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "parley.db")
    yield db
    db.close()


CHAT_ID = "c0a01ab1-2b3c-4d5e-6f70-8090a0b0c0d0"


def _rows(db, chat_id=CHAT_ID):
    return state.list_msg_links_for_chat(db, chat_id, limit=500)


# ── persisted-type coverage ───────────────────────────────────────────


def test_user_message_writes_row(db):
    state.record_envelope(db, {
        "type": "user_message",
        "chat_id": CHAT_ID,
        "message_id": "umsg_test_1",
        "text": "hello",
    })
    rows = _rows(db)
    assert len(rows) == 1
    r = rows[0]
    assert r["id"] == "umsg_test_1"
    assert r["role"] == "user"
    assert r["content"] == "hello"
    assert r["status"] == "final"


def test_reply_delta_then_final_accumulates_and_finalizes(db):
    # Hermes streams cumulative text per delta; final may omit text
    # entirely. Cumulative content lives on the last delta.
    state.record_envelope(db, {
        "type": "reply_delta",
        "chat_id": CHAT_ID,
        "message_id": "msg_test_1",
        "text": "Hello",
    })
    state.record_envelope(db, {
        "type": "reply_delta",
        "chat_id": CHAT_ID,
        "message_id": "msg_test_1",
        "text": "Hello world",
    })
    rows = _rows(db)
    assert len(rows) == 1
    assert rows[0]["status"] == "streaming"
    assert rows[0]["content"] == "Hello world"

    # reply_final with no text body — pull from existing row.
    state.record_envelope(db, {
        "type": "reply_final",
        "chat_id": CHAT_ID,
        "message_id": "msg_test_1",
    })
    rows = _rows(db)
    assert len(rows) == 1
    assert rows[0]["status"] == "final"
    assert rows[0]["content"] == "Hello world"


def test_reply_final_with_explicit_text_overrides_buffer(db):
    state.record_envelope(db, {
        "type": "reply_delta",
        "chat_id": CHAT_ID,
        "message_id": "msg_test_2",
        "text": "partial",
    })
    state.record_envelope(db, {
        "type": "reply_final",
        "chat_id": CHAT_ID,
        "message_id": "msg_test_2",
        "text": "final answer",
    })
    rows = _rows(db)
    assert rows[0]["content"] == "final answer"
    assert rows[0]["status"] == "final"


def test_tool_call_writes_row_keyed_tc_callid(db):
    state.record_envelope(db, {
        "type": "tool_call",
        "chat_id": CHAT_ID,
        "call_id": "call_abc",
        "tool_name": "web_search",
        "args": {"q": "openclaw"},
    })
    rows = _rows(db)
    assert len(rows) == 1
    r = rows[0]
    assert r["id"] == "tc:call_abc"
    assert r["role"] == "tool"
    assert r["toolName"] == "web_search"
    assert r["toolCallId"] == "call_abc"
    # args serialized as JSON
    assert "openclaw" in r["content"]


def test_tool_result_writes_row_keyed_tr_callid(db):
    state.record_envelope(db, {
        "type": "tool_result",
        "chat_id": CHAT_ID,
        "call_id": "call_abc",
        "tool_name": "web_search",
        "result": "results: [...]",
    })
    rows = _rows(db)
    assert len(rows) == 1
    r = rows[0]
    assert r["id"] == "tr:call_abc"
    assert r["role"] == "tool"
    assert r["content"] == "results: [...]"


def test_notification_writes_row_with_kind(db):
    state.record_envelope(db, {
        "type": "notification",
        "chat_id": CHAT_ID,
        "message_id": "notif_test_1",
        "kind": "cron",
        "content": "Cronjob Response: hourly summary",
    })
    rows = _rows(db)
    assert len(rows) == 1
    r = rows[0]
    assert r["id"] == "notif_test_1"
    assert r["role"] == "assistant"
    assert r["kind"] == "cron"


def test_notification_prefers_and_preserves_parley_id(db):
    env = {
        "type": "notification",
        "chat_id": CHAT_ID,
        "parley_id": "notif_state_1",
        "message_id": "notif_other_1",
        "kind": "background",
        "content": "Background done",
    }

    rid = state.record_envelope(db, env)

    assert rid == "notif_state_1"
    assert env["parley_id"] == "notif_state_1"
    rows = _rows(db)
    assert len(rows) == 1
    assert rows[0]["id"] == "notif_state_1"
    assert rows[0]["kind"] == "background"


def test_notification_without_message_id_mints_synthesized_id(db):
    env = {
        "type": "notification",
        "chat_id": CHAT_ID,
        "kind": "reminder",
        "content": "ping",
    }
    rid = state.record_envelope(db, env)
    assert rid is not None
    assert rid.startswith("notif_")
    assert env["parley_id"] == rid
    rows = _rows(db)
    assert len(rows) == 1
    assert rows[0]["id"] == rid


# ── non-persisted types: must NOT produce rows ────────────────────────


@pytest.mark.parametrize("etype", [
    "typing",
    "session_changed",
    "error",
    "image",
    "unread_changed",
])
def test_transient_envelope_types_do_not_write(db, etype):
    state.record_envelope(db, {"type": etype, "chat_id": CHAT_ID})
    assert _rows(db) == []


# ── id-space discipline ───────────────────────────────────────────────


def test_user_message_without_id_skipped(db):
    """No row id → no row. Otherwise we'd create unkeyed garbage."""
    state.record_envelope(db, {
        "type": "user_message",
        "chat_id": CHAT_ID,
        "text": "no id",
    })
    assert _rows(db) == []


def test_missing_chat_id_skipped(db):
    state.record_envelope(db, {
        "type": "user_message",
        "message_id": "umsg_x",
        "text": "hi",
    })
    assert _rows(db) == []


def test_chat_id_source_prefix_stripped(db):
    """PWA-supplied `parley:<uuid>` ids and bare UUIDs land in the
    same chat. The dispatcher path strips the prefix; record_envelope
    mirrors that so a turn that came in prefixed doesn't fork into a
    second chat row."""
    state.record_envelope(db, {
        "type": "user_message",
        "chat_id": f"parley:{CHAT_ID}",
        "message_id": "umsg_pfx",
        "text": "prefixed",
    })
    rows = _rows(db, chat_id=CHAT_ID)
    assert len(rows) == 1
    assert rows[0]["id"] == "umsg_pfx"


# ── idempotency ───────────────────────────────────────────────────────


def test_repeating_user_message_is_idempotent(db):
    env = {
        "type": "user_message",
        "chat_id": CHAT_ID,
        "message_id": "umsg_idem",
        "text": "once",
    }
    state.record_envelope(db, env)
    state.record_envelope(db, env)
    state.record_envelope(db, env)
    rows = _rows(db)
    assert len(rows) == 1
    assert rows[0]["content"] == "once"


# ── multi-turn ordering ───────────────────────────────────────────────


def test_full_turn_flow_produces_three_rows(db):
    """Smoke: realistic single-turn flow (user → tool → reply) writes
    three rows, one per envelope, in emit order."""
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_full_1", "text": "search openclaw",
    })
    state.record_envelope(db, {
        "type": "tool_call", "chat_id": CHAT_ID,
        "call_id": "c1", "tool_name": "web_search",
        "args": {"q": "openclaw"},
    })
    state.record_envelope(db, {
        "type": "tool_result", "chat_id": CHAT_ID,
        "call_id": "c1", "tool_name": "web_search",
        "result": "ok",
    })
    state.record_envelope(db, {
        "type": "reply_delta", "chat_id": CHAT_ID,
        "message_id": "msg_full_1", "text": "Here are the results",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_full_1",
    })
    rows = _rows(db)
    ids = [r["id"] for r in rows]
    assert ids == ["umsg_full_1", "tc:c1", "tr:c1", "msg_full_1"]
    assert rows[-1]["status"] == "final"
    assert rows[-1]["content"] == "Here are the results"
