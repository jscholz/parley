"""Divergence monitor + orphan-adopt repair — transcript v3 Phase 5.

Design-doc core move 5: **monitor, never heal-by-insert.** With the
content reconcile retired from the serving chain (Phase 4,
``PARLEY_RECONCILE_RETIRED``), nothing silently repairs drift for
migrated chats anymore — BY DESIGN (healing-by-inference is how v1 and
v2 both rotted). This module surfaces the drift instead:

  * ``sweep_chat_sync`` — per marked chat, compare the live state.db
    chain against msg_links representation. Two DEGRADING signals,
    both shapes of "a message exists that v3 serves blind":

      - ``unlinked_live``: live conversational rows NO observed turn
        claimed and no msg_links twin covers — the linker-missed-turn /
        plugin-down / terminal-turn shape (Phase 4's critical risk:
        such messages are invisible, and any envelope-only copy is
        liveness-blind — /undo//retry can't retract it).
      - ``claimed_missing``: rows an observed turn DID claim
        (turn_links) whose msg_links twin has since vanished or lost
        its link — store damage / a lost stamp.

    Never-alarm classes: machinery seeds, ``session_meta`` rows,
    compaction-replay duplicates, /undo soft-deletes (active=0 without
    compacted — retracted, not missing), rows inside a still-OPEN turn
    window, and rows younger than ``MONITOR_RECENT_GRACE_S`` (a
    mid-flight background turn's rows land before its close). A linked
    state row that VANISHED (``orphaned_links``) is /retry-by-design —
    the v3 read already retracts it — so it is counted for visibility
    but never degrades.

    Emissions follow the plugin's journald reality: WARNINGs reach the
    journal, INFO does not — so the alert is a ``logger.warning``
    (``transcript-diverge``, deduped per chat on the degradation
    fingerprint) and the per-sweep count summary rides the perf-trace
    stderr channel (``[perf-trace INFO] … transcript-monitor …``,
    emitted on every FULL sweep; the stats fast-path below stays
    silent). ``build_transcript_health`` feeds ``/v1/push/health`` and
    ``/v1/transcript/health`` → the proxy's diagnostics response
    (push_health pattern).

  * ``adopt_orphans_sync`` — the explicit recovery affordance for
    "plugin down while core writes" (design-doc edge case): imports the
    unlinked live set into msg_links as ``legacy:<id>`` twins via THE
    shared legacy-import representation
    (parley_state.insert_legacy_twin — reconcile Pass 2's own shape).
    Assisted, never automatic: the default call is a DRY RUN returning
    the would-adopt list; ``confirm=True`` performs it. Refuses
    unmarked chats (the legacy reconcile path owns those). For drift
    with a plausible ENVELOPE twin (content-linkable damage), the
    offline repair (parley_chat_migration.repair_chat_sync) is the
    right tool — adopting there would mint a duplicate body.

Cadence: no timers. ``parley_route_items._spawn_background_reconcile``
runs the sweep in exactly the chain slot the retired reconcile used
(items-poll triggered, per-chat throttled, worker-thread only). A
stats fast-path (chain MAX(id)+COUNT plus the chat's linked-row count,
mirroring reconcile's no-drift fast-path) keeps steady-state sweeps at
two cheap queries instead of an O(history) walk per poll.

state.db is opened ``mode=ro`` only; unreachable state.db returns None
and never alarms (unverifiable is not degraded — same contract as the
v3 read serving nothing rather than guessing).
"""

from __future__ import annotations

import contextlib
import logging
import os
from .parley_env import env_get
import sqlite3
import sys
import time
from typing import Any, Dict, List, Optional

from .parley_ids import SIDEKICK_SOURCE
from .parley_state import (
    _classify_replay_duplicate_state_ids,
    _is_compaction_seed,
    insert_legacy_twin,
)
from .parley_turn_linker import _CHAIN_CTE, _connect_state_ro, _row_get

logger = logging.getLogger(__name__)

# Rows younger than this never alarm (and are never adopt candidates):
# an in-flight or background turn's rows land in state.db before the
# close that links them. Generous — a sweep only ever DELAYS detection
# by one grace window, while a false alarm mid-turn would cry wolf on
# every long background job.
MONITOR_RECENT_GRACE_S = float(
    env_get("PARLEY_MONITOR_GRACE_S", "300") or 300,
)

# In-memory registry: chat_id → last sweep snapshot. Feeds
# build_transcript_health (diagnostics); dies with the process like
# the push-health monitor's rolling window — the next poll re-sweeps.
_health: Dict[str, Dict[str, Any]] = {}
# chat_id → last WARNED degradation fingerprint. A standing degradation
# warns ONCE (per shape) instead of once per 20s poll; healing clears
# it so a relapse re-warns.
_warned: Dict[str, str] = {}


def _chain_rows(conn, chat_id: str, source: str) -> List[Any]:
    """Full chain row set (the audit's columns + liveness flags).
    Falls back without active/compacted for pre-0.18 fixtures."""
    base = (
        _CHAIN_CTE
        + "SELECT m.id, m.role, m.content, m.tool_name, m.tool_call_id, "
        "m.tool_calls, m.timestamp{cols} "
        "FROM messages m JOIN session_root sr ON m.session_id = sr.id "
        "ORDER BY m.id ASC"
    )
    try:
        return list(conn.execute(
            base.format(cols=", m.active, m.compacted"), (chat_id, source),
        ).fetchall())
    except sqlite3.OperationalError:
        return list(conn.execute(
            base.format(cols=""), (chat_id, source),
        ).fetchall())


def _collect_sync(
    db, state_db_path, chat_id: str, source: str, *, now: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """One full comparison pass. Returns the raw snapshot (plus the
    candidate row objects under ``_candidate_rows`` for adopt), or None
    when state.db is unreachable."""
    now = time.time() if now is None else now
    try:
        with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
            rows = _chain_rows(conn, chat_id, source)
    except Exception:
        return None

    dup_ids, _provable = _classify_replay_duplicate_state_ids(rows)
    try:
        linked = {
            str(r["agent_row_id"]) for r in db.fetchall(
                "SELECT agent_row_id FROM msg_links "
                "WHERE chat_id = ? AND agent_row_id IS NOT NULL",
                (chat_id,),
            )
        }
        claimed = {
            str(r["agent_row_id"]) for r in db.fetchall(
                "SELECT agent_row_id FROM turn_links WHERE chat_id = ?",
                (chat_id,),
            )
        }
        open_row = db.fetchone(
            "SELECT MIN(hwm_open) AS lo FROM turn_observations "
            "WHERE chat_id = ? AND status = 'open'",
            (chat_id,),
        )
    except Exception:
        return None
    open_lo = open_row["lo"] if open_row and open_row["lo"] is not None else None

    live = 0
    pending = 0
    unlinked_live: List[str] = []
    claimed_missing: List[str] = []
    candidate_rows: List[Any] = []
    state_ids = set()
    for r in rows:
        rid = str(r["id"])
        state_ids.add(rid)
        content = r["content"] or ""
        active = _row_get(r, "active", 1)
        compacted = _row_get(r, "compacted", 0)
        if active in (0, "0", False) and compacted in (0, "0", False, None):
            continue  # /undo soft-delete — retracted, not missing.
        if _is_compaction_seed(content):
            continue  # machinery — never served, never missing.
        if rid in dup_ids:
            continue  # compaction-replay copy — its original represents it.
        if (r["role"] or "") == "session_meta":
            continue  # hermes machinery row the client projection ignores.
        live += 1
        if rid in linked:
            continue
        if open_lo is not None and int(r["id"]) > int(open_lo):
            pending += 1  # inside a still-open turn window — not judged yet.
            continue
        ts = r["timestamp"]
        if ts is not None and (now - float(ts)) < MONITOR_RECENT_GRACE_S:
            pending += 1  # too fresh — the close that links it may be in flight.
            continue
        if rid in claimed:
            claimed_missing.append(rid)
        else:
            unlinked_live.append(rid)
        candidate_rows.append(r)

    orphaned_links = sum(1 for a in linked if a not in state_ids)
    return {
        "chat_id": chat_id,
        "state_live": live,
        "represented": live - len(unlinked_live) - len(claimed_missing) - pending,
        "unlinked_live": unlinked_live,
        "claimed_missing": claimed_missing,
        "orphaned_links": orphaned_links,
        "pending": pending,
        "_candidate_rows": candidate_rows,
        # Stats for the next sweep's fast-path (see _stats_unchanged).
        "chain_hwm": int(rows[-1]["id"]) if rows else 0,
        "chain_count": len(rows),
        "links_count": len(linked),
    }


def _current_stats(db, state_db_path, chat_id: str, source: str):
    """The three cheap change detectors: chain MAX(id), chain COUNT,
    and the chat's linked msg_links row count. Any drift shape the
    monitor alarms on moves at least one of them (new rows → hwm/count;
    deletions → count; twin vanished / link severed → links_count).
    Returns None when unreadable (falls through to the full sweep)."""
    try:
        with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
            row = conn.execute(
                _CHAIN_CTE
                + "SELECT COALESCE(MAX(m.id), 0) AS hwm, COUNT(*) AS n "
                "FROM messages m JOIN session_root sr ON m.session_id = sr.id",
                (chat_id, source),
            ).fetchone()
        links = db.fetchone(
            "SELECT COUNT(*) AS n FROM msg_links "
            "WHERE chat_id = ? AND agent_row_id IS NOT NULL",
            (chat_id,),
        )
        return (int(row["hwm"]), int(row["n"]), int(links["n"]))
    except Exception:
        return None


def _fingerprint(snap: Dict[str, Any]) -> str:
    return "%d:%d:%s:%s" % (
        len(snap["unlinked_live"]), len(snap["claimed_missing"]),
        ",".join(snap["unlinked_live"][:5]),
        ",".join(snap["claimed_missing"][:5]),
    )


def sweep_chat_sync(
    db, state_db_path, chat_id: str, source: str = SIDEKICK_SOURCE,
    *, now: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """One monitor sweep for a MARKED chat (worker thread only —
    O(history) walk on the full path). Returns the health snapshot, or
    None for unmarked chats / unreachable state.db (both: no opinion,
    no alarm). Alert-only: NOTHING is written to msg_links here."""
    if db is None or state_db_path is None:
        return None
    from . import parley_chat_migration as _migration  # noqa: WPS433
    if _migration.get_migration(db, chat_id) is None:
        return None

    prev = _health.get(chat_id)
    stats = _current_stats(db, state_db_path, chat_id, source)
    if prev is not None and stats is not None and stats == (
        prev.get("chain_hwm"), prev.get("chain_count"), prev.get("links_count"),
    ):
        # Fast-path: nothing moved since the last full sweep — reuse
        # its verdict (steady-state polls must not re-walk history;
        # the reconcile fast-path lesson, 2026-06-23).
        prev["swept_at"] = time.time() if now is None else now
        return prev

    snap = _collect_sync(db, state_db_path, chat_id, source, now=now)
    if snap is None:
        return None
    snap.pop("_candidate_rows", None)
    degraded = bool(snap["unlinked_live"] or snap["claimed_missing"])
    snap["status"] = "degraded" if degraded else "healthy"
    snap["swept_at"] = time.time() if now is None else now
    _health[chat_id] = snap

    # Count summary on the perf-trace stderr channel (journald keeps
    # stderr; logger.info dies at the gateway's WARN-and-up config).
    # Full sweeps only — the fast-path above returns before here.
    print(
        f"[perf-trace INFO] [parley] transcript-monitor chat={chat_id} "
        f"status={snap['status']} live={snap['state_live']} "
        f"represented={snap['represented']} "
        f"unlinked_live={len(snap['unlinked_live'])} "
        f"claimed_missing={len(snap['claimed_missing'])} "
        f"orphaned_links={snap['orphaned_links']} pending={snap['pending']}",
        flush=True, file=sys.stderr,
    )
    if degraded:
        fp = _fingerprint(snap)
        if _warned.get(chat_id) != fp:
            _warned[chat_id] = fp
            first = (snap["unlinked_live"] or snap["claimed_missing"])[0]
            logger.warning(
                "[parley] transcript-diverge chat=%s unlinked_live=%d "
                "claimed_missing=%d first_row=%s — these messages are "
                "invisible/liveness-blind on the v3 read; repair via "
                "orphan-adopt (POST /v1/transcript/adopt-orphans) or "
                "offline repair (POST /v1/transcript/repair). No auto-heal "
                "by design.",
                chat_id, len(snap["unlinked_live"]),
                len(snap["claimed_missing"]), first,
            )
    else:
        _warned.pop(chat_id, None)
    return snap


def build_transcript_health(db=None) -> Dict[str, Any]:
    """The ``transcript_health`` diagnostics blob (push_health pattern:
    served on /v1/push/health + /v1/transcript/health, folded into the
    proxy's diagnostics response). Aggregates the in-process sweep
    registry; ``migrated_chats`` comes from the durable marker table
    when a db handle is supplied."""
    from .parley_turn_linker import reconcile_retired  # noqa: WPS433

    degraded = [
        {
            "chat_id": chat_id,
            "unlinked_live": len(snap["unlinked_live"]),
            "claimed_missing": len(snap["claimed_missing"]),
            "swept_at": snap.get("swept_at"),
        }
        for chat_id, snap in sorted(_health.items())
        if snap.get("status") == "degraded"
    ]
    sweep_times = [
        snap.get("swept_at") for snap in _health.values()
        if snap.get("swept_at") is not None
    ]
    out: Dict[str, Any] = {
        "status": "degraded" if degraded else "healthy",
        "chats_swept": len(_health),
        "degraded": degraded,
        "last_sweep_at": max(sweep_times) if sweep_times else None,
        "reconcile_retired": reconcile_retired(),
    }
    if db is not None:
        try:
            row = db.fetchone("SELECT COUNT(*) AS n FROM chat_migrations")
            out["migrated_chats"] = int(row["n"]) if row else 0
        except Exception:
            pass
    return out


def adopt_orphans_sync(
    db, state_db_path, chat_id: str, source: str = SIDEKICK_SOURCE,
    *, confirm: bool = False, now: Optional[float] = None,
) -> Dict[str, Any]:
    """Orphan-adopt repair (assisted, explicit — NEVER automatic): for
    one MARKED chat, import the unlinked live state rows into msg_links
    as ``legacy:<id>`` twins — the exact representation the backfill
    legacy import uses (shared insert_legacy_twin). Candidate set =
    the monitor's degrading set (same exclusions: machinery, dups,
    session_meta, retracted, open-window, grace), so what it adopts is
    exactly what the WARNING complained about.

    Default is a DRY RUN: returns the candidate list without writing.
    ``confirm=True`` performs the import (idempotent — adopted rows
    leave the candidate set). Worker thread only."""
    if db is None or state_db_path is None:
        return {"ok": False, "error": "unconfigured"}
    from . import parley_chat_migration as _migration  # noqa: WPS433
    if _migration.get_migration(db, chat_id) is None:
        # Unmarked chats belong to the legacy reconcile path — adopting
        # here would race its own import.
        return {"ok": False, "error": "chat_not_migrated", "chat_id": chat_id}
    snap = _collect_sync(db, state_db_path, chat_id, source, now=now)
    if snap is None:
        return {"ok": False, "error": "state_unreachable", "chat_id": chat_id}
    candidate_rows = snap.pop("_candidate_rows")
    candidates = [
        {
            "id": str(r["id"]),
            "role": r["role"],
            "content_head": (r["content"] or "")[:120],
            "timestamp": r["timestamp"],
            "claimed": str(r["id"]) in set(snap["claimed_missing"]),
        }
        for r in candidate_rows
    ]
    if not confirm:
        # Show, don't touch — the operator reviews this list first.
        print(
            f"[perf-trace INFO] [parley] orphan-adopt DRY-RUN "
            f"chat={chat_id} candidates={len(candidates)}",
            flush=True, file=sys.stderr,
        )
        return {
            "ok": True, "dry_run": True, "chat_id": chat_id,
            "adopted": 0, "adopted_ids": [], "candidates": candidates,
        }
    adopted_ids: List[str] = []
    for r in candidate_rows:
        try:
            if insert_legacy_twin(db, chat_id, r):
                adopted_ids.append(str(r["id"]))
        except Exception:
            continue
    # Operator action — journald-visible (WARNING, matching the alert
    # channel it answers), plus refresh the health registry so the
    # diagnostics flip back without waiting for the next poll.
    logger.warning(
        "[parley] orphan-adopt chat=%s adopted=%d ids=%s",
        chat_id, len(adopted_ids), ",".join(adopted_ids[:20]),
    )
    sweep_chat_sync(db, state_db_path, chat_id, source, now=now)
    return {
        "ok": True, "dry_run": False, "chat_id": chat_id,
        "adopted": len(adopted_ids), "adopted_ids": adopted_ids,
        "candidates": candidates,
    }
