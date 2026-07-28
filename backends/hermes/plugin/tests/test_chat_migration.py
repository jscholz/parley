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
