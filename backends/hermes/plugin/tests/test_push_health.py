"""Push-health guardrails — regression suite for the 2026-07 outage
where every push_kind_* pref sat at false in the live parley.db for
9+ days and nothing louder than per-skip journal WARNINGs said so.

Coverage:
  - Pref defaults pinned: unset push_kind_* → enabled (fresh installs
    push). All-false is RESPECTED (user intent) but must trip the
    health signal.
  - PushHealthMonitor: burst of pref-driven skips within the rolling
    window → exactly ONE prominent stderr alert per window; counters
    prune outside the window.
  - Dispatcher startup: all supported kinds disabled → one prominent
    stderr alert at construction.
  - build_push_health blob: effective kinds map, all_kinds_disabled
    tripwire, monitor snapshot fold-in (feeds /v1/push/health → proxy
    diagnostics → PWA settings panel).
  - /v1/push/health + /v1/push/prefs routes: legacy `kinds` object
    writes are canonicalized to per-key rows, never stored nested.
  - Legacy `kinds` push_prefs row migration: idempotent, per-key rows
    always win, legacy row deleted.
  - PARLEY_TEST_GUARD: ParleyDB refuses to open a DB under the
    live state dirs while the guard env is set (the isolation that
    would have prevented the incident's corrupting write).
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from ..parley_db import ParleyDB
from ..parley_dispatcher import (
    PushDispatcher,
    PushHealthMonitor,
    _kind_pref_enabled,
    _SUPPORTED_PUSH_KINDS,
    build_push_health,
)
from ..parley_routes import handle_prefs, handle_push_health
from .. import parley_state as state


# ── Fixtures ───────────────────────────────────────────────────────────


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "sidekick.db")
    yield db
    db.close()


@pytest.fixture
def dispatcher_factory(db, monkeypatch):
    """Build a dispatcher with pywebpush stubbed, AFTER the test has
    arranged prefs — the startup health check runs at construction."""
    from .. import parley_dispatcher as sd

    sent = []

    def fake_webpush(*, subscription_info, data, **kw):
        sent.append({"endpoint": subscription_info["endpoint"], "data": data})
        return None

    monkeypatch.setattr(sd, "webpush", fake_webpush)

    def build():
        d = PushDispatcher(db, vapid_subject="mailto:test@example.com")
        d._sent = sent  # type: ignore[attr-defined]
        return d

    return build


class FakeRequest:
    def __init__(self, body=None, method="POST"):
        self._body = body or {}
        self.method = method

    async def json(self):
        return self._body


def _body(resp):
    return json.loads(resp.text)


def _pref_rows(db):
    return {r["key"]: r["value_json"] for r in db.fetchall("SELECT key, value_json FROM push_prefs")}


# ── Pref defaults pinned (4c) ──────────────────────────────────────────


def test_unset_kind_prefs_default_to_enabled(db):
    """Fresh install: no push_kind_* rows → every kind pushes."""
    for kind in _SUPPORTED_PUSH_KINDS:
        assert _kind_pref_enabled(db, kind) is True


def test_all_false_is_respected_but_flagged(db, dispatcher_factory, capsys):
    """All-false is a legal user choice — dispatch honors it — but the
    startup tripwire must shout, and the health blob must flag it."""
    for kind in _SUPPORTED_PUSH_KINDS:
        state.set_pref(db, f"push_kind_{kind}", False)
    dispatcher = dispatcher_factory()
    err = capsys.readouterr().err
    assert "[push-health ALERT]" in err
    assert "ALL push kinds disabled at startup" in err
    # Dispatch still respects the toggle (no push).
    out = dispatcher.dispatch_envelope(
        {"type": "reply_final", "chat_id": "chat-1"}, body_override="hi")
    assert out["skipped"] == "kind_disabled"
    health = build_push_health(db, dispatcher)
    assert health["all_kinds_disabled"] is True
    assert health["monitor"]["startup_all_kinds_disabled"] is True


def test_startup_check_quiet_when_any_kind_enabled(db, dispatcher_factory, capsys):
    state.set_pref(db, "push_kind_cron", False)
    dispatcher_factory()
    assert "[push-health ALERT]" not in capsys.readouterr().err


# ── PushHealthMonitor ──────────────────────────────────────────────────


def test_skip_burst_alerts_exactly_once_per_window(capsys):
    mon = PushHealthMonitor(window_sec=3600, alert_threshold=5)
    t0 = 1_000_000.0
    for i in range(4):
        mon.record_skip("kind_disabled", now=t0 + i)
    assert "[push-health ALERT]" not in capsys.readouterr().err
    mon.record_skip("kind_disabled", now=t0 + 4)  # threshold crossed
    assert "pushes suppressed by user prefs" in capsys.readouterr().err
    # More skips inside the same window: no repeat shout.
    for i in range(20):
        mon.record_skip("kind_disabled", now=t0 + 10 + i)
    assert "[push-health ALERT]" not in capsys.readouterr().err
    # Next window: shout again.
    mon.record_skip("kind_disabled", now=t0 + 3700)
    for i in range(5):
        mon.record_skip("kind_disabled", now=t0 + 3701 + i)
    assert "[push-health ALERT]" in capsys.readouterr().err


def test_transient_skip_reasons_do_not_alert(capsys):
    """user_engaged / muted / no_subscribers are working-as-intended
    gates — they enrich the snapshot but never trip the pref alert."""
    mon = PushHealthMonitor(window_sec=3600, alert_threshold=5)
    t0 = 2_000_000.0
    for i in range(50):
        mon.record_skip("user_engaged", now=t0 + i)
        mon.record_skip("muted", now=t0 + i)
    assert "[push-health ALERT]" not in capsys.readouterr().err
    snap = mon.snapshot(now=t0 + 60)
    assert snap["skips_in_window"]["user_engaged"] == 50
    assert snap["pref_skips_in_window"] == 0


def test_monitor_window_prunes_old_skips():
    mon = PushHealthMonitor(window_sec=3600, alert_threshold=5)
    t0 = 3_000_000.0
    for i in range(3):
        mon.record_skip("kind_disabled", now=t0 + i)
    snap = mon.snapshot(now=t0 + 3601 + 3)
    assert snap["skips_in_window"] == {}
    assert snap["pref_skips_in_window"] == 0


def test_dispatch_kind_disabled_burst_trips_monitor(db, dispatcher_factory, capsys):
    """End-to-end: a disabled kind + a burst of envelopes → aggregate
    stderr alert (not just per-skip logger lines)."""
    state.set_pref(db, "push_kind_agent_reply", False)
    dispatcher = dispatcher_factory()
    capsys.readouterr()  # drain (startup check is quiet here anyway)
    for i in range(PushHealthMonitor().alert_threshold):
        dispatcher.dispatch_envelope(
            {"type": "reply_final", "chat_id": f"chat-{i}"}, body_override="x")
    err = capsys.readouterr().err
    assert "[push-health ALERT]" in err
    snap = dispatcher.health.snapshot()
    assert snap["pref_skips_in_window"] >= PushHealthMonitor().alert_threshold


# ── build_push_health / route ──────────────────────────────────────────


def test_build_push_health_shape(db, dispatcher_factory):
    state.set_pref(db, "push_kind_cron", False)
    state.set_pref(db, "quiet_hours", {"enabled": True, "start": "09:51", "end": "10:51"})
    dispatcher = dispatcher_factory()
    health = build_push_health(db, dispatcher)
    assert health["kinds"] == {"agent_reply": True, "approval": True, "cron": False}
    assert health["disabled_kinds"] == ["cron"]
    assert health["all_kinds_disabled"] is False
    assert health["quiet_hours"]["start"] == "09:51"
    assert health["subscriptions"] == 0
    assert health["monitor"]["window_sec"] == 3600


def test_push_health_route(db):
    ctx = SimpleNamespace(db=db, dispatcher=None)
    resp = asyncio.run(handle_push_health(ctx, FakeRequest(method="GET")))
    assert resp.status == 200
    health = _body(resp)["push_health"]
    assert health["all_kinds_disabled"] is False
    assert set(health["kinds"]) == set(_SUPPORTED_PUSH_KINDS)
    assert "monitor" not in health  # no dispatcher wired in this rig


# ── Canonical-shape prefs writes ───────────────────────────────────────


def test_prefs_post_kinds_object_is_canonicalized(db):
    """POST key='kinds' never stores a nested row — it fans out to the
    per-key push_kind_* rows the dispatcher actually reads."""
    ctx = SimpleNamespace(db=db)
    resp = asyncio.run(handle_prefs(ctx, FakeRequest({
        "key": "kinds", "value": {"agent_reply": False, "cron": True},
    })))
    assert resp.status == 200
    assert _body(resp)["canonicalized"] is True
    rows = _pref_rows(db)
    assert "kinds" not in rows
    assert json.loads(rows["push_kind_agent_reply"]) is False
    assert json.loads(rows["push_kind_cron"]) is True


def test_prefs_post_legacy_broad_notification_toggle(db):
    """Legacy broad `notification` toggle maps to cron + approval
    (proxy prefs.ts mergeWithDefaults semantics)."""
    ctx = SimpleNamespace(db=db)
    resp = asyncio.run(handle_prefs(ctx, FakeRequest({
        "key": "kinds", "value": {"notification": False},
    })))
    assert resp.status == 200
    rows = _pref_rows(db)
    assert "kinds" not in rows
    assert json.loads(rows["push_kind_cron"]) is False
    assert json.loads(rows["push_kind_approval"]) is False
    assert "push_kind_agent_reply" not in rows


def test_prefs_post_kinds_non_object_rejected(db):
    ctx = SimpleNamespace(db=db)
    resp = asyncio.run(handle_prefs(ctx, FakeRequest({"key": "kinds", "value": "nope"})))
    assert resp.status == 400
    assert _pref_rows(db) == {}


# ── Legacy `kinds` row migration ───────────────────────────────────────


def test_migrate_legacy_kinds_row(db):
    db.exec("INSERT INTO push_prefs (key, value_json) VALUES (?, ?)",
            ("kinds", json.dumps({"notification": False})))
    assert state.migrate_legacy_push_prefs(db) is True
    rows = _pref_rows(db)
    assert "kinds" not in rows
    assert json.loads(rows["push_kind_cron"]) is False
    assert json.loads(rows["push_kind_approval"]) is False
    # Second run: no legacy row → no-op.
    assert state.migrate_legacy_push_prefs(db) is False


def test_migrate_never_clobbers_existing_per_key_rows(db):
    """The user's live per-key toggles always win over the dead legacy
    blob — migration only fills gaps."""
    state.set_pref(db, "push_kind_cron", True)
    db.exec("INSERT INTO push_prefs (key, value_json) VALUES (?, ?)",
            ("kinds", json.dumps({"notification": False, "agent_reply": False})))
    assert state.migrate_legacy_push_prefs(db) is True
    rows = _pref_rows(db)
    assert "kinds" not in rows
    assert json.loads(rows["push_kind_cron"]) is True          # preserved
    assert json.loads(rows["push_kind_approval"]) is False     # gap filled
    assert json.loads(rows["push_kind_agent_reply"]) is False  # gap filled


def test_migrate_malformed_legacy_row_still_deletes(db):
    db.exec("INSERT INTO push_prefs (key, value_json) VALUES (?, ?)",
            ("kinds", "{not json"))
    assert state.migrate_legacy_push_prefs(db) is True
    assert _pref_rows(db) == {}


def test_expand_kinds_drops_unknown_kind_names():
    out = state.expand_kinds_pref_value({"agent_reply": True, "bogus_kind": True})
    assert out == {"agent_reply": True}


# ── PARLEY_TEST_GUARD live-DB tripwire ───────────────────────────────


def test_guard_blocks_live_state_dirs(tmp_path, monkeypatch):
    """With the guard env set (conftest sets it for the whole suite),
    opening a DB under ~/.hermes (or ~/.parley, ~/.sidekick,
    ~/.openclaw-sk-integ)
    raises before anything touches disk. HOME is faked so the test is
    safe even if the guard were broken."""
    monkeypatch.setenv("HOME", str(tmp_path))
    for dirname in (".hermes", ".parley", ".sidekick", ".openclaw-sk-integ"):
        live_path = tmp_path / dirname / "parley.db"
        with pytest.raises(RuntimeError, match="TEST_GUARD"):
            ParleyDB(live_path)
        assert not live_path.parent.exists()  # raised before mkdir


def test_guard_blocks_live_state_dirs_under_legacy_env_spelling(tmp_path, monkeypatch):
    """The pytest command line historically sets SIDEKICK_TEST_GUARD=1
    (legacy spelling); the tripwire must keep honoring it post-rename."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("PARLEY_TEST_GUARD", raising=False)
    monkeypatch.setenv("SIDEKICK_TEST_GUARD", "1")
    with pytest.raises(RuntimeError, match="TEST_GUARD"):
        ParleyDB(tmp_path / ".hermes" / "parley.db")


def test_guard_allows_tmp_paths(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = ParleyDB(tmp_path / "elsewhere" / "sidekick.db")
    db.close()


def test_guard_disabled_without_env(tmp_path, monkeypatch):
    """Production path: no guard env → live dirs open normally (the
    gateway itself must not be blocked)."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("PARLEY_TEST_GUARD", raising=False)
    monkeypatch.delenv("SIDEKICK_TEST_GUARD", raising=False)
    db = ParleyDB(tmp_path / ".hermes" / "parley.db")
    db.close()
