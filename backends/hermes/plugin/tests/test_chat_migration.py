"""One-time backfill + chat migration marker (transcript v3 Phase 2).

Pins ``sidekick_chat_migration``: the legacy import (the content-
fingerprint reconcile run ONCE per chat), the pre-import heal of
pre-aa81f4f status-bubble / tr: mislinks onto orchestration state rows
(2026-07-28 re-soak forensics: 27 bubble zips + 1 tr: mislink, all
minted before the fix deployed 2026-07-23 19:38Z), the "cleanly" gate,
and the durable ``chat_migrations`` marker Phase 3's read flip
(``SIDEKICK_ITEMS_V3``) will consult.

The state.db rig mirrors tests/test_turn_linker.py (live hermes 0.18
shape). Mislink fixtures are synthesized to the forensic shape
(role=assistant, empty content, tool_calls present, tool_call_id NULL)
— the preserved field dump ``~/.sidekick/missing-bubble-repro-*.json``
is a home-dir artifact tests can't depend on.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time

import pytest

from ..sidekick_db import SidekickDB
from .. import sidekick_chat_migration as migration
from .. import sidekick_state as state
from .. import sidekick_turn_linker as linker


CHAT_ID = "b3e11a02-migration-test"
SESSION = "20260728_000000_test"
SRC = "sidekick"


@pytest.fixture
def db(tmp_path):
    db = SidekickDB(tmp_path / "sidekick.db")
    yield db
    db.close()


@pytest.fixture
def state_db(tmp_path):
    """Fake hermes state.db — live 0.18 shape (active/compacted/
    platform_message_id present)."""
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
def _reset_compare_state():
    linker._compare_hwm.clear()
    yield
    linker._compare_hwm.clear()


def _add_msg(state_db, role, content, ts, tool_calls=None, tool_name=None,
             tool_call_id=None, active=1, sid=SESSION):
    conn = sqlite3.connect(str(state_db))
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, "
        "tool_call_id, tool_calls, timestamp, active) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (sid, role, content, tool_name, tool_call_id, tool_calls, ts, active),
    )
    conn.commit()
    rowid = cur.lastrowid
    conn.close()
    return rowid


def _orch(*call_ids):
    return json.dumps([
        {"id": cid, "function": {"name": "t", "arguments": "{}"}}
        for cid in call_ids
    ])


def _seed_legacy_history(state_db):
    """Pre-write-through history: user → orchestration → tool → final,
    none of it represented in msg_links yet."""
    u = _add_msg(state_db, "user", "hello", 100.0)
    orch = _add_msg(state_db, "assistant", "", 101.0, tool_calls=_orch("cA"))
    t = _add_msg(state_db, "tool", '{"ok": true}', 102.0,
                 tool_call_id="cA", tool_name="terminal")
    f = _add_msg(state_db, "assistant", "done", 103.0)
    return u, orch, t, f


def _link(db, sk_id):
    return db.fetchone(
        "SELECT agent_row_id FROM msg_links WHERE id = ?", (sk_id,))


# ── legacy import + marker ────────────────────────────────────────────


def test_backfill_imports_legacy_history_and_mints_marker(db, state_db, capsys):
    ids = _seed_legacy_history(state_db)
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True and res["already"] is False
    for sid in ids:
        row = _link(db, f"legacy:{sid}")
        assert row is not None and str(row["agent_row_id"]) == str(sid)
    marker = migration.get_migration(db, CHAT_ID)
    assert marker is not None
    assert marker["schema_version"] == migration.SCHEMA_VERSION
    assert marker["stats"]["state_rows"] == 4
    assert marker["stats"]["unresolved"] == 0
    # Operator-visible mint line rides the perf-trace stderr channel
    # (logger.info never reaches journald).
    assert "chat-migration" in capsys.readouterr().err


def test_backfill_rerun_is_noop(db, state_db):
    """Idempotency: the marker short-circuits a re-run entirely. History
    arriving AFTER migration belongs to write-through + the linker, not
    to a second import."""
    _seed_legacy_history(state_db)
    first = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert first["migrated"] is True and first["already"] is False
    minted_at = db.fetchone(
        "SELECT migrated_at FROM chat_migrations WHERE chat_id = ?",
        (CHAT_ID,))["migrated_at"]
    extra = _add_msg(state_db, "user", "post-migration row", 200.0)
    again = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert again["migrated"] is True and again["already"] is True
    assert _link(db, f"legacy:{extra}") is None
    assert db.fetchone(
        "SELECT migrated_at FROM chat_migrations WHERE chat_id = ?",
        (CHAT_ID,))["migrated_at"] == minted_at


def test_marker_withheld_when_import_left_holes(db, state_db, monkeypatch):
    """"Cleanly" = every live chain row represented in msg_links (linked
    or legacy-imported) AND no residual orchestration mislink. Simulate
    a failed import (reconcile no-op): the marker must be withheld so
    Phase 3 never flips reads onto a store with holes."""
    _seed_legacy_history(state_db)
    monkeypatch.setattr(migration, "reconcile_from_state_db", lambda *a, **k: 0)
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is False and res["reason"] == "not_clean"
    assert res["unresolved"] == 4
    assert migration.get_migration(db, CHAT_ID) is None
    # The real import on the next attempt mints the marker.
    monkeypatch.undo()
    res2 = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res2["migrated"] is True
    assert migration.get_migration(db, CHAT_ID) is not None


def test_backfill_no_marker_when_state_db_unreachable(db, tmp_path):
    res = migration.backfill_chat_sync(
        db, tmp_path / "missing-state.db", CHAT_ID, SRC)
    assert res["migrated"] is False and res["reason"] == "state_unreachable"
    assert migration.get_migration(db, CHAT_ID) is None


def test_replay_dup_rows_do_not_block_clean_migration(db, state_db):
    """Compaction-replay duplicates are never legacy-imported (reconcile
    skips them by design) — they must not count as unresolved holes."""
    _add_msg(state_db, "user", "hi", 100.0)
    _add_msg(state_db, "assistant", "reply", 101.0)
    # Re-flush batch: machinery seed + a replay copy of the user row
    # (replay copies of user rows keep their original timestamps).
    _add_msg(state_db, "assistant", "[PRIOR CONTEXT — for reference only]", 200.0)
    dup = _add_msg(state_db, "user", "hi", 100.0)
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True
    assert res["replay_dups"] == 1
    assert _link(db, f"legacy:{dup}") is None


def test_get_migration_ignores_stale_schema_version(db, state_db):
    """A marker minted at an older schema_version is treated as
    unmigrated — bumping SCHEMA_VERSION forces re-migration when the
    "cleanly" criteria gain teeth."""
    db.exec(
        "INSERT INTO chat_migrations (chat_id, migrated_at, schema_version, "
        "stats) VALUES (?, ?, 0, '{}')",
        (CHAT_ID, time.time()),
    )
    assert migration.get_migration(db, CHAT_ID) is None
    _seed_legacy_history(state_db)
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True and res["already"] is False
    assert migration.get_migration(db, CHAT_ID)["schema_version"] \
        == migration.SCHEMA_VERSION


# ── orchestration-mislink heal (3c) ───────────────────────────────────


def test_backfill_heals_status_bubble_and_tr_mislinks(db, state_db):
    """Pre-aa81f4f order-fallback zipped ephemeral status bubbles onto
    empty orchestration rows (27 field cases) plus one tr: mislink. Heal
    = NULL the mislink; the follow-up reconcile re-links tr: by exact
    call id and mints the orchestration legacy twin; the bubble stays
    envelope-only (it has no state twin at all)."""
    u, orch, t, f = _seed_legacy_history(state_db)
    state.upsert_msg_link(
        db, id="msg_bubble", chat_id=CHAT_ID, role="assistant",
        content="⏳ Working — 3 min elapsed", agent_row_id=str(orch))
    state.upsert_msg_link(
        db, id="tr:cA", chat_id=CHAT_ID, role="tool",
        content='{"ok": true}', tool_call_id="cA", agent_row_id=str(orch))
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True
    assert res["mislinks_healed"] == 2
    assert _link(db, "msg_bubble")["agent_row_id"] is None
    assert str(_link(db, "tr:cA")["agent_row_id"]) == str(t)
    assert str(_link(db, f"legacy:{orch}")["agent_row_id"]) == str(orch)
    assert u is not None and f is not None


def test_backfill_preserves_legacy_twin_on_orchestration_row(db, state_db):
    """reconcile's own legacy:<id> twin is the ONE legitimate msg_links
    owner of an orchestration state row — the heal must not touch it."""
    _, orch, _, _ = _seed_legacy_history(state_db)
    state.upsert_msg_link(
        db, id=f"legacy:{orch}", chat_id=CHAT_ID, role="assistant",
        content="", tool_calls=_orch("cA"), agent_row_id=str(orch))
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True
    assert res["mislinks_healed"] == 0
    assert str(_link(db, f"legacy:{orch}")["agent_row_id"]) == str(orch)


# ── tr:/tc: wrong-call-id mislink heal (field 2026-07-29, bf6edbf4) ───
#
# Pre-fix content-fingerprint linking could zip a ``tr:<call_X>``
# envelope onto the state row of a DIFFERENT call whose result content
# happened to collide (live instance: tr:call_PZOY… → row 78913
# carrying call_0T3z… while the true row 81447 existed). tool_call_ids
# are unique per call by construction, so a tr:/tc: row whose linked
# state row carries a different non-empty tool_call_id is a provable
# mislink. Heal = NULL it; reconcile Pass 1.a relinks tr:* by exact
# call id; tc:* stays unlinked by design.


def _seed_two_tool_calls(state_db):
    """The bf6edbf4 shape: two tool calls whose results are identical
    strings — the exact collision that crossed the old fingerprint."""
    u = _add_msg(state_db, "user", "check both", 100.0)
    orch = _add_msg(state_db, "assistant", "", 101.0, tool_calls=_orch("cX", "cY"))
    tx = _add_msg(state_db, "tool", '{"total_count": 0}', 102.0,
                  tool_call_id="cX", tool_name="search_files")
    ty = _add_msg(state_db, "tool", '{"total_count": 0}', 103.0,
                  tool_call_id="cY", tool_name="search_files")
    f = _add_msg(state_db, "assistant", "nothing found", 104.0)
    return u, orch, tx, ty, f


def test_backfill_heals_wrong_call_id_tr_mislink(db, state_db):
    """tr:cY mislinked onto cX's state row → healed (NULLed) and
    relinked by the follow-up reconcile to the row carrying cY. The
    correctly-linked tr:cX is untouched."""
    _, _, tx, ty, _ = _seed_two_tool_calls(state_db)
    state.upsert_msg_link(
        db, id="tr:cX", chat_id=CHAT_ID, role="tool",
        content='{"total_count": 0}', tool_call_id="cX", agent_row_id=str(tx))
    state.upsert_msg_link(
        db, id="tr:cY", chat_id=CHAT_ID, role="tool",
        content='{"total_count": 0}', tool_call_id="cY", agent_row_id=str(tx))
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True, res
    assert res["mislinks_healed"] == 1
    assert str(_link(db, "tr:cX")["agent_row_id"]) == str(tx)
    assert str(_link(db, "tr:cY")["agent_row_id"]) == str(ty)


def test_backfill_heals_wrong_call_id_tc_mislink(db, state_db):
    """A tc:* (call-args) row mislinked onto another call's state row is
    the same provable class. tc:* has no state twin by design, so it
    heals to NULL and STAYS unlinked."""
    _, _, tx, _, _ = _seed_two_tool_calls(state_db)
    state.upsert_msg_link(
        db, id="tc:cY", chat_id=CHAT_ID, role="tool",
        content='{"path": "x"}', tool_call_id="cY", agent_row_id=str(tx))
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True, res
    assert res["mislinks_healed"] == 1
    assert _link(db, "tc:cY")["agent_row_id"] is None


def test_wrong_call_id_mislink_counts_as_residual(db, state_db, monkeypatch):
    """The audit must re-detect the class post-heal: with the heal
    disabled, the mislink survives the import and the marker is
    withheld (residual_mislinks != 0) — Phase 3 never flips onto a
    store carrying a known-wrong link."""
    _, _, tx, _, _ = _seed_two_tool_calls(state_db)
    state.upsert_msg_link(
        db, id="tr:cY", chat_id=CHAT_ID, role="tool",
        content='{"total_count": 0}', tool_call_id="cY", agent_row_id=str(tx))
    monkeypatch.setattr(
        migration, "heal_tool_call_mislinks_sync", lambda *a, **k: 0)
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is False and res["reason"] == "not_clean"
    assert res["residual_mislinks"] == 1
    assert migration.get_migration(db, CHAT_ID) is None


def test_backfill_heals_content_incompatible_mislinks(db, state_db):
    """Pre-fix zips onto NON-orchestration rows (2026-07-30 flip-prep
    sweep of live msg_links: 213 links across 32 chats — status
    bubbles onto real assistant replies, /approve//steer envelopes
    onto real user rows). The envelope content can never legitimately
    be content-INCOMPATIBLE with its linked state row (compatibility
    is the post-fix linker's own mint rule; exact-match links start
    equal and hermes never updates content) — so incompatibility is
    provable damage. Heal = NULL; the state row re-imports as its
    legacy twin, the envelope serves as itself."""
    u, orch, t, f = _seed_legacy_history(state_db)
    state.upsert_msg_link(
        db, id="msg_bubble2", chat_id=CHAT_ID, role="assistant",
        content="⏳ Still working... (15 min elapsed)", agent_row_id=str(f))
    state.upsert_msg_link(
        db, id="umsg_cmd", chat_id=CHAT_ID, role="user",
        content="/approve", agent_row_id=str(u))
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True, res
    assert res["mislinks_healed"] == 2
    assert _link(db, "msg_bubble2")["agent_row_id"] is None
    assert _link(db, "umsg_cmd")["agent_row_id"] is None
    # The wrongly-claimed rows re-import with their true content.
    assert str(_link(db, f"legacy:{u}")["agent_row_id"]) == str(u)
    assert str(_link(db, f"legacy:{f}")["agent_row_id"]) == str(f)


def test_content_compatible_drift_is_not_healed(db, state_db):
    """Whitespace / truncation / post-edit drift stays linked — the heal
    uses the SAME compatibility predicate the linker mints by, so only
    pairings the current linker could never produce are touched."""
    u, _, _, f = _seed_legacy_history(state_db)
    state.upsert_msg_link(
        db, id="umsg_ok", chat_id=CHAT_ID, role="user",
        content="hello", agent_row_id=str(u))
    state.upsert_msg_link(
        db, id="msg_ok", chat_id=CHAT_ID, role="assistant",
        content="done — and one more thing", agent_row_id=str(f))
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True, res
    assert res["mislinks_healed"] == 0
    assert str(_link(db, "umsg_ok")["agent_row_id"]) == str(u)
    assert str(_link(db, "msg_ok")["agent_row_id"]) == str(f)


def test_content_mislink_counts_as_residual(db, state_db, monkeypatch):
    """Audit-side re-detection: with the heal disabled the marker is
    withheld — a known-wrong body never rides a read flip."""
    u, _, _, _ = _seed_legacy_history(state_db)
    state.upsert_msg_link(
        db, id="umsg_cmd", chat_id=CHAT_ID, role="user",
        content="/approve", agent_row_id=str(u))
    monkeypatch.setattr(
        migration, "heal_content_mislinks_sync", lambda *a, **k: 0)
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is False and res["reason"] == "not_clean"
    assert res["residual_mislinks"] == 1
    assert migration.get_migration(db, CHAT_ID) is None


def test_schema_version_2_forces_lazy_remigration(db, state_db):
    """The stronger criteria (wrong-call-id detection) require already-
    minted chats to re-migrate: SCHEMA_VERSION is bumped to 2 and a
    version-1 marker no longer gates — the next backfill re-runs the
    heal and re-mints at the current version."""
    assert migration.SCHEMA_VERSION == 2
    _, _, tx, ty, _ = _seed_two_tool_calls(state_db)
    state.upsert_msg_link(
        db, id="tr:cY", chat_id=CHAT_ID, role="tool",
        content='{"total_count": 0}', tool_call_id="cY", agent_row_id=str(tx))
    db.exec(
        "INSERT INTO chat_migrations (chat_id, migrated_at, schema_version, "
        "stats) VALUES (?, ?, 1, '{}')",
        (CHAT_ID, time.time()),
    )
    assert migration.get_migration(db, CHAT_ID) is None
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True and res["already"] is False
    assert res["mislinks_healed"] == 1
    assert str(_link(db, "tr:cY")["agent_row_id"]) == str(ty)
    assert migration.get_migration(db, CHAT_ID)["schema_version"] == 2


# ── flag / purge / wiring ─────────────────────────────────────────────


def test_kill_switch(monkeypatch, db, state_db):
    monkeypatch.setenv("SIDEKICK_CHAT_MIGRATION", "0")
    assert migration.enabled() is False
    _seed_legacy_history(state_db)
    assert migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC) is None
    assert migration.get_migration(db, CHAT_ID) is None
    assert db.fetchone("SELECT 1 FROM msg_links LIMIT 1") is None
    monkeypatch.setenv("SIDEKICK_CHAT_MIGRATION", "1")
    assert migration.enabled() is True


def test_purge_chat_scrubs_migration_marker_and_compare_state(db, state_db):
    """Chat delete must cascade to the Phase-2 tables — a re-created
    chat_id must re-migrate and re-compare from scratch."""
    _seed_legacy_history(state_db)
    assert migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)["migrated"]
    db.exec(
        "INSERT INTO linker_compare_state (chat_id, compared_through) "
        "VALUES (?, 1.0)", (CHAT_ID,))
    linker.purge_chat_sync(db, CHAT_ID)
    assert migration.get_migration(db, CHAT_ID) is None
    assert db.fetchone(
        "SELECT 1 FROM linker_compare_state WHERE chat_id = ?",
        (CHAT_ID,)) is None


def test_background_reconcile_runs_backfill_dark(db, state_db):
    """The items route's background reconcile chain mints the marker
    (dark: serving untouched until Phase 3 consults it)."""
    from .. import sidekick_route_items as route

    class _Adapter:
        _sidekick_db = db
        _state_db_path = state_db

    _seed_legacy_history(state_db)

    async def go():
        route._spawn_background_reconcile(_Adapter(), CHAT_ID, SRC)
        await asyncio.gather(*list(route._reconcile_tasks))

    asyncio.run(go())
    assert migration.get_migration(db, CHAT_ID) is not None
