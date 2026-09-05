"""Native (APNs) push lane — token store, dispatcher fan-out + prune, routes."""
from __future__ import annotations

import asyncio
import json

import pytest

from .. import parley_apns as apns
from .. import parley_dispatcher as sd
from .. import parley_state as state
from ..parley_db import ParleyDB
from ..parley_dispatcher import PushDispatcher

CFG = apns.ApnsConfig("-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n", "KEY1234567", "7BWJRMNR96", "com.jscholz.parley", "sandbox")
TOK_A, TOK_B = "a" * 64, "b" * 64


@pytest.fixture
def db(tmp_path):
    d = ParleyDB(tmp_path / "parley.db")
    yield d
    d.close()


@pytest.fixture
def dispatcher(db, monkeypatch):
    sent_web, sent_native = [], []
    monkeypatch.setattr(sd, "webpush", lambda *, subscription_info, data, **kw: sent_web.append(subscription_info["endpoint"]))
    d = PushDispatcher(db, vapid_subject="mailto:test@example.com")
    d._apns_cfg, d._apns_cfg_loaded = CFG, True

    def fake_send(cfg, token, payload):
        if token == TOK_B:
            raise apns.ApnsError(410, "Unregistered")
        sent_native.append((token, payload))
    d.apns_send = fake_send
    d._sent_web, d._sent_native = sent_web, sent_native  # type: ignore[attr-defined]
    return d


def test_token_store_roundtrip(db):
    assert state.upsert_native_token(db, token=TOK_A.upper(), user_agent="ios") == {"created": True}
    assert state.upsert_native_token(db, token=TOK_A, user_agent="ios2") == {"created": False}
    rows = state.list_native_tokens(db)
    assert [r["token"] for r in rows] == [TOK_A] and rows[0]["user_agent"] == "ios2"
    state.mark_native_token_used(db, TOK_A)
    assert state.list_native_tokens(db)[0]["last_used_at"] is not None
    assert state.remove_native_token(db, TOK_A) == {"removed": True}
    assert state.remove_native_token(db, TOK_A) == {"removed": False}


def test_dispatch_fans_out_to_native_and_prunes_dead_tokens(dispatcher, db):
    state.upsert_subscription(db, endpoint="https://web/1", p256dh="p", auth="a", user_agent="t")
    state.upsert_native_token(db, token=TOK_A, user_agent="iphone")
    state.upsert_native_token(db, token=TOK_B, user_agent="old-iphone")
    out = dispatcher.dispatch_envelope({"type": "reply_final", "chat_id": "abc-1"}, body_override="hello")
    assert out["web"] == 1 and out["native"] == 1 and out["pruned"] == 1 and out["delivered"] == 2
    assert dispatcher._sent_web == ["https://web/1"]
    tok, payload = dispatcher._sent_native[0]
    assert tok == TOK_A and payload["chat_id"] == "abc-1" and "title" in payload and payload["body"]
    assert [r["token"] for r in state.list_native_tokens(db)] == [TOK_A], "dead token pruned"


def test_native_only_subscribers_still_dispatch(dispatcher, db):
    state.upsert_native_token(db, token=TOK_A)
    out = dispatcher.dispatch_envelope({"type": "reply_final", "chat_id": "abc-2"}, body_override="hi")
    assert out["native"] == 1 and out["web"] == 0 and "skipped" not in out


def test_unconfigured_apns_skips_native_quietly(dispatcher, db):
    dispatcher._apns_cfg = None
    state.upsert_native_token(db, token=TOK_A)
    out = dispatcher.dispatch_envelope({"type": "reply_final", "chat_id": "abc-3"}, body_override="hi")
    assert out["native"] == 0 and out["delivered"] == 0 and "skipped" not in out
    assert [r["token"] for r in state.list_native_tokens(db)] == [TOK_A], "never pruned for our own misconfig"


def test_push_health_reports_native_counts(db):
    state.upsert_native_token(db, token=TOK_A)
    h = sd.build_push_health(db)
    assert h["native_tokens"] == 1 and h["apns_configured"] in (True, False)


class _Req:
    def __init__(self, body): self._b = body
    async def json(self): return self._b


def _run(c): return asyncio.new_event_loop().run_until_complete(c)


def test_native_routes(db, monkeypatch):
    from .. import parley_routes as routes
    monkeypatch.setattr(routes, "_read_json", lambda request: request.json())
    import types
    ctx = types.SimpleNamespace(db=db)
    r = _run(routes.handle_subscribe_native(ctx, _Req({"platform": "ios", "token": TOK_A, "userAgent": "Parley/iOS"})))
    assert r.status == 201 and json.loads(r.text)["total"] == 1
    r = _run(routes.handle_subscribe_native(ctx, _Req({"platform": "ios", "token": TOK_A})))
    assert r.status == 200 and json.loads(r.text)["created"] is False
    assert _run(routes.handle_subscribe_native(ctx, _Req({"platform": "ios", "token": "short"}))).status == 400
    assert _run(routes.handle_subscribe_native(ctx, _Req({"platform": "android", "token": TOK_A}))).status == 400
    r = _run(routes.handle_unsubscribe_native(ctx, _Req({"token": TOK_A})))
    assert r.status == 200 and json.loads(r.text)["removed"] is True and json.loads(r.text)["total"] == 0
    assert _run(routes.handle_unsubscribe_native(ctx, _Req({}))).status == 400
