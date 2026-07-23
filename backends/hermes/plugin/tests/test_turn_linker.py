"""Turn-end deterministic linker (transcript v3 Phase 1, dark launch).

Pins ``sidekick_turn_linker``'s pure classification core plus the
watermark open/close/barrier machinery against the field shapes that
killed v1/v2's content heuristics:

  * the 2026-07-15/16 compaction re-flush batches (old tool_call_ids
    re-appended in-window at one timestamp, plus the rotation-style
    replay where originals sit BEFORE the window),
  * /retry hard rewrites (whole chain deleted + reinserted mid-window),
  * interrupted turns closed by the next-turn-start barrier,
  * gateway-restart gaps (rows with no observing turn),
  * slash-command turns (gateway-intercepted, no user row persisted).

The state.db rig mirrors tests/test_reconcile_replay_dedup.py but adds
the ``active`` / ``compacted`` / ``platform_message_id`` columns the
live hermes 0.18 schema has — the linker snapshots ``active`` into the
observation flags (Phase 3 needs it).
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time

import pytest

from ..sidekick_db import SidekickDB
from .. import sidekick_state as state
from .. import sidekick_turn_linker as linker


CHAT_ID = "b3e11a02-linker-test"
SESSION = "20260720_000000_test"
SRC = "sidekick"


@pytest.fixture
def db(tmp_path):
    db = SidekickDB(tmp_path / "sidekick.db")
    yield db
    db.close()


@pytest.fixture
def state_db(tmp_path):
    """Fake hermes state.db — live 0.18 shape (active/compacted/
    platform_message_id present, unlike the older reconcile rig)."""
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


def _wipe_messages(state_db):
    conn = sqlite3.connect(str(state_db))
    conn.execute("DELETE FROM messages")
    conn.commit()
    conn.close()


def _obs(db, turn_id):
    return db.fetchone(
        "SELECT * FROM turn_observations WHERE chat_id = ? AND turn_id = ?",
        (CHAT_ID, turn_id),
    )


def _obs_flags(db, turn_id):
    row = _obs(db, turn_id)
    return json.loads(row["flags"] or "{}") if row else {}


def _claims(db, turn_id):
    """{agent_row_id: (msg_id, method)} for one turn."""
    rows = db.fetchall(
        "SELECT msg_id, agent_row_id, method FROM turn_links "
        "WHERE chat_id = ? AND turn_id = ?",
        (CHAT_ID, turn_id),
    )
    return {r["agent_row_id"]: (r["msg_id"], r["method"]) for r in rows}


def _snap(user_message_id="", user_text=None, final_message_id="", call_ids=()):
    return {
        "user_message_id": user_message_id,
        "user_text": user_text,
        "final_message_id": final_message_id,
        "call_ids": set(call_ids),
    }


def _orch(*call_ids):
    return json.dumps([
        {"id": cid, "function": {"name": "t", "arguments": "{}"}}
        for cid in call_ids
    ])


def _row(rid, role, content="", tool_call_id="", tool_calls="", active=1):
    return {
        "id": rid, "role": role, "content": content,
        "tool_call_id": tool_call_id, "tool_calls": tool_calls,
        "timestamp": 1000.0 + rid, "active": active,
    }


# ── enabled() kill switch ─────────────────────────────────────────────


def test_kill_switch(monkeypatch, db, state_db):
    monkeypatch.setenv("SIDEKICK_TURN_LINKER", "0")
    assert linker.enabled() is False

    class _Adapter:
        _sidekick_db = db
        _state_db_path = state_db
        _turn_buffer = None

    asyncio.run(linker.open_turn_watermark(_Adapter(), CHAT_ID, "umsg_x"))
    assert db.fetchone("SELECT 1 FROM turn_observations LIMIT 1") is None
    assert linker.compare_and_log(db, CHAT_ID) is None
    monkeypatch.setenv("SIDEKICK_TURN_LINKER", "1")
    assert linker.enabled() is True


# ── slash-command detection ───────────────────────────────────────────


def test_slash_command_detection():
    assert linker._is_slash_command_text("/status") is True
    assert linker._is_slash_command_text("  /status now") is True
    assert linker._is_slash_command_text("[voice] /status") is True
    assert linker._is_slash_command_text("hello there") is False
    assert linker._is_slash_command_text("") is False
    assert linker._is_slash_command_text(None) is False
    # Command-shaped only: a leading slash on non-command text (paths,
    # fractions) must NOT gate the user-row claim.
    assert linker._is_slash_command_text("/2+2=?") is False
    assert linker._is_slash_command_text("/tmp/foo is full") is False


# ── classify_window_rows (the pure core) ──────────────────────────────


def test_classify_normal_turn_with_content_diverged_final():
    """(1) user + orchestration + tool + final. The final's persisted
    content differs from the envelope (hermes post-persist explainer
    footer) — content equality is NOT required for the final claim."""
    rows = [
        _row(11, "user", "run the report"),
        _row(12, "assistant", "", tool_calls=_orch("call_a")),
        _row(13, "tool", '{"ok": true}', tool_call_id="call_a"),
        _row(14, "assistant", "Report done.\n\n---\nfooter added post-persist"),
    ]
    res = linker.classify_window_rows(
        rows,
        turn_call_ids={"call_a"},
        user_message_id="umsg_1",
        user_text="run the report",
        final_message_id="msg_f1",
    )
    by_id = {c["agent_row_id"]: c for c in res["claims"]}
    assert by_id["11"] == {"agent_row_id": "11", "msg_id": "umsg_1", "method": "user"}
    assert by_id["12"] == {"agent_row_id": "12", "msg_id": None, "method": "orchestration"}
    assert by_id["13"] == {"agent_row_id": "13", "msg_id": "tr:call_a", "method": "tool_call_id"}
    assert by_id["14"] == {"agent_row_id": "14", "msg_id": "msg_f1", "method": "final"}
    assert res["unclaimed"] == {}
    assert "final_no_row" not in res["flags"]


def test_classify_tool_heavy_turn_live_shape():
    """(2) mirrors live rows 77661-77671: interleaved orchestration/tool
    rows, one orchestration with FOUR parallel calls, ending in a plain
    final. Orchestration rows claim with msg_id=NULL."""
    calls = ["c1", "c2", "c3", "c4", "c5", "c6"]
    rows = [
        _row(61, "user", "Say more about the safety of diesel and coolant."),
        _row(62, "assistant", "", tool_calls=_orch("c1")),
        _row(63, "tool", "skill loaded", tool_call_id="c1"),
        _row(64, "assistant", "", tool_calls=_orch("c2", "c3", "c4", "c5")),
        _row(65, "tool", "search 1", tool_call_id="c2"),
        _row(66, "tool", "search 2", tool_call_id="c3"),
        _row(67, "tool", "search 3", tool_call_id="c4"),
        _row(68, "tool", "search 4", tool_call_id="c5"),
        _row(69, "assistant", "", tool_calls=_orch("c6")),
        _row(70, "tool", "extract", tool_call_id="c6"),
        _row(71, "assistant", "**Spitting immediately makes the risk much lower**"),
    ]
    res = linker.classify_window_rows(
        rows,
        turn_call_ids=set(calls),
        user_message_id="umsg_2",
        user_text="Say more about the safety of diesel and coolant.",
        final_message_id="msg_f2",
    )
    by_id = {c["agent_row_id"]: c for c in res["claims"]}
    assert len(by_id) == 11 and res["unclaimed"] == {}
    for rid, cid in (("63", "c1"), ("65", "c2"), ("66", "c3"),
                     ("67", "c4"), ("68", "c5"), ("70", "c6")):
        assert by_id[rid] == {
            "agent_row_id": rid, "msg_id": f"tr:{cid}", "method": "tool_call_id",
        }
    for rid in ("62", "64", "69"):
        assert by_id[rid]["msg_id"] is None
        assert by_id[rid]["method"] == "orchestration"
    assert by_id["71"]["msg_id"] == "msg_f2"


def test_classify_history_rewrite_claims_only_final_and_own_tools():
    """(4) /retry hard rewrite: every chain row was deleted + reinserted
    mid-window (pre-window chain count SHRANK), so the window holds the
    whole reinserted history plus the new turn. Only the turn's own
    tool/orchestration rows and the final may be claimed — NEVER a user
    row (the single-user-row heuristic would grab a reinserted copy)."""
    rows = [
        # Reinserted history (new ids, old identities).
        _row(101, "user", "old prompt one"),
        _row(102, "assistant", "old reply one"),
        _row(103, "assistant", "", tool_calls=_orch("old_call")),
        _row(104, "tool", "old result", tool_call_id="old_call"),
        # The retried turn's own rows.
        _row(105, "user", "retry this please"),
        _row(106, "assistant", "", tool_calls=_orch("new_call")),
        _row(107, "tool", "new result", tool_call_id="new_call"),
        _row(108, "assistant", "fresh final"),
    ]
    res = linker.classify_window_rows(
        rows,
        turn_call_ids={"new_call"},
        user_message_id="umsg_retry",
        user_text="retry this please",
        final_message_id="msg_retry",
        count_at_open=6,             # chain rows at open…
        chain_count_at_open_now=0,   # …all gone at close → rewrite.
    )
    assert "history_rewrite" in res["flags"]
    by_id = {c["agent_row_id"]: c for c in res["claims"]}
    # Own tool + orchestration + final claimed.
    assert by_id["107"]["msg_id"] == "tr:new_call"
    assert by_id["106"]["method"] == "orchestration"
    assert by_id["108"] == {
        "agent_row_id": "108", "msg_id": "msg_retry", "method": "final",
    }
    # NO user row claimed; foreign tool/orchestration unclaimed.
    assert not any(c["method"] == "user" for c in res["claims"])
    assert res["unclaimed"]["101"] == "history_rewrite"
    assert res["unclaimed"]["105"] == "history_rewrite"
    assert res["unclaimed"]["104"] == "foreign_tool"
    assert res["unclaimed"]["103"] == "foreign_orchestration"
    assert res["unclaimed"]["102"] == "intermediate_assistant"


def test_classify_compaction_reflush_batch_never_claimed():
    """(5) hermes 0.18 compaction re-flush lands IN-WINDOW: originals
    soft-deleted (active=0), a machinery seed row, then tail copies
    carrying OLD tool_call_ids all at one flush timestamp. Nothing from
    the batch may be claimed; the turn's own rows still claim. The own
    user row goes UNCLAIMED here (replayed user copies make it
    ambiguous — rule 4 claims none rather than guess) with the
    ambiguous_user flag."""
    rows = [
        # Own turn rows.
        _row(201, "user", "compact then answer"),
        _row(202, "assistant", "", tool_calls=_orch("own_call")),
        _row(203, "tool", "own result", tool_call_id="own_call"),
        # The re-flush batch (one flush timestamp, old call ids).
        _row(204, "assistant", "[PRIOR CONTEXT — for reference only]"),
        _row(205, "user", "an earlier prompt"),
        _row(206, "assistant", "", tool_calls=_orch("stale_call")),
        _row(207, "tool", "stale summarized result", tool_call_id="stale_call"),
        _row(208, "assistant", "an earlier reply"),
        # Own final lands after the flush.
        _row(209, "assistant", "the actual fresh answer"),
    ]
    res = linker.classify_window_rows(
        rows,
        turn_call_ids={"own_call"},
        user_message_id="umsg_cmp",
        user_text="compact then answer",
        final_message_id="msg_cmp",
    )
    assert "compaction_flush" in res["flags"]
    by_id = {c["agent_row_id"]: c for c in res["claims"]}
    assert by_id["203"]["msg_id"] == "tr:own_call"
    assert by_id["202"]["method"] == "orchestration"
    assert by_id["209"] == {
        "agent_row_id": "209", "msg_id": "msg_cmp", "method": "final",
    }
    # Nothing from the batch claimed.
    batch = {"204", "205", "206", "207", "208"}
    assert not (set(by_id) & batch)
    assert res["unclaimed"]["207"] == "foreign_tool"
    assert res["unclaimed"]["206"] == "foreign_orchestration"
    assert res["unclaimed"]["208"] == "intermediate_assistant"
    # Two user rows in-window → ambiguous, claim NONE (not even own).
    assert "ambiguous_user" in res["flags"]
    assert not any(c["method"] == "user" for c in res["claims"])
    assert "201" in res["unclaimed"] and "205" in res["unclaimed"]
    assert "204" in res["machinery_ids"]


def test_classify_rotation_style_replay_07_15_shape():
    """(5b) the 07-15 incident shape: the replay batch is verbatim
    copies of rows whose ORIGINALS sit before the window (already
    linked in msg_links) — in-window we see only the copies, with old
    tool_call_ids and one user copy alongside the turn's own user."""
    rows = [
        _row(301, "user", "did this turn die?"),           # own user
        # replay copies of an earlier turn:
        _row(302, "user", "can you delete pls?"),
        _row(303, "assistant", "", tool_calls=_orch("call_46T4")),
        _row(304, "tool", "[terminal] ran rm", tool_call_id="call_46T4"),
        _row(305, "assistant", "Deleted and verified. 🧹"),
        # own final:
        _row(306, "assistant", "No—sorry, it got bogged down."),
    ]
    res = linker.classify_window_rows(
        rows,
        turn_call_ids=set(),          # own turn ran no tools
        user_message_id="umsg_died",
        user_text="did this turn die?",
        final_message_id="msg_sorry",
    )
    by_id = {c["agent_row_id"]: c for c in res["claims"]}
    assert res["unclaimed"]["304"] == "foreign_tool"
    assert res["unclaimed"]["303"] == "foreign_orchestration"
    assert res["unclaimed"]["305"] == "intermediate_assistant"
    assert by_id["306"]["msg_id"] == "msg_sorry"
    assert "ambiguous_user" in res["flags"]
    assert not any(c["method"] == "user" for c in res["claims"])


def test_classify_slash_command_turn():
    """(8) gateway-intercepted slash command: no user row persists.
    Zero user rows is NOT ambiguous — and if a foreign user row IS in
    the window, the command gate must refuse to claim it."""
    res = linker.classify_window_rows(
        [],
        turn_call_ids=set(),
        user_message_id="umsg_slash",
        user_text="/status",
        final_message_id=None,
    )
    assert res["claims"] == [] and res["unclaimed"] == {}
    assert "ambiguous_user" not in res["flags"]
    assert res["user_is_command"] is True

    # One (foreign) user row in a command window → still no user claim.
    res2 = linker.classify_window_rows(
        [_row(401, "user", "a replayed stray row")],
        turn_call_ids=set(),
        user_message_id="umsg_slash2",
        user_text="/status",
        final_message_id=None,
    )
    assert not any(c["method"] == "user" for c in res2["claims"])
    assert res2["unclaimed"]["401"] == "command_turn"


def test_classify_prelinked_rows_excluded():
    """Rule 1: rows already linked in msg_links (mid-turn notification
    persistence) are excluded from claims AND from unclaimed leftovers,
    and reported for the comparison to skip."""
    rows = [
        _row(501, "user", "hi"),
        _row(502, "assistant", "a mid-turn notification body"),
        _row(503, "assistant", "final"),
    ]
    res = linker.classify_window_rows(
        rows,
        user_message_id="umsg_p", user_text="hi",
        final_message_id="msg_p",
        already_linked_ids={"502"},
    )
    by_id = {c["agent_row_id"]: c for c in res["claims"]}
    assert set(by_id) == {"501", "503"}
    assert by_id["503"]["method"] == "final"
    assert res["prelinked_ids"] == ["502"]
    assert "502" not in res["unclaimed"]


def test_classify_snapshots_inactive_rows():
    """The window's active=0 rows are surfaced (Phase 3 needs the soft-
    delete signal) whether or not they end up claimed."""
    rows = [
        _row(601, "user", "q", active=0),
        _row(602, "assistant", "final", active=1),
    ]
    res = linker.classify_window_rows(
        rows, user_message_id="umsg_a", user_text="q",
        final_message_id="msg_a",
    )
    assert res["inactive_ids"] == ["601"]


# ── watermark open / close / barrier (sync internals + shadow tables) ─


def test_open_close_normal_turn(db, state_db):
    """(1, integration) open → rows land → reply_final close. Claims in
    turn_links only (msg_links untouched — dark launch), observation
    closed with counts + active snapshot in flags."""
    pre = _add_msg(state_db, "user", "earlier turn", 100.0)  # pre-window
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_n1", user_text="do it")
    o = _obs(db, "umsg_n1")
    assert o["status"] == "open"
    assert o["hwm_open"] == pre and o["count_at_open"] == 1

    u = _add_msg(state_db, "user", "do it", 200.0)
    a = _add_msg(state_db, "assistant", "", 201.0, tool_calls=_orch("cX"))
    t = _add_msg(state_db, "tool", "res", 202.0, tool_call_id="cX",
                 tool_name="terminal")
    f = _add_msg(state_db, "assistant", "done + post-persist footer", 203.0,
                 active=0)  # exercise the active snapshot end-to-end

    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_n1"},
        entry_snapshot=_snap("umsg_n1", "do it", "msg_n1", {"cX"}),
    )
    o = _obs(db, "umsg_n1")
    assert o["status"] == "closed"
    assert o["hwm_close"] == f
    assert o["row_count"] == 4 and o["claimed"] == 4 and o["unclaimed"] == 0
    claims = _claims(db, "umsg_n1")
    assert claims[str(u)] == ("umsg_n1", "user")
    assert claims[str(a)] == (None, "orchestration")
    assert claims[str(t)] == ("tr:cX", "tool_call_id")
    assert claims[str(f)] == ("msg_n1", "final")
    assert _obs_flags(db, "umsg_n1").get("inactive_ids") == [str(f)]
    # DARK LAUNCH: the linker must never write msg_links.
    assert db.fetchone("SELECT 1 FROM msg_links LIMIT 1") is None


def test_interrupted_turn_closed_by_barrier(db, state_db):
    """(3) no reply_final ever arrives; the NEXT turn's open flushes the
    stale window as aborted — tools still claimed, no final claim, and
    the next turn's user row is NOT mis-claimed into the old window."""
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_i1", user_text="long job")
    u1 = _add_msg(state_db, "user", "long job", 100.0)
    a1 = _add_msg(state_db, "assistant", "", 101.0, tool_calls=_orch("cI"))
    t1 = _add_msg(state_db, "tool", "partial", 102.0, tool_call_id="cI")
    # interrupt — next turn opens; the stale TurnEntry is still live in
    # the buffer at that point, so its snapshot reaches the flush.
    linker._open_sync(
        db, state_db, CHAT_ID, SRC, "umsg_i2", user_text="try again",
        entry_snapshot=_snap("umsg_i1", "long job", "", {"cI"}),
    )
    o1 = _obs(db, "umsg_i1")
    assert o1["status"] == "aborted"
    claims1 = _claims(db, "umsg_i1")
    assert claims1[str(t1)] == ("tr:cI", "tool_call_id")
    assert claims1[str(a1)] == (None, "orchestration")
    assert claims1[str(u1)] == ("umsg_i1", "user")
    assert not any(m == "final" for (_mid, m) in claims1.values())

    # Second turn proceeds normally — its rows land AFTER the barrier.
    u2 = _add_msg(state_db, "user", "try again", 200.0)
    f2 = _add_msg(state_db, "assistant", "ok done", 201.0)
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_i2"},
        entry_snapshot=_snap("umsg_i2", "try again", "msg_i2"),
    )
    claims2 = _claims(db, "umsg_i2")
    assert claims2[str(u2)] == ("umsg_i2", "user")
    assert claims2[str(f2)] == ("msg_i2", "final")
    assert str(u2) not in claims1


def test_retry_rewrite_detected_via_chain_count(db, state_db):
    """(4, integration) mid-window /retry deletes + reinserts the whole
    chain: pre-window count shrinks below count_at_open → the close
    flags history_rewrite and refuses the user claim."""
    for i in range(4):
        _add_msg(state_db, "user" if i % 2 == 0 else "assistant",
                 f"history {i}", 100.0 + i)
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_r1", user_text="redo")
    assert _obs(db, "umsg_r1")["count_at_open"] == 4
    _wipe_messages(state_db)  # /retry rewrote the session…
    for i in range(4):        # …reinserting history at NEW ids…
        _add_msg(state_db, "user" if i % 2 == 0 else "assistant",
                 f"history {i}", 100.0 + i)
    ru = _add_msg(state_db, "user", "redo", 300.0)      # …plus the new turn.
    rf = _add_msg(state_db, "assistant", "redone", 301.0)
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_r1"},
        entry_snapshot=_snap("umsg_r1", "redo", "msg_r1"),
    )
    o = _obs(db, "umsg_r1")
    assert o["status"] == "closed"
    assert "history_rewrite" in _obs_flags(db, "umsg_r1").get("flags", [])
    claims = _claims(db, "umsg_r1")
    assert claims[str(rf)] == ("msg_r1", "final")
    assert str(ru) not in claims  # never the user row in a rewrite
    assert not any(m == "user" for (_mid, m) in claims.values())


def test_gateway_restart_gap_recorded_unobserved(db, state_db):
    """(6) rows appended with no observing turn (plugin down / terminal
    use) become ONE unobserved observation with the gap bounds and zero
    claims."""
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_g1", user_text="hi")
    u = _add_msg(state_db, "user", "hi", 100.0)
    f = _add_msg(state_db, "assistant", "hello", 101.0)
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_g1"},
        entry_snapshot=_snap("umsg_g1", "hi", "msg_g1"),
    )
    # Plugin goes down; terminal appends rows.
    g1 = _add_msg(state_db, "user", "typed in terminal", 200.0)
    g2 = _add_msg(state_db, "assistant", "terminal reply", 201.0)
    # Plugin back; next PWA turn opens.
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_g2", user_text="back")
    gap_id = f"gap:{f}-{g2}"
    o = _obs(db, gap_id)
    assert o is not None and o["status"] == "unobserved"
    assert o["hwm_open"] == f and o["hwm_close"] == g2
    assert o["row_count"] == 2 and o["claimed"] == 0
    assert _claims(db, gap_id) == {}
    # The fresh window starts after the gap.
    assert _obs(db, "umsg_g2")["hwm_open"] == g2
    assert str(g1) not in _claims(db, "umsg_g2")


def test_background_notification_window(db, state_db):
    """(7 of plan §3/§4) a notification with no open window synthesizes
    a background window over (last hwm, now]; the notification's own
    row is pre-excluded (already linked by _persist_notification);
    other background rows stay unclaimed; status='background'."""
    base = _add_msg(state_db, "user", "seed", 50.0)
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_b0", user_text="seed")
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_b0"},
        entry_snapshot=_snap("umsg_b0", "seed", "msg_b0"),
    )
    # Background cron turn: agent rows + the persisted notification row.
    bg_a = _add_msg(state_db, "assistant", "cron working", 300.0)
    notif = _add_msg(state_db, "assistant", "cron says hi", 301.0)
    state.record_envelope(db, {
        "type": "notification", "chat_id": CHAT_ID,
        "sidekick_id": "notif_1784900000000_abc",
        "content": "cron says hi", "kind": "cron",
        "agent_row_id": str(notif),
    })
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "notification", "sidekick_id": "notif_1784900000000_abc",
         "chat_id": CHAT_ID, "content": "cron says hi"},
    )
    o = _obs(db, "notif_1784900000000_abc")
    assert o is not None and o["status"] == "background"
    assert o["hwm_open"] == base and o["hwm_close"] == notif
    # Nothing claimed; the notif row was pre-excluded, the stray
    # assistant row stays unclaimed (background windows never guess).
    assert _claims(db, "notif_1784900000000_abc") == {}
    flags = _obs_flags(db, "notif_1784900000000_abc")
    assert flags.get("prelinked_ids") == [str(notif)]
    assert flags.get("unclaimed", {}).get(str(bg_a)) == "background"


def test_notification_during_open_window_is_noop(db, state_db):
    """A mid-turn notification must NOT steal the open window — its row
    is mid-turn-linked and will be pre-excluded at the window's close."""
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_m1", user_text="go")
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "notification", "sidekick_id": "notif_mid", "chat_id": CHAT_ID},
    )
    assert _obs(db, "umsg_m1")["status"] == "open"
    assert _obs(db, "notif_mid") is None


def test_slash_command_turn_integration(db, state_db):
    """(8, integration) /status turn: cmd flag persisted at open, zero
    rows land, close records a clean empty window without
    ambiguous_user."""
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_s1", user_text="/status")
    assert _obs_flags(db, "umsg_s1").get("cmd") is True
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_s1"},
        entry_snapshot=_snap("umsg_s1", "/status", "msg_s1"),
    )
    o = _obs(db, "umsg_s1")
    assert o["status"] == "closed" and o["claimed"] == 0
    assert "ambiguous_user" not in _obs_flags(db, "umsg_s1").get("flags", [])


# ── dark-launch comparison ────────────────────────────────────────────


def _seed_compared_turn(db, state_db, *, reconcile_agrees: bool):
    """One closed observed turn with a user + final claim, then seed
    msg_links with reconcile's (agreeing or diverging) opinion."""
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_c1", user_text="hi")
    u = _add_msg(state_db, "user", "hi", 100.0)
    f = _add_msg(state_db, "assistant", "hello there", 101.0)
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_c1"},
        entry_snapshot=_snap("umsg_c1", "hi", "msg_c1"),
    )
    # A later replay copy of the final, OUTSIDE the observed window —
    # the shape reconcile's content matching can mis-target.
    stray = _add_msg(state_db, "assistant", "hello there", 102.0)
    state.upsert_msg_link(db, id="umsg_c1", chat_id=CHAT_ID, role="user",
                          content="hi", agent_row_id=str(u))
    state.upsert_msg_link(
        db, id="msg_c1", chat_id=CHAT_ID, role="assistant",
        content="hello there",
        agent_row_id=str(f) if reconcile_agrees else str(stray),
    )
    return u, f, stray


def test_compare_and_log_agreement(db, state_db, capsys):
    _seed_compared_turn(db, state_db, reconcile_agrees=True)
    counts = linker.compare_and_log(db, CHAT_ID, state_db_path=state_db)
    assert counts == {
        "turns": 1, "agree": 2, "diverge": 0,
        "linker_only": 0, "reconcile_only": 0, "gap_rows": 0,
    }
    # Clean lines ride the perf-trace stderr channel — the gateway's
    # stdlib handler drops sub-WARNING records, so logger.info soak
    # lines never reached journalctl (field 2026-07-20).
    err = capsys.readouterr().err
    assert "linker-soak" in err and "diverge=0" in err
    # High-water mark: nothing new → silent (no per-poll spam).
    assert linker.compare_and_log(db, CHAT_ID, state_db_path=state_db) is None
    assert "linker-soak" not in capsys.readouterr().err


def test_compare_and_log_divergence_detail(db, state_db, caplog):
    """(7) reconcile linked the final envelope to a DIFFERENT state row
    (a same-content replay copy outside the window): one warning line
    with diverge=1, the detail triple, and content_equal=True."""
    u, f, stray = _seed_compared_turn(db, state_db, reconcile_agrees=False)
    with caplog.at_level(logging.INFO, logger=linker.logger.name):
        counts = linker.compare_and_log(db, CHAT_ID, state_db_path=state_db)
    assert counts["diverge"] == 1 and counts["agree"] == 1
    assert "diverge=1" in caplog.text
    assert f"linker={f} reconcile={stray}" in caplog.text
    assert "content_equal=True" in caplog.text


def test_compare_orchestration_legacy_twin_agreement(db, state_db):
    """msg_id=NULL (orchestration) claims agree iff reconcile minted the
    legacy:<agent_row_id> twin; absent twin counts linker_only."""
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_o1", user_text="go")
    u = _add_msg(state_db, "user", "go", 99.5)
    a = _add_msg(state_db, "assistant", "", 100.0, tool_calls=_orch("cO"))
    t = _add_msg(state_db, "tool", "r", 101.0, tool_call_id="cO")
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_o1"},
        entry_snapshot=_snap("umsg_o1", "go", "msg_o1", {"cO"}),
    )
    # Reconcile's world: legacy twin for the orchestration row, and the
    # tr: envelope linked to the tool row.
    state.upsert_msg_link(db, id=f"legacy:{a}", chat_id=CHAT_ID,
                          role="assistant", content="", agent_row_id=str(a))
    state.upsert_msg_link(db, id="tr:cO", chat_id=CHAT_ID, role="tool",
                          content="r", agent_row_id=str(t))
    counts = linker.compare_and_log(db, CHAT_ID, state_db_path=state_db)
    assert counts["agree"] == 2
    assert counts["diverge"] == 0 and counts["reconcile_only"] == 0
    # linker_only when reconcile has no opinion yet.
    assert counts["linker_only"] == 1  # the user claim: umsg_o1 not in msg_links


def test_compare_sweep_skips_gap_windows_emits_gap_rows(db, state_db, capsys):
    """v3 soak forensics: 'unobserved' gap windows claim nothing by
    design, so counting reconcile's links inside them as reconcile_only
    manufactured divergence noise (the large counters were compare-side
    artifacts). Gap windows must be skipped from the opinion counters
    and reported as raw linked-row volume (gap_rows)."""
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_gr1", user_text="hi")
    u = _add_msg(state_db, "user", "hi", 100.0)
    f = _add_msg(state_db, "assistant", "hello there", 101.0)
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_gr1"},
        entry_snapshot=_snap("umsg_gr1", "hi", "msg_gr1"),
    )
    state.upsert_msg_link(db, id="umsg_gr1", chat_id=CHAT_ID, role="user",
                          content="hi", agent_row_id=str(u))
    state.upsert_msg_link(db, id="msg_gr1", chat_id=CHAT_ID, role="assistant",
                          content="hello there", agent_row_id=str(f))
    # Plugin down: two rows land unobserved; reconcile links them.
    g1 = _add_msg(state_db, "user", "typed in terminal", 200.0)
    g2 = _add_msg(state_db, "assistant", "terminal reply", 201.0)
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_gr2", user_text="back")
    state.upsert_msg_link(db, id=f"legacy:{g1}", chat_id=CHAT_ID, role="user",
                          content="typed in terminal", agent_row_id=str(g1))
    state.upsert_msg_link(db, id=f"legacy:{g2}", chat_id=CHAT_ID,
                          role="assistant", content="terminal reply",
                          agent_row_id=str(g2))
    counts = linker.compare_and_log(db, CHAT_ID, state_db_path=state_db)
    assert counts["agree"] == 2 and counts["diverge"] == 0
    assert counts["reconcile_only"] == 0, \
        "gap-window links are volume, not divergence"
    assert counts["gap_rows"] == 2
    err = capsys.readouterr().err
    assert "gap_rows=2" in err


def test_compare_sweep_skips_background_windows(db, state_db):
    """'background' windows claim nothing beyond rule-1 pre-exclusions;
    reconcile's links inside them count as gap_rows, never
    reconcile_only. The prelinked notification row counts as neither."""
    base = _add_msg(state_db, "user", "seed", 50.0)
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_bg0", user_text="seed")
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_bg0"},
        entry_snapshot=_snap("umsg_bg0", "seed", "msg_bg0"),
    )
    counts0 = linker.compare_and_log(db, CHAT_ID, state_db_path=state_db)
    assert counts0 is not None  # drain the seed turn from the sweep
    bg_a = _add_msg(state_db, "assistant", "cron working", 300.0)
    notif = _add_msg(state_db, "assistant", "cron says hi", 301.0)
    state.record_envelope(db, {
        "type": "notification", "chat_id": CHAT_ID,
        "sidekick_id": "notif_1784900000001_bg",
        "content": "cron says hi", "kind": "cron",
        "agent_row_id": str(notif),
    })
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "notification", "sidekick_id": "notif_1784900000001_bg",
         "chat_id": CHAT_ID, "content": "cron says hi"},
    )
    # Reconcile linked the stray background row too.
    state.upsert_msg_link(db, id=f"legacy:{bg_a}", chat_id=CHAT_ID,
                          role="assistant", content="cron working",
                          agent_row_id=str(bg_a))
    counts = linker.compare_and_log(db, CHAT_ID, state_db_path=state_db)
    assert counts["reconcile_only"] == 0
    assert counts["gap_rows"] == 1  # bg_a only; notif was prelinked
    assert base is not None


def test_compare_excludes_session_meta_rows(db, state_db):
    """state.db session_meta rows are hermes machinery: the linker
    leaves them unclaimed (unrecognized_role) while reconcile links a
    legacy: twin — that structural disagreement must not count as
    reconcile_only. Compare-side skip (not classify-side machinery)
    because reconcile keeps linking them regardless."""
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_sm1", user_text="hi")
    u = _add_msg(state_db, "user", "hi", 100.0)
    meta = _add_msg(state_db, "session_meta", '{"model": "opus"}', 100.5)
    f = _add_msg(state_db, "assistant", "hello", 101.0)
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_sm1"},
        entry_snapshot=_snap("umsg_sm1", "hi", "msg_sm1"),
    )
    state.upsert_msg_link(db, id="umsg_sm1", chat_id=CHAT_ID, role="user",
                          content="hi", agent_row_id=str(u))
    state.upsert_msg_link(db, id="msg_sm1", chat_id=CHAT_ID, role="assistant",
                          content="hello", agent_row_id=str(f))
    state.upsert_msg_link(db, id=f"legacy:{meta}", chat_id=CHAT_ID,
                          role="session_meta", content='{"model": "opus"}',
                          agent_row_id=str(meta))
    counts = linker.compare_and_log(db, CHAT_ID, state_db_path=state_db)
    assert counts["agree"] == 2
    assert counts["reconcile_only"] == 0, \
        "session_meta machinery must not count as reconcile_only"


def test_divergence_logged_once_with_counts_on_perf_trace_only(
    db, state_db, capsys, caplog,
):
    """The full-count soak line must appear exactly once (the
    aggregation-canonical [perf-trace INFO] stderr line); the WARNING is
    a distinct linker-soak-diverge alert without the counts, so grep
    aggregations never double-count a divergent chat."""
    _seed_compared_turn(db, state_db, reconcile_agrees=False)
    with caplog.at_level(logging.WARNING, logger=linker.logger.name):
        counts = linker.compare_and_log(db, CHAT_ID, state_db_path=state_db)
    assert counts["diverge"] == 1
    err = capsys.readouterr().err
    assert "linker-soak chat=" in err and "agree=" in err
    assert len(caplog.records) == 1
    assert "linker-soak-diverge" in caplog.text
    assert "agree=" not in caplog.text, \
        "WARNING must not duplicate the full-count aggregation line"
    assert "first_diverge=" in caplog.text


def test_gap_window_compaction_flag(db, state_db):
    """(Phase-2 gate) organic compactions land in unobserved gap
    windows in the field — the gap observation must carry the
    compaction_flush flag (+ inactive count) so the linker has live
    compaction coverage."""
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_gc1", user_text="hi")
    _add_msg(state_db, "user", "hi", 100.0)
    f = _add_msg(state_db, "assistant", "hello", 101.0)
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_gc1"},
        entry_snapshot=_snap("umsg_gc1", "hi", "msg_gc1"),
    )
    # Organic compaction while unobserved: machinery seed + a
    # deactivated replay copy land in the gap.
    _add_msg(state_db, "assistant",
             "[CONTEXT COMPACTION — REFERENCE ONLY] earlier turns", 200.0)
    d = _add_msg(state_db, "assistant", "replayed copy", 200.0, active=0)
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_gc2", user_text="next")
    gap_id = f"gap:{f}-{d}"
    o = _obs(db, gap_id)
    assert o is not None and o["status"] == "unobserved"
    flags = _obs_flags(db, gap_id)
    assert "compaction_flush" in flags.get("flags", []), \
        "gap windows must detect compaction machinery rows"
    assert flags.get("inactive") == 1
    # A machinery-free gap stays unflagged.
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_gc2"},
        entry_snapshot=_snap("umsg_gc2", "next", "msg_gc2"),
    )
    _add_msg(state_db, "user", "typed in terminal", 300.0)
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_gc3", user_text="more")
    plain_gaps = db.fetchall(
        "SELECT flags FROM turn_observations "
        "WHERE chat_id = ? AND status = 'unobserved' AND turn_id != ?",
        (CHAT_ID, gap_id),
    )
    assert len(plain_gaps) == 1
    plain_flags = json.loads(plain_gaps[0]["flags"] or "{}")
    assert "compaction_flush" not in plain_flags.get("flags", [])


def test_delete_conversation_purges_turn_tables(db, state_db, monkeypatch):
    """Chat delete must cascade to the linker's shadow tables — without
    it, deleted chats leave orphan observations/claims that the compare
    sweep keeps judging against an empty session chain."""
    from ..sidekick_route_conversations import delete_conversation_sync

    monkeypatch.delenv("HINDSIGHT_URL", raising=False)
    monkeypatch.delenv("SIDEKICK_HINDSIGHT_URL", raising=False)
    linker._open_sync(db, state_db, CHAT_ID, SRC, "umsg_d1", user_text="hi")
    _add_msg(state_db, "user", "hi", 100.0)
    _add_msg(state_db, "assistant", "bye", 101.0)
    linker._close_sync(
        db, state_db, CHAT_ID, SRC,
        {"type": "reply_final", "message_id": "msg_d1"},
        entry_snapshot=_snap("umsg_d1", "hi", "msg_d1"),
    )
    assert db.fetchone(
        "SELECT 1 FROM turn_links WHERE chat_id = ?", (CHAT_ID,)) is not None
    linker._compare_hwm[CHAT_ID] = 123.0

    class _Adapter:
        _sidekick_db = db
        _state_db_path = state_db

    assert delete_conversation_sync(_Adapter(), CHAT_ID, SRC) == "ok"
    assert db.fetchone(
        "SELECT 1 FROM turn_links WHERE chat_id = ?", (CHAT_ID,)) is None
    assert db.fetchone(
        "SELECT 1 FROM turn_observations WHERE chat_id = ?", (CHAT_ID,)) is None
    assert CHAT_ID not in linker._compare_hwm


# ── async wiring sanity ───────────────────────────────────────────────


class _FakeAdapter:
    def __init__(self, db, state_db):
        self._sidekick_db = db
        self._state_db_path = state_db
        from ..sidekick_turn_buffer import TurnBuffer
        self._turn_buffer = TurnBuffer()


def test_async_wiring_full_turn(db, state_db):
    """Public coroutine surface end-to-end: open (barrier + watermark) →
    envelopes observed via the real TurnBuffer (call_ids +
    final_message_id additive fields) → schedule-style close."""
    adapter = _FakeAdapter(db, state_db)
    row_ids = {}

    async def flow():
        await linker.open_turn_watermark(
            adapter, CHAT_ID, "umsg_w1", user_text="wire it",
        )
        adapter._turn_buffer.open_turn(
            chat_id=CHAT_ID, user_message="wire it", user_message_id="umsg_w1",
        )
        # Dispatch happens after the watermark: rows land in-window.
        row_ids["u"] = _add_msg(state_db, "user", "wire it", 100.0)
        row_ids["t"] = _add_msg(state_db, "tool", "res", 101.0, tool_call_id="cW")
        row_ids["f"] = _add_msg(state_db, "assistant", "wired", 102.0)
        adapter._turn_buffer.observe_envelope({
            "type": "tool_call", "chat_id": CHAT_ID, "call_id": "cW",
            "tool_name": "terminal", "args": {},
        })
        adapter._turn_buffer.observe_envelope({
            "type": "reply_final", "chat_id": CHAT_ID, "message_id": "msg_w1",
        })
        entry = adapter._turn_buffer.close_turn(CHAT_ID)
        assert entry.call_ids == {"cW"}
        assert entry.final_message_id == "msg_w1"
        await linker.close_turn_and_link(
            adapter, CHAT_ID,
            {"type": "reply_final", "chat_id": CHAT_ID, "message_id": "msg_w1"},
            turn_entry=entry,
        )

    asyncio.run(flow())
    o = _obs(db, "umsg_w1")
    assert o is not None and o["status"] == "closed"
    claims = _claims(db, "umsg_w1")
    assert claims[str(row_ids["u"])] == ("umsg_w1", "user")
    assert claims[str(row_ids["t"])] == ("tr:cW", "tool_call_id")
    assert claims[str(row_ids["f"])] == ("msg_w1", "final")
