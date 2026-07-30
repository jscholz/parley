"""Transcript v3 Phases 4 + 5 — write-time links, reconcile retirement,
divergence monitor, orphan-adopt + offline repair.

Phase 4 promotes the turn linker from dark shadow-writer to the REAL
link writer: at turn close its claims stamp ``msg_links.agent_row_id``
for migrated ("marked") chats, and the background items-poll chain
retires the content reconcile for chats v3 actually serves (flag on +
current-version marker). Precedence (pinned here): a linker claim
fills a NULL link, WINS over a differing reconcile-minted link (the
claim is the deterministic one), and NEVER overwrites another linker
claim. Unmarked chats keep the whole legacy chain unchanged —
reconcile → one-shot migration backfill (force_full) → soak compare.

Phase 5 replaces the retired reconcile's safety net with a divergence
monitor (alert-only — decision memo 3: invisibility + alert, never
invention) plus two explicit repair affordances: orphan-adopt (the
plugin-down / terminal-turn recovery) and the offline repair entry
point (force_full reconcile + re-audit + re-mint, the ONE place
content matching still runs).

The state.db rig mirrors tests/test_items_v3_read_path.py (live
hermes 0.18 shape).
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
from types import SimpleNamespace

import pytest

from ..sidekick_db import SidekickDB
from .. import sidekick_chat_migration as migration
from .. import sidekick_route_items as route
from .. import sidekick_state as state
from .. import sidekick_transcript_monitor as monitor
from .. import sidekick_turn_linker as linker


CHAT_ID = "c4d22b13-phase45-test"
SESSION = "20260730_000000_p45"
SRC = "sidekick"
# Epoch-scale base (matches the v3 read-path rig) — far enough in the
# past that every seeded row is outside the monitor's recency grace
# when swept at NOW.
BASE = 1_784_500_000.0
NOW = BASE + 100_000.0


@pytest.fixture
def db(tmp_path):
    db = SidekickDB(tmp_path / "sidekick.db")
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
    # Flag defaults under test control; process caches must not leak.
    monkeypatch.delenv("SIDEKICK_RECONCILE_RETIRED", raising=False)
    monkeypatch.delenv("SIDEKICK_ITEMS_V3", raising=False)
    monkeypatch.delenv("SIDEKICK_RECONCILE_BG_DISABLED", raising=False)
    linker._compare_hwm.clear()
    monitor._health.clear()
    monitor._warned.clear()
    route._last_reconcile_at.clear()
    yield
    linker._compare_hwm.clear()
    monitor._health.clear()
    monitor._warned.clear()
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


def _snap(user_message_id="", user_text=None, final_message_id="", call_ids=()):
    return {
        "user_message_id": user_message_id,
        "user_text": user_text,
        "final_message_id": final_message_id,
        "call_ids": set(call_ids),
    }


def _pin(db, sk_id, ts):
    db.exec("UPDATE msg_links SET created_at = ?, updated_at = ? WHERE id = ?",
            (ts, ts, sk_id))


def _link(db, sk_id):
    return db.fetchone(
        "SELECT agent_row_id FROM msg_links WHERE id = ?", (sk_id,))


def _mint_marker(db, state_db):
    """Migrate the chat (possibly empty history) so it is 'marked'."""
    res = migration.backfill_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True, res
    return res


def _run_turn(db, state_db, i, ts):
    """One fresh post-migration turn end-to-end through the LINKER ONLY
    (no reconcile): write-through envelopes + state.db rows + the
    watermark open/close. Returns the state row ids."""
    cid = f"call_{i}"
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": f"umsg_{i}", "text": f"question {i}",
    })
    _pin(db, f"umsg_{i}", ts)
    linker._open_sync(db, state_db, CHAT_ID, SRC, f"umsg_{i}",
                      user_text=f"question {i}")
    u = _add_msg(state_db, "user", f"question {i}", ts)
    orch = _add_msg(state_db, "assistant", "", ts + 1.0, tool_calls=_orch(cid))
    t = _add_msg(state_db, "tool", json.dumps({"ok": i}), ts + 2.0,
                 tool_call_id=cid, tool_name="terminal")
    f = _add_msg(state_db, "assistant", f"answer {i}", ts + 3.0)
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
    _pin(db, f"tc:{cid}", ts + 1.5)
    _pin(db, f"tr:{cid}", ts + 2.0)
    _pin(db, f"msg_{i}", ts + 3.0)
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": f"msg_{i}"},
        entry_snapshot=_snap(f"umsg_{i}", f"question {i}", f"msg_{i}", {cid}),
    )
    return {"user": u, "orch": orch, "tool": t, "final": f, "call": cid}


# ── Phase 4: linker stamps msg_links at turn close ────────────────────


def test_close_stamps_agent_row_id_for_marked_chat(db, state_db):
    """The deterministic write-time link becomes the REAL link: for a
    marked chat, turn close stamps agent_row_id from the turn's claims
    and mints the legacy:<id> twin for the (envelope-less)
    orchestration row — no reconcile pass involved."""
    _mint_marker(db, state_db)
    ids = _run_turn(db, state_db, 1, BASE)
    assert str(_link(db, "umsg_1")["agent_row_id"]) == str(ids["user"])
    assert str(_link(db, "tr:call_1")["agent_row_id"]) == str(ids["tool"])
    assert str(_link(db, "msg_1")["agent_row_id"]) == str(ids["final"])
    twin = db.fetchone(
        "SELECT agent_row_id, role, tool_calls, status FROM msg_links "
        "WHERE id = ?", (f"legacy:{ids['orch']}",))
    assert twin is not None
    assert str(twin["agent_row_id"]) == str(ids["orch"])
    assert twin["role"] == "assistant" and twin["status"] == "final"
    assert "call_1" in (twin["tool_calls"] or "")


def test_close_does_not_stamp_unmarked_chat(db, state_db):
    """Unmarked chats stay on the legacy path: reconcile owns their
    links; the linker keeps writing shadow tables only."""
    ids = _run_turn(db, state_db, 1, BASE)
    assert _link(db, "umsg_1")["agent_row_id"] is None
    assert _link(db, "msg_1")["agent_row_id"] is None
    assert _link(db, f"legacy:{ids['orch']}") is None


def test_close_does_not_stamp_when_flag_reverted(db, state_db, monkeypatch):
    """SIDEKICK_RECONCILE_RETIRED=0 restores the full Phase-3 posture
    (dark linker) without touching v3 serving."""
    monkeypatch.setenv("SIDEKICK_RECONCILE_RETIRED", "0")
    _mint_marker(db, state_db)
    ids = _run_turn(db, state_db, 1, BASE)
    assert _link(db, "umsg_1")["agent_row_id"] is None
    assert _link(db, f"legacy:{ids['orch']}") is None


def test_stamp_fills_null_and_overrides_reconcile_minted(db, state_db):
    """Precedence rule, halves 1+2: a NULL link is filled; a DIFFERING
    link with no linker claim behind it is reconcile-minted content
    inference — the deterministic claim wins."""
    _mint_marker(db, state_db)
    stray = _add_msg(state_db, "assistant", "pre-window stray", BASE - 10.0)
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_p", "text": "hi",
    })
    # Simulated stale reconcile opinion: umsg_p zipped onto the stray.
    db.exec("UPDATE msg_links SET agent_row_id = ? WHERE id = 'umsg_p'",
            (str(stray),))
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_p", user_text="hi")
    u = _add_msg(state_db, "user", "hi", BASE)
    f = _add_msg(state_db, "assistant", "hello", BASE + 1.0)
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_p", "text": "hello",
    })
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_p"},
        entry_snapshot=_snap("umsg_p", "hi", "msg_p"),
    )
    # Reconcile-minted diff overridden by the claim…
    assert str(_link(db, "umsg_p")["agent_row_id"]) == str(u)
    # …and the NULL link filled.
    assert str(_link(db, "msg_p")["agent_row_id"]) == str(f)


def test_stamp_never_overwrites_prior_linker_claim(db, state_db):
    """Precedence rule, half 3: when msg_links carries a value that IS
    a prior linker claim for the same envelope, the earlier claim
    stands — the linker never fights itself."""
    _mint_marker(db, state_db)
    prior = _add_msg(state_db, "user", "hi", BASE - 10.0)
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_p", "text": "hi",
    })
    db.exec("UPDATE msg_links SET agent_row_id = ? WHERE id = 'umsg_p'",
            (str(prior),))
    db.exec(
        "INSERT INTO turn_links (chat_id, msg_id, agent_row_id, turn_id, "
        "method, created_at) VALUES (?, 'umsg_p', ?, 'umsg_p', 'user', ?)",
        (CHAT_ID, str(prior), BASE - 10.0),
    )
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_p", user_text="hi")
    u = _add_msg(state_db, "user", "hi", BASE)
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_p"},
        entry_snapshot=_snap("umsg_p", "hi", "msg_p"),
    )
    assert str(_link(db, "umsg_p")["agent_row_id"]) == str(prior)
    assert u is not None


# ── Phase 4: background chain — reconcile retired for marked chats ────


class _Adapter:
    def __init__(self, db, state_db):
        self._sidekick_db = db
        self._state_db_path = state_db


def _drive_chain(db, state_db):
    async def go():
        route._spawn_background_reconcile(_Adapter(db, state_db), CHAT_ID, SRC)
        await asyncio.gather(*list(route._reconcile_tasks))
    asyncio.run(go())


@pytest.fixture
def reconcile_spy(monkeypatch):
    """Wrap the real reconcile so the chain still behaves, recording
    calls. Patched on BOTH referencing modules: the chain calls
    ``sidekick_state.reconcile_from_state_db`` while the migration
    backfill bound the name at import."""
    calls = []
    real = state.reconcile_from_state_db

    def spy(*args, **kwargs):
        calls.append((args, kwargs))
        return real(*args, **kwargs)

    monkeypatch.setattr(state, "reconcile_from_state_db", spy)
    monkeypatch.setattr(migration, "reconcile_from_state_db", spy)
    return calls


def test_marked_chat_skips_content_reconcile_runs_monitor(
    db, state_db, monkeypatch, reconcile_spy,
):
    """For chats v3 serves (flag + marker + retirement), the chain runs
    the divergence monitor INSTEAD of reconcile → migration → compare."""
    _mint_marker(db, state_db)
    reconcile_spy.clear()  # drain the marker mint's own force_full call
    monkeypatch.setenv("SIDEKICK_ITEMS_V3", "1")
    _drive_chain(db, state_db)
    assert reconcile_spy == [], "content reconcile must be retired for marked chats"
    assert CHAT_ID in monitor._health, "monitor sweep replaces the reconcile slot"


def test_unmarked_chat_still_reconciles_and_migrates(
    db, state_db, monkeypatch, reconcile_spy,
):
    """Legacy path unchanged: reconcile runs, the one-shot migration
    backfill (force_full inside) mints the marker, compare stays."""
    monkeypatch.setenv("SIDEKICK_ITEMS_V3", "1")
    _add_msg(state_db, "user", "legacy hello", BASE)
    _add_msg(state_db, "assistant", "legacy reply", BASE + 1.0)
    _drive_chain(db, state_db)
    assert len(reconcile_spy) >= 1, "unmarked chats keep the content reconcile"
    assert any(k.get("force_full") for _a, k in reconcile_spy), \
        "the migration backfill's force_full legacy import must still run"
    assert migration.get_migration(db, CHAT_ID) is not None
    assert CHAT_ID not in monitor._health


def test_marked_chat_reconciles_when_retirement_reverted(
    db, state_db, monkeypatch, reconcile_spy,
):
    """SIDEKICK_RECONCILE_RETIRED=0 → full Phase-3 chain for everyone,
    independent of v3 serving."""
    _mint_marker(db, state_db)
    reconcile_spy.clear()
    monkeypatch.setenv("SIDEKICK_ITEMS_V3", "1")
    monkeypatch.setenv("SIDEKICK_RECONCILE_RETIRED", "0")
    _drive_chain(db, state_db)
    assert len(reconcile_spy) == 1
    assert CHAT_ID not in monitor._health


def test_marked_chat_reconciles_when_v3_serving_off(
    db, state_db, monkeypatch, reconcile_spy,
):
    """Retirement is coupled to v3 actually serving the chat: with the
    read flag off, the legacy read depends on reconcile again — so it
    runs."""
    _mint_marker(db, state_db)
    reconcile_spy.clear()
    monkeypatch.delenv("SIDEKICK_ITEMS_V3", raising=False)
    _drive_chain(db, state_db)
    assert len(reconcile_spy) == 1


# ── Phase 5: divergence monitor ───────────────────────────────────────


def test_monitor_clean_chat_is_healthy(db, state_db, caplog):
    _mint_marker(db, state_db)
    _run_turn(db, state_db, 1, BASE)
    with caplog.at_level(logging.WARNING, logger=monitor.logger.name):
        snap = monitor.sweep_chat_sync(db, state_db, CHAT_ID, SRC, now=NOW)
    assert snap["status"] == "healthy"
    assert snap["unlinked_live"] == [] and snap["claimed_missing"] == []
    assert not caplog.records
    health = monitor.build_transcript_health(db)
    assert health["status"] == "healthy"
    assert health["chats_swept"] == 1


def test_monitor_detects_linker_missed_turn(db, state_db, caplog, capsys):
    """THE Phase-4 risk case: rows landed with no observing turn
    (gateway crash mid-turn, plugin down, terminal use). They are
    served-invisible and liveness-blind — the monitor must fire a
    journald WARNING + degrade transcript_health. No auto-heal."""
    _mint_marker(db, state_db)
    g1 = _add_msg(state_db, "user", "typed in terminal", BASE + 10.0)
    g2 = _add_msg(state_db, "assistant", "terminal reply", BASE + 11.0)
    with caplog.at_level(logging.WARNING, logger=monitor.logger.name):
        snap = monitor.sweep_chat_sync(db, state_db, CHAT_ID, SRC, now=NOW)
    assert snap["status"] == "degraded"
    assert set(snap["unlinked_live"]) == {str(g1), str(g2)}
    assert snap["claimed_missing"] == []
    assert len(caplog.records) == 1
    assert "transcript-diverge" in caplog.text and CHAT_ID in caplog.text
    # perf-trace INFO summary line (stderr — journald keeps it).
    err = capsys.readouterr().err
    assert "transcript-monitor" in err and "unlinked_live=2" in err
    health = monitor.build_transcript_health(db)
    assert health["status"] == "degraded"
    assert [c["chat_id"] for c in health["degraded"]] == [CHAT_ID]
    # NOTHING was healed — alert only.
    assert _link(db, f"legacy:{g1}") is None
    # Re-sweep with the same damage: no duplicate WARNING spam.
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger=monitor.logger.name):
        monitor.sweep_chat_sync(db, state_db, CHAT_ID, SRC, now=NOW + 60)
    assert not caplog.records


def test_monitor_detects_vanished_twin(db, state_db, caplog):
    """A state row the linker claimed whose msg_links twin vanished
    (store damage / lost stamp) is the other half of the linker-missed
    shape: live + claimed but unrepresented."""
    _mint_marker(db, state_db)
    ids = _run_turn(db, state_db, 1, BASE)
    db.exec("DELETE FROM msg_links WHERE id = 'msg_1'")
    with caplog.at_level(logging.WARNING, logger=monitor.logger.name):
        snap = monitor.sweep_chat_sync(db, state_db, CHAT_ID, SRC, now=NOW)
    assert snap["status"] == "degraded"
    assert snap["claimed_missing"] == [str(ids["final"])]
    assert snap["unlinked_live"] == []
    assert "claimed_missing=1" in caplog.text


def test_monitor_ignores_pending_machinery_retracted_and_meta(db, state_db):
    """Never-alarm classes: machinery seeds, session_meta rows, /undo
    soft-deletes, rows inside an OPEN turn window, and rows younger
    than the recency grace (mid-flight background turns)."""
    _mint_marker(db, state_db)
    _add_msg(state_db, "assistant",
             "[CONTEXT COMPACTION — REFERENCE ONLY] earlier turns", BASE)
    _add_msg(state_db, "session_meta", '{"model": "opus"}', BASE + 1.0)
    _add_msg(state_db, "user", "undone", BASE + 2.0, active=0)
    _add_msg(state_db, "assistant", "just landed", NOW - 5.0)  # inside grace
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_open",
                      user_text="in flight")
    _add_msg(state_db, "user", "in flight", BASE + 3.0)  # open window
    snap = monitor.sweep_chat_sync(db, state_db, CHAT_ID, SRC, now=NOW)
    assert snap["status"] == "healthy"
    assert snap["unlinked_live"] == []
    assert snap["pending"] == 2  # grace row + open-window row


def test_monitor_orphaned_links_are_informational(db, state_db, caplog):
    """A linked state row VANISHING is /retry-by-design: the v3 read
    already retracts it. Counted for visibility, never degraded."""
    _mint_marker(db, state_db)
    ids = _run_turn(db, state_db, 1, BASE)
    for key in ("user", "orch", "tool", "final"):
        _mutate_state(state_db, "DELETE FROM messages WHERE id = ?",
                      (ids[key],))
    with caplog.at_level(logging.WARNING, logger=monitor.logger.name):
        snap = monitor.sweep_chat_sync(db, state_db, CHAT_ID, SRC, now=NOW)
    assert snap["status"] == "healthy"
    assert snap["orphaned_links"] == 4
    assert not caplog.records


def test_monitor_unreachable_state_db_never_alarms(db, tmp_path, state_db):
    _mint_marker(db, state_db)
    assert monitor.sweep_chat_sync(
        db, tmp_path / "gone.db", CHAT_ID, SRC, now=NOW) is None
    assert CHAT_ID not in monitor._health


def test_monitor_fast_path_skips_unchanged_chat(db, state_db, capsys):
    """Steady state must not re-walk history per poll (the reconcile
    fast-path lesson): unchanged chain + links → cached snapshot, no
    fresh summary line."""
    _mint_marker(db, state_db)
    _run_turn(db, state_db, 1, BASE)
    monitor.sweep_chat_sync(db, state_db, CHAT_ID, SRC, now=NOW)
    capsys.readouterr()
    snap = monitor.sweep_chat_sync(db, state_db, CHAT_ID, SRC, now=NOW + 30)
    assert snap["status"] == "healthy"
    assert "transcript-monitor" not in capsys.readouterr().err


def test_purge_chat_clears_monitor_health(db, state_db):
    _mint_marker(db, state_db)
    monitor.sweep_chat_sync(db, state_db, CHAT_ID, SRC, now=NOW)
    assert CHAT_ID in monitor._health
    linker.purge_chat_sync(db, CHAT_ID)
    assert CHAT_ID not in monitor._health


# ── Phase 5: orphan-adopt repair ──────────────────────────────────────


def test_adopt_dry_run_then_confirm_is_idempotent(db, state_db):
    """Adopt = the plugin-down recovery affordance: dry run SHOWS the
    would-adopt set without writing; confirm imports exactly the
    unlinked live set as legacy:<id> twins (the backfill's own
    representation); a second confirm adopts nothing."""
    _mint_marker(db, state_db)
    g1 = _add_msg(state_db, "user", "typed in terminal", BASE + 10.0)
    g2 = _add_msg(state_db, "assistant", "terminal reply", BASE + 11.0)
    dry = monitor.adopt_orphans_sync(db, state_db, CHAT_ID, SRC, now=NOW)
    assert dry["ok"] is True and dry["dry_run"] is True
    assert {c["id"] for c in dry["candidates"]} == {str(g1), str(g2)}
    assert dry["adopted"] == 0
    assert _link(db, f"legacy:{g1}") is None
    res = monitor.adopt_orphans_sync(
        db, state_db, CHAT_ID, SRC, confirm=True, now=NOW)
    assert res["ok"] is True and res["dry_run"] is False
    assert res["adopted"] == 2
    assert set(res["adopted_ids"]) == {str(g1), str(g2)}
    for rid in (g1, g2):
        assert str(_link(db, f"legacy:{rid}")["agent_row_id"]) == str(rid)
    again = monitor.adopt_orphans_sync(
        db, state_db, CHAT_ID, SRC, confirm=True, now=NOW)
    assert again["adopted"] == 0 and again["candidates"] == []
    # The adopted turn now serves on the v3 read and the chat is healthy.
    items = state.list_messages_for_chat_v3(db, state_db, CHAT_ID)["items"]
    contents = [it["content"] for it in items]
    assert "typed in terminal" in contents and "terminal reply" in contents
    assert monitor.sweep_chat_sync(
        db, state_db, CHAT_ID, SRC, now=NOW)["status"] == "healthy"


def test_adopt_excludes_never_adopt_classes(db, state_db):
    """Machinery, /undo'd rows, and in-grace rows are not candidates —
    adopting them would re-materialize what the read must hide."""
    _mint_marker(db, state_db)
    keeper = _add_msg(state_db, "assistant", "real orphan", BASE + 1.0)
    _add_msg(state_db, "assistant", "[PRIOR CONTEXT — for reference only]",
             BASE + 2.0)
    _add_msg(state_db, "user", "undone", BASE + 3.0, active=0)
    _add_msg(state_db, "assistant", "too fresh", NOW - 5.0)
    dry = monitor.adopt_orphans_sync(db, state_db, CHAT_ID, SRC, now=NOW)
    assert [c["id"] for c in dry["candidates"]] == [str(keeper)]


def test_adopt_refuses_unmarked_chat(db, state_db):
    """Unmarked chats belong to the legacy reconcile path — adopting
    there would race the backfill's own import."""
    _add_msg(state_db, "user", "legacy row", BASE)
    res = monitor.adopt_orphans_sync(
        db, state_db, CHAT_ID, SRC, confirm=True, now=NOW)
    assert res["ok"] is False and res["error"] == "chat_not_migrated"
    assert db.fetchone("SELECT 1 FROM msg_links LIMIT 1") is None


# ── Phase 4: offline repair entry point ───────────────────────────────


def test_repair_heals_synthetic_damaged_chat_end_to_end(db, state_db):
    """Reconcile survives as the OFFLINE repair tool: drop the marker,
    heal mislinks, force_full content reconcile, re-audit, re-mint."""
    u = _add_msg(state_db, "user", "hello", BASE)
    t = _add_msg(state_db, "tool", '{"ok": true}', BASE + 1.0,
                 tool_call_id="cR", tool_name="terminal")
    f = _add_msg(state_db, "assistant", "done", BASE + 2.0)
    first = _mint_marker(db, state_db)
    minted_at = db.fetchone(
        "SELECT migrated_at FROM chat_migrations WHERE chat_id = ?",
        (CHAT_ID,))["migrated_at"]
    # Synthetic damage: one twin deleted, one link severed.
    db.exec("DELETE FROM msg_links WHERE id = ?", (f"legacy:{t}",))
    db.exec("UPDATE msg_links SET agent_row_id = NULL WHERE id = ?",
            (f"legacy:{f}",))
    assert monitor.sweep_chat_sync(
        db, state_db, CHAT_ID, SRC, now=NOW)["status"] == "degraded"
    res = migration.repair_chat_sync(db, state_db, CHAT_ID, SRC)
    assert res["migrated"] is True and res["already"] is False
    assert str(_link(db, f"legacy:{t}")["agent_row_id"]) == str(t)
    assert str(_link(db, f"legacy:{f}")["agent_row_id"]) == str(f)
    assert db.fetchone(
        "SELECT migrated_at FROM chat_migrations WHERE chat_id = ?",
        (CHAT_ID,))["migrated_at"] > minted_at
    assert monitor.sweep_chat_sync(
        db, state_db, CHAT_ID, SRC, now=NOW + 60)["status"] == "healthy"
    assert first is not None and u is not None


# ── Phase 4 ↔ Phase 3 integration: v3 serves a linker-stamped turn ────


def test_v3_read_serves_linker_stamped_fresh_turn(db, state_db):
    """End-to-end without any reconcile: write-through bodies + linker
    stamp at close → the v3 read serves the turn under STATE ids
    (linked, liveness-aware), the orchestration twin included, and a
    subsequent /undo retracts through the stamped link."""
    _mint_marker(db, state_db)
    ids = _run_turn(db, state_db, 1, BASE)
    items = state.list_messages_for_chat_v3(db, state_db, CHAT_ID)["items"]
    by_sk = {it.get("sidekick_id"): it for it in items}
    assert by_sk["umsg_1"]["id"] == ids["user"]
    assert by_sk["tr:call_1"]["id"] == ids["tool"]
    assert by_sk["msg_1"]["id"] == ids["final"]
    assert by_sk[f"legacy:{ids['orch']}"]["id"] == ids["orch"]
    assert not any(str(s).startswith("tc:") for s in by_sk)
    # Liveness through the stamped link: /undo retracts the final.
    _mutate_state(state_db, "UPDATE messages SET active = 0 WHERE id = ?",
                  (ids["final"],))
    items = state.list_messages_for_chat_v3(db, state_db, CHAT_ID)["items"]
    assert ids["final"] not in {it["id"] for it in items}
    assert ids["user"] in {it["id"] for it in items}


# ── diagnostics surface + routes ──────────────────────────────────────


class _FakeRequest:
    def __init__(self, body=None, method="POST"):
        self._body = body or {}
        self.method = method

    async def json(self):
        return self._body


def _body(resp):
    return json.loads(resp.text)


def _ctx(db, state_db):
    return SimpleNamespace(db=db, dispatcher=None, state_db_path=state_db,
                           vapid_subject="mailto:test@example.com")


def test_push_health_route_carries_transcript_health(db, state_db):
    """The proxy folds /v1/push/health into its diagnostics response;
    transcript_health rides the same surface (push_health pattern)."""
    from ..sidekick_routes import handle_push_health
    monitor.sweep_chat_sync(db, state_db, CHAT_ID, SRC, now=NOW)  # unmarked → None
    _mint_marker(db, state_db)
    monitor.sweep_chat_sync(db, state_db, CHAT_ID, SRC, now=NOW)
    resp = asyncio.run(handle_push_health(_ctx(db, state_db),
                                          _FakeRequest(method="GET")))
    body = _body(resp)
    th = body["transcript_health"]
    assert th["status"] == "healthy"
    assert th["chats_swept"] == 1
    assert th["migrated_chats"] == 1
    assert "degraded" in th and "last_sweep_at" in th


def test_transcript_health_route(db, state_db):
    from ..sidekick_routes import handle_transcript_health
    resp = asyncio.run(handle_transcript_health(_ctx(db, state_db),
                                                _FakeRequest(method="GET")))
    assert resp.status == 200
    assert _body(resp)["transcript_health"]["status"] == "healthy"


def test_transcript_repair_route(db, state_db):
    from ..sidekick_routes import handle_transcript_repair
    _add_msg(state_db, "user", "legacy hello", BASE)
    resp = asyncio.run(handle_transcript_repair(
        _ctx(db, state_db), _FakeRequest({"chat_id": f"{SRC}:{CHAT_ID}"})))
    assert resp.status == 200
    body = _body(resp)
    assert body["ok"] is True and body["result"]["migrated"] is True
    assert migration.get_migration(db, CHAT_ID) is not None


def test_transcript_adopt_route_dry_run_confirm_and_refusal(db, state_db):
    from ..sidekick_routes import handle_transcript_adopt
    # Refusal first: unmarked chat → 409.
    resp = asyncio.run(handle_transcript_adopt(
        _ctx(db, state_db), _FakeRequest({"chat_id": CHAT_ID, "confirm": True})))
    assert resp.status == 409
    assert _body(resp)["error"] == "chat_not_migrated"
    _mint_marker(db, state_db)
    g1 = _add_msg(state_db, "user", "typed in terminal", BASE + 10.0)
    resp = asyncio.run(handle_transcript_adopt(
        _ctx(db, state_db), _FakeRequest({"chat_id": CHAT_ID})))
    body = _body(resp)
    assert resp.status == 200 and body["dry_run"] is True
    assert [c["id"] for c in body["candidates"]] == [str(g1)]
    assert _link(db, f"legacy:{g1}") is None
    resp = asyncio.run(handle_transcript_adopt(
        _ctx(db, state_db), _FakeRequest({"chat_id": CHAT_ID, "confirm": True})))
    body = _body(resp)
    assert body["adopted"] == 1
    assert str(_link(db, f"legacy:{g1}")["agent_row_id"]) == str(g1)
