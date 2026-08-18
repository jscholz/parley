"""Transcript v3 read path (Phase 3, ``PARLEY_ITEMS_V3``).

Pins the read flip: for chats holding a current-``SCHEMA_VERSION``
``chat_migrations`` marker, the items endpoint serves **parley.db
bodies** (msg_links) in parley.db's own frozen per-row order,
consulting state.db only THROUGH links as a liveness oracle:

  * linked row (agent_row_id set) → served iff the state row still
    exists and was not user-retracted (/undo soft-delete: active=0
    with compacted=0). Compaction-archived originals (active=0,
    compacted=1) are the user's real scrollback and keep serving.
  * /retry (full DELETE+reinsert) → old links orphan → retracted;
    the regenerated turn arrives via fresh links (relink-forward,
    decision memo 2026-07-28 — no content re-adoption, ever).
  * unlinked msg_links row → served iff status='final' (the
    envelope-only set: slash-command replies, gateway status bubbles,
    the envelope→flush window). ``tc:*`` call-args rows stay
    status='streaming' and never serve.
  * unlinked STATE rows are never served — invisible by construction
    (failure direction: invisibility + alert, never invention).

Parity: on a healthy migrated chat the v3 output must byte-match the
v2 read (state.db bodies + annotations) — same items, same field
order, same pagination contracts — so the PWA is untouched by the
flip. The 07-15 field dump (~/.sidekick/missing-bubble-repro-*.json)
was consulted for the live shapes (wrong-call-id tr: mislink,
orchestration rows, tool result content) but is a home-dir artifact
tests can't depend on — fixtures here synthesize the same shapes
(state.db rig mirrors test_chat_migration.py's live 0.18 schema).
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time

import pytest

from ..parley_db import ParleyDB
from .. import parley_chat_migration as migration
from .. import parley_route_items as route
from .. import parley_state as state
from .. import parley_turn_linker as linker
from ..parley_turn_buffer import TurnBuffer


CHAT_ID = "f3a10c77-v3-read-path-test"
SESSION = "20260730_000000_test"
SRC = "sidekick"
# Epoch-scale base so envelope-only ids land in the epoch-millis cursor
# space (>= state._ENVELOPE_CURSOR_THRESHOLD), like production rows.
BASE = 1_784_500_000.0


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "sidekick.db")
    yield db
    db.close()


@pytest.fixture
def state_db(tmp_path):
    """Fake hermes state.db — live 0.18 shape (active/compacted present)."""
    path = tmp_path / "state.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            user_id TEXT,
            system_prompt TEXT,
            parent_session_id TEXT,
            started_at REAL NOT NULL
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_call_id TEXT,
            tool_calls TEXT,
            tool_name TEXT,
            timestamp REAL NOT NULL,
            platform_message_id TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            compacted INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
        """
    )
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, started_at) VALUES (?, ?, ?, ?)",
        (SESSION, SRC, CHAT_ID, time.time()),
    )
    conn.commit()
    conn.close()
    return path


@pytest.fixture(autouse=True)
def _reset_shared_state(monkeypatch):
    # Route tests must not spawn real background reconciles, and the
    # linker compare cache must not leak across tests.
    monkeypatch.setenv("PARLEY_RECONCILE_BG_DISABLED", "1")
    linker._compare_hwm.clear()
    route._last_reconcile_at.clear()
    yield
    linker._compare_hwm.clear()
    route._last_reconcile_at.clear()


def _add_msg(state_db, role, content, ts, tool_calls=None, tool_name=None,
             tool_call_id=None, active=1, compacted=0, sid=SESSION):
    conn = sqlite3.connect(str(state_db))
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, "
        "tool_call_id, tool_calls, timestamp, active, compacted) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (sid, role, content, tool_name, tool_call_id, tool_calls, ts,
         active, compacted),
    )
    conn.commit()
    rowid = cur.lastrowid
    conn.close()
    return rowid


def _mutate_state(state_db, sql, params=()):
    conn = sqlite3.connect(str(state_db))
    conn.execute(sql, params)
    conn.commit()
    conn.close()


def _orch(*call_ids):
    return json.dumps([
        {"id": cid, "function": {"name": "t", "arguments": "{}"}}
        for cid in call_ids
    ])


def _pin(db, sk_id, ts):
    """Pin a msg_links row's created_at (record_envelope stamps wall-clock
    now; byte-parity with v2's state-timestamp created_at needs
    deterministic times — live drift is emit-vs-flush seconds, display
    only)."""
    db.exec("UPDATE msg_links SET created_at = ?, updated_at = ? WHERE id = ?",
            (ts, ts, sk_id))


def _seed_turn(db, state_db, i, ts):
    """One healthy turn, both stores: user → orchestration → tool →
    final in state.db; the write-through envelope sequence in
    msg_links (the orchestration row has no envelope — reconcile
    mints its legacy twin during migration)."""
    cid = f"call_{i}"
    u = _add_msg(state_db, "user", f"question {i}", ts)
    orch = _add_msg(state_db, "assistant", "", ts + 1.0, tool_calls=_orch(cid))
    t = _add_msg(state_db, "tool", json.dumps({"ok": i}), ts + 2.0,
                 tool_call_id=cid, tool_name="terminal")
    f = _add_msg(state_db, "assistant", f"answer {i}", ts + 3.0)
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": f"umsg_{i}", "text": f"question {i}",
    })
    state.record_envelope(db, {
        "type": "tool_call", "chat_id": CHAT_ID, "call_id": cid,
        "tool_name": "terminal", "args": {"cmd": i},
    })
    state.record_envelope(db, {
        "type": "tool_result", "chat_id": CHAT_ID, "call_id": cid,
        "tool_name": "terminal", "result": json.dumps({"ok": i}),
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": f"msg_{i}", "text": f"answer {i}",
    })
    _pin(db, f"umsg_{i}", ts)
    _pin(db, f"tc:{cid}", ts + 1.5)
    _pin(db, f"tr:{cid}", ts + 2.0)
    _pin(db, f"msg_{i}", ts + 3.0)
    return {"user": u, "orch": orch, "tool": t, "final": f, "call": cid}


def _seed_healthy_chat(db, state_db):
    """Two tool-using turns + a session_meta machinery row + a linked
    cron notification + an envelope-only gateway status bubble — the
    full conversational + non-conversational live mix — then migrate."""
    t1 = _seed_turn(db, state_db, 1, BASE)
    t2 = _seed_turn(db, state_db, 2, BASE + 10.0)
    meta = _add_msg(state_db, "session_meta", '{"model": "opus"}', BASE + 20.0)
    notif_row = _add_msg(state_db, "assistant", "Cronjob Response: ok",
                         BASE + 21.0)
    state.record_envelope(db, {
        "type": "notification", "chat_id": CHAT_ID, "kind": "cron",
        "message_id": "notif_1784500021000_test", "content": "Cronjob Response: ok",
        "agent_row_id": str(notif_row),
    })
    _pin(db, "notif_1784500021000_test", BASE + 21.0)
    # Gateway status bubble: arrives via send() as a plain assistant
    # reply, has no state.db twin ever — the envelope-only class.
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "sk-1784500022-1",
        "text": "⏳ Still working... (3 min elapsed)",
    })
    _pin(db, "sk-1784500022-1", BASE + 22.0)
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True, res
    return {"t1": t1, "t2": t2, "meta": meta, "notif": notif_row}


def _v2_tail(db, state_db, **kw):
    return state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, SRC, **kw)


def _v3_tail(db, state_db, **kw):
    return state.list_messages_for_chat_v3(db, state_db, CHAT_ID, **kw)


# ── v3-vs-v2 parity on healthy chats ──────────────────────────────────


def test_v3_matches_v2_byte_for_byte_on_healthy_chat(db, state_db):
    """The whole point of the flip gate: on an undamaged migrated chat
    the v3 read serves EXACTLY the conversational set v2 serves — same
    items, same field insertion order, byte-identical JSON — including
    the non-conversational live mix (session_meta machinery row the
    client projection ignores, envelope-only status bubble, linked
    cron notification) and excluding tc:* streaming rows."""
    _seed_healthy_chat(db, state_db)
    v2 = _v2_tail(db, state_db)
    v3 = _v3_tail(db, state_db)
    assert json.dumps(v3["items"]) == json.dumps(v2["items"])
    assert v3["first_id"] == v2["first_id"]
    assert v3["has_more"] == v2["has_more"]
    # Sanity on the compared content: both turns + notification + the
    # bubble + session_meta made it through; tc:* never serves.
    sks = [it.get("sidekick_id") for it in v3["items"]]
    assert "umsg_1" in sks and "msg_2" in sks
    assert "sk-1784500022-1" in sks
    assert "notif_1784500021000_test" in sks
    assert any(str(s).startswith("legacy:") for s in sks)  # orch twins
    assert not any(str(s).startswith("tc:") for s in sks)
    assert any(it["role"] == "session_meta" for it in v3["items"])


def test_v3_matches_v2_on_paged_reads(db, state_db):
    """Pagination parity: limit/before (scroll-up), after (load-newer),
    around (deep drill) all serve byte-identical pages so the PWA's
    cursors keep working across the flip."""
    ids = _seed_healthy_chat(db, state_db)
    v2 = _v2_tail(db, state_db, limit=4)
    v3 = _v3_tail(db, state_db, limit=4)
    assert json.dumps(v3["items"]) == json.dumps(v2["items"])
    assert (v3["first_id"], v3["has_more"]) == (v2["first_id"], v2["has_more"])

    cursor = ids["t2"]["user"]
    v2 = _v2_tail(db, state_db, limit=3, before_id=cursor)
    v3 = _v3_tail(db, state_db, limit=3, before_id=cursor)
    assert json.dumps(v3["items"]) == json.dumps(v2["items"])
    assert (v3["first_id"], v3["has_more"]) == (v2["first_id"], v2["has_more"])

    after = ids["t1"]["final"]
    v2 = state.list_messages_after_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, SRC, after_id=after, limit=3)
    v3 = state.list_messages_after_for_chat_v3(
        db, state_db, CHAT_ID, after_id=after, limit=3)
    assert json.dumps(v3["items"]) == json.dumps(v2["items"])
    assert v3 == v2

    v2 = state.list_messages_around_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, SRC, target="tr:call_1", limit=6)
    v3 = state.list_messages_around_for_chat_v3(
        db, state_db, CHAT_ID, target="tr:call_1", limit=6)
    assert json.dumps(v3["items"]) == json.dumps(v2["items"])
    assert v3 == v2
    assert v3["target_found"] is True


def test_v3_after_cursor_on_since_linked_envelope_row(db, state_db):
    """A delta cursor taken while a row was still envelope-only (epoch-ms
    id) must keep working after reconcile links the row (its served id
    becomes the state id). The 2026-07-04 vanishing-reply class in v3
    form: the epoch alias must resolve to the row's position instead of
    excluding every durable row forever."""
    ids = _seed_healthy_chat(db, state_db)
    # The client saw msg_2 as envelope-only before its link landed: its
    # cursor is int(created_at * 1000).
    epoch_cursor = int((BASE + 13.0) * 1000)
    result = state.list_messages_after_for_chat_v3(
        db, state_db, CHAT_ID, after_id=epoch_cursor)
    got = [it.get("sidekick_id") for it in result["items"]]
    assert got == [f"legacy:{ids['meta']}", "notif_1784500021000_test",
                   "sk-1784500022-1"], got


# ── liveness: /undo, /retry, compaction ──────────────────────────────


def test_undo_soft_delete_retracts_linked_rows(db, state_db):
    """/undo sets active=0 (compacted=0) — the row still exists, so the
    liveness oracle must read the flag, not row existence (decision
    memo 1). The retracted turn disappears from the v3 read; everything
    else keeps serving."""
    ids = _seed_healthy_chat(db, state_db)
    for key in ("user", "orch", "tool", "final"):
        _mutate_state(state_db,
                      "UPDATE messages SET active = 0 WHERE id = ?",
                      (ids["t2"][key],))
    items = _v3_tail(db, state_db)["items"]
    served_ids = {it["id"] for it in items}
    for key in ("user", "orch", "tool", "final"):
        assert ids["t2"][key] not in served_ids
    assert ids["t1"]["user"] in served_ids
    assert ids["t1"]["final"] in served_ids


def test_compaction_archived_originals_keep_serving(db, state_db):
    """In-place compaction soft-archives the ORIGINALS as active=0 +
    compacted=1 (hermes_state.archive_and_compact) and re-inserts the
    rebuilt context as fresh active rows. The archived originals are
    the user's real scrollback and MUST keep serving; the re-flush
    copies have no envelope → no link → invisible by construction."""
    ids = _seed_healthy_chat(db, state_db)
    _mutate_state(state_db,
                  "UPDATE messages SET active = 0, compacted = 1 "
                  "WHERE session_id = ?", (SESSION,))
    # Re-flush: summary + replay copy, both unlinked in msg_links.
    _add_msg(state_db, "assistant", "[summary of earlier turns]", BASE + 30.0)
    _add_msg(state_db, "user", "question 2", BASE + 10.0)
    items = _v3_tail(db, state_db)["items"]
    served_ids = {it["id"] for it in items}
    assert ids["t1"]["user"] in served_ids, \
        "compaction-archived originals are the scrollback — must serve"
    assert ids["t2"]["final"] in served_ids
    contents = [it["content"] for it in items]
    assert "[summary of earlier turns]" not in contents
    assert contents.count("question 2") == 1, \
        "unlinked replay copy must be invisible by construction"


def test_retry_retracts_orphans_and_serves_relinked_turn(db, state_db):
    """/retry is a full DELETE+reinsert — every row id changes. Old
    links orphan → those messages retract (that's what the user asked
    /retry to do); the regenerated turn arrives via fresh links. NO
    content re-adoption (decision memo 2)."""
    ids = _seed_healthy_chat(db, state_db)
    old = ids["t2"]
    for key in ("user", "orch", "tool", "final"):
        _mutate_state(state_db, "DELETE FROM messages WHERE id = ?",
                      (old[key],))
    new_u = _add_msg(state_db, "user", "question 2", BASE + 40.0)
    new_f = _add_msg(state_db, "assistant", "answer 2 (regenerated)",
                     BASE + 41.0)
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_2_retry", "text": "question 2",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_2_retry", "text": "answer 2 (regenerated)",
    })
    _pin(db, "umsg_2_retry", BASE + 40.0)
    _pin(db, "msg_2_retry", BASE + 41.0)
    db.exec("UPDATE msg_links SET agent_row_id = ? WHERE id = 'umsg_2_retry'",
            (str(new_u),))
    db.exec("UPDATE msg_links SET agent_row_id = ? WHERE id = 'msg_2_retry'",
            (str(new_f),))
    items = _v3_tail(db, state_db)["items"]
    served_ids = {it["id"] for it in items}
    # Orphaned links retract immediately — no reconcile pass needed.
    for key in ("user", "orch", "tool", "final"):
        assert old[key] not in served_ids
    # The old turn's envelope rows must NOT resurface as envelope-only
    # rows (their links orphaned; they were not unlinked).
    sks = [it.get("sidekick_id") for it in items]
    assert "umsg_2" not in sks and "msg_2" not in sks
    assert new_u in served_ids and new_f in served_ids
    assert "answer 2 (regenerated)" in [it["content"] for it in items]


def test_unlinked_state_rows_are_never_served(db, state_db):
    """The inversion v3 exists for: state.db rows no observed turn
    claimed (compaction replays, machinery, rows appended while the
    plugin was down) are invisible by construction — failure direction
    is invisibility + alert, never invention (decision memo 3)."""
    _seed_healthy_chat(db, state_db)
    _add_msg(state_db, "assistant", "row appended with no observing turn",
             BASE + 50.0)
    contents = [it["content"] for it in _v3_tail(db, state_db)["items"]]
    assert "row appended with no observing turn" not in contents


def test_state_db_unreachable_serves_nothing(db, state_db, tmp_path):
    """Liveness unverifiable → serve nothing rather than guess (a
    transient state.db hiccup must not resurrect retracted rows).
    Mirrors the v2 reader's unreachable contract."""
    _seed_healthy_chat(db, state_db)
    missing = tmp_path / "gone-state.db"
    result = state.list_messages_for_chat_v3(db, missing, CHAT_ID)
    assert result == {"items": [], "first_id": None, "has_more": False}


# ── envelope-only serving (filtering correctness) ─────────────────────


def test_streaming_and_cancelled_envelope_rows_never_serve(db, state_db):
    """Unlinked rows serve ONLY at status='final': tc:* call-args rows
    stay streaming forever; an aborted reply_delta without a final must
    not surface as a phantom bubble (the in-flight turn overlays via
    the TurnBuffer instead)."""
    _seed_healthy_chat(db, state_db)
    state.record_envelope(db, {
        "type": "reply_delta", "chat_id": CHAT_ID,
        "message_id": "msg_aborted", "text": "partial strea",
    })
    _pin(db, "msg_aborted", BASE + 60.0)
    sks = [it.get("sidekick_id") for it in _v3_tail(db, state_db)["items"]]
    assert "msg_aborted" not in sks
    assert not any(str(s).startswith("tc:") for s in sks)


def test_fresh_chat_envelope_only_rows_serve_before_flush(db, state_db):
    """The envelope→flush window: rows written through at emit time
    serve as envelope-only items before any state.db row (or link)
    exists — same live-edge contract the v2 union provides."""
    _seed_healthy_chat(db, state_db)
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_live", "text": "just sent",
    })
    _pin(db, "umsg_live", BASE + 70.0)
    items = _v3_tail(db, state_db)["items"]
    assert items[-1].get("sidekick_id") == "umsg_live"
    assert items[-1]["id"] == int((BASE + 70.0) * 1000)


def test_healed_status_bubble_serves_once_envelope_only(db, state_db):
    """The Phase-2 heal class end-to-end: a pre-fix status bubble
    mislinked onto an orchestration row is unlinked by migration and
    then serves exactly ONCE, as itself (envelope-only) — never as an
    annotation on (or twin of) the orchestration state row."""
    t1 = _seed_turn(db, state_db, 1, BASE)
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_bubble", "text": "⏳ Working — 3 min elapsed",
    })
    _pin(db, "msg_bubble", BASE + 5.0)
    db.exec("UPDATE msg_links SET agent_row_id = ? WHERE id = 'msg_bubble'",
            (str(t1["orch"]),))
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True
    items = _v3_tail(db, state_db)["items"]
    bubbles = [it for it in items
               if it["content"] == "⏳ Working — 3 min elapsed"]
    assert len(bubbles) == 1
    assert bubbles[0]["id"] == int((BASE + 5.0) * 1000)  # envelope-only id
    orch_items = [it for it in items if it["id"] == t1["orch"]]
    assert len(orch_items) == 1
    assert orch_items[0]["sidekick_id"] == f"legacy:{t1['orch']}"


# ── route gating (flag × marker) + inflight composition ──────────────


class _Adapter:
    def __init__(self, db, state_db, turn_buffer=None):
        self._parley_db = db
        self._state_db_path = state_db
        self._turn_buffer = turn_buffer

    def _check_http_auth(self, request):
        return True


class _Req:
    """Minimal aiohttp request stand-in — handle_get_items reads
    match_info, query, and .get('t_perf_arrived')."""

    def __init__(self, chat_id, query=None):
        self.match_info = {"id": chat_id}
        self.query = query or {}

    def get(self, key, default=None):
        return default


def _drive_items(adapter, chat_id=CHAT_ID, query=None):
    async def go():
        return await route.handle_get_items(adapter, _Req(chat_id, query))
    resp = asyncio.run(go())
    assert resp.status == 200
    # The repo conftest stubs aiohttp.web with a minimal Response whose
    # json_response payload lands on `.text`.
    return json.loads(resp.text)


def _seed_undo_discriminator(db, state_db):
    """Migrated chat with one /undo'd (active=0) linked row — the
    observable v2/v3 discriminator: legacy serves it, v3 retracts it."""
    ids = _seed_healthy_chat(db, state_db)
    _mutate_state(state_db, "UPDATE messages SET active = 0 WHERE id = ?",
                  (ids["t2"]["final"],))
    return ids["t2"]["final"]


def test_route_flag_on_marked_chat_serves_v3(db, state_db, monkeypatch):
    undone = _seed_undo_discriminator(db, state_db)
    monkeypatch.setenv("PARLEY_ITEMS_V3", "1")
    body = _drive_items(_Adapter(db, state_db))
    assert undone not in {it["id"] for it in body["data"]}


def test_route_flag_off_keeps_legacy_read(db, state_db, monkeypatch):
    """Instant global revert: unsetting the flag restores the legacy
    read for every chat, markers or not."""
    undone = _seed_undo_discriminator(db, state_db)
    monkeypatch.delenv("PARLEY_ITEMS_V3", raising=False)
    body = _drive_items(_Adapter(db, state_db))
    assert undone in {it["id"] for it in body["data"]}


def test_route_unmarked_chat_falls_back_to_legacy(db, state_db, monkeypatch):
    """Per-chat automatic fallback: flag on but no marker → legacy."""
    undone = _seed_undo_discriminator(db, state_db)
    db.exec("DELETE FROM chat_migrations WHERE chat_id = ?", (CHAT_ID,))
    monkeypatch.setenv("PARLEY_ITEMS_V3", "1")
    body = _drive_items(_Adapter(db, state_db))
    assert undone in {it["id"] for it in body["data"]}


def test_route_stale_schema_version_falls_back_to_legacy(db, state_db, monkeypatch):
    """A marker minted at an older SCHEMA_VERSION gates nothing — the
    chat re-migrates lazily and reads stay legacy until it does."""
    undone = _seed_undo_discriminator(db, state_db)
    db.exec("UPDATE chat_migrations SET schema_version = ? WHERE chat_id = ?",
            (migration.SCHEMA_VERSION - 1, CHAT_ID))
    monkeypatch.setenv("PARLEY_ITEMS_V3", "1")
    body = _drive_items(_Adapter(db, state_db))
    assert undone in {it["id"] for it in body["data"]}


def test_route_v3_composes_with_inflight_overlay(db, state_db, monkeypatch):
    """The TurnBuffer in-flight slice overlays the v3 read exactly as it
    does the legacy read — mid-turn reload keeps its streaming bubbles."""
    undone = _seed_undo_discriminator(db, state_db)
    monkeypatch.setenv("PARLEY_ITEMS_V3", "1")
    tb = TurnBuffer()
    tb.open_turn(chat_id=CHAT_ID, user_message="live question",
                 user_message_id="umsg_inflight")
    body = _drive_items(_Adapter(db, state_db, turn_buffer=tb))
    assert undone not in {it["id"] for it in body["data"]}  # still v3
    assert body["inflight"][0] == {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_inflight", "text": "live question",
    }
