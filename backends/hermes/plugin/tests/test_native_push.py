"""Native (APNs) push lane — token store, dispatcher fan-out + prune, routes."""
from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from .. import parley_apns as apns
from .. import parley_dispatcher as sd
from .. import parley_state as state
from ..parley_db import ParleyDB
from ..parley_dispatcher import PushDispatcher

CFG = apns.ApnsConfig("-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n", "KEY1234567", "7BWJRMNR96", "com.example.parley", "sandbox")
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


def test_dispatch_system_reaches_web_and_native_verbatim_and_ignores_chat_gates(dispatcher, db):
    """The capture stall warning (proxy capture.ts) is a safety alert: it
    must arrive even when the meeting's chat is muted and the phone looks
    engaged — a frozen page cannot un-engage itself. Incident 2026-10-21."""
    state.upsert_subscription(db, endpoint="https://web/1", p256dh="p", auth="a", user_agent="t")
    state.upsert_native_token(db, token=TOK_A, user_agent="iphone")
    state.upsert_native_token(db, token=TOK_B, user_agent="old-iphone")
    state.set_mute(db, "parley:meeting-1", True)
    dispatcher.engagement._last_seen["parley:meeting-1"] = int(time.time() * 1000)  # looks engaged right now
    out = dispatcher.dispatch_system({
        "title": '⚠️ "Board meeting" may not be recording',
        "body": "No audio has reached the server since it started 3m ago. Open Parley to check.",
        "chat_id": "parley:meeting-1",
        "tag": "capture-stall-cap_1",
    })
    assert out["web"] == 1 and out["native"] == 1 and out["pruned"] == 1 and "skipped" not in out
    assert dispatcher._sent_web == ["https://web/1"]
    tok, payload = dispatcher._sent_native[0]
    assert tok == TOK_A
    assert payload["title"] == '⚠️ "Board meeting" may not be recording', "title is delivered verbatim, no speaker/icon rewrite"
    assert payload["tag"] == "capture-stall-cap_1" and payload["chat_id"] == "parley:meeting-1"
    assert payload["url"].startswith("/?chat=parley%3Ameeting-1"), "tap deep-links to the meeting chat"
    assert [r["token"] for r in state.list_native_tokens(db)] == [TOK_A], "dead token pruned like any other send"


def test_dispatch_system_with_nobody_to_tell_says_so(dispatcher, db):
    out = dispatcher.dispatch_system({"title": "t", "body": "b"})
    assert out["skipped"] == "no_subscribers" and out["delivered"] == 0


# ── Native badge sync (2026-11-14: icon 96 vs app 6) ─────────────────


def test_badge_sync_sends_server_total_dedupes_and_clears_with_zero(dispatcher, db):
    state.upsert_native_token(db, token=TOK_A)
    totals = [6]
    dispatcher.unread_total_fn = lambda: totals[0]
    out = dispatcher.sync_native_badge(reason="seen")
    assert out["badge"] == 6 and out["delivered"] == 1 and out["skipped_same"] == 0
    tok, payload = dispatcher._sent_native[-1]
    assert tok == TOK_A and payload == {"badge": 6, "badge_only": True}
    assert apns.build_payload(payload) == {"aps": {"badge": 6}}, "no alert, no sound: a silent icon update"
    # Same total again → nothing sent (the device already shows it).
    out = dispatcher.sync_native_badge(reason="seen")
    assert out["delivered"] == 0 and out["skipped_same"] == 1 and len(dispatcher._sent_native) == 1
    # Everything read → ZERO goes out (alert pushes floor at 1; only this path clears the icon).
    totals[0] = 0
    out = dispatcher.sync_native_badge(reason="seen")
    assert out["badge"] == 0 and out["delivered"] == 1
    assert dispatcher._sent_native[-1][1] == {"badge": 0, "badge_only": True}
    health = sd.build_push_health(db, dispatcher)["badge_sync"]
    assert health["badge"] == 0 and health["delivered"] == 1 and health["reason"] == "seen" and health["at"] > 0


def test_alert_push_badge_counts_as_sent_so_sync_does_not_repeat_it(dispatcher, db):
    state.upsert_native_token(db, token=TOK_A)
    dispatcher.unread_total_fn = lambda: 3
    dispatcher.dispatch_envelope({"type": "reply_final", "chat_id": "abc-9"}, body_override="hi")
    assert dispatcher._sent_native[-1][1]["badge"] == 3
    out = dispatcher.sync_native_badge(reason="reply_final")
    assert out["delivered"] == 0 and out["skipped_same"] == 1, "alert push already carried 3"


def test_badge_sync_prunes_dead_tokens_and_skips_unconfigured(dispatcher, db):
    state.upsert_native_token(db, token=TOK_A)
    state.upsert_native_token(db, token=TOK_B)  # fake sender raises 410 for B
    dispatcher.unread_total_fn = lambda: 2
    out = dispatcher.sync_native_badge()
    assert out["delivered"] == 1 and out["pruned"] == 1
    assert [r["token"] for r in state.list_native_tokens(db)] == [TOK_A]
    dispatcher._apns_cfg = None
    assert dispatcher.sync_native_badge()["skipped"] == "apns_unconfigured"
    dispatcher.unread_total_fn = None
    assert dispatcher.schedule_badge_sync("x") is False


def test_schedule_badge_sync_debounces_into_one_run(dispatcher, db, monkeypatch):
    monkeypatch.setattr(sd, "BADGE_SYNC_DEBOUNCE_S", 0.05)
    state.upsert_native_token(db, token=TOK_A)
    calls = []
    dispatcher.unread_total_fn = lambda: calls.append(1) or 4
    for _ in range(5):
        assert dispatcher.schedule_badge_sync("burst") is True
    assert dispatcher._sent_native == [], "nothing goes out before the window closes"
    deadline = time.time() + 2
    while len(dispatcher._sent_native) < 1 and time.time() < deadline:
        time.sleep(0.01)
    time.sleep(0.15)
    assert len(calls) == 1 and dispatcher._sent_native == [(TOK_A, {"badge": 4, "badge_only": True})]


def test_unread_changed_publish_schedules_badge_sync_once_per_envelope():
    """The hook lives at the single publish point: ANY unread mutation that
    tells clients to re-fetch also re-derives the icon number."""
    from .. import parley_route_events as ev
    from types import SimpleNamespace
    seen = []
    adapter = SimpleNamespace(_event_id_counter=0, _event_replay_ring=[], _event_subscribers=set(),
                              _schedule_native_badge_sync=lambda cause: seen.append(cause))
    ev.publish_out_of_turn(adapter, {"type": "unread_changed", "chat_id": "c1", "cause": "seen"})
    ev.publish_out_of_turn(adapter, {"type": "reply_final", "chat_id": "c1"})
    ev.publish_out_of_turn(adapter, {"type": "unread_changed", "chat_id": "c2", "cause": "mark"})
    assert seen == ["seen", "mark"]
    # Adapters without the hook (older fakes) publish unchanged.
    bare = SimpleNamespace(_event_id_counter=0, _event_replay_ring=[], _event_subscribers=set())
    assert ev.publish_out_of_turn(bare, {"type": "unread_changed", "chat_id": "c1", "cause": "seen"}) is False


def test_adapter_badge_sync_gated_on_plugin_owned_push(monkeypatch):
    from .. import ParleyAdapter
    adapter = ParleyAdapter.__new__(ParleyAdapter)
    scheduled = []
    adapter._push_dispatcher = SimpleNamespace(schedule_badge_sync=lambda c: scheduled.append(c))
    monkeypatch.setattr(ParleyAdapter, "_push_owned_by_plugin", staticmethod(lambda: False))
    adapter._schedule_native_badge_sync("seen")
    assert scheduled == []
    monkeypatch.setattr(ParleyAdapter, "_push_owned_by_plugin", staticmethod(lambda: True))
    adapter._schedule_native_badge_sync("seen")
    assert scheduled == ["seen"]
