"""Turn-end deterministic linker — transcript v3 Phase 1 (DARK LAUNCH).

WHY this module exists: two field incidents in two days (2026-07-15/16)
traced to the same root — the transcript's envelope↔state.db identity is
*inferred after the fact* by content matching, timestamp windows, and
positional zips over the whole session. Every hermes-core update that
changes a write pattern (0.18's compaction re-flush, /retry rewrites)
mints a new duplicate/reorder shape faster than heuristics can be
enumerated. v3 replaces inference with one deterministic capture at the
only moment the truth is cheaply knowable: **turn end**. See
``workspace/documents/agent-development/
parley-transcript-v3-deterministic-link-design-2026-07-16.md``.

Phase 1 is a dark launch:

  * A watermark (``hwm_open`` = MAX(messages.id) over the chat's session
    chain) is captured in ``handle_responses`` BEFORE ``_dispatch_message``
    can run — race-free by construction, since hermes-core only appends
    the turn's rows during/after dispatch.
  * At ``reply_final`` (and for background turns, at the ``notification``
    envelope) the window ``hwm_open < id <= hwm_close`` is classified by
    ``classify_window_rows`` — a PURE, structure-only function. NO content
    matching, ever: tool rows pair by exact ``tool_call_id``; the user row
    pairs by being the single user row in a single-turn window; the final
    assistant row pairs positionally within the window (content equality
    deliberately NOT required — hermes post-persist mutations like
    explainer footers made content matching the bug, not the fix).
  * Links land in SHADOW tables (``turn_links`` / ``turn_observations``,
    see parley_db.py). For unmarked chats the content-matching
    reconcile stays authoritative and ``compare_and_log`` diffs the two
    opinions after each background reconcile (ONE ``linker-soak``
    journal line per chat with anything to report).

Phase 4 (2026-07-30, ``PARLEY_RECONCILE_RETIRED``, default ON): for
chats holding a current-version ``chat_migrations`` marker the linker
is the REAL link writer — turn-close claims stamp
``msg_links.agent_row_id`` directly (``_stamp_claims_sync``: linker
claim fills NULL, wins over a reconcile-minted value, never overwrites
another linker claim) and mint the orchestration ``legacy:<id>`` twins.
The background chain (parley_route_items) retires the content
reconcile for those chats; Phase 5's divergence monitor
(parley_transcript_monitor) replaces both the reconcile safety net
and the linker-soak compare there. Reconcile survives untouched as the
offline repair tool (parley_chat_migration.repair_chat_sync).

Interrupted turns are closed by the *next-turn-start barrier*
(``flush_pending_capture``): opening a new watermark first captures any
still-open window as ``status='aborted'`` — whatever rows landed are
classified with the same rules. Rows appended while the plugin was down
(gateway restart, terminal use) become ONE ``status='unobserved'``
observation with the gap bounds and zero claims.

Kill switch: ``PARLEY_TURN_LINKER=0`` disables everything (default on).

Threading: the ``*_sync`` internals do sqlite work and MUST NOT run on
the asyncio loop thread — the public coroutines route them through
``run_in_parley_worker`` (same discipline as reconcile, see the
2026-06-23 loop-starvation incident notes in parley_state.py).
state.db is opened ``mode=ro`` only; parley.db writes go through the
lock-guarded ParleyDB handle.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from .parley_env import env_get
import re
import sqlite3
import sys
import time
from typing import Any, Dict, List, Optional, Set

from .parley_ids import SIDEKICK_SOURCE
from .parley_state import _is_compaction_seed

logger = logging.getLogger(__name__)

# Fire-and-forget close tasks — held so they aren't GC'd mid-flight
# (same pattern as parley_route_items._reconcile_tasks).
_close_tasks: Set["asyncio.Task"] = set()

# Per-chat high-water mark of already-compared observations
# (closed_at). compare_and_log only reports NEW turns / divergences so
# the soak line doesn't spam every items poll. Process-level CACHE
# only — the durable copy lives in parley.db linker_compare_state
# (see _load_compare_hwm): in-memory-only marks reset on every gateway
# restart, so compare re-swept full history and re-WARNed stale
# pre-fix links forever (2026-07-28 re-soak forensics).
_compare_hwm: Dict[str, float] = {}


def _load_compare_hwm(db, chat_id: str) -> float:
    """Compared-through mark for one chat: process cache first, then
    the durable linker_compare_state row (0.0 for a never-compared
    chat)."""
    cached = _compare_hwm.get(chat_id)
    if cached is not None:
        return cached
    hwm = 0.0
    try:
        row = db.fetchone(
            "SELECT compared_through FROM linker_compare_state WHERE chat_id = ?",
            (chat_id,),
        )
        if row and row["compared_through"] is not None:
            hwm = float(row["compared_through"])
    except Exception:
        pass
    _compare_hwm[chat_id] = hwm
    return hwm


def _store_compare_hwm(db, chat_id: str, value: float) -> None:
    """Durable write-through of the compare mark. The MAX() guard keeps
    a stale writer from ever moving the mark backwards."""
    _compare_hwm[chat_id] = value
    try:
        db.exec(
            "INSERT INTO linker_compare_state (chat_id, compared_through) "
            "VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET "
            "compared_through = MAX(linker_compare_state.compared_through, "
            "excluded.compared_through)",
            (chat_id, value),
        )
    except Exception:
        pass


def enabled() -> bool:
    """Env kill switch. PARLEY_TURN_LINKER, default '1'; '0' disables
    watermark capture, close/link, and the soak comparison entirely."""
    return env_get("PARLEY_TURN_LINKER", "1").strip().lower() not in (
        "0", "false", "no",
    )


def reconcile_retired() -> bool:
    """Transcript v3 Phase 4 flag: ``PARLEY_RECONCILE_RETIRED``,
    default ON (approved 2026-07-30). While set, the linker is promoted
    from dark shadow-writer to the REAL link writer: for migrated
    ("marked") chats its turn-close claims stamp
    ``msg_links.agent_row_id`` (and mint the orchestration rows'
    ``legacy:<id>`` twins), and the background items-poll chain retires
    the content reconcile for chats v3 actually serves — Phase 5's
    divergence monitor takes reconcile's slot there.

    Independently revertible: '0' restores the full Phase-3 posture
    (reconcile maintains links, linker back to shadow tables only)
    WITHOUT touching ``PARLEY_ITEMS_V3`` serving — the v3 read never
    cares who wrote agent_row_id."""
    return env_get("PARLEY_RECONCILE_RETIRED", "1",
    ).strip().lower() not in ("0", "false", "no")


# ── Slash-command gate ────────────────────────────────────────────────
#
# A dispatched slash command (/status, /model …) is intercepted by the
# gateway and never persists a user row to state.db. The user-row rule
# must therefore not claim ANY user row for such a turn — the only user
# row in the window would be somebody else's (e.g. a replayed copy).
# Detection mirrors the /v1/commands catalog: hermes_cli.commands'
# is_gateway_known_command when importable (production — the plugin
# runs inside the gateway process), else a conservative shape check
# (any leading /word counts as a command; skipping a claim is safe,
# mis-claiming is not).

_COMMAND_SHAPE_RE = re.compile(r"^/[A-Za-z][\w-]*$")


def _is_slash_command_text(text: Optional[str]) -> bool:
    if not isinstance(text, str):
        return False
    t = text.strip()
    # The voice flag is prepended before dispatch (see handle_responses);
    # strip it so a dictated command still gates.
    if t.startswith("[voice]"):
        t = t[len("[voice]"):].lstrip()
    if not t.startswith("/"):
        return False
    first = t.split(None, 1)[0]
    if not _COMMAND_SHAPE_RE.match(first):
        return False
    name = first[1:].lower()
    try:
        from hermes_cli.commands import is_gateway_known_command  # noqa: WPS433
        return bool(is_gateway_known_command(name))
    except Exception:
        # Registry unavailable (test rigs) — conservative: treat any
        # command-shaped text as a command. An unclaimed genuine user
        # row surfaces in the soak counts; a mis-claimed one corrupts
        # identity.
        return True


def _row_get(row: Any, key: str, default: Any = None) -> Any:
    """Field access that works for sqlite3.Row AND plain dicts, tolerating
    absent columns (older fixtures without ``active``)."""
    try:
        if key in row.keys():
            return row[key]
    except AttributeError:
        pass
    return default


def _call_ids_from_tool_calls(raw: Any) -> Optional[Set[str]]:
    """Call-id set from a state.db assistant row's tool_calls JSON.
    Empty set for no orchestration; None when the payload is present but
    unparseable (treated as foreign — can't verify subset)."""
    if not raw:
        return set()
    try:
        entries = json.loads(raw)
    except Exception:
        return None
    if not isinstance(entries, list):
        return None
    out: Set[str] = set()
    for e in entries:
        if isinstance(e, dict):
            cid = e.get("id") or e.get("call_id")
            if isinstance(cid, str) and cid:
                out.add(cid)
    return out


# ── The pure core ─────────────────────────────────────────────────────

def classify_window_rows(
    rows: List[Any],
    *,
    turn_call_ids: Any = frozenset(),
    user_message_id: Optional[str] = None,
    user_text: Optional[str] = None,
    user_is_command: Optional[bool] = None,
    final_message_id: Optional[str] = None,
    already_linked_ids: Any = frozenset(),
    count_at_open: Optional[int] = None,
    chain_count_at_open_now: Optional[int] = None,
    background: bool = False,
) -> Dict[str, Any]:
    """Deterministically pair one turn window's state.db rows with the
    turn's envelope ids. PURE — no I/O, no content matching. Rules (in
    order; each row claimed at most once):

      1. Pre-exclude rows already linked in msg_links.agent_row_id
         (covers _persist_notification's deterministic mid-turn links)
         and compaction machinery rows; machinery presence sets flag
         ``compaction_flush``.
      2. Replay/rewrite guards (structure only): foreign tool rows /
         foreign orchestration rows are never claimed; a shrunk
         pre-window chain (``chain_count_at_open_now < count_at_open``)
         flags ``history_rewrite`` (a /retry deleted+reinserted the
         chain) — in such a window only rules 3/5/6 targets are claimed,
         never the user row.
      3. tool rows ↔ ``tr:<call_id>`` by exact tool_call_id.
      4. THE single non-excluded user row ↔ the turn's umsg_*; skipped
         for slash-command turns; >1 user rows → claim none + flag
         ``ambiguous_user``.
      5. assistant rows whose tool_calls ⊆ the turn's call-id set →
         claimed with msg_id=NULL (no envelope exists; the comparison
         treats reconcile's legacy:<id> twin as agreement).
      6. the LAST non-excluded plain assistant row ↔ reply_final's
         msg_*. Content equality NOT required. No such row → flag
         ``final_no_row`` (expected when final_response is empty).
      7. leftovers → unclaimed with a reason; background windows claim
         nothing beyond rule-1 exclusions.

    Returns ``{claims, unclaimed, flags, prelinked_ids, machinery_ids,
    inactive_ids, history_rewrite, user_is_command}`` where claims is a
    list of ``{agent_row_id, msg_id, method}`` and unclaimed maps
    agent_row_id → reason.
    """
    flags: Set[str] = set()
    claims: List[Dict[str, Any]] = []
    unclaimed: Dict[str, str] = {}
    prelinked_ids: List[str] = []
    machinery_ids: List[str] = []
    inactive_ids: List[str] = []
    call_ids = {str(c) for c in (turn_call_ids or ()) if c}
    linked = {str(x) for x in (already_linked_ids or ())}
    if user_is_command is None:
        user_is_command = _is_slash_command_text(user_text)

    # Rule 1 — pre-exclusions + active snapshot.
    work: List[Dict[str, Any]] = []
    for r in rows:
        rid = str(_row_get(r, "id"))
        content = _row_get(r, "content") or ""
        active = _row_get(r, "active", 1)
        if active in (0, "0", False):
            inactive_ids.append(rid)
        if rid in linked:
            prelinked_ids.append(rid)
            continue
        if _is_compaction_seed(content):
            machinery_ids.append(rid)
            flags.add("compaction_flush")
            continue
        work.append({
            "id": rid,
            "role": _row_get(r, "role") or "",
            "tool_call_id": _row_get(r, "tool_call_id") or "",
            "tool_calls": _row_get(r, "tool_calls") or "",
        })

    # Rule 2 — history-rewrite guard: /retry deleted + reinserted the
    # whole chain mid-window, so the pre-window row count SHRANK. The
    # window then holds reinserted history — positional/singleton
    # heuristics (the user rule) are void; only exact-id rules (3/5)
    # and the final may claim.
    history_rewrite = (
        count_at_open is not None
        and chain_count_at_open_now is not None
        and chain_count_at_open_now < count_at_open
    )
    if history_rewrite:
        flags.add("history_rewrite")

    # Rules 2/3/5 walk + bucket users / plain assistants for 4/6.
    user_rows: List[Dict[str, Any]] = []
    plain_assistant: List[Dict[str, Any]] = []
    for row in work:
        role = row["role"]
        if role == "tool":
            # Rule 3 gated by rule 2: exact tool_call_id membership in
            # THIS turn's envelope call-id set. A replayed/foreign tool
            # row (old call id) is never claimed.
            cid = row["tool_call_id"]
            if cid and cid in call_ids:
                claims.append({
                    "agent_row_id": row["id"],
                    "msg_id": f"tr:{cid}",
                    "method": "tool_call_id",
                })
            else:
                unclaimed[row["id"]] = "foreign_tool"
        elif role == "assistant":
            tc_ids = _call_ids_from_tool_calls(row["tool_calls"])
            if tc_ids is None:
                # Present but unparseable — can't verify ownership.
                unclaimed[row["id"]] = "foreign_orchestration"
            elif tc_ids:
                # Rule 5 gated by rule 2: the orchestration's call ids
                # must ALL belong to this turn.
                if tc_ids <= call_ids:
                    claims.append({
                        "agent_row_id": row["id"],
                        "msg_id": None,
                        "method": "orchestration",
                    })
                else:
                    unclaimed[row["id"]] = "foreign_orchestration"
            else:
                plain_assistant.append(row)
        elif role == "user":
            user_rows.append(row)
        else:
            unclaimed[row["id"]] = "unrecognized_role"

    # Rule 4 — the user row. Only when the window is a normal observed
    # turn: never in a rewrite window (reinserted copies), never for a
    # gateway-intercepted slash command (no user row persists — any
    # user row present is someone else's), never for background
    # windows, and never when >1 candidate (ambiguous — claim none).
    if background:
        for row in user_rows:
            unclaimed[row["id"]] = "background"
    elif history_rewrite:
        for row in user_rows:
            unclaimed[row["id"]] = "history_rewrite"
    elif user_is_command:
        for row in user_rows:
            unclaimed[row["id"]] = "command_turn"
    elif not user_message_id:
        for row in user_rows:
            unclaimed[row["id"]] = "no_user_envelope"
    elif len(user_rows) == 1:
        claims.append({
            "agent_row_id": user_rows[0]["id"],
            "msg_id": user_message_id,
            "method": "user",
        })
    elif len(user_rows) > 1:
        flags.add("ambiguous_user")
        for row in user_rows:
            unclaimed[row["id"]] = "ambiguous_user"

    # Rule 6 — the final assistant row.
    if background:
        for row in plain_assistant:
            unclaimed[row["id"]] = "background"
    elif final_message_id:
        if plain_assistant:
            claims.append({
                "agent_row_id": plain_assistant[-1]["id"],
                "msg_id": final_message_id,
                "method": "final",
            })
            for row in plain_assistant[:-1]:
                unclaimed[row["id"]] = "intermediate_assistant"
        else:
            flags.add("final_no_row")
    else:
        for row in plain_assistant:
            unclaimed[row["id"]] = "no_final_envelope"

    return {
        "claims": claims,
        "unclaimed": unclaimed,
        "flags": sorted(flags),
        "prelinked_ids": prelinked_ids,
        "machinery_ids": machinery_ids,
        "inactive_ids": inactive_ids,
        "history_rewrite": history_rewrite,
        "user_is_command": bool(user_is_command),
    }


# ── state.db chain queries (mode=ro) ─────────────────────────────────
#
# Same recursive CTE as parley_state's reconcile / items readers:
# roll compaction-rotated child sessions (user_id=NULL, matching
# system-prompt head) up under the requested chat_id.

_CHAIN_CTE = """
    WITH RECURSIVE session_root(id, root_system_prompt) AS (
        SELECT id, system_prompt FROM sessions
         WHERE user_id = ? AND source = ?
        UNION ALL
        SELECT s.id, sr.root_system_prompt
          FROM sessions s
          JOIN session_root sr ON s.parent_session_id = sr.id
         WHERE s.user_id IS NULL
           AND LENGTH(COALESCE(sr.root_system_prompt, '')) >= 200
           AND SUBSTR(COALESCE(s.system_prompt, ''), 1, 200)
               = SUBSTR(sr.root_system_prompt, 1, 200)
    )
"""


def _connect_state_ro(state_db_path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{state_db_path}?mode=ro", uri=True, timeout=2.0)
    conn.row_factory = sqlite3.Row
    return conn


def _chain_stats(conn, chat_id: str, source: str, *, upto: Optional[int] = None):
    """(MAX(id), COUNT(*)) over the chat's session-chain rows,
    optionally bounded to ``id <= upto``."""
    sql = (
        _CHAIN_CTE
        + "SELECT COALESCE(MAX(m.id), 0) AS hwm, COUNT(*) AS n "
        "FROM messages m JOIN session_root sr ON m.session_id = sr.id"
    )
    params: list = [chat_id, source]
    if upto is not None:
        sql += " WHERE m.id <= ?"
        params.append(upto)
    row = conn.execute(sql, params).fetchone()
    return (int(row["hwm"]), int(row["n"])) if row else (0, 0)


def _window_rows(conn, chat_id: str, source: str, lo: int, hi: int) -> List[Any]:
    """Chain rows ``lo < id <= hi`` ORDER BY id. Selects ``active`` when
    the live schema has it (it does since hermes 0.18); falls back
    without for older fixtures."""
    base = (
        "SELECT m.id, m.role, m.content, m.tool_call_id, m.tool_calls, "
        "m.timestamp{active} "
        "FROM messages m JOIN session_root sr ON m.session_id = sr.id "
        "WHERE m.id > ? AND m.id <= ? ORDER BY m.id ASC"
    )
    params = (chat_id, source, lo, hi)
    try:
        return list(conn.execute(
            _CHAIN_CTE + base.format(active=", m.active"), params
        ).fetchall())
    except sqlite3.OperationalError:
        return list(conn.execute(
            _CHAIN_CTE + base.format(active=""), params
        ).fetchall())


def _already_linked_in_range(db, chat_id: str, lo: int, hi: int) -> Set[str]:
    """state.db ids in (lo, hi] that msg_links has already linked —
    rule-1 pre-exclusions (mid-turn notification links, prior turns)."""
    try:
        rows = db.fetchall(
            "SELECT agent_row_id FROM msg_links "
            "WHERE chat_id = ? AND agent_row_id IS NOT NULL "
            "AND CAST(agent_row_id AS INTEGER) > ? "
            "AND CAST(agent_row_id AS INTEGER) <= ?",
            (chat_id, lo, hi),
        )
        return {str(r["agent_row_id"]) for r in rows}
    except Exception:
        return set()


def _entry_snapshot(entry: Any) -> Optional[Dict[str, Any]]:
    """Plain-dict snapshot of a TurnEntry (taken on the loop thread —
    the entry is popped from the buffer at reply_final, so the worker
    can't fetch it later)."""
    if entry is None:
        return None
    return {
        "user_message_id": getattr(entry, "user_message_id", "") or "",
        "user_text": getattr(entry, "user_message", None),
        "final_message_id": getattr(entry, "final_message_id", "") or "",
        "call_ids": set(getattr(entry, "call_ids", ()) or ()),
    }


# ── sync internals (worker thread only) ───────────────────────────────

def _stamp_claims_sync(db, chat_id: str, claims, window_rows) -> Dict[str, int]:
    """Phase 4 — the deterministic write-time link becomes the REAL
    link: project one closed window's claims into ``msg_links`` for a
    MARKED chat (callers gate on the marker + ``reconcile_retired()``).

    Precedence, per claim (deliberate — see the Phase-4 plan):

      * envelope link NULL → fill it (the steady-state write-through
        case: the envelope row exists, the link doesn't yet);
      * envelope link differs and the existing value is NOT a linker
        claim for this envelope (no ``turn_links`` row pairs them) →
        the value is reconcile-minted content inference — the
        deterministic claim WINS and overwrites it;
      * envelope link differs but ``turn_links`` shows an earlier
        linker claim paired exactly (existing_row ↔ this envelope) →
        NEVER overwrite another linker claim: first stamp stands;
      * missing envelope row → skip. Write-through owns envelope
        bodies; the stamp never invents one (decision memo 3 —
        invisibility over invention). The divergence monitor flags the
        resulting unrepresented row.
      * orchestration claims (msg_id=None — no envelope exists by
        construction) → mint the ``legacy:<id>`` twin via the SHARED
        legacy-import representation (parley_state.insert_legacy_twin,
        the same shape reconcile's Pass 2 / the backfill import mint).
        Exact-id, zero content inference. Without this, every fresh
        tool-using turn on a retired chat would lose its orchestration
        row (the PWA's tool-name/args source on reload).

    Returns counters (filled/overrode/kept/minted/skipped) for the
    perf-trace breadcrumb. Worker thread only (sqlite writes)."""
    from .parley_state import insert_legacy_twin  # noqa: WPS433

    row_map = {str(_row_get(r, "id")): r for r in window_rows}
    counts = {"filled": 0, "overrode": 0, "kept": 0, "minted": 0, "skipped": 0}
    now = time.time()
    for c in claims:
        arid = str(c["agent_row_id"])
        msg_id = c["msg_id"]
        if msg_id is None:
            row = row_map.get(arid)
            if row is None:
                counts["skipped"] += 1
                continue
            try:
                if insert_legacy_twin(db, chat_id, row):
                    counts["minted"] += 1
            except Exception:
                counts["skipped"] += 1
            continue
        link = db.fetchone(
            "SELECT agent_row_id FROM msg_links WHERE id = ? AND chat_id = ?",
            (msg_id, chat_id),
        )
        if link is None:
            counts["skipped"] += 1
            continue
        existing = link["agent_row_id"]
        if existing is not None and str(existing) == arid:
            continue  # already the deterministic link — nothing to do.
        if existing is not None:
            prior = db.fetchone(
                "SELECT msg_id FROM turn_links "
                "WHERE chat_id = ? AND agent_row_id = ?",
                (chat_id, str(existing)),
            )
            if prior is not None and prior["msg_id"] == msg_id:
                counts["kept"] += 1  # an earlier linker claim owns this pair.
                continue
        try:
            db.exec(
                "UPDATE msg_links SET agent_row_id = ?, updated_at = ? "
                "WHERE id = ?",
                (arid, now, msg_id),
            )
            counts["overrode" if existing is not None else "filled"] += 1
        except Exception:
            counts["skipped"] += 1
    return counts


def _chat_is_marked(db, chat_id: str) -> bool:
    """Current-SCHEMA_VERSION migration marker present? (Lazy import —
    parley_chat_migration imports from this module at load time.)"""
    from . import parley_chat_migration as _migration  # noqa: WPS433
    try:
        return _migration.get_migration(db, chat_id) is not None
    except Exception:
        return False


def _capture_window_sync(
    db, state_db_path, chat_id: str, source: str, obs_row: Any,
    *, trigger: Optional[Dict[str, Any]], entry_snapshot: Optional[Dict[str, Any]],
    status: str,
) -> None:
    """Close one open observation: capture hwm_close, classify the
    window, write turn_links claims, finalize the observation row."""
    turn_id = obs_row["turn_id"]
    hwm_open = int(obs_row["hwm_open"])
    count_at_open = obs_row["count_at_open"]
    try:
        prev_flags = json.loads(obs_row["flags"] or "{}")
        if not isinstance(prev_flags, dict):
            prev_flags = {}
    except Exception:
        prev_flags = {}

    with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
        hwm_close, _total = _chain_stats(conn, chat_id, source)
        rows = _window_rows(conn, chat_id, source, hwm_open, hwm_close)
        chain_count_now = _chain_stats(conn, chat_id, source, upto=hwm_open)[1]

    linked = _already_linked_in_range(db, chat_id, hwm_open, hwm_close)
    snap = entry_snapshot or {}
    user_message_id: Optional[str] = snap.get("user_message_id") or None
    if user_message_id is None and status != "background" \
            and not str(turn_id).startswith(("gap:", "notif_")):
        # Plugin restarted mid-turn (in-memory TurnEntry lost): the
        # observation's turn_id IS the umsg, so the user claim survives.
        user_message_id = str(turn_id)
    final_message_id = snap.get("final_message_id") or None
    if final_message_id is None and trigger \
            and trigger.get("type") == "reply_final":
        mid = trigger.get("message_id")
        final_message_id = mid if isinstance(mid, str) and mid else None
    user_is_command = bool(prev_flags.get("cmd"))
    if not user_is_command and snap.get("user_text") is not None:
        user_is_command = _is_slash_command_text(snap.get("user_text"))

    result = classify_window_rows(
        rows,
        turn_call_ids=snap.get("call_ids") or set(),
        user_message_id=user_message_id,
        user_is_command=user_is_command,
        final_message_id=final_message_id,
        already_linked_ids=linked,
        count_at_open=count_at_open,
        chain_count_at_open_now=chain_count_now,
        background=(status == "background"),
    )

    now = time.time()
    for c in result["claims"]:
        db.exec(
            "INSERT OR REPLACE INTO turn_links "
            "(chat_id, msg_id, agent_row_id, turn_id, method, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (chat_id, c["msg_id"], c["agent_row_id"], turn_id, c["method"], now),
        )
    # Phase 4 (2026-07-30, PARLEY_RECONCILE_RETIRED): for marked
    # chats the claims ALSO stamp msg_links — the deterministic
    # write-time link is the real link now that the content reconcile
    # no longer maintains it for these chats. Aborted windows stamp
    # too (an interrupted turn's rows keep their liveness links);
    # background/gap windows have no claims by design. Unmarked chats
    # stay dark (reconcile owns their links until migration).
    if result["claims"] and reconcile_retired() and _chat_is_marked(db, chat_id):
        try:
            stamped = _stamp_claims_sync(db, chat_id, result["claims"], rows)
            if any(stamped.values()):
                print(
                    f"[perf-trace INFO] [parley] linker-stamp "
                    f"chat={chat_id} turn={turn_id} "
                    f"filled={stamped['filled']} minted={stamped['minted']} "
                    f"overrode={stamped['overrode']} kept={stamped['kept']} "
                    f"skipped={stamped['skipped']}",
                    flush=True, file=sys.stderr,
                )
        except Exception as exc:
            logger.warning(
                "[parley] linker-stamp failed chat=%s turn=%s: %s",
                chat_id, turn_id, exc,
            )
    flags_obj = dict(prev_flags)
    for key, value in (
        ("flags", result["flags"]),
        ("unclaimed", result["unclaimed"]),
        ("inactive_ids", result["inactive_ids"]),
        ("prelinked_ids", result["prelinked_ids"]),
    ):
        if value:
            flags_obj[key] = value
    env_count = (
        (0 if (user_is_command or not user_message_id) else 1)
        + len(snap.get("call_ids") or ())
        + (1 if final_message_id else 0)
    )
    db.exec(
        "UPDATE turn_observations SET hwm_close = ?, status = ?, flags = ?, "
        "env_count = ?, row_count = ?, claimed = ?, unclaimed = ?, closed_at = ? "
        "WHERE chat_id = ? AND turn_id = ?",
        (
            hwm_close, status, json.dumps(flags_obj),
            env_count, len(rows), len(result["claims"]),
            len(result["unclaimed"]), now, chat_id, turn_id,
        ),
    )


def _flush_pending_sync(
    db, state_db_path, chat_id: str, source: str,
    *, entry_snapshot: Optional[Dict[str, Any]] = None,
) -> int:
    """The barrier: close any still-open window for the chat as
    ``aborted``, claiming whatever rows landed. Runs at next-turn open
    — race-free because the new turn hasn't dispatched yet, so nothing
    of the NEW turn can be in state.db. Returns windows flushed."""
    open_rows = db.fetchall(
        "SELECT * FROM turn_observations WHERE chat_id = ? AND status = 'open' "
        "ORDER BY created_at ASC",
        (chat_id,),
    )
    flushed = 0
    for o in open_rows:
        snap = None
        if entry_snapshot and entry_snapshot.get("user_message_id") == o["turn_id"]:
            snap = entry_snapshot
        _capture_window_sync(
            db, state_db_path, chat_id, source, o,
            trigger=None, entry_snapshot=snap, status="aborted",
        )
        flushed += 1
    return flushed


def _open_sync(
    db, state_db_path, chat_id: str, source: str, turn_id: str,
    *, user_text: Optional[str] = None,
    entry_snapshot: Optional[Dict[str, Any]] = None,
) -> None:
    """Open a turn window: barrier-flush stale windows, record any
    unobserved gap, persist the open observation (survives restart)."""
    _flush_pending_sync(
        db, state_db_path, chat_id, source, entry_snapshot=entry_snapshot,
    )
    with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
        hwm, count = _chain_stats(conn, chat_id, source)
        # Unobserved gap: rows appended between the last persisted
        # watermark and now (plugin down / terminal use) get ONE
        # status='unobserved' observation with the bounds, zero claims.
        last_row = db.fetchone(
            "SELECT MAX(COALESCE(hwm_close, hwm_open)) AS m "
            "FROM turn_observations WHERE chat_id = ?",
            (chat_id,),
        )
        last_hwm = last_row["m"] if last_row and last_row["m"] is not None else None
        now = time.time()
        if last_hwm is not None and hwm > int(last_hwm):
            lo = int(last_hwm)
            gap_count = count - _chain_stats(conn, chat_id, source, upto=lo)[1]
            gap_flags: Dict[str, Any] = {"gap": [lo, hwm]}
            # Compaction detection inside the gap (v3 soak forensics:
            # ALL organic compactions in the 3-day window landed in
            # unobserved gaps — hermes-core's flush happens between
            # observed turns — leaving the linker's compaction
            # detection with zero live coverage; the Phase-2 gate
            # requires "linker observed an organic compaction").
            # Bounded read: the window (lo, hwm] only, same mode=ro
            # connection the stats came from. Machinery-seed presence
            # sets compaction_flush; the soft-deleted-row count rides
            # along as `inactive` (compaction deactivates originals).
            try:
                gap_rows = _window_rows(conn, chat_id, source, lo, hwm)
            except Exception:
                gap_rows = []
            inactive_n = 0
            for r in gap_rows:
                if _is_compaction_seed(_row_get(r, "content") or ""):
                    gap_flags["flags"] = ["compaction_flush"]
                if _row_get(r, "active", 1) in (0, "0", False):
                    inactive_n += 1
            if inactive_n:
                gap_flags["inactive"] = inactive_n
            db.exec(
                "INSERT OR REPLACE INTO turn_observations "
                "(chat_id, turn_id, hwm_open, hwm_close, count_at_open, status, "
                " flags, env_count, row_count, claimed, unclaimed, created_at, "
                " closed_at) "
                "VALUES (?, ?, ?, ?, NULL, 'unobserved', ?, NULL, ?, 0, ?, ?, ?)",
                (
                    chat_id, f"gap:{lo}-{hwm}", lo, hwm,
                    json.dumps(gap_flags),
                    gap_count, gap_count, now, now,
                ),
            )
    flags: Dict[str, Any] = {}
    if _is_slash_command_text(user_text):
        # Persisted at open so the slash gate survives a plugin restart
        # (the TurnEntry snapshot won't).
        flags["cmd"] = True
    db.exec(
        "INSERT OR REPLACE INTO turn_observations "
        "(chat_id, turn_id, hwm_open, count_at_open, status, flags, created_at) "
        "VALUES (?, ?, ?, ?, 'open', ?, ?)",
        (chat_id, turn_id, hwm, count, json.dumps(flags), now),
    )


def _background_capture_sync(
    db, state_db_path, chat_id: str, source: str,
    trigger: Dict[str, Any],
) -> None:
    """Background (notification-triggered) window: no handle_responses
    open exists, so synthesize one spanning (last observed hwm, now]
    and capture it as status='background'. Claims nothing beyond
    rule-1 exclusions — the notification's own row is already
    deterministically linked by _persist_notification."""
    turn_id = (
        trigger.get("sidekick_id") or trigger.get("message_id")
        or f"notif_{int(time.time() * 1000)}"
    )
    last_row = db.fetchone(
        "SELECT MAX(COALESCE(hwm_close, hwm_open)) AS m "
        "FROM turn_observations WHERE chat_id = ?",
        (chat_id,),
    )
    now = time.time()
    with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
        hwm, _count = _chain_stats(conn, chat_id, source)
    if last_row is None or last_row["m"] is None:
        # No prior watermark for this chat — an unanchored window would
        # span the whole history; record an empty anchor instead so the
        # NEXT background turn is bounded.
        db.exec(
            "INSERT OR REPLACE INTO turn_observations "
            "(chat_id, turn_id, hwm_open, hwm_close, count_at_open, status, "
            " flags, env_count, row_count, claimed, unclaimed, created_at, "
            " closed_at) "
            "VALUES (?, ?, ?, ?, NULL, 'background', ?, 0, 0, 0, 0, ?, ?)",
            (chat_id, str(turn_id), hwm, hwm,
             json.dumps({"unanchored": True}), now, now),
        )
        return
    lo = int(last_row["m"])
    db.exec(
        "INSERT OR REPLACE INTO turn_observations "
        "(chat_id, turn_id, hwm_open, count_at_open, status, flags, created_at) "
        "VALUES (?, ?, ?, NULL, 'open', '{}', ?)",
        (chat_id, str(turn_id), lo, now),
    )
    obs = db.fetchone(
        "SELECT * FROM turn_observations WHERE chat_id = ? AND turn_id = ?",
        (chat_id, str(turn_id)),
    )
    _capture_window_sync(
        db, state_db_path, chat_id, source, obs,
        trigger=trigger, entry_snapshot=None, status="background",
    )


def _close_sync(
    db, state_db_path, chat_id: str, source: str,
    trigger_env: Dict[str, Any],
    *, entry_snapshot: Optional[Dict[str, Any]] = None,
) -> None:
    """Turn-end capture. reply_final closes the open window as
    'closed'; a notification with no open window synthesizes a
    background window; a notification DURING an open window is a no-op
    (its row is mid-turn-linked and pre-excluded at that window's
    close). Safe to run post-hoc: hermes-core persists the turn's rows
    strictly BEFORE the plugin sees reply_final (gateway extracts
    final_response only after the agent run — and its single
    end-of-chain persistence step — returns)."""
    etype = trigger_env.get("type")
    open_rows = db.fetchall(
        "SELECT * FROM turn_observations WHERE chat_id = ? AND status = 'open' "
        "ORDER BY created_at ASC",
        (chat_id,),
    )
    if etype == "notification":
        if open_rows:
            return
        _background_capture_sync(db, state_db_path, chat_id, source, trigger_env)
        return
    if not open_rows:
        return
    # Anything older than the newest open window is stale (shouldn't
    # happen — the barrier flushes at open — but never claim the fresh
    # turn's rows into a stale window).
    for o in open_rows[:-1]:
        _capture_window_sync(
            db, state_db_path, chat_id, source, o,
            trigger=None, entry_snapshot=None, status="aborted",
        )
    newest = open_rows[-1]
    snap = entry_snapshot
    if snap and snap.get("user_message_id") \
            and snap["user_message_id"] != newest["turn_id"]:
        snap = None
    _capture_window_sync(
        db, state_db_path, chat_id, source, newest,
        trigger=trigger_env, entry_snapshot=snap, status="closed",
    )


# ── Dark-launch comparison (soak) ─────────────────────────────────────

def compare_and_log(
    db, chat_id: str,
    *, state_db_path=None, closed_before: Optional[float] = None,
) -> Optional[Dict[str, int]]:
    """Diff the linker's shadow decisions against the content-matching
    reconcile's msg_links.agent_row_id for turns not yet compared, and
    emit ONE journal line per chat when there's something to say.

    Called right after reconcile_from_state_db in the background
    reconcile task, so msg_links reflects a fresh reconcile pass.
    ``closed_before`` bounds the comparison to observations closed
    before that reconcile started (a turn closing DURING the pass would
    otherwise be judged against stale links and never re-compared).

    Runs sqlite work — worker thread only. Returns the counts dict for
    tests, or None when nothing was compared.
    """
    if not enabled():
        return None
    hwm = _load_compare_hwm(db, chat_id)
    cutoff = closed_before if closed_before is not None else time.time()
    try:
        obs_rows = db.fetchall(
            "SELECT turn_id, hwm_open, hwm_close, status, flags, closed_at "
            "FROM turn_observations "
            "WHERE chat_id = ? AND status != 'open' AND closed_at IS NOT NULL "
            "AND closed_at > ? AND closed_at <= ? ORDER BY closed_at ASC",
            (chat_id, hwm, cutoff),
        )
    except Exception:
        return None
    if not obs_rows:
        return None

    agree = diverge = linker_only = reconcile_only = gap_rows = dup_call = 0
    first_detail = ""
    for o in obs_rows:
        try:
            flags_obj = json.loads(o["flags"] or "{}")
            if not isinstance(flags_obj, dict):
                flags_obj = {}
        except Exception:
            flags_obj = {}
        prelinked = set(flags_obj.get("prelinked_ids") or [])
        if o["status"] in ("unobserved", "background"):
            # Gap/background windows claim nothing BY DESIGN (zero
            # claims, no envelope ids), so reconcile's links inside
            # them are not divergence — counting them as
            # reconcile_only manufactured the huge counters the v3
            # soak forensics traced to compare-side artifacts. Report
            # the linked-row volume separately so gap coverage stays
            # visible on the soak line.
            if o["hwm_open"] is not None and o["hwm_close"] is not None:
                recon_rows = db.fetchall(
                    "SELECT agent_row_id FROM msg_links "
                    "WHERE chat_id = ? AND agent_row_id IS NOT NULL "
                    "AND CAST(agent_row_id AS INTEGER) > ? "
                    "AND CAST(agent_row_id AS INTEGER) <= ?",
                    (chat_id, int(o["hwm_open"]), int(o["hwm_close"])),
                )
                gap_rows += sum(
                    1 for r in recon_rows
                    if str(r["agent_row_id"]) not in prelinked
                )
            _compare_hwm[chat_id] = max(
                _compare_hwm.get(chat_id, 0.0), float(o["closed_at"]),
            )
            continue
        claims = db.fetchall(
            "SELECT msg_id, agent_row_id, method FROM turn_links "
            "WHERE chat_id = ? AND turn_id = ?",
            (chat_id, o["turn_id"]),
        )
        claimed_arids: Set[str] = set()
        for c in claims:
            arid = str(c["agent_row_id"])
            claimed_arids.add(arid)
            if c["msg_id"]:
                row = db.fetchone(
                    "SELECT agent_row_id FROM msg_links WHERE id = ?",
                    (c["msg_id"],),
                )
                recon = (
                    str(row["agent_row_id"])
                    if row and row["agent_row_id"] is not None else None
                )
                if recon == arid:
                    agree += 1
                elif recon is None:
                    linker_only += 1
                elif _same_tool_call_id(state_db_path, arid, recon):
                    # Superseded-by-compaction: state.db holds BOTH the
                    # original tool row (active=0 compacted=1) and the
                    # re-flush copy under ONE tool_call_id; reconcile
                    # prefers the re-flushed copy while the linker's
                    # append-only claim named the original. Row
                    # identity migrated under compaction — agreement,
                    # not divergence (54 of the 82 divergences in the
                    # 2026-07-28 re-soak were this class).
                    agree += 1
                    dup_call += 1
                else:
                    diverge += 1
                    if not first_detail:
                        first_detail = _divergence_detail(
                            state_db_path, c["msg_id"], arid, recon,
                        )
            else:
                # Orchestration claim (no envelope). Agreement iff
                # reconcile minted the legacy:<id> twin for the row.
                legacy = db.fetchone(
                    "SELECT 1 FROM msg_links WHERE id = ?", (f"legacy:{arid}",),
                )
                if legacy:
                    agree += 1
                else:
                    owner = db.fetchone(
                        "SELECT id FROM msg_links "
                        "WHERE chat_id = ? AND agent_row_id = ?",
                        (chat_id, arid),
                    )
                    if owner:
                        diverge += 1
                        if not first_detail:
                            first_detail = (
                                " first_diverge=(row=%s linker=orchestration "
                                "reconcile=%s)" % (arid, owner["id"])
                            )
                    else:
                        linker_only += 1
        # Reconcile linked rows in this window the linker didn't claim
        # (and didn't pre-exclude as already-linked at capture time).
        # state.db session_meta rows are hermes machinery: the linker
        # leaves them unclaimed (unrecognized_role) while reconcile
        # links a legacy: twin — a permanent structural disagreement,
        # not divergence. Skipped here (compare-side) rather than as
        # classify machinery because reconcile keeps linking them
        # regardless, so a linker-side exclusion alone would still
        # count them reconcile_only forever.
        if o["hwm_open"] is not None and o["hwm_close"] is not None:
            recon_rows = db.fetchall(
                "SELECT agent_row_id, role FROM msg_links "
                "WHERE chat_id = ? AND agent_row_id IS NOT NULL "
                "AND CAST(agent_row_id AS INTEGER) > ? "
                "AND CAST(agent_row_id AS INTEGER) <= ?",
                (chat_id, int(o["hwm_open"]), int(o["hwm_close"])),
            )
            for r in recon_rows:
                if (r["role"] or "") == "session_meta":
                    continue
                a = str(r["agent_row_id"])
                if a not in claimed_arids and a not in prelinked:
                    reconcile_only += 1
        _compare_hwm[chat_id] = max(
            _compare_hwm.get(chat_id, 0.0), float(o["closed_at"]),
        )

    # One durable write per sweep (not per observation) — the loop
    # above advanced the in-memory mark; restarts resume from here.
    _store_compare_hwm(db, chat_id, _compare_hwm.get(chat_id, 0.0))

    counts = {
        "turns": len(obs_rows), "agree": agree, "diverge": diverge,
        "linker_only": linker_only, "reconcile_only": reconcile_only,
        "gap_rows": gap_rows, "dup_call": dup_call,
    }
    line = (
        f"[parley] linker-soak chat={chat_id} turns={counts['turns']} "
        f"agree={agree} diverge={diverge} linker_only={linker_only} "
        f"reconcile_only={reconcile_only} gap_rows={gap_rows} "
        f"dup_call={dup_call}{first_detail}"
    )
    # Soak lines go to stderr in the perf-trace style: the gateway's
    # stdlib logging handler drops sub-WARNING records, so a
    # logger.info soak line never reaches journalctl — and an
    # invisible soak defeats the Phase-1 gate (field 2026-07-20: the
    # first live soak line was emitted and filtered). This perf-trace
    # line is the ONLY one carrying full counts (aggregation-
    # canonical); divergence additionally raises a distinct
    # `linker-soak-diverge` WARNING for alerting, deliberately WITHOUT
    # the counts so grep aggregations never double-count a divergent
    # chat (v3 soak forensics: the double-logged full line inflated
    # count recipes).
    print(f"[perf-trace INFO] {line}", flush=True, file=sys.stderr)
    if diverge:
        logger.warning(
            "[parley] linker-soak-diverge chat=%s diverge=%d%s",
            chat_id, diverge, first_detail,
        )
    return counts


def _same_tool_call_id(state_db_path, arid_a, arid_b) -> bool:
    """True when both state rows exist and carry the SAME non-empty
    tool_call_id — the superseded-by-compaction shape (original +
    re-flush copy of one tool call). Content is deliberately not
    consulted: the compressor rewrites replayed tool results."""
    if state_db_path is None:
        return False
    try:
        with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
            rows = conn.execute(
                "SELECT id, tool_call_id FROM messages WHERE id IN (?, ?)",
                (arid_a, arid_b),
            ).fetchall()
    except Exception:
        return False
    if len(rows) != 2:
        return False
    call_ids = [r["tool_call_id"] or "" for r in rows]
    return bool(call_ids[0]) and call_ids[0] == call_ids[1]


def _divergence_detail(state_db_path, msg_id, linker_arid, recon_arid) -> str:
    """First-divergence breadcrumb incl. whether the two candidate
    state rows carry identical content (harmless dup) or not (real)."""
    content_equal: Optional[bool] = None
    if state_db_path is not None:
        try:
            with contextlib.closing(_connect_state_ro(state_db_path)) as conn:
                rows = {
                    str(r["id"]): r["content"] or ""
                    for r in conn.execute(
                        "SELECT id, content FROM messages WHERE id IN (?, ?)",
                        (linker_arid, recon_arid),
                    ).fetchall()
                }
            if str(linker_arid) in rows and str(recon_arid) in rows:
                content_equal = rows[str(linker_arid)] == rows[str(recon_arid)]
        except Exception:
            content_equal = None
    return (
        " first_diverge=(msg_id=%s linker=%s reconcile=%s content_equal=%s)"
        % (msg_id, linker_arid, recon_arid, content_equal)
    )


def purge_chat_sync(db, chat_id: str) -> int:
    """Chat-delete cascade for the linker's shadow tables. Called from
    parley_route_conversations.delete_conversation_sync (worker
    thread) — without it, a deleted chat leaves orphan observations /
    claims that the compare sweep keeps judging against an empty
    session chain (v3 soak forensics: dead chats polluted the
    counters). Phase-2 state rides the same cascade: the durable
    compare mark and the migration marker must die with the chat so a
    re-created chat_id re-compares / re-migrates from scratch.
    Best-effort per table; returns rows removed."""
    removed = 0
    for table in (
        "turn_links", "turn_observations",
        "linker_compare_state", "chat_migrations",
    ):
        try:
            cur = db.exec(f"DELETE FROM {table} WHERE chat_id = ?", (chat_id,))
            removed += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        except Exception:
            continue
    _compare_hwm.pop(chat_id, None)
    # Phase-5 monitor state dies with the chat too (a lingering entry
    # would keep a deleted chat in the transcript_health diagnostics).
    try:
        from . import parley_transcript_monitor as _monitor  # noqa: WPS433
        _monitor._health.pop(chat_id, None)
        _monitor._warned.pop(chat_id, None)
    except Exception:
        pass
    return removed


# ── public async API (loop thread) ────────────────────────────────────

def _bare_chat_id(chat_id: str) -> str:
    """Strip a `source:` prefix (dispatcher-added) — the linker keys
    everything by the bare chat_id, same as record_envelope."""
    if ":" in chat_id:
        return chat_id.partition(":")[2]
    return chat_id


async def open_turn_watermark(
    adapter, chat_id: str, turn_id: str, *, user_text: Optional[str] = None,
) -> None:
    """Capture hwm_open for a new turn. MUST be awaited BEFORE
    _dispatch_message runs (race-free capture) and before the turn
    buffer replaces the previous TurnEntry (the barrier flush needs
    the stale entry's call-id set)."""
    if not enabled():
        return
    db = getattr(adapter, "_parley_db", None)
    state_db_path = getattr(adapter, "_state_db_path", None)
    if db is None or state_db_path is None:
        return
    tb = getattr(adapter, "_turn_buffer", None)
    snap = _entry_snapshot(tb.active_for_chat(chat_id)) if tb is not None else None
    from .parley_perf_trace import run_in_parley_worker  # noqa: WPS433
    try:
        await run_in_parley_worker(
            _open_sync, db, state_db_path, _bare_chat_id(chat_id),
            SIDEKICK_SOURCE, turn_id,
            user_text=user_text, entry_snapshot=snap,
        )
    except Exception as exc:
        logger.warning("[parley] turn-linker open failed for %s: %s", chat_id, exc)


async def flush_pending_capture(adapter, chat_id: str) -> None:
    """The next-turn-start barrier, standalone form. open_turn_watermark
    runs it implicitly; exposed for explicit stale-window cleanup."""
    if not enabled():
        return
    db = getattr(adapter, "_parley_db", None)
    state_db_path = getattr(adapter, "_state_db_path", None)
    if db is None or state_db_path is None:
        return
    tb = getattr(adapter, "_turn_buffer", None)
    snap = _entry_snapshot(tb.active_for_chat(chat_id)) if tb is not None else None
    from .parley_perf_trace import run_in_parley_worker  # noqa: WPS433
    try:
        await run_in_parley_worker(
            _flush_pending_sync, db, state_db_path, _bare_chat_id(chat_id),
            SIDEKICK_SOURCE, entry_snapshot=snap,
        )
    except Exception as exc:
        logger.warning("[parley] turn-linker flush failed for %s: %s", chat_id, exc)


async def close_turn_and_link(
    adapter, chat_id: str, trigger_env: Dict[str, Any],
    *, turn_entry: Any = None,
) -> None:
    """Turn-end capture + link, off-loop. ``turn_entry`` is the
    TurnEntry popped by _safe_send_envelope at reply_final (None for
    notification triggers / when no turn was open)."""
    if not enabled():
        return
    db = getattr(adapter, "_parley_db", None)
    state_db_path = getattr(adapter, "_state_db_path", None)
    if db is None or state_db_path is None:
        return
    snap = _entry_snapshot(turn_entry)
    from .parley_perf_trace import run_in_parley_worker  # noqa: WPS433
    try:
        await run_in_parley_worker(
            _close_sync, db, state_db_path, _bare_chat_id(chat_id),
            SIDEKICK_SOURCE, dict(trigger_env), entry_snapshot=snap,
        )
    except Exception as exc:
        logger.warning("[parley] turn-linker close failed for %s: %s", chat_id, exc)


def schedule_close(adapter, chat_id: str, env: Dict[str, Any], turn_entry: Any) -> None:
    """Fire-and-forget close_turn_and_link from _safe_send_envelope
    (loop thread). Holds task refs so they aren't GC'd mid-flight."""
    if not enabled():
        return
    if getattr(adapter, "_parley_db", None) is None:
        return
    task = asyncio.ensure_future(
        close_turn_and_link(adapter, chat_id, dict(env), turn_entry=turn_entry)
    )
    _close_tasks.add(task)
    task.add_done_callback(_close_tasks.discard)
