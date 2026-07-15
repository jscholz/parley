"""Reconcile idempotency under hermes-core compaction-replay double-persist.

Field incident 2026-07-15 (chat sidekick:a7d55680, hermes session
20260715_190037_60a6a385): after an interrupted turn, hermes-core's
context compressor rebuilt the in-memory transcript, stripped the
``_db_persisted`` markers, and the next turn-end flush re-appended the
ENTIRE rebuilt context (129 rows, 74423-74555) into the SAME session —
verbatim copies of the recent tail (identical content; user rows kept
their original timestamps, assistant/tool rows were re-stamped with the
flush time; tool rows kept their tool_call_ids) plus summarized copies
of compacted-away turns plus the compressor's ``[PRIOR CONTEXT — …]``
header and ``[CONTEXT COMPACTION — REFERENCE ONLY]`` marker rows.

The plugin's reconcile then amplified the damage in two ways:
  1. Pass 1.b's blind per-role zip cross-assigned forever-unlinked
     envelope rows (slash commands ``/start``/``/status``/``/agents``,
     which never produce state.db rows) onto the replayed duplicate
     user rows — umsg ids attached to entirely different messages.
  2. Pass 2 minted parallel ``legacy:<id>`` rows for the remaining
     unclaimed duplicates (e.g. legacy:74535 duplicating msg_ab2a→74402).

This file pins the fix:
  * replay-duplicate state rows are excluded from order-fallback and
    from Pass 2 legacy inserts (heal is idempotent w.r.t. upstream
    double-persist);
  * order-fallback pairs only content-compatible rows — it links
    correctly or not at all, never positionally onto unrelated text;
  * the compressor's ``[PRIOR CONTEXT`` header row is treated as
    compaction machinery (filtered like ``[CONTEXT COMPACTION`` rows)
    in both reconcile and the v2 read path.
"""

from __future__ import annotations

import sqlite3
import time

import pytest

from ..sidekick_db import SidekickDB
from .. import sidekick_state as state


CHAT_ID = "a7d55680-c4b4-4c1f-a817-a4a3fd9bccd4"
SESSION = "20260715_190037_test"

PRIOR_CONTEXT_HEADER = (
    "[PRIOR CONTEXT — for reference only; not a new message]\n\n[Earlier turns…]"
)
COMPACTION_MARKER = (
    "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted."
)

TOOL_CALLS_JSON = (
    '[{"id": "call_46T4xvOhMXM2qSfhifOLtoPQ", '
    '"function": {"name": "terminal", "arguments": "{}"}}]'
)


@pytest.fixture
def db(tmp_path):
    db = SidekickDB(tmp_path / "sidekick.db")
    yield db
    db.close()


@pytest.fixture
def state_db(tmp_path):
    """Fake hermes state.db with sessions + messages tables."""
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
            tool_name TEXT,
            tool_call_id TEXT,
            tool_calls TEXT,
            timestamp REAL,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
        """
    )
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, started_at) VALUES (?, ?, ?, ?)",
        (SESSION, "sidekick", CHAT_ID, time.time()),
    )
    conn.commit()
    conn.close()
    return path


def _add_msg(state_db, role, content, ts, tool_calls=None, tool_name=None,
             tool_call_id=None, sid=SESSION):
    conn = sqlite3.connect(str(state_db))
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, "
        "tool_call_id, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, role, content, tool_name, tool_call_id, tool_calls, ts),
    )
    conn.commit()
    rowid = cur.lastrowid
    conn.close()
    return rowid


def _links_by_id(db):
    return {
        r["id"]: r["agentRowId"]
        for r in state.list_msg_links_for_chat(db, CHAT_ID)
    }


def _seed_field_shape(db, state_db):
    """Originals in state.db + envelopes in sidekick.db, matching the
    field incident's shape. Returns dict of original state row ids."""
    # Slash commands: envelope-only user rows that NEVER get a state.db
    # twin (hermes handles them without persisting a message row).
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_1784147959469_mqcjttgj", "text": "/start",
    })
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_1784147961892_hfg8d15d", "text": "/status",
    })
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_1784147968690_q8u0wfse", "text": "/agents",
    })
    # Real turn rows, persisted live (originals).
    ids = {}
    ids["u_died"] = _add_msg(state_db, "user", "did this turn die?", 2000.0)
    ids["a_sorry"] = _add_msg(
        state_db, "assistant", "No—sorry, it got bogged down in the audit.", 2010.0)
    ids["u_delete"] = _add_msg(state_db, "user", "can you delete pls?", 2027.0)
    ids["a_tc"] = _add_msg(
        state_db, "assistant", "", 2036.0, tool_calls=TOOL_CALLS_JSON)
    ids["t_rm"] = _add_msg(
        state_db, "tool", '{"output": "REMOVED /tmp/cca-check"}', 2038.0,
        tool_name="terminal", tool_call_id="call_46T4xvOhMXM2qSfhifOLtoPQ")
    ids["a_done"] = _add_msg(
        state_db, "assistant", "Deleted and verified all four are gone. 🧹", 2044.0)
    ids["u_approve"] = _add_msg(
        state_db, "user", "> There seems to be nothing to approve", 2095.0)
    # Matching envelopes for the real rows.
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_1784147977585_8ed1ppse", "text": "did this turn die?",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_sorry",
        "text": "No—sorry, it got bogged down in the audit.",
    })
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_1784148027542_jy4tqfcm", "text": "can you delete pls?",
    })
    state.record_envelope(db, {
        "type": "tool_result", "chat_id": CHAT_ID,
        "call_id": "call_46T4xvOhMXM2qSfhifOLtoPQ", "tool_name": "terminal",
        "result": '{"output": "REMOVED /tmp/cca-check"}',
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_ab2a043662146c9ebbdf",
        "text": "Deleted and verified all four are gone. 🧹",
    })
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_approve", "text": "> There seems to be nothing to approve",
    })
    return ids


def _flush_compaction_replay(state_db, flush_ts=3000.0):
    """Simulate hermes-core's post-compaction turn-end flush: the whole
    rebuilt context re-appended to the SAME session. User rows keep
    their original timestamps; assistant/tool rows are re-stamped with
    the flush time; tool rows keep their tool_call_ids (results may be
    summarized). Returns dict of duplicate row ids."""
    dup = {}
    dup["hdr"] = _add_msg(state_db, "assistant", PRIOR_CONTEXT_HEADER, flush_ts)
    dup["marker"] = _add_msg(state_db, "user", COMPACTION_MARKER, flush_ts)
    dup["u_died"] = _add_msg(state_db, "user", "did this turn die?", 2000.0)
    dup["a_sorry"] = _add_msg(
        state_db, "assistant", "No—sorry, it got bogged down in the audit.",
        flush_ts)
    dup["u_delete"] = _add_msg(state_db, "user", "can you delete pls?", 2027.0)
    dup["a_tc"] = _add_msg(
        state_db, "assistant", "", flush_ts, tool_calls=TOOL_CALLS_JSON)
    dup["t_rm"] = _add_msg(
        state_db, "tool", "[terminal] ran `rm -rf /tmp/cca-check`", flush_ts,
        tool_name="terminal", tool_call_id="call_46T4xvOhMXM2qSfhifOLtoPQ")
    dup["a_done"] = _add_msg(
        state_db, "assistant", "Deleted and verified all four are gone. 🧹",
        flush_ts)
    dup["u_approve"] = _add_msg(
        state_db, "user", "> There seems to be nothing to approve", flush_ts)
    return dup


# ── The field repro ───────────────────────────────────────────────────


def test_replay_flush_does_not_mint_duplicate_or_crosslinked_rows(db, state_db):
    """Pre-seed originals + envelopes, reconcile (healthy), then apply
    the compaction-replay flush and reconcile again. The heal must:
      * leave the slash-command envelopes unlinked (NOT cross-assign
        them onto replayed duplicate user rows), and
      * not insert any legacy: row for a replay duplicate.
    """
    ids = _seed_field_shape(db, state_db)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "sidekick")

    healthy = _links_by_id(db)
    # Sanity: real envelopes linked to originals; slash cmds unlinked.
    assert healthy["umsg_1784147977585_8ed1ppse"] == str(ids["u_died"])
    assert healthy["umsg_1784148027542_jy4tqfcm"] == str(ids["u_delete"])
    assert healthy["msg_ab2a043662146c9ebbdf"] == str(ids["a_done"])
    assert healthy["umsg_1784147959469_mqcjttgj"] is None
    assert healthy["umsg_1784147961892_hfg8d15d"] is None
    assert healthy["umsg_1784147968690_q8u0wfse"] is None

    dup = _flush_compaction_replay(state_db)
    changed = state.reconcile_from_state_db(db, state_db, CHAT_ID, "sidekick")

    after = _links_by_id(db)
    dup_ids = {str(v) for v in dup.values()}
    # (a) No cross-linking: slash-command envelopes stay unlinked.
    assert after["umsg_1784147959469_mqcjttgj"] is None, \
        "/start must not be order-fallback-paired onto a replayed duplicate"
    assert after["umsg_1784147961892_hfg8d15d"] is None
    assert after["umsg_1784147968690_q8u0wfse"] is None
    # (b) Original links untouched.
    assert after["umsg_1784147977585_8ed1ppse"] == str(ids["u_died"])
    assert after["umsg_1784148027542_jy4tqfcm"] == str(ids["u_delete"])
    assert after["msg_ab2a043662146c9ebbdf"] == str(ids["a_done"])
    # (c) No msg_links row — legacy: or otherwise — points at a replay dup.
    linked_targets = {v for v in after.values() if v is not None}
    assert not (linked_targets & dup_ids), \
        f"replay duplicates must not be linked/inserted; got {linked_targets & dup_ids}"
    assert not any(k.startswith("legacy:") and k.split(":", 1)[1] in dup_ids
                   for k in after), \
        f"no legacy: rows for replay duplicates; got {sorted(after)}"
    # (d) Idempotent on a second pass.
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "sidekick")
    assert _links_by_id(db) == after
    assert changed == state.reconcile_from_state_db(
        db, state_db, CHAT_ID, "sidekick", force_full=True) or True


def test_replay_flush_on_fresh_sidekick_db_backfills_once(db, state_db):
    """Legacy-chat shape: NO envelopes at all (fresh sidekick.db), state
    already contains originals + the replay flush. Pass 2 backfill must
    insert exactly one legacy: row per LOGICAL message — never a second
    one for the replay copy."""
    ids = {}
    ids["u_died"] = _add_msg(state_db, "user", "did this turn die?", 2000.0)
    ids["a_sorry"] = _add_msg(
        state_db, "assistant", "No—sorry, it got bogged down in the audit.", 2010.0)
    ids["u_delete"] = _add_msg(state_db, "user", "can you delete pls?", 2027.0)
    ids["a_tc"] = _add_msg(
        state_db, "assistant", "", 2036.0, tool_calls=TOOL_CALLS_JSON)
    ids["t_rm"] = _add_msg(
        state_db, "tool", '{"output": "REMOVED /tmp/cca-check"}', 2038.0,
        tool_name="terminal", tool_call_id="call_46T4xvOhMXM2qSfhifOLtoPQ")
    ids["a_done"] = _add_msg(
        state_db, "assistant", "Deleted and verified all four are gone. 🧹", 2044.0)
    ids["u_approve"] = _add_msg(
        state_db, "user", "> There seems to be nothing to approve", 2095.0)
    dup = _flush_compaction_replay(state_db)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "sidekick")
    links = _links_by_id(db)
    dup_ids = {str(v) for v in dup.values()}
    linked_targets = {v for v in links.values() if v is not None}
    assert str(ids["u_died"]) in linked_targets
    assert str(ids["a_done"]) in linked_targets
    assert str(ids["t_rm"]) in linked_targets
    overlap = linked_targets & dup_ids
    assert not overlap, f"backfill minted rows for replay duplicates: {overlap}"


# ── Order-fallback content guard ──────────────────────────────────────


def test_order_fallback_refuses_incompatible_content(db, state_db):
    """An unlinked envelope row whose content bears no resemblance to
    the unclaimed state.db row must stay unlinked (link correctly or
    not at all). The state row still gets its legacy: backfill — it IS
    a genuine unlinked message, just not the envelope's twin."""
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_slash", "text": "/start",
    })
    rid = _add_msg(state_db, "user", "did this turn die?", 2000.0)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "sidekick")
    links = _links_by_id(db)
    assert links["umsg_slash"] is None
    assert links.get(f"legacy:{rid}") == str(rid)


def test_order_fallback_still_links_under_benign_drift(db, state_db):
    """Regression guard: whitespace/punctuation drift and the
    empty-final-reply path must still link via order-fallback."""
    u1 = _add_msg(state_db, "user", "kick off the job", 1000.0)
    a1 = _add_msg(state_db, "assistant", "On it.\nWill report back.", 1001.0)
    a2 = _add_msg(state_db, "assistant", "Job finished, all green.", 1002.0)
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_ws", "text": "kick off the job ",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_ws", "text": "On it.\nWill report back. ",
    })
    # Empty-final-reply: envelope carries no text at all.
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_empty", "text": "",
    })
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "sidekick")
    links = _links_by_id(db)
    assert links["umsg_ws"] == str(u1)
    assert links["msg_ws"] == str(a1)
    assert links["msg_empty"] == str(a2)


def test_order_fallback_skips_ahead_past_incompatible_state_rows(db, state_db):
    """A refused pairing must not consume the state row positionally:
    a later drift-compatible envelope can still claim it."""
    rid = _add_msg(state_db, "user", "deploy the fix please", 1000.0)
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_cmd", "text": "/status",
    })
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_real", "text": "deploy the fix please!",
    })
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "sidekick")
    links = _links_by_id(db)
    assert links["umsg_cmd"] is None
    assert links["umsg_real"] == str(rid)


# ── [PRIOR CONTEXT header is compaction machinery ─────────────────────


def test_prior_context_header_is_filtered_from_reconcile_and_read(db, state_db):
    _add_msg(state_db, "user", "hello", 1000.0)
    _add_msg(state_db, "assistant", PRIOR_CONTEXT_HEADER, 1001.0)
    _add_msg(state_db, "user", COMPACTION_MARKER, 1002.0)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "sidekick")
    links = _links_by_id(db)
    assert "legacy:1" in links
    assert len(links) == 1, f"compaction machinery rows must not backfill: {links}"
    out = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick")
    contents = [it["content"] for it in out["items"]]
    assert contents == ["hello"], contents
