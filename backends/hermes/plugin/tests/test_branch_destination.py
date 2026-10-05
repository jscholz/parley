"""``/branch`` in Parley opens a NEW chat (2026-10-05).

Hermes' ``/branch`` forks the session and rebinds the CURRENT chat to the
copy unless the adapter can open a sibling (thread platforms). Parley has
no threads, so until now a branch silently switched the chat on screen to
the clone — same transcript, original parked behind ``/resume`` — which
read as "nothing happened". ``open_branch_destination`` (called by the
galatea-local hermes hook) mints a fresh chat for the clone instead.
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_user_message_broadcast import _load_plugin, _make_adapter  # noqa: E402


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


class _Source:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def _adapter(plugin):
    adapter = _make_adapter(plugin)
    built: list[dict] = []

    def build_source(**kw):
        built.append(dict(kw))
        return _Source(**kw)

    adapter.build_source = build_source
    adapter.invalidate_session_rows_cache = lambda: built.append({"flushed": True})
    return adapter, built


def test_branch_destination_is_a_fresh_dm_chat_with_a_deep_link(plugin):
    adapter, built = _adapter(plugin)
    origin = _Source(chat_id="c548e9c0-5cac-40dd-8eeb-afe1952f4c9b", chat_type="dm")

    dest, ref = asyncio.run(adapter.open_branch_destination(origin, 'help on "post-training"'))

    kw = built[0]
    new_id = kw["chat_id"]
    assert new_id != origin.chat_id
    uuid.UUID(new_id)  # bare uuid — the shape mintChatId()/inbound chat ids use
    # Same shape as an inbound message's source → same session key the next message arrives on.
    assert kw["chat_type"] == "dm" and kw["user_id"] == new_id
    assert kw["chat_name"] == f"parley:{new_id[:8]}" and kw["user_name"] == "parley-user"
    assert dest.chat_id == new_id
    assert ref == f"[open the new chat](/?chat=parley:{new_id})"
    # The poller must not treat the new chat as unknown, and the drawer cache is flushed.
    assert new_id in adapter._known_chat_ids
    assert {"flushed": True} in built


def test_each_branch_gets_its_own_chat(plugin):
    adapter, _ = _adapter(plugin)
    origin = _Source(chat_id="abc", chat_type="dm")
    a, _ = asyncio.run(adapter.open_branch_destination(origin, "one"))
    b, _ = asyncio.run(adapter.open_branch_destination(origin, "two"))
    assert a.chat_id != b.chat_id
