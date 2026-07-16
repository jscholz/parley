"""Unit tests for the cross-device user-message broadcast.

When a user dispatches a message via ``POST /v1/responses``, the plugin
emits a ``user_message`` envelope BEFORE the agent dispatch so other
connected PWA tabs render the user bubble immediately. Without this,
only the agent's reply propagated to other devices and the user's own
message was invisible until manual refresh.

Covers ``SidekickAdapter._handle_responses``:

  * Envelope is emitted with the documented shape
    (type, chat_id, message_id, text).
  * Envelope fires BEFORE ``_dispatch_message`` is invoked.
  * PWA-supplied ``user_message_id`` from the request body is
    propagated into the envelope (originating-device dedup hinges on
    this).
  * Server mints a fallback id when the field is absent (back-compat
    for raw OAI third-parties / legacy clients).

The plugin's hermes imports are stubbed exactly the same way as
``test_pdf_rasterize.py`` so the tests run without a hermes-agent
install on PYTHONPATH.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sqlite3
import sys
import time
import types
from pathlib import Path
from unittest import mock

import pytest


# ── plugin loader (mirror of test_pdf_rasterize.py setup) ────────────

def _install_hermes_stubs() -> None:
    if "gateway" not in sys.modules:
        sys.modules["gateway"] = types.ModuleType("gateway")
    if "gateway.config" not in sys.modules:
        cfg = types.ModuleType("gateway.config")

        class _Platform:
            SIDEKICK = "sidekick"

        class _PlatformConfig:
            pass

        cfg.Platform = _Platform
        cfg.PlatformConfig = _PlatformConfig
        sys.modules["gateway.config"] = cfg
    if "gateway.platforms" not in sys.modules:
        sys.modules["gateway.platforms"] = types.ModuleType("gateway.platforms")
    if "gateway.platforms.base" not in sys.modules:
        base = types.ModuleType("gateway.platforms.base")

        class _BasePlatformAdapter:
            pass

        class _MessageEvent:
            pass

        class _MessageType:
            TEXT = "text"

        class _SendResult:
            def __init__(self, success=False, message_id=None, error=None):
                self.success = success
                self.message_id = message_id
                self.error = error

        base.BasePlatformAdapter = _BasePlatformAdapter
        base.MessageEvent = _MessageEvent
        base.MessageType = _MessageType
        base.SendResult = _SendResult
        sys.modules["gateway.platforms.base"] = base


def _load_plugin():
    """Import under the real package name so relative imports resolve;
    see test_user_id_queries._load_plugin for context. Eager-loads
    route submodules so tests can reference them as
    ``plugin.sidekick_route_*``."""
    _install_hermes_stubs()
    plugin_pkg = Path(__file__).resolve().parents[1]
    parent_dir = str(plugin_pkg.parent)
    if parent_dir not in sys.path:
        sys.path.insert(0, parent_dir)
    pkg = importlib.import_module(plugin_pkg.name)
    for sub in (
        "sidekick_ids", "sidekick_route_conversations",
        "sidekick_route_items", "sidekick_route_events",
        "sidekick_route_responses", "sidekick_route_settings",
    ):
        importlib.import_module(f"{plugin_pkg.name}.{sub}")
    return pkg


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


# ── adapter + request stubs ──────────────────────────────────────────


def _make_adapter(plugin):
    """Bypass __init__ so we don't need PlatformConfig / aiohttp wiring.
    We patch _safe_send_envelope and _check_http_auth + _dispatch_message
    on the instance to capture the call sequence."""
    adapter = plugin.SidekickAdapter.__new__(plugin.SidekickAdapter)
    # Minimum state _handle_responses touches before our patches kick in.
    adapter._turn_queues = {}
    adapter._response_message_ids = {}
    adapter._message_seq = 0
    adapter._known_chat_ids = set()
    return adapter


class _FakeRequest:
    """Minimal aiohttp.web.Request stand-in — _handle_responses only
    calls .json() and indirectly _check_http_auth (which we patch)."""

    def __init__(self, body: dict):
        self._body = body

    async def json(self):
        return self._body


async def _drive_handle_responses(plugin, body: dict):
    """Drive sidekick_route_responses.handle_responses with the auth +
    dispatch + streaming-write paths neutered. Returns the captured
    envelopes (in order) and the list of dispatch calls.

    Post-2026-05-17 the responses handler lives as a free function on
    sidekick_route_responses, not as an adapter method. We patch the
    module-level _handle_streaming / _handle_blocking to short-circuit
    the SSE machinery while still observing the pre-dispatch envelope
    + dispatch call sequence."""
    route_resp = plugin.sidekick_route_responses
    adapter = _make_adapter(plugin)
    # _capture_msg_high_water_mark + _coerce_input are exercised before
    # dispatch — stub them out so the test doesn't need state.db.
    adapter._capture_msg_high_water_mark = lambda chat_id: 0
    sent: list[dict] = []
    dispatched: list[dict] = []

    async def fake_send_envelope(env):
        # Capture a snapshot — caller may mutate after.
        sent.append(dict(env))
        return True

    async def fake_dispatch_message(*, chat_id, text, attachments=None):
        dispatched.append({
            "chat_id": chat_id, "text": text, "attachments": attachments,
        })

    adapter._safe_send_envelope = fake_send_envelope
    adapter._dispatch_message = fake_dispatch_message
    adapter._check_http_auth = lambda req: True
    # TurnBuffer is optional; stub absent.
    adapter._turn_buffer = None

    # Force the streaming + blocking paths to terminate immediately by
    # monkeypatching the module-level helpers. We want to assert what
    # happened BEFORE the dispatch — emit-user-message + register-queue
    # — not exercise the full SSE stream.
    async def fake_streaming(*args, **kwargs):
        return mock.MagicMock(name="StreamResponse")

    async def fake_blocking(*args, **kwargs):
        return mock.MagicMock(name="Response")

    saved_streaming = route_resp._handle_streaming
    saved_blocking = route_resp._handle_blocking
    route_resp._handle_streaming = fake_streaming
    route_resp._handle_blocking = fake_blocking
    try:
        req = _FakeRequest(body)
        await route_resp.handle_responses(adapter, req)
    finally:
        route_resp._handle_streaming = saved_streaming
        route_resp._handle_blocking = saved_blocking
    return sent, dispatched


# ── tests ────────────────────────────────────────────────────────────


def test_user_message_envelope_emitted_with_documented_shape(plugin):
    """The envelope carries type, chat_id, message_id, and text."""
    sent, _ = asyncio.run(_drive_handle_responses(plugin, {
        "conversation": "abc-123",
        "input": "hello world",
        "stream": True,
        "user_message_id": "umsg_pwa_supplied_xyz",
    }))
    user_envs = [e for e in sent if e.get("type") == "user_message"]
    assert len(user_envs) == 1, f"expected exactly one user_message envelope, got {sent}"
    env = user_envs[0]
    assert env["type"] == "user_message"
    assert env["chat_id"] == "abc-123"
    assert env["message_id"] == "umsg_pwa_supplied_xyz"
    assert env["text"] == "hello world"


def test_user_message_envelope_fires_before_dispatch(plugin):
    """Order matters: emission must happen BEFORE _dispatch_message
    so other PWA tabs paint the bubble before any reply_delta lands.

    Post-2026-05-17 the responses handler lives as
    sidekick_route_responses.handle_responses(adapter, request); the
    streaming helper as _handle_streaming. We patch the module-level
    helpers here to short-circuit the SSE path while observing the
    pre-dispatch envelope + dispatch call ordering."""
    route_resp = plugin.sidekick_route_responses
    adapter = _make_adapter(plugin)
    adapter._capture_msg_high_water_mark = lambda chat_id: 0
    adapter._turn_buffer = None
    order: list[str] = []

    async def tracking_send(env):
        if env.get("type") == "user_message":
            order.append("user_message")
        return True

    async def tracking_dispatch(*, chat_id, text, attachments=None):
        order.append("dispatch")

    adapter._safe_send_envelope = tracking_send
    adapter._dispatch_message = tracking_dispatch
    adapter._check_http_auth = lambda req: True

    async def fake_streaming(*args, **kwargs):
        # Simulate the dispatch the streaming path would normally
        # schedule — handle_streaming kicks off _dispatch_message via
        # asyncio.create_task internally. Args are positional in the
        # free function: (adapter, request, chat_id, text, queue, ...)
        await tracking_dispatch(chat_id=kwargs.get("chat_id", args[2]),
                                text=kwargs.get("text", args[3]))
        return mock.MagicMock()

    saved_streaming = route_resp._handle_streaming
    saved_blocking = route_resp._handle_blocking
    route_resp._handle_streaming = fake_streaming
    route_resp._handle_blocking = mock.AsyncMock()
    try:
        req = _FakeRequest({
            "conversation": "ord-1", "input": "hi", "stream": True,
        })
        asyncio.run(route_resp.handle_responses(adapter, req))
    finally:
        route_resp._handle_streaming = saved_streaming
        route_resp._handle_blocking = saved_blocking

    # Envelope MUST come first.
    assert order[:2] == ["user_message", "dispatch"], (
        f"expected user_message before dispatch, got {order}"
    )


def test_user_message_id_minted_when_absent(plugin):
    """Back-compat: clients that don't pre-mint a user_message_id still
    get a server-allocated one. They just won't dedup against the
    broadcast (single-device by definition)."""
    sent, _ = asyncio.run(_drive_handle_responses(plugin, {
        "conversation": "noid-chat",
        "input": "hey",
        "stream": True,
    }))
    user_envs = [e for e in sent if e.get("type") == "user_message"]
    assert len(user_envs) == 1
    mid = user_envs[0]["message_id"]
    assert isinstance(mid, str) and mid, "expected non-empty server-minted message_id"
    assert mid.startswith("umsg_"), f"expected umsg_ prefix, got {mid!r}"


def test_user_message_envelope_uses_voice_prefixed_text(plugin):
    """`voice: true` causes the plugin to prepend `[voice] ` to text
    before dispatch. The user_message envelope should reflect what we
    actually fed the agent so other-device bubbles match what got sent."""
    sent, _ = asyncio.run(_drive_handle_responses(plugin, {
        "conversation": "voice-1",
        "input": "remind me later",
        "voice": True,
        "stream": True,
    }))
    user_envs = [e for e in sent if e.get("type") == "user_message"]
    assert len(user_envs) == 1
    assert user_envs[0]["text"].startswith("[voice]"), (
        f"expected [voice] prefix in broadcast text, got {user_envs[0]['text']!r}"
    )


def test_response_route_reuses_same_assistant_message_id_for_sidekick_envelopes(plugin):
    """The OpenAI Responses item id and Sidekick envelope id must match.

    Regression for the 2026-05-20 duplicate-bubble class: the route
    minted ``msg_*`` for SSE frames, but ``SidekickAdapter.send()``
    independently minted ``sk-<unix>-<seq>`` for the Sidekick envelope
    and sidekick.db write-through row. History replay then surfaced
    durable rows with the ``sk-*`` sidekick_id while the live/inflight
    bubble was keyed by ``msg_*``.
    """
    route_resp = plugin.sidekick_route_responses
    adapter = _make_adapter(plugin)
    adapter._check_http_auth = lambda req: True
    adapter._coerce_input = lambda input_field: input_field if isinstance(input_field, str) else None
    adapter._turn_buffer = None
    sent: list[dict] = []

    async def capture_envelope(env):
        sent.append(dict(env))
        return True

    adapter._safe_send_envelope = capture_envelope

    async def fake_streaming(adapter_arg, request, chat_id, text, queue,
                             response_id, message_id, created_at, **kwargs):
        assert adapter_arg._next_message_id(chat_id) == message_id
        result = await adapter_arg.send(chat_id, "assistant text")
        assert result.message_id == message_id
        return mock.MagicMock(name="StreamResponse")

    saved_streaming = route_resp._handle_streaming
    saved_blocking = route_resp._handle_blocking
    route_resp._handle_streaming = fake_streaming
    route_resp._handle_blocking = mock.AsyncMock()
    try:
        req = _FakeRequest({
            "conversation": "assistant-id-chat",
            "input": "hello",
            "stream": True,
        })
        asyncio.run(route_resp.handle_responses(adapter, req))
    finally:
        route_resp._handle_streaming = saved_streaming
        route_resp._handle_blocking = saved_blocking

    assistant_ids = [
        e["message_id"] for e in sent
        if e.get("type") in ("reply_delta", "reply_final")
    ]
    assert len(assistant_ids) == 2
    assert assistant_ids[0] == assistant_ids[1]
    assert assistant_ids[0].startswith("msg_")
    assert not assistant_ids[0].startswith("sk-")
    assert adapter._response_message_ids == {}

def test_send_classifies_background_cron_delivery_as_notification(plugin):
    adapter = _make_adapter(plugin)
    adapter._turn_buffer = None
    sent: list[dict] = []

    async def capture_envelope(env):
        if env.get("type") == "notification":
            env["sidekick_id"] = "notif_test_cron"
        sent.append(dict(env))
        return True

    adapter._safe_send_envelope = capture_envelope
    content = (
        "Cronjob Response: morning brief\n"
        "(job_id: job-123)\n"
        "-------------\n\n"
        "Cron body"
    )

    result = asyncio.run(adapter.send("cron-chat", content))

    assert result.message_id == "notif_test_cron"
    assert sent == [{
        "type": "notification",
        "chat_id": "cron-chat",
        "kind": "cron",
        "content": content,
        "text": content,
        "sidekick_id": "notif_test_cron",
    }]


def test_send_preserves_active_turn_contract_for_cron_shaped_text(plugin):
    adapter = _make_adapter(plugin)
    adapter._turn_buffer = None
    adapter._turn_queues["active-chat"] = object()
    sent: list[dict] = []

    async def capture_envelope(env):
        sent.append(dict(env))
        return True

    adapter._safe_send_envelope = capture_envelope
    content = (
        "Cronjob Response: sample\n"
        "(job_id: job-456)\n"
        "-------------\n\n"
        "Example text"
    )

    result = asyncio.run(adapter.send("active-chat", content))

    assert result.message_id.startswith("msg_")
    assert [e["type"] for e in sent] == ["reply_delta", "reply_final"]
    assert sent[0]["text"] == content



def test_send_classifies_approval_prompt_as_urgent_notification(plugin):
    adapter = _make_adapter(plugin)
    adapter._turn_buffer = None
    adapter._turn_queues["approval-chat"] = object()
    sent: list[dict] = []

    async def capture_envelope(env):
        if env.get("type") == "notification":
            env["sidekick_id"] = "notif_test_approval"
        sent.append(dict(env))
        return True

    adapter._safe_send_envelope = capture_envelope
    content = (
        "⚠️ Dangerous command requires approval:\n\n"
        "printf safe-approval-smoke\n\n"
        "Reason: command approval test\n"
        "Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel."
    )

    result = asyncio.run(adapter.send("approval-chat", content))

    assert result.message_id == "notif_test_approval"
    assert len(sent) == 1
    env = sent[0]
    # expires_at (unified elicitation, 2026-07-13): epoch ms mirroring
    # the gateway's approval window so the PWA pop-up dies WITH the
    # approval. Timing-dependent — assert shape + plausible window,
    # then compare the rest exactly.
    expires_at = env.pop("expires_at", None)
    assert isinstance(expires_at, int)
    now_ms = int(time.time() * 1000)
    # Default window is 60s (config approvals.timeout); allow config
    # overrides up to 1h and a generous lower bound for slow runs.
    assert now_ms + 5_000 < expires_at <= now_ms + 3_600_000
    assert env == {
        "type": "notification",
        "chat_id": "approval-chat",
        "kind": "approval",
        "content": content,
        "text": content,
        "urgent": True,
        "sidekick_id": "notif_test_approval",
    }


def _make_current_schema_state_db(path: Path, *, chat_id: str) -> Path:
    """Create the post-cleanup state.db subset without sidekick_msg_links."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            user_id TEXT,
            started_at REAL NOT NULL,
            parent_session_id TEXT,
            system_prompt TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            timestamp REAL NOT NULL,
            tool_name TEXT,
            tool_call_id TEXT,
            tool_calls TEXT
        );
        """
    )
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, started_at) VALUES (?, ?, ?, ?)",
        ("session-current-schema", "sidekick", chat_id, time.time()),
    )
    conn.commit()
    conn.close()
    return path


def test_approval_persists_and_surfaces_without_retired_state_side_table(
    plugin, tmp_path,
):
    """Approval persistence must match the post-May-19 production schema."""
    import importlib

    state = importlib.import_module(f"{plugin.__name__}.sidekick_state")
    db_mod = importlib.import_module(f"{plugin.__name__}.sidekick_db")

    chat_id = "approval-current-schema"
    adapter = _make_envelope_routing_adapter(plugin)
    adapter._state_db_path = _make_current_schema_state_db(
        tmp_path / "state.db", chat_id=chat_id,
    )
    adapter._sidekick_db = db_mod.SidekickDB(tmp_path / "sidekick.db")
    subscriber = asyncio.Queue()
    adapter._event_subscribers.add(subscriber)

    content = (
        "⚠️ Dangerous command requires approval:\n\n"
        "printf safe-approval-smoke\n\n"
        "Reason: command approval test\n"
        "Reply /approve to execute or /deny to cancel."
    )
    result = asyncio.run(adapter.send(chat_id, content))

    assert result.success is True
    assert result.message_id.startswith("notif_")

    with sqlite3.connect(adapter._state_db_path) as conn:
        state_rows = conn.execute(
            "SELECT id, role, content FROM messages ORDER BY id"
        ).fetchall()
    assert len(state_rows) == 1
    state_row_id, role, body = state_rows[0]
    assert role == "assistant"
    assert body == content

    sidekick_row = adapter._sidekick_db.fetchone(
        "SELECT id, kind, status, agent_row_id FROM msg_links WHERE id = ?",
        (result.message_id,),
    )
    assert sidekick_row is not None
    assert sidekick_row["kind"] == "approval"
    assert sidekick_row["status"] == "final"
    assert sidekick_row["agent_row_id"] == str(state_row_id)

    replayed = [env for _event_id, env in adapter._event_replay_ring]
    approval_events = [env for env in replayed if env.get("kind") == "approval"]
    assert len(approval_events) == 1
    assert approval_events[0]["sidekick_id"] == result.message_id
    _event_id, delivered = subscriber.get_nowait()
    assert delivered["sidekick_id"] == result.message_id

    history = state.list_messages_for_chat_with_state_db_source(
        adapter._sidekick_db, adapter._state_db_path, chat_id, "sidekick",
    )
    assert len(history["items"]) == 1
    assert history["items"][0]["sidekick_id"] == result.message_id
    assert history["items"][0]["kind"] == "approval"

    adapter._sidekick_db.close()


def test_failure_event_reaches_out_of_turn_replay_ring(plugin):
    """A run failure must surface as an event rather than vanish."""
    adapter = _make_envelope_routing_adapter(plugin)
    env = {
        "type": "error",
        "chat_id": "failure-chat",
        "message": "agent run interrupted",
    }

    # No live subscriber is present, hence False; replay retention is still
    # mandatory so a reconnecting PWA receives the failure.
    assert asyncio.run(adapter._safe_send_envelope(env)) is False
    replayed = [item for _event_id, item in adapter._event_replay_ring]
    assert replayed == [{
        **env,
        "should_push": False,
        "chat_id": "sidekick:failure-chat",
    }]


def _make_envelope_routing_adapter(plugin):
    adapter = _make_adapter(plugin)
    adapter._turn_buffer = None
    adapter._sidekick_db = None
    adapter._push_dispatcher = None
    adapter._event_subscribers = set()
    adapter._event_replay_ring = []
    adapter._event_id_counter = 0
    return adapter


class _FakePushDispatcher:
    def __init__(self, *, delivered=1, body="delivered body"):
        self.delivered = delivered
        self.body = body
        self.dispatched = []

    def observe_envelope(self, env):
        if env.get("type") == "reply_final":
            return self.body
        return None

    def dispatch_envelope(self, env, *, body_override=None):
        self.dispatched.append({"env": dict(env), "body_override": body_override})
        if self.delivered <= 0:
            return {"delivered": 0, "pruned": 0, "skipped": "user_engaged"}
        return {"delivered": self.delivered, "pruned": 0}


def _make_push_activity_adapter(plugin, tmp_path, monkeypatch, *, delivered=1):
    import importlib
    state = importlib.import_module(f"{plugin.__name__}.sidekick_state")
    db_mod = importlib.import_module(f"{plugin.__name__}.sidekick_db")
    SidekickDB = db_mod.SidekickDB

    adapter = _make_envelope_routing_adapter(plugin)
    adapter._sidekick_db = SidekickDB(tmp_path / "sidekick.db")
    adapter._push_dispatcher = _FakePushDispatcher(delivered=delivered)
    adapter._state_db_path = None
    monkeypatch.setenv("SIDEKICK_PUSH_OWNED_BY_PLUGIN", "true")
    return adapter, state


def test_delivered_agent_reply_push_creates_activity_item(plugin, tmp_path, monkeypatch):
    adapter, state = _make_push_activity_adapter(plugin, tmp_path, monkeypatch)

    asyncio.run(adapter._safe_send_envelope({
        "type": "reply_final",
        "chat_id": "chat-activity",
        "message_id": "msg_activity_1",
    }))

    items = state.list_activity_items(adapter._sidekick_db)
    assert len(items) == 1
    item = items[0]
    assert item["id"] == "msg_activity_1"
    assert item["messageId"] == "msg_activity_1"
    assert item["chatId"] == "sidekick:chat-activity"
    assert item["kind"] == "agent_reply"
    assert item["body"] == "delivered body"
    assert item["read"] is False


def test_suppressed_agent_reply_push_does_not_create_activity_item(plugin, tmp_path, monkeypatch):
    adapter, state = _make_push_activity_adapter(
        plugin, tmp_path, monkeypatch, delivered=0
    )

    asyncio.run(adapter._safe_send_envelope({
        "type": "reply_final",
        "chat_id": "chat-engaged",
        "message_id": "msg_engaged_1",
    }))

    assert state.list_activity_items(adapter._sidekick_db) == []


def test_delivered_cron_notification_push_creates_activity_item(plugin, tmp_path, monkeypatch):
    adapter, state = _make_push_activity_adapter(plugin, tmp_path, monkeypatch)

    asyncio.run(adapter._safe_send_envelope({
        "type": "notification",
        "chat_id": "cron-chat",
        "kind": "cron",
        "sidekick_id": "notif_cron_1",
        "content": "Cron output body",
    }))

    items = state.list_activity_items(adapter._sidekick_db)
    assert len(items) == 1
    item = items[0]
    assert item["id"] == "notif_cron_1"
    assert item["messageId"] == "notif_cron_1"
    assert item["chatId"] == "sidekick:cron-chat"
    assert item["kind"] == "cron"
    assert item["title"] == "Cron notification"
    assert item["body"] == "Cron output body"
    assert item["read"] is False


@pytest.mark.parametrize("env_type", ["tool_call", "tool_result"])
def test_active_turn_tool_events_also_publish_to_persistent_event_stream(plugin, env_type):
    """Live tool progress must reach the transcript-centric /v1/events stream.

    The active /v1/responses turn queue is still fed for compatibility, but
    tool rows are observational UI state that every open PWA should see while
    the tool is running. Otherwise the transcript only catches up from history
    after reply_final.
    """
    adapter = _make_envelope_routing_adapter(plugin)
    turn_q = asyncio.Queue()
    event_q = asyncio.Queue()
    adapter._turn_queues["live-chat"] = turn_q
    adapter._event_subscribers.add(event_q)

    env = {
        "type": env_type,
        "chat_id": "live-chat",
        "call_id": "call_live",
        "tool_name": "terminal",
    }
    if env_type == "tool_call":
        env["args"] = {"cmd": "sleep 5; printf ok"}
    else:
        env["result"] = "ok"

    assert asyncio.run(adapter._safe_send_envelope(env)) is True

    assert turn_q.get_nowait()["type"] == env_type
    eid, published = event_q.get_nowait()
    assert eid == 1
    assert published["type"] == env_type
    assert published["chat_id"] == "sidekick:live-chat"
    assert adapter._event_replay_ring == [(1, published)]


def test_active_turn_reply_delta_stays_on_response_queue_only(plugin):
    """Do not duplicate high-volume token deltas onto /v1/events."""
    adapter = _make_envelope_routing_adapter(plugin)
    turn_q = asyncio.Queue()
    event_q = asyncio.Queue()
    adapter._turn_queues["live-chat"] = turn_q
    adapter._event_subscribers.add(event_q)

    assert asyncio.run(adapter._safe_send_envelope({
        "type": "reply_delta",
        "chat_id": "live-chat",
        "text": "partial",
        "message_id": "msg_live",
    })) is True

    assert turn_q.get_nowait()["type"] == "reply_delta"
    assert event_q.empty()
    assert adapter._event_replay_ring == []
