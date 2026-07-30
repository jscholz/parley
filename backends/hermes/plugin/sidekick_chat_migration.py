"""One-time per-chat backfill + migration marker — transcript v3 Phase 2 (DARK).

Migration-plan item 2 (see ``workspace/documents/agent-development/
sidekick-transcript-v3-deterministic-link-design-2026-07-16.md``): run
the content-fingerprint reconcile ONCE per chat as a *legacy import*
for history that predates write-through, heal the known pre-fix
mislinks, and mint a durable ``chat_migrations`` marker. Phase 3
(``SIDEKICK_ITEMS_V3``) flips the items read to sidekick.db bodies
ONLY for chats holding a marker at the current ``SCHEMA_VERSION`` —
until then this module changes nothing on any serving path.

Marker semantics — a marker row asserts, as of ``migrated_at``:

  * every live state.db chain row (machinery seeds and compaction-
    replay duplicates excluded — reconcile skips those by design) has
    a msg_links twin: linked via ``agent_row_id`` or explicitly
    legacy-imported (``legacy:<state_id>``);
  * no msg_links row mislinks onto an orchestration-shaped state row
    (the pre-aa81f4f status-bubble/tr: zip class, healed below);
  * no ``tr:``/``tc:`` row mislinks onto a DIFFERENT call's state row
    (the wrong-call-id fingerprint zip — field 2026-07-29, chat
    bf6edbf4; healed below);
  * no non-tool row is linked to a state row whose content it is NOT
    content-compatible with (pre-fix positional zips of status
    bubbles / slash-command envelopes onto real transcript rows —
    2026-07-30 flip-prep sweep found 213 across 32 live chats; under
    the v2 read these only corrupt the sidekick_id annotation, under
    the v3 read they would serve the WRONG BODY at that position).

Both new criteria landed at ``SCHEMA_VERSION`` 2 so already-minted
chats re-migrate lazily (cheap — one marker short-circuit miss).

"Cleanly" (the mint gate): ``unresolved == 0`` AND
``residual_mislinks == 0`` with state.db reachable for the audit.
No tolerance threshold — the marker gates a READ flip, and a single
unrepresented row is a message Phase 3 would silently drop. An
unclean pass withholds the marker and WARNs; the next background
reconcile retries, so transient causes (a turn flushing mid-pass,
a sidekick.db hiccup) self-heal.

Idempotent: the marker short-circuits re-runs entirely (one indexed
lookup). Rows arriving after migration belong to write-through + the
turn linker, never to a second import. Bump ``SCHEMA_VERSION`` to
force re-migration when the criteria gain teeth — ``get_migration``
treats older versions as unmigrated.

Live-safety: every sidekick.db write goes through the autocommit
SidekickDB handle (row-bounded implicit transactions, no long write
locks); state.db is only ever opened ``mode=ro``. Worker thread only —
the underlying reconcile is O(history) GIL-held Python (see the
2026-06-23 loop-starvation notes in sidekick_state.py).

Kill switch: ``SIDEKICK_CHAT_MIGRATION=0`` (default on, dark —
consistent with SIDEKICK_TURN_LINKER).
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional

from .sidekick_ids import SIDEKICK_SOURCE
from .sidekick_state import (
    _classify_replay_duplicate_state_ids,
    _is_compaction_seed,
    reconcile_from_state_db,
)
from .sidekick_turn_linker import _CHAIN_CTE, _connect_state_ro

logger = logging.getLogger(__name__)

# 2 (2026-07-30): wrong-call-id tr:/tc: mislinks + content-incompatible
# non-tool mislinks joined the heal + residual audit; version-1 markers
# re-migrate lazily (cheap — the marker short-circuit is the only thing
# the bump invalidates).
SCHEMA_VERSION = 2


def enabled() -> bool:
    """Env kill switch. SIDEKICK_CHAT_MIGRATION, default '1'; '0'
    disables backfill, heal, and marker minting entirely."""
    return os.environ.get("SIDEKICK_CHAT_MIGRATION", "1").strip().lower() not in (
        "0", "false", "no",
    )


def get_migration(db, chat_id: str) -> Optional[Dict[str, Any]]:
    """The chat's migration marker at the CURRENT schema version, or
    None (unmigrated / stale-version markers are both None — Phase 3
    must treat them identically). ``stats`` comes back parsed."""
    try:
        row = db.fetchone(
            "SELECT chat_id, migrated_at, schema_version, stats "
            "FROM chat_migrations WHERE chat_id = ?",
            (chat_id,),
        )
    except Exception:
        return None
    if row is None or int(row["schema_version"]) < SCHEMA_VERSION:
        return None
    out = dict(row)
    try:
        stats = json.loads(row["stats"] or "{}")
        out["stats"] = stats if isinstance(stats, dict) else {}
    except Exception:
        out["stats"] = {}
    return out


# ── Orchestration-mislink heal (2026-07-28 re-soak forensics) ─────────
#
# Before the aa81f4f fix (deployed 2026-07-23 19:38Z), reconcile's
# order-fallback zipped ephemeral gateway status bubbles ("⏳ Working…")
# — and in one case a tr: envelope — onto orchestration state rows
# (role=assistant, empty content, tool_calls present, tool_call_id
# NULL). Such a row has NO envelope twin by construction: its only
# legitimate msg_links owner is reconcile's own legacy:<id> twin.
# Post-fix reconcile can no longer mint this shape, but the stale links
# persist in msg_links and keep the linker-soak diverge counter dirty.


def _orchestration_row_ids(conn, chat_id: str, source: str) -> set:
    """Orchestration-shaped rows across the chat's session chain."""
    sql = (
        _CHAIN_CTE
        + "SELECT m.id FROM messages m JOIN session_root sr "
        "ON m.session_id = sr.id "
        "WHERE m.role = 'assistant' AND COALESCE(m.content, '') = '' "
        "AND COALESCE(m.tool_calls, '') != '' "
        "AND COALESCE(m.tool_call_id, '') = ''"
    )
    return {str(r["id"]) for r in conn.execute(sql, (chat_id, source)).fetchall()}


def _find_orchestration_mislinks(db, orch_ids: set, chat_id: str) -> List[str]:
    """msg_links ids (this chat) whose agent_row_id names an
    orchestration row without BEING its legacy:<id> twin."""
    if not orch_ids:
        return []
    try:
        rows = db.fetchall(
            "SELECT id, agent_row_id FROM msg_links "
            "WHERE chat_id = ? AND agent_row_id IS NOT NULL",
            (chat_id,),
        )
    except Exception:
        return []
    return [
        str(r["id"]) for r in rows
        if str(r["agent_row_id"]) in orch_ids
        and str(r["id"]) != f"legacy:{r['agent_row_id']}"
    ]


def heal_orchestration_mislinks_sync(
    db, state_db_path, chat_id: str, source: str = SIDEKICK_SOURCE,
) -> int:
    """NULL the agent_row_id on every mislinked row — never relink
    here: the follow-up reconcile re-links tr:* by exact call id and
    mints the legacy twin, while status bubbles stay envelope-only
    (they have no state twin at all). Row-bounded autocommit writes;
    returns rows healed."""
    try:
        with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
            orch_ids = _orchestration_row_ids(conn, chat_id, source)
    except Exception:
        return 0
    healed = 0
    for sk_id in _find_orchestration_mislinks(db, orch_ids, chat_id):
        try:
            db.exec(
                "UPDATE msg_links SET agent_row_id = NULL, updated_at = ? "
                "WHERE id = ?",
                (time.time(), sk_id),
            )
            healed += 1
        except Exception:
            continue
    return healed


# ── Wrong-call-id tr:/tc: mislink heal (field 2026-07-29, bf6edbf4) ───
#
# Pre-fix content-fingerprint linking could zip a ``tr:<call_X>`` (or
# ``tc:<call_X>``) envelope onto the state row of a DIFFERENT call whose
# result content collided (live instance: chat bf6edbf4-…, msg
# tr:call_PZOYFvkwKv6i2V9ASnqoNcDz → row 78913 carrying call_0T3z…
# while the true row 81447 existed). tool_call_ids are unique per call
# by construction, so a tr:/tc: row whose linked state row carries a
# different non-empty tool_call_id is a PROVABLE mislink. A state row
# with an EMPTY tool_call_id is the orchestration class above, not this
# one; a missing state row is orphan-drop's job.

_TOOL_LINK_CHUNK = 500


def _find_tool_call_mislinks(conn, db, chat_id: str) -> List[str]:
    """msg_links ids (this chat) shaped ``tr:<id>``/``tc:<id>`` whose
    agent_row_id names a state row carrying a DIFFERENT non-empty
    tool_call_id."""
    try:
        rows = db.fetchall(
            "SELECT id, tool_call_id, agent_row_id FROM msg_links "
            "WHERE chat_id = ? AND agent_row_id IS NOT NULL "
            "AND (id LIKE 'tr:%' OR id LIKE 'tc:%')",
            (chat_id,),
        )
    except Exception:
        return []
    if not rows:
        return []
    state_call_ids: dict = {}
    arids = sorted({str(r["agent_row_id"]) for r in rows})
    try:
        for start in range(0, len(arids), _TOOL_LINK_CHUNK):
            chunk = arids[start:start + _TOOL_LINK_CHUNK]
            placeholders = ",".join("?" * len(chunk))
            got = conn.execute(
                f"SELECT id, tool_call_id FROM messages WHERE id IN ({placeholders})",
                chunk,
            ).fetchall()
            for g in got:
                state_call_ids[str(g["id"])] = g["tool_call_id"] or ""
    except Exception:
        return []
    out: List[str] = []
    for r in rows:
        expected = (r["tool_call_id"] or "") or str(r["id"])[3:]
        actual = state_call_ids.get(str(r["agent_row_id"]))
        if actual and expected and actual != expected:
            out.append(str(r["id"]))
    return out


def heal_tool_call_mislinks_sync(db, state_db_path, chat_id: str) -> int:
    """NULL the agent_row_id on every wrong-call-id tr:/tc: link —
    never relink here: the follow-up reconcile Pass 1.a relinks tr:*
    by exact call id (its replay-dup preference keeps it off re-flush
    copies); tc:* stays unlinked by design. Row-bounded autocommit
    writes; returns rows healed."""
    try:
        with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
            mislinked = _find_tool_call_mislinks(conn, db, chat_id)
    except Exception:
        return 0
    healed = 0
    for sk_id in mislinked:
        try:
            db.exec(
                "UPDATE msg_links SET agent_row_id = NULL, updated_at = ? "
                "WHERE id = ?",
                (time.time(), sk_id),
            )
            healed += 1
        except Exception:
            continue
    return healed


# ── Content-incompatible mislink heal (2026-07-30 flip-prep sweep) ────
#
# The residue of every pre-fix zip shape at once: a non-tool msg_links
# row linked to a state row whose content it is NOT content-compatible
# with (``_order_fallback_content_compatible`` — the post-fix linker's
# own mint rule). No legitimate link can fail it: exact-match links
# start content-EQUAL and hermes never updates message content
# (whole-session ops delete+reinsert under new ids); order-fallback
# links require compatibility at mint; notification links copy their
# own content. Live sweep 2026-07-30: 213 such links across 32 chats —
# ⏳/📦/⏩ gateway bubbles onto real assistant replies, /approve//steer
# envelopes onto real user rows, two cross-zipped user messages.
# Tool rows are exempt (call id is their identity, content is not —
# the wrong-call-id heal above covers them); legacy:<id> twins are
# copies by construction; orchestration-shaped targets belong to the
# first heal class and are excluded so residual never double-counts.


def _find_content_mislinks(conn, db, chat_id: str) -> List[str]:
    """Non-tool, non-legacy msg_links ids (this chat) whose envelope
    content is content-INCOMPATIBLE with their linked state row."""
    from .sidekick_state import _order_fallback_content_compatible
    try:
        rows = db.fetchall(
            "SELECT id, content, agent_row_id FROM msg_links "
            "WHERE chat_id = ? AND agent_row_id IS NOT NULL "
            "AND role != 'tool' AND id NOT LIKE 'legacy:%'",
            (chat_id,),
        )
    except Exception:
        return []
    if not rows:
        return []
    state_rows: dict = {}
    arids = sorted({str(r["agent_row_id"]) for r in rows})
    try:
        for start in range(0, len(arids), _TOOL_LINK_CHUNK):
            chunk = arids[start:start + _TOOL_LINK_CHUNK]
            placeholders = ",".join("?" * len(chunk))
            got = conn.execute(
                "SELECT id, role, content, tool_calls, tool_call_id "
                f"FROM messages WHERE id IN ({placeholders})",
                chunk,
            ).fetchall()
            for g in got:
                state_rows[str(g["id"])] = g
    except Exception:
        return []
    out: List[str] = []
    for r in rows:
        st = state_rows.get(str(r["agent_row_id"]))
        if st is None:
            continue  # orphan-drop's job.
        if (st["role"] == "assistant" and not (st["content"] or "")
                and (st["tool_calls"] or "")
                and not (st["tool_call_id"] or "")):
            continue  # orchestration-shaped — first heal class.
        if not _order_fallback_content_compatible(r["content"], st["content"]):
            out.append(str(r["id"]))
    return out


def heal_content_mislinks_sync(db, state_db_path, chat_id: str) -> int:
    """NULL the agent_row_id on every content-incompatible non-tool
    link. Never relink here: the follow-up reconcile re-imports the
    wrongly-claimed state row as its legacy twin (true content
    restored) while the envelope row serves as itself — and post-fix
    order-fallback can't re-mint the pairing (it requires the very
    compatibility that failed). Returns rows healed."""
    try:
        with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
            mislinked = _find_content_mislinks(conn, db, chat_id)
    except Exception:
        return 0
    healed = 0
    for sk_id in mislinked:
        try:
            db.exec(
                "UPDATE msg_links SET agent_row_id = NULL, updated_at = ? "
                "WHERE id = ?",
                (time.time(), sk_id),
            )
            healed += 1
        except Exception:
            continue
    return healed


# ── Backfill + marker ─────────────────────────────────────────────────


def _audit_chat_sync(
    db, state_db_path, chat_id: str, source: str,
) -> Optional[Dict[str, Any]]:
    """Post-import audit: is every live chain row represented in
    msg_links? Returns the stats dict, or None when state.db is
    unreachable (the marker must never be minted on an unverifiable
    pass)."""
    try:
        with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
            rows = conn.execute(
                _CHAIN_CTE
                + "SELECT m.id, m.role, m.content, m.tool_call_id, "
                "m.tool_calls, m.timestamp FROM messages m "
                "JOIN session_root sr ON m.session_id = sr.id "
                "ORDER BY m.id ASC",
                (chat_id, source),
            ).fetchall()
    except Exception:
        return None
    # Same exclusions reconcile applies: machinery seeds are never
    # served; the AGGRESSIVE replay-dup set is never legacy-imported
    # (its logical messages already exist via their first occurrence).
    dup_ids, _provable = _classify_replay_duplicate_state_ids(rows)
    machinery = {
        str(r["id"]) for r in rows if _is_compaction_seed(r["content"] or "")
    }
    try:
        linked_rows = db.fetchall(
            "SELECT agent_row_id FROM msg_links "
            "WHERE chat_id = ? AND agent_row_id IS NOT NULL",
            (chat_id,),
        )
        envelope_only_row = db.fetchone(
            "SELECT COUNT(*) AS n FROM msg_links "
            "WHERE chat_id = ? AND agent_row_id IS NULL",
            (chat_id,),
        )
    except Exception:
        return None
    linked = {str(r["agent_row_id"]) for r in linked_rows}
    unresolved = sum(
        1 for r in rows
        if str(r["id"]) not in linked
        and str(r["id"]) not in dup_ids
        and str(r["id"]) not in machinery
    )
    return {
        "state_rows": len(rows),
        "machinery": len(machinery),
        "replay_dups": len(dup_ids),
        "linked": len(linked),
        "envelope_only": int(envelope_only_row["n"]),
        "unresolved": unresolved,
    }


def backfill_chat_sync(
    db, state_db_path, chat_id: str, source: str = SIDEKICK_SOURCE,
) -> Optional[Dict[str, Any]]:
    """One-time legacy import + marker mint for one chat (worker
    thread only). Sequence: marker short-circuit → mislink heal →
    force_full reconcile (the legacy import; fast-path bypassed so
    Pass-2 inserts and orphan drops always run) → audit → mint iff
    clean. Returns the outcome dict for tests/diagnostics, None when
    disabled or unconfigured."""
    if not enabled():
        return None
    if db is None or state_db_path is None:
        return None
    existing = get_migration(db, chat_id)
    if existing is not None:
        return {"migrated": True, "already": True, **existing["stats"]}
    t0 = time.monotonic()
    healed = heal_orchestration_mislinks_sync(db, state_db_path, chat_id, source)
    healed += heal_tool_call_mislinks_sync(db, state_db_path, chat_id)
    healed += heal_content_mislinks_sync(db, state_db_path, chat_id)
    if healed:
        # WARNING so the heal is journald-visible (per-chat pre-heal
        # counts also land in the marker stats below).
        logger.warning(
            "[sidekick] chat-migration healed %d pre-fix mislink(s) "
            "(orchestration / wrong-call-id / content-incompatible) "
            "chat=%s", healed, chat_id,
        )
    reconcile_from_state_db(db, state_db_path, chat_id, source, force_full=True)
    stats = _audit_chat_sync(db, state_db_path, chat_id, source)
    if stats is None:
        logger.warning(
            "[sidekick] chat-migration chat=%s state.db unreachable — "
            "marker withheld", chat_id,
        )
        return {"migrated": False, "reason": "state_unreachable",
                "mislinks_healed": healed}
    stats["mislinks_healed"] = healed
    # Residual re-detection guards against a heal/reconcile bug
    # re-minting the mislink shape on this very pass.
    try:
        with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
            orch_ids = _orchestration_row_ids(conn, chat_id, source)
            residual = len(_find_orchestration_mislinks(db, orch_ids, chat_id))
            residual += len(_find_tool_call_mislinks(conn, db, chat_id))
            residual += len(_find_content_mislinks(conn, db, chat_id))
    except Exception:
        residual = -1  # unverifiable — treated as unclean below.
    stats["residual_mislinks"] = residual
    if stats["unresolved"] != 0 or residual != 0:
        logger.warning(
            "[sidekick] chat-migration chat=%s NOT clean unresolved=%d "
            "residual_mislinks=%d — marker withheld (retries on next "
            "background reconcile)",
            chat_id, stats["unresolved"], residual,
        )
        return {"migrated": False, "reason": "not_clean", **stats}
    now = time.time()
    try:
        db.exec(
            "INSERT OR REPLACE INTO chat_migrations "
            "(chat_id, migrated_at, schema_version, stats) VALUES (?, ?, ?, ?)",
            (chat_id, now, SCHEMA_VERSION, json.dumps(stats)),
        )
    except Exception as exc:
        logger.warning(
            "[sidekick] chat-migration marker write failed chat=%s: %s",
            chat_id, exc,
        )
        return {"migrated": False, "reason": "marker_write_failed", **stats}
    # Operator-visible mint line on the perf-trace stderr channel — the
    # gateway's stdlib handler drops sub-WARNING records, so a
    # logger.info here would never reach journalctl.
    wall_ms = (time.monotonic() - t0) * 1000.0
    print(
        f"[perf-trace INFO] [sidekick] chat-migration chat={chat_id} "
        f"migrated schema_version={SCHEMA_VERSION} "
        f"state_rows={stats['state_rows']} linked={stats['linked']} "
        f"replay_dups={stats['replay_dups']} "
        f"envelope_only={stats['envelope_only']} "
        f"mislinks_healed={healed} wall={wall_ms:.0f}ms",
        flush=True, file=sys.stderr,
    )
    return {"migrated": True, "already": False, **stats}
