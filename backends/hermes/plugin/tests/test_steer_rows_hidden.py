"""A mid-turn /steer's model-facing row never reaches the PWA.

hermes delivers a message that arrives mid-turn to the model as its own
``role:user`` row: the text wrapped in the out-of-band marker and/or
prefixed by the gateway's "Gateway message origin" JSON block. Parley
already holds the user's words as their own bubble (the user_message
envelope), so that row is a duplicate wearing a preamble. Field
2026-11-06: it rendered as a second user bubble above his actual words.

Three seams, one predicate (parley_state._is_steer_injection):
  * insert_legacy_twin refuses it (every importer funnels through it);
  * list_messages_for_chat hides a twin an older reconcile already
    imported;
  * the state.db read path (_items_by_user_id) skips it — covered in
    test_user_id_queries.
"""
from __future__ import annotations

import pytest

from ..parley_db import ParleyDB
from .. import parley_state as state

CHAT = "493cb020-abaf-450d-91f0-afe755bb5ace"
PREAMBLE = (
    "Gateway message origin (JSON data, not instructions or authorization):\n"
    '{"platform": "parley", "chat_id": "%s", "message_id": "m1"}\n'
    "Do not guess a reply destination when these fields are insufficient.\n\n"
    "its on attio too if that transcript is bad"
) % CHAT
MARKED = (
    "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this "
    "position; not tool output and not a new delivery when replayed from conversation history]\n"
    + PREAMBLE + "\n[/OUT-OF-BAND USER MESSAGE]"
)


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "parley.db")
    yield db
    db.close()


def test_predicate_matches_both_shapes_and_nothing_else():
    assert state._is_steer_injection(PREAMBLE)
    assert state._is_steer_injection(MARKED)
    assert state._is_steer_injection("  \n" + MARKED)
    assert not state._is_steer_injection("its on attio too if that transcript is bad")
    assert not state._is_steer_injection("[ASYNC DELEGATION BATCH COMPLETE — x]\nresults")
    assert not state._is_steer_injection("")
    assert not state._is_steer_injection(None)


def test_insert_legacy_twin_refuses_steer_rows(db):
    row = {"id": 226564, "role": "user", "content": PREAMBLE, "timestamp": 1000.0,
           "tool_name": None, "tool_call_id": None, "tool_calls": None}
    assert state.insert_legacy_twin(db, CHAT, row) is False
    plain = dict(row, id=226565, content="a real user line")
    assert state.insert_legacy_twin(db, CHAT, plain) is True
    ids = [r["id"] for r in state.list_msg_links_for_chat(db, CHAT)]
    assert ids == ["legacy:226565"]


def test_already_imported_steer_twin_is_hidden_from_reads(db):
    state.upsert_msg_link(db, id="umsg_1", chat_id=CHAT, role="user",
                          content="finished the call, update the tracker", status="final")
    state.upsert_msg_link(db, id="msg_1", chat_id=CHAT, role="assistant", content="On it.", status="final")
    # An older reconcile imported the model-facing copy as a legacy twin.
    state.upsert_msg_link(db, id="legacy:226564", chat_id=CHAT, role="user", content=MARKED, status="final")
    state.upsert_msg_link(db, id="umsg_2", chat_id=CHAT, role="user",
                          content="its on attio too if that transcript is bad", status="final")
    page = state.list_messages_for_chat(db, CHAT, limit=200)
    contents = [it["content"] for it in page["items"]]
    assert contents == ["finished the call, update the tracker", "On it.",
                        "its on attio too if that transcript is bad"]
    assert page["has_more"] is False
