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
    (the pre-aa81f4f status-bubble/tr: zip class, healed below).

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

SCHEMA_VERSION = 1


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
    if healed:
        # WARNING so the heal is journald-visible (per-chat pre-heal
        # counts also land in the marker stats below).
        logger.warning(
            "[sidekick] chat-migration healed %d pre-fix orchestration "
            "mislink(s) chat=%s", healed, chat_id,
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
