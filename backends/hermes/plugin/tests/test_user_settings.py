"""Synced user settings (parley.db ``user_settings``).

Covers the storage helpers (``get_user_setting`` / ``set_user_setting`` /
``list_user_settings``) and the ``/v1/user-settings`` route handler that
the PWA's cross-device settings (STT key-terms today) ride on.

Pins down:
  - get returns the fallback for an absent key, the stored JSON otherwise
  - set upserts (insert then update same key) and stamps updated_at
  - list returns the whole {key: value} map with JSON decoded
  - values can be scalars, objects, AND lists (key-terms = a JSON array)
  - the route handler: GET → {settings: {...}}, POST → upsert + echo

Plus the compare-and-swap surface added after the 2026-07-31 keyterms
clobber incident (a phone's stale IDB mirror overwrote a newer server
row via last-write-wins). CAS semantics pinned here:
  - POST with no ``base_updated_at`` → unconditional write (old-client LWW)
  - ``base_updated_at: null`` → write only if the row does NOT exist
  - ``base_updated_at: <ts>`` → write only if it matches the row's
    current updated_at exactly; otherwise 409 + current {value, updated_at}
  - every successful POST returns the NEW updated_at
  - GET carries a sibling ``updated_at`` {key: ts} map so clients can
    track the base for their next CAS write
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from ..parley_db import ParleyDB
from .. import parley_state as state
from ..parley_routes import handle_user_settings


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "sidekick.db")
    yield db
    db.close()


class FakeRequest:
    def __init__(self, method, body=None):
        self.method = method
        self._body = body or {}

    async def json(self):
        return self._body


def _body(resp):
    return json.loads(resp.text)


def test_get_missing_returns_fallback(db):
    assert state.get_user_setting(db, "nope") is None
    assert state.get_user_setting(db, "nope", fallback=[]) == []


def test_set_then_get_roundtrips_list(db):
    state.set_user_setting(db, "stt_keyterms", ["Deepgram", "Parley"])
    assert state.get_user_setting(db, "stt_keyterms") == ["Deepgram", "Parley"]


def test_set_upserts_and_stamps_updated_at(db):
    state.set_user_setting(db, "theme", "dark")
    row1 = db.fetchone("SELECT value, updated_at FROM user_settings WHERE key = ?", ("theme",))
    assert json.loads(row1["value"]) == "dark"
    assert row1["updated_at"] > 0

    state.set_user_setting(db, "theme", "light")
    rows = db.fetchall("SELECT key FROM user_settings WHERE key = ?", ("theme",))
    assert len(rows) == 1  # upsert, not a second row
    assert state.get_user_setting(db, "theme") == "light"


def test_value_can_be_object(db):
    state.set_user_setting(db, "vad", {"silence_ms": 800, "barge": True})
    assert state.get_user_setting(db, "vad") == {"silence_ms": 800, "barge": True}


def test_list_returns_decoded_map(db):
    state.set_user_setting(db, "stt_keyterms", ["a", "b"])
    state.set_user_setting(db, "theme", "dark")
    assert state.list_user_settings(db) == {
        "stt_keyterms": ["a", "b"],
        "theme": "dark",
    }


def test_route_get_returns_settings_map(db):
    state.set_user_setting(db, "stt_keyterms", ["Hermes"])
    ctx = SimpleNamespace(db=db)
    resp = asyncio.run(handle_user_settings(ctx, FakeRequest("GET")))
    assert resp.status == 200
    body = _body(resp)
    assert body["settings"] == {"stt_keyterms": ["Hermes"]}


def test_route_post_upserts_and_echoes(db):
    ctx = SimpleNamespace(db=db)
    resp = asyncio.run(handle_user_settings(
        ctx, FakeRequest("POST", {"key": "stt_keyterms", "value": ["x", "y"]})
    ))
    assert resp.status == 200
    body = _body(resp)
    assert body["ok"] is True
    assert body["key"] == "stt_keyterms"
    assert body["value"] == ["x", "y"]
    assert state.get_user_setting(db, "stt_keyterms") == ["x", "y"]


def test_route_post_missing_key_is_400(db):
    ctx = SimpleNamespace(db=db)
    resp = asyncio.run(handle_user_settings(ctx, FakeRequest("POST", {"value": 1})))
    assert resp.status == 400


def test_route_post_empty_list_clears_not_seeds(db):
    """An explicit [] is a distinct, persisted state — NOT 'never saved'.
    The frontend relies on this to respect a cleared key-terms list."""
    ctx = SimpleNamespace(db=db)
    asyncio.run(handle_user_settings(
        ctx, FakeRequest("POST", {"key": "stt_keyterms", "value": []})
    ))
    assert state.get_user_setting(db, "stt_keyterms", fallback="sentinel") == []


# ── Compare-and-swap (keyterms clobber incident, 2026-07-31) ──────────

def _post(db, body):
    ctx = SimpleNamespace(db=db)
    return asyncio.run(handle_user_settings(ctx, FakeRequest("POST", body)))


def _get(db):
    ctx = SimpleNamespace(db=db)
    return asyncio.run(handle_user_settings(ctx, FakeRequest("GET")))


def test_post_returns_new_updated_at(db):
    resp = _post(db, {"key": "stt_keyterms", "value": ["a"]})
    assert resp.status == 200
    body = _body(resp)
    assert body["ok"] is True
    assert isinstance(body["updated_at"], float) and body["updated_at"] > 0
    row = db.fetchone(
        "SELECT updated_at FROM user_settings WHERE key = ?", ("stt_keyterms",))
    assert row["updated_at"] == body["updated_at"]


def test_get_includes_updated_at_map(db):
    state.set_user_setting(db, "stt_keyterms", ["a"])
    state.set_user_setting(db, "theme", "dark")
    resp = _get(db)
    assert resp.status == 200
    body = _body(resp)
    assert set(body["updated_at"].keys()) == {"stt_keyterms", "theme"}
    for ts in body["updated_at"].values():
        assert isinstance(ts, float) and ts > 0
    # settings map unchanged (additive extension — old clients unaffected)
    assert body["settings"] == {"stt_keyterms": ["a"], "theme": "dark"}


def test_cas_matching_base_writes(db):
    first = _body(_post(db, {"key": "k", "value": ["v1"]}))
    resp = _post(db, {"key": "k", "value": ["v2"],
                      "base_updated_at": first["updated_at"]})
    assert resp.status == 200
    body = _body(resp)
    assert body["value"] == ["v2"]
    assert body["updated_at"] > first["updated_at"]


def test_cas_stale_base_is_409_with_current_state(db):
    _post(db, {"key": "k", "value": ["v1"]})
    second = _body(_post(db, {"key": "k", "value": ["v2"]}))
    # Device with a stale base (pre-v2) tries to write — must NOT clobber.
    resp = _post(db, {"key": "k", "value": ["stale"],
                      "base_updated_at": second["updated_at"] - 10.0})
    assert resp.status == 409
    body = _body(resp)
    assert body["error"] == "conflict"
    assert body["value"] == ["v2"]
    assert body["updated_at"] == second["updated_at"]
    # Row untouched.
    assert state.get_user_setting(db, "k") == ["v2"]


def test_cas_null_base_means_no_row_expected(db):
    # No row yet: base null → write (first-device adoption).
    resp = _post(db, {"key": "k", "value": ["v1"], "base_updated_at": None})
    assert resp.status == 200
    # Row now exists: base null → 409 (another device won the race).
    resp2 = _post(db, {"key": "k", "value": ["other"], "base_updated_at": None})
    assert resp2.status == 409
    assert _body(resp2)["value"] == ["v1"]
    assert state.get_user_setting(db, "k") == ["v1"]


def test_cas_numeric_base_against_missing_row_is_409(db):
    # Client thinks a row exists (has a ts) but it's gone → conflict with
    # value/updated_at null so the client can see the row vanished.
    resp = _post(db, {"key": "gone", "value": ["v"], "base_updated_at": 123.0})
    assert resp.status == 409
    body = _body(resp)
    assert body["value"] is None
    assert body["updated_at"] is None
    assert state.get_user_setting(db, "gone", fallback="absent") == "absent"


def test_absent_base_keeps_last_write_wins(db):
    # Old clients (stale CAP bundle) send no base — behavior unchanged.
    _post(db, {"key": "k", "value": ["v1"]})
    resp = _post(db, {"key": "k", "value": ["v2"]})
    assert resp.status == 200
    assert state.get_user_setting(db, "k") == ["v2"]


def test_cas_updated_at_strictly_increases(db):
    ts = None
    for i in range(3):
        body = _body(_post(db, {"key": "k", "value": [f"v{i}"]} |
                           ({"base_updated_at": ts} if ts is not None else {})))
        assert ts is None or body["updated_at"] > ts
        ts = body["updated_at"]


def test_cas_invalid_base_type_is_400(db):
    resp = _post(db, {"key": "k", "value": ["v"], "base_updated_at": "nope"})
    assert resp.status == 400
