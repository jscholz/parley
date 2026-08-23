"""Read-path filtering of compaction-replay duplicate rows.

Field incident 2026-07-16 (chat parley:20249e46, hermes session
20260715_133109_8bdaf262, "Preparing for Ben Coaching Session"): after
an in-place context compaction, hermes-core's turn-end flush
re-appended the ENTIRE rebuilt context into the SAME session (rows
75969-76028, flush ts 1784208910.7255x). The 2026-07-15 reconcile fix
(test_reconcile_replay_dedup.py) kept the heal idempotent — no
cross-links, no legacy: twins — but the v2 READ path still served BOTH
copies of every duplicated message (user 75950/76010, assistant
75967/76027, …), wasting the read window and scrambling the client's
dedup ordering.

Replay-batch asymmetry mirrored from the field data (do not "clean up"):
  * verbatim USER copies mostly keep their ORIGINAL timestamps
    (75969 kept 1784118668 from row 73266) — but at least one user row
    (76028) was RE-STAMPED with the flush time;
  * assistant copies are re-stamped with the flush time;
  * tool copies keep their tool_call_id but may carry SUMMARIZED
    (compressor-rewritten) content, re-stamped with the flush time;
  * the batch carries the machinery rows ([CONTEXT COMPACTION marker,
    [PRIOR CONTEXT header) stamped with the flush time.

This file pins the read-side fix:
  * every read (tail, before-cursor, after-cursor, around-target)
    serves exactly ONE copy of each duplicated message — the ORIGINAL
    row (by id);
  * duplicates whose original falls OUTSIDE the bounded read window are
    still filtered (via the replay_dups set reconcile persists);
  * summarized (rewritten-content) replay rows are NOT provable
    duplicates and still serve;
  * a legitimately repeated identical message with no compaction-flush
    context still serves BOTH copies (the read filter is strictly
    narrower than reconcile's aggressive linking dedup);
  * pagination cursors stay consistent (has_more/first_id contracts,
    paging to exhaustion yields each logical message exactly once).
"""

from __future__ import annotations

import sqlite3
import time

import pytest

from ..parley_db import ParleyDB
from .. import parley_state as state


CHAT_ID = "20249e46-3bf1-4eaa-8ba5-ac6d0a3772f8"
SESSION = "20260715_133109_test"
FLUSH_TS = 3000.0

COMPACTION_MARKER = (
    "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted."
)

U_HEY = "Hey. I have a coaching session with Ben coming up at two, and…"
A_REPEAT = "## Daniel’s repeatback\n\n> I understand the technical development…"
U_TRUTH = "That is indeed truthful, and I think your separation from sk…"
SUMMARIZED_TOOL = "[skill_view] name=executive-effectiveness-coaching (8,042 chars)"
SUMMARIZED_ASSISTANT = (
    "[Summary of earlier coaching-prep discussion: goals for the Ben "
    "session, repeatback drills with Anna and Daniel personas.]"
)

TOOL_CALLS_JSON = (
    '[{"id": "call_CCdyCfrAT8P0tDmGVygH0UfE", '
    '"function": {"name": "skill_view", "arguments": "{}"}}]'
)
TOOL_CALL_ID = "call_CCdyCfrAT8P0tDmGVygH0UfE"


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "parley.db")
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
        (SESSION, "parley", CHAT_ID, time.time()),
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


def _seed_originals(state_db):
    """The live rows persisted before the compaction flush."""
    ids = {}
    ids["u_hey"] = _add_msg(state_db, "user", U_HEY, 1000.0)
    ids["a_skill"] = _add_msg(
        state_db, "assistant", "", 1010.0, tool_calls=TOOL_CALLS_JSON)
    ids["t_skill"] = _add_msg(
        state_db, "tool", '{"output": "<the full 8,042-char skill body>"}',
        1011.0, tool_name="skill_view", tool_call_id=TOOL_CALL_ID)
    ids["a_repeat"] = _add_msg(state_db, "assistant", A_REPEAT, 1500.0)
    ids["u_truth"] = _add_msg(state_db, "user", U_TRUTH, 1600.0)
    return ids


def _flush_compaction_replay(state_db, flush_ts=FLUSH_TS):
    """The post-compaction turn-end flush: the whole rebuilt context
    re-appended to the SAME session. Mirrors the field asymmetry — see
    module docstring."""
    dup = {}
    # Verbatim user copy KEEPING its original timestamp (75969 shape).
    dup["u_hey"] = _add_msg(state_db, "user", U_HEY, 1000.0)
    # Assistant tool-call row re-stamped with the flush time.
    dup["a_skill"] = _add_msg(
        state_db, "assistant", "", flush_ts, tool_calls=TOOL_CALLS_JSON)
    # Tool row: SUMMARIZED content, same tool_call_id, flush-stamped.
    dup["t_skill"] = _add_msg(
        state_db, "tool", SUMMARIZED_TOOL, flush_ts,
        tool_name="skill_view", tool_call_id=TOOL_CALL_ID)
    # Machinery marker INSIDE the batch (75976 shape).
    dup["marker"] = _add_msg(state_db, "user", COMPACTION_MARKER, flush_ts)
    # Compressor-rewritten summary of compacted-away turns: NOT a
    # provable duplicate — must still serve.
    dup["summary"] = _add_msg(
        state_db, "assistant", SUMMARIZED_ASSISTANT, flush_ts)
    # Assistant copy re-stamped with the flush time (76027 shape).
    dup["a_repeat"] = _add_msg(state_db, "assistant", A_REPEAT, flush_ts)
    # User copy RE-STAMPED with the flush time (76028 shape).
    dup["u_truth"] = _add_msg(state_db, "user", U_TRUTH, flush_ts)
    return dup


def _post_flush_turn(state_db):
    """New live rows appended after the replay flush."""
    ids = {}
    ids["u_new"] = _add_msg(state_db, "user", "and one more thing", 3100.0)
    ids["a_new"] = _add_msg(
        state_db, "assistant", "Noted — one more thing handled.", 3200.0)
    return ids


def _read(db, state_db, **kw):
    return state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "parley", **kw)


# ── Tail read: single copy, original ids, summaries survive ──────────


def test_tail_read_serves_one_copy_of_each_duplicated_message(db, state_db):
    """Fresh damage, no reconcile yet: the whole batch fits in the tail
    window, so the read alone must already serve exactly one copy of
    each duplicated message — the ORIGINAL rows by id — while the
    summarized replay row (not a provable dup) still serves."""
    ids = _seed_originals(state_db)
    dup = _flush_compaction_replay(state_db)
    new = _post_flush_turn(state_db)

    out = _read(db, state_db)
    got_ids = [it["id"] for it in out["items"]]

    expected = [
        ids["u_hey"], ids["a_skill"], ids["t_skill"], ids["a_repeat"],
        ids["u_truth"], dup["summary"], new["u_new"], new["a_new"],
    ]
    assert got_ids == expected, (
        f"read must serve originals + summary + new turn only; got {got_ids}"
    )
    # Each duplicated content appears exactly once.
    contents = [it["content"] for it in out["items"]]
    for text in (U_HEY, A_REPEAT, U_TRUTH):
        assert contents.count(text) == 1, f"duplicate bubbles for {text!r}"
    # Summarized replay rows still serve.
    assert SUMMARIZED_ASSISTANT in contents
    # Pagination contract on the unfiltered-tail case.
    assert out["has_more"] is False
    assert out["first_id"] == ids["u_hey"]


def test_around_read_serves_one_copy(db, state_db):
    """The around-target (full-transcript) reader dedupes the same way."""
    ids = _seed_originals(state_db)
    dup = _flush_compaction_replay(state_db)
    _post_flush_turn(state_db)

    out = state.list_messages_around_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "parley", target=str(ids["a_repeat"]),
        limit=200)
    assert out["target_found"] is True
    got_ids = [it["id"] for it in out["items"]]
    assert ids["a_repeat"] in got_ids
    for rid in (dup["u_hey"], dup["a_skill"], dup["t_skill"],
                dup["a_repeat"], dup["u_truth"]):
        assert rid not in got_ids, f"replay dup {rid} served by around-read"
    assert dup["summary"] in got_ids


# ── Bounded window: original OUTSIDE the window ───────────────────────


def _seed_deep_history(state_db, n=80):
    """Filler turns between the originals and the flush so the originals
    fall OUTSIDE a bounded tail window (window = limit + elision margin;
    the staged delta must exceed it — boundary-adversarial)."""
    return [
        _add_msg(state_db, "user", f"filler note {i:03d}", 2000.0 + i)
        for i in range(n)
    ]


def test_bounded_read_filters_dup_whose_original_is_outside_window(db, state_db):
    """Re-stamped replay copies sort at the flush time — far from their
    originals. With 80 filler rows in between, a limit=10 tail read's
    fetch window can NOT contain the originals, so the filter must come
    from the replay_dups set reconcile persisted."""
    ids = _seed_originals(state_db)
    _seed_deep_history(state_db)
    dup = _flush_compaction_replay(state_db)
    new = _post_flush_turn(state_db)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley",
                                  force_full=True)

    out = _read(db, state_db, limit=10)
    got_ids = [it["id"] for it in out["items"]]
    for key, rid in dup.items():
        if key in ("summary", "marker"):
            continue
        assert rid not in got_ids, (
            f"replay dup {key}={rid} served (original outside window)")
    # Newest page: summary + new turn + newest fillers.
    assert new["u_new"] in got_ids and new["a_new"] in got_ids
    assert dup["summary"] in got_ids
    assert out["has_more"] is True
    assert out["first_id"] == got_ids[0]
    assert ids["u_hey"] not in got_ids  # sanity: originals truly out of page


def test_paging_to_exhaustion_yields_each_message_exactly_once(db, state_db):
    """before-cursor paging across the damage: every logical message
    exactly once, original ids only, cursors monotonic, terminates."""
    ids = _seed_originals(state_db)
    fillers = _seed_deep_history(state_db)
    dup = _flush_compaction_replay(state_db)
    new = _post_flush_turn(state_db)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley",
                                  force_full=True)

    pages, cursor = [], None
    for _ in range(50):  # hard stop against a paging loop
        out = _read(db, state_db, limit=10, before_id=cursor)
        if not out["items"]:
            assert out["has_more"] is False
            break
        assert out["first_id"] == out["items"][0]["id"]
        pages.append(out["items"])
        if not out["has_more"]:
            break
        cursor = out["first_id"]
    else:
        pytest.fail("paging did not terminate")

    all_ids = [it["id"] for page in pages for it in page]
    assert len(all_ids) == len(set(all_ids)), "a row served on two pages"
    expected = set(ids.values()) | set(fillers) | set(new.values()) | {dup["summary"]}
    assert set(all_ids) == expected, (
        f"missing={expected - set(all_ids)} extra={set(all_ids) - expected}")


def test_after_cursor_read_filters_dups(db, state_db):
    """Load-newer paging from a cursor at the last original: only the
    summary + the new turn are newer — no replay copies."""
    ids = _seed_originals(state_db)
    dup = _flush_compaction_replay(state_db)
    new = _post_flush_turn(state_db)
    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley",
                                  force_full=True)

    out = state.list_messages_after_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "parley", after_id=ids["u_truth"], limit=200)
    got_ids = [it["id"] for it in out["items"]]
    assert got_ids == [dup["summary"], new["u_new"], new["a_new"]], got_ids
    assert out["has_more_newer"] is False


# ── Semantics: only PROVABLE dups are filtered ────────────────────────


def test_identical_repeat_without_flush_context_still_serves(db, state_db):
    """A user (or assistant) legitimately repeating the exact same text
    later — with no compaction flush anchoring it — is NOT a provable
    replay duplicate and must keep serving BOTH copies, before and
    after reconcile (reconcile's aggressive linking dedup must not
    leak into the read filter)."""
    a1 = _add_msg(state_db, "user", "ok", 100.0)
    b1 = _add_msg(state_db, "assistant", "Done.", 110.0)
    a2 = _add_msg(state_db, "user", "ok", 200.0)
    b2 = _add_msg(state_db, "assistant", "Done.", 210.0)

    out = _read(db, state_db)
    assert [it["id"] for it in out["items"]] == [a1, b1, a2, b2]

    state.reconcile_from_state_db(db, state_db, CHAT_ID, "parley",
                                  force_full=True)
    out = _read(db, state_db)
    assert [it["id"] for it in out["items"]] == [a1, b1, a2, b2], (
        "legit repeats must survive the persisted replay_dups filter")
