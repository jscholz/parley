import asyncio
import json
from types import SimpleNamespace

from backends.hermes.plugin.parley_routes import handle_test

PUSH_KINDS = [
    "agent_reply",
    "cron",
]


class FakeRequest:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


class FakeDispatcher:
    def __init__(self):
        self.envelopes = []

    def dispatch_envelope(self, env):
        self.envelopes.append(env)
        return {"delivered": 1, "pruned": 0}


class FakeSender:
    def __init__(self):
        self.envelopes = []

    async def send_envelope(self, env):
        self.envelopes.append(env)
        return True


def _body(resp):
    return json.loads(resp.text)


def test_push_test_endpoint_synthesizes_notification_kind():
    dispatcher = FakeDispatcher()
    ctx = SimpleNamespace(dispatcher=dispatcher)

    resp = asyncio.run(handle_test(ctx, FakeRequest({
        "chat_id": "chat-1",
        "kind": "cron",
        "text": "Cron fired",
    })))

    assert resp.status == 200
    assert dispatcher.envelopes == [{
        "type": "notification",
        "chat_id": "chat-1",
        "content": "Cron fired",
        "text": "Cron fired",
        "should_push": True,
        "kind": "cron",
    }]
    assert _body(resp)["envelope"]["kind"] == "cron"


def test_push_test_endpoint_agent_reply_kind_uses_reply_final():
    dispatcher = FakeDispatcher()
    ctx = SimpleNamespace(dispatcher=dispatcher)

    resp = asyncio.run(handle_test(ctx, FakeRequest({
        "chat_id": "chat-2",
        "kind": "agent_reply",
        "body": "Agent finished",
    })))

    assert resp.status == 200
    assert dispatcher.envelopes[0]["type"] == "reply_final"
    assert "kind" not in dispatcher.envelopes[0]
    assert dispatcher.envelopes[0]["content"] == "Agent finished"
    assert dispatcher.envelopes[0]["message_id"].startswith("msg_test_")


def test_push_test_endpoint_uses_normal_envelope_fanout_when_available():
    dispatcher = FakeDispatcher()
    sender = FakeSender()
    ctx = SimpleNamespace(dispatcher=dispatcher, send_envelope=sender.send_envelope)

    resp = asyncio.run(handle_test(ctx, FakeRequest({
        "chat_id": "chat-3",
        "kind": "cron",
        "body": "Cron fired",
        "should_push": False,
    })))

    assert resp.status == 200
    assert dispatcher.envelopes == []
    assert sender.envelopes == [{
        "type": "notification",
        "chat_id": "chat-3",
        "content": "Cron fired",
        "text": "Cron fired",
        "should_push": False,
        "kind": "cron",
    }]
    assert _body(resp)["published"] is True


def test_push_test_endpoint_supports_every_settings_category():
    for kind in PUSH_KINDS:
        dispatcher = FakeDispatcher()
        ctx = SimpleNamespace(dispatcher=dispatcher)

        resp = asyncio.run(handle_test(ctx, FakeRequest({
            "chat_id": f"chat-{kind}",
            "kind": kind,
            "body": f"Body for {kind}",
        })))

        assert resp.status == 200
        env = dispatcher.envelopes[0]
        if kind == "agent_reply":
            assert env["type"] == "reply_final"
            assert "kind" not in env
            assert env["message_id"].startswith("msg_test_")
        else:
            assert env["type"] == "notification"
            assert env["kind"] == kind
        assert env["chat_id"] == f"chat-{kind}"
        assert env["content"] == f"Body for {kind}"
