"""`turn_active` on the items endpoint + phantom in-flight eviction.

His report 2026-09-15: reopening old sessions showed a permanent
"Thinking". The turn buffer was only emptied by a ``reply_final``, so a
turn that ended any other way left an entry the items endpoint replayed
as ``inflight`` forever. The endpoint now answers from the one source of
truth for "a turn is running" (``_turn_queues``) and evicts phantoms.
"""
from __future__ import annotations

import time

from .. import parley_route_items as route
from ..parley_turn_buffer import TurnBuffer


class _Adapter:
    def __init__(self, *, buffer=None, queues=None):
        self._turn_buffer = buffer
        self._turn_queues = queues if queues is not None else {}


def test_no_buffer_no_queue_is_idle():
    assert route.resolve_inflight(_Adapter(), "chat-a") == (False, [])


def test_live_turn_returns_inflight_and_active():
    buf = TurnBuffer()
    buf.open_turn(chat_id="chat-a", user_message="hello", user_message_id="umsg_1")
    a = _Adapter(buffer=buf, queues={"chat-a": object()})
    active, envs = route.resolve_inflight(a, "chat-a")
    assert active is True
    assert [e["type"] for e in envs][:1] == ["user_message"]
    # Still buffered — a live turn keeps its mirror.
    assert buf.active_for_chat("chat-a") is not None


def test_phantom_entry_is_evicted_and_reported_idle():
    buf = TurnBuffer()
    buf.open_turn(chat_id="chat-a", user_message="hello", user_message_id="umsg_1",
                  started_at=time.time() - 7200)
    a = _Adapter(buffer=buf, queues={})          # handler long gone
    active, envs = route.resolve_inflight(a, "chat-a")
    assert (active, envs) == (False, [])
    assert buf.active_for_chat("chat-a") is None  # evicted on sight
    # Idempotent: a second read stays idle and quiet.
    assert route.resolve_inflight(a, "chat-a") == (False, [])


def test_other_chats_turn_does_not_count():
    buf = TurnBuffer()
    buf.open_turn(chat_id="chat-a", user_message="hello", user_message_id="umsg_1")
    a = _Adapter(buffer=buf, queues={"chat-b": object()})
    assert route.turn_is_active(a, "chat-a") is False
    assert route.turn_is_active(a, "chat-b") is True
    active, envs = route.resolve_inflight(a, "chat-a")
    assert active is False and envs == []


def test_queue_without_buffer_is_still_active():
    """The queue is registered before the buffer opens; that instant is
    a live turn with nothing to replay yet."""
    a = _Adapter(buffer=TurnBuffer(), queues={"chat-a": object()})
    assert route.resolve_inflight(a, "chat-a") == (True, [])
