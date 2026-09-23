"""Turn lifecycle from hermes' processing hooks (field 2026-09-23).

His report: "I come back to chats that are finished and I see it
thinking … it can run for many minutes afterwards." Slack stayed crisp
because its adapter rides ``on_processing_start``/``on_processing_complete``
(👀 on, 👀 off); the Parley plugin implemented neither, so the PWA
guessed from typing pulses and a straggler typing after the final
resurrected "Thinking". The hooks now emit ``turn_start``/``turn_end``
on the event channel, drive ``turn_active`` and the per-message marks.
"""
from __future__ import annotations

import asyncio
import os
import sys
import types
from enum import Enum

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_user_message_broadcast import _load_plugin, _make_adapter  # noqa: E402

from .. import parley_route_items as route_items
from ..parley_turn_lifecycle import TurnLifecycle, outcome_name


class _Outcome(Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"


def _event(chat_id="c1", message_id="evt-1", umid=None):
    return types.SimpleNamespace(
        source=types.SimpleNamespace(chat_id=chat_id),
        message_id=message_id,
        metadata={"parley_user_message_id": umid} if umid else {},
    )


# ── pure bookkeeping ────────────────────────────────────────────────


def test_outcome_name_accepts_enum_value_and_junk():
    assert outcome_name(_Outcome.CANCELLED) == "cancelled"
    assert outcome_name("FAILURE") == "failure"
    assert outcome_name(None) == "success"


def test_start_complete_round_trip():
    lc = TurnLifecycle()
    start = lc.start("c1", "t1", "umsg_1")
    assert start == {"type": "turn_start", "chat_id": "c1", "turn_id": "t1",
                     "user_message_id": "umsg_1"}
    assert lc.is_active("c1") and lc.acks("c1") == {"umsg_1": "processing"}
    end = lc.complete("c1", "t1", _Outcome.SUCCESS)
    assert end["outcome"] == "success" and end["active_turns"] == 0
    assert end["replied"] is False
    assert not lc.is_active("c1") and lc.acks("c1") == {"umsg_1": "success"}


def test_nested_followup_keeps_chat_active_until_parent_ends():
    """hermes drains a follow-up in-band: start A, start B, end B, end A."""
    lc = TurnLifecycle()
    lc.start("c1", "A", "umsg_a")
    lc.start("c1", "B", "umsg_b")
    end_b = lc.complete("c1", "B", _Outcome.SUCCESS)
    assert end_b["active_turns"] == 1 and lc.is_active("c1")
    assert lc.acks("c1") == {"umsg_a": "processing", "umsg_b": "success"}
    end_a = lc.complete("c1", "A", _Outcome.SUCCESS)
    assert end_a["active_turns"] == 0 and not lc.is_active("c1")


def test_note_reply_marks_running_turns_replied():
    lc = TurnLifecycle()
    lc.start("c1", "t1", "umsg_1")
    lc.note_reply("c1")
    assert lc.complete("c1", "t1", _Outcome.FAILURE)["replied"] is True


def test_complete_without_start_still_settles():
    lc = TurnLifecycle()
    end = lc.complete("c1", "ghost", _Outcome.FAILURE)
    assert end["type"] == "turn_end" and end["active_turns"] == 0
    assert lc.acks("c1") == {}


def test_recent_outcomes_are_bounded():
    lc = TurnLifecycle()
    for i in range(80):
        lc.start("c1", f"t{i}", f"umsg_{i}")
        lc.complete("c1", f"t{i}", _Outcome.SUCCESS)
    acks = lc.acks("c1")
    assert len(acks) == 50 and "umsg_79" in acks and "umsg_0" not in acks


def test_umid_survives_event_rebuild_via_message_id():
    """/queue and /steer rebuild MessageEvent keeping message_id only."""
    lc = TurnLifecycle()
    lc.remember_event("evt-9", "umsg_9")
    rebuilt = types.SimpleNamespace(message_id="evt-9", metadata={})
    assert lc.user_message_id_for(rebuilt) == "umsg_9"


# ── adapter hooks ───────────────────────────────────────────────────


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


def _adapter(plugin, monkeypatch):
    adapter = _make_adapter(plugin)
    published: list[dict] = []
    events_mod = sys.modules[type(adapter).__module__ + ".parley_route_events"]
    monkeypatch.setattr(events_mod, "publish_out_of_turn",
                        lambda _a, env: published.append(dict(env)) or True)
    return adapter, published


def test_hooks_publish_start_and_end_with_bubble_id(plugin, monkeypatch):
    adapter, published = _adapter(plugin, monkeypatch)
    ev = _event(umid="umsg_1")
    asyncio.run(adapter.on_processing_start(ev))
    assert route_items.turn_is_active(adapter, "c1") is True
    asyncio.run(adapter.on_processing_complete(ev, _Outcome.CANCELLED))
    assert [e["type"] for e in published] == ["turn_start", "turn_end"]
    assert published[0]["user_message_id"] == "umsg_1"
    assert published[1]["outcome"] == "cancelled"
    assert all(e["should_push"] is False for e in published)
    assert route_items.turn_is_active(adapter, "c1") is False
    assert route_items.turn_acks(adapter, "c1") == {"umsg_1": "cancelled"}


def test_end_is_routed_to_the_waiting_handler_by_bubble_id(plugin, monkeypatch):
    """A turn that ends with no reply_final must not hold the POST (and
    turn_active) for the full timeout."""
    adapter, _ = _adapter(plugin, monkeypatch)
    queue: asyncio.Queue = asyncio.Queue()
    adapter._turn_queues["c1"] = queue
    ev = _event(umid="umsg_1")
    asyncio.run(adapter.on_processing_start(ev))
    asyncio.run(adapter.on_processing_complete(ev, _Outcome.FAILURE))
    env = queue.get_nowait()
    assert env["type"] == "turn_end" and env["user_message_id"] == "umsg_1"


def test_internal_event_end_is_not_routed_to_a_handler(plugin, monkeypatch):
    """An event with no Parley bubble (delegation-complete, background
    notice) has no handler of its own to release."""
    adapter, _ = _adapter(plugin, monkeypatch)
    queue: asyncio.Queue = asyncio.Queue()
    adapter._turn_queues["c1"] = queue
    ev = _event()
    asyncio.run(adapter.on_processing_start(ev))
    asyncio.run(adapter.on_processing_complete(ev, _Outcome.SUCCESS))
    assert queue.empty()


def _drive_blocking(plugin, adapter, queue, umid, feed, timeout=2.0):
    route = sys.modules[type(adapter).__module__ + ".parley_route_responses"]

    async def dispatch(**_kw):
        return None
    adapter._dispatch_message = dispatch
    adapter._turn_buffer = None
    for env in feed:
        queue.put_nowait(env)

    async def go():
        return await asyncio.wait_for(route._handle_blocking(
            adapter, "c1", "hi", queue, "resp_1", "msg_1", 0, user_message_id=umid), timeout=timeout)
    return asyncio.run(go())


def test_blocking_handler_ignores_another_messages_end(plugin, monkeypatch):
    """B was POSTed while A ran and replaced the chat's queue: A's end
    must not release B's handler."""
    adapter, _ = _adapter(plugin, monkeypatch)
    queue: asyncio.Queue = asyncio.Queue()
    adapter._turn_queues["c1"] = queue
    feed = [{"type": "turn_end", "chat_id": "c1", "user_message_id": "umsg_a", "outcome": "success"}]
    with pytest.raises(asyncio.TimeoutError):
        _drive_blocking(plugin, adapter, queue, "umsg_b", feed, timeout=0.2)


def test_blocking_handler_exits_on_its_own_end(plugin, monkeypatch):
    adapter, _ = _adapter(plugin, monkeypatch)
    queue: asyncio.Queue = asyncio.Queue()
    adapter._turn_queues["c1"] = queue
    feed = [
        {"type": "turn_end", "chat_id": "c1", "user_message_id": "umsg_a", "outcome": "success"},
        {"type": "turn_end", "chat_id": "c1", "user_message_id": "umsg_b", "outcome": "failure"},
    ]
    _drive_blocking(plugin, adapter, queue, "umsg_b", feed)
    assert queue.empty() and "c1" not in adapter._turn_queues


def test_handler_does_not_pop_a_newer_handlers_queue(plugin, monkeypatch):
    adapter, _ = _adapter(plugin, monkeypatch)
    mine: asyncio.Queue = asyncio.Queue()
    newer: asyncio.Queue = asyncio.Queue()
    adapter._turn_queues["c1"] = newer
    feed = [{"type": "reply_final", "chat_id": "c1", "message_id": "msg_1"}]
    _drive_blocking(plugin, adapter, mine, "umsg_a", feed)
    assert adapter._turn_queues["c1"] is newer


def test_real_reply_marks_turn_replied_interim_does_not(plugin, monkeypatch):
    adapter, published = _adapter(plugin, monkeypatch)
    adapter._turn_buffer = None

    async def capture(env):
        return True
    adapter._safe_send_envelope = capture
    ev = _event()
    asyncio.run(adapter.on_processing_start(ev))
    asyncio.run(adapter.send("c1", "⚠️ No activity for 5 min.",
                             metadata={"_interim_send": True}))
    assert adapter._lifecycle._active["c1"]["evt-1"]["replied"] is False
    asyncio.run(adapter.send("c1", "done!"))
    asyncio.run(adapter.on_processing_complete(ev, _Outcome.SUCCESS))
    assert published[-1]["replied"] is True
