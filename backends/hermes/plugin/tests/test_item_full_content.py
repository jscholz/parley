"""GET /v1/conversations/{id}/items/{item_id} — one row, full content
(2026-10-12). The proxy serves transcript pages with tool output cut to
a preview; opening a tool row fetches the full row here. Lookup by any
id the items read may have served: state row id (agent_row_id), the
parley id, or the envelope-time alias int(created_at*1000)."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from ..parley_db import ParleyDB
from .. import parley_route_items as route

CHAT = "item-full-content-test"          # bare chat id, as msg_links stores it
GW = "parley:" + CHAT                       # gateway id, as the path carries it
BIG = "x" * 50_000


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "parley.db")
    yield db
    db.close()


def _link(db, pid, role, content, created_at, agent_row_id=None, tool_name=None, tool_call_id=None):
    db.exec(
        "INSERT INTO msg_links (id, chat_id, role, content, created_at, updated_at, status, agent_row_id, tool_name, tool_call_id) "
        "VALUES (?, ?, ?, ?, ?, ?, 'final', ?, ?, ?)",
        (pid, CHAT, role, content, created_at, created_at, agent_row_id, tool_name, tool_call_id),
    )


def _req(chat, item):
    return SimpleNamespace(match_info={"id": chat, "item_id": item}, query={})


def _adapter(db):
    return SimpleNamespace(_parley_db=db, _check_http_auth=lambda r: True)


def _call(db, chat, item):
    """`chat` is the gateway id as the proxy sends it."""
    resp = asyncio.run(route.handle_get_item(_adapter(db), _req(chat, item)))
    return resp.status, (json.loads(resp.text) if resp.text else None)


def test_lookup_accepts_the_bare_chat_id_too(db):
    _link(db, "tr:bare", "tool", "bare", 1_790_000_000.0, agent_row_id=1)
    assert _call(db, CHAT, "1")[1]["content"] == "bare"


def test_full_content_by_state_row_id(db):
    _link(db, "tr:abc", "tool", BIG, 1_790_000_000.5, agent_row_id=4242, tool_name="terminal", tool_call_id="call_1")
    status, body = _call(db, GW, "4242")
    assert status == 200
    assert body["content"] == BIG and len(body["content"]) == 50_000
    assert body["role"] == "tool" and body["tool_name"] == "terminal" and body["tool_call_id"] == "call_1"
    assert body["parley_id"] == "tr:abc" and body["id"] == "4242"


def test_lookup_by_parley_id_and_by_envelope_alias(db):
    _link(db, "msg_unlinked", "assistant", "hello", 1_790_000_001.25)
    assert _call(db, GW, "msg_unlinked")[1]["content"] == "hello"
    assert _call(db, GW, str(int(1_790_000_001.25 * 1000)))[1]["content"] == "hello"


def test_other_chat_and_unknown_rows_are_404(db):
    _link(db, "tr:z", "tool", BIG, 1_790_000_002.0, agent_row_id=7)
    assert _call(db, "parley:someone-else", "7")[0] == 404
    assert _call(db, GW, "999999")[0] == 404
    assert _call(db, GW, "nope")[0] == 404


def test_auth_and_missing_store(db):
    adapter = SimpleNamespace(_parley_db=db, _check_http_auth=lambda r: False)
    assert asyncio.run(route.handle_get_item(adapter, _req(GW, "1"))).status == 401
    adapter = SimpleNamespace(_parley_db=None, _check_http_auth=lambda r: True)
    assert asyncio.run(route.handle_get_item(adapter, _req(GW, "1"))).status == 503
