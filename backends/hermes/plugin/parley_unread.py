"""Unread compute against hermes state.db.

Mirrors openclaw plugin's ``src/unread-storage.js``: derive per-chat
unread count by walking state.db for assistant rows newer than the
``unread_state.last_read_at`` pointer. Same SSOT model: this count
drives sidebar badges, app badge (sum), and was the implicit input
to push dispatch.

Reads from hermes state.db via a read-only sqlite connection. The
plugin's ``_state_db_path`` field carries the resolved location.
"""

from __future__ import annotations

import contextlib
import os
from .parley_env import env_get
import sqlite3
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .parley_state import list_unread_state


# ── Per-process TTL cache for compute_unread results ────────────────
#
# compute_unread is O(N_chats × M_msgs) — it loops over every chat and
# runs a recursive-CTE COUNT(*) per chat against state.db. The PWA
# polls /unread on every drawer-list refresh (multiple times per second
# during a burst). Without caching, each poll re-runs the same expensive
# computation and saturates the bounded worker pool, queueing every
# other request (caught 2026-06-23 — /items for a big chat queued for
# 13s+ behind ~3 concurrent compute_unread calls).
#
# 5-second TTL: drawer badge UX tolerates ≤5s staleness (new envelopes
# arrive via ``record_envelope`` which invalidates the cache explicitly
# — see ``invalidate_unread_cache`` callers — so the TTL only delays
# unrelated state.db-side updates; in practice the badge bumps within
# ~ms of the source event). Bumped from 2s after the batch-query
# rewrite below cut compute_unread from ~9s to ~2s; the TTL must be
# meaningfully larger than the compute time so repeat polls within a
# burst can actually hit the cache. Tunable via
# PARLEY_UNREAD_CACHE_TTL_MS for emergencies.
_CACHE_TTL_S = float(env_get("PARLEY_UNREAD_CACHE_TTL_MS", "5000") or 5000) / 1000.0
_cache: Dict[str, Tuple[float, Dict]] = {}  # key → (cached_at_monotonic, result)
_cache_lock = threading.Lock()


def invalidate_unread_cache(source: Optional[str] = None) -> None:
    """Drop cached compute_unread results. Called after writes that
    would change the count (mark_seen, set_marked, envelope arrival).
    ``source=None`` flushes every key — used on bulk events. Keeping
    explicit invalidation alongside the TTL means callers that need
    sub-TTL freshness (a /unread/seen POST → immediate /unread refetch)
    don't see stale data.
    """
    with _cache_lock:
        if source is None:
            _cache.clear()
        else:
            _cache.pop(source, None)


def _read_state_unread_state(db) -> Dict[str, Tuple[Optional[float], bool]]:
    """Pull last_read_at + marked_unread keyed by chat_id."""
    rows = list_unread_state(db)
    return {
        r["chatId"]: (r["lastReadAt"], bool(r["markedUnread"]))
        for r in rows
    }


# Grace window before an out-of-universe unread_state row is purged.
# Protects the brand-new-chat race: the user opens a chat mid-first-
# turn, mark_seen writes the pointer, but the state.db session row
# hasn't been flushed yet — the chat is briefly absent from the
# universe and its FRESH pointer must survive until the flush lands.
_STALE_UNREAD_PURGE_GRACE_S = 3600.0


def _purge_stale_unread_state(db, pointer: Dict[str, Tuple[Optional[float], bool]],
                              universe: set, source: str) -> None:
    """Delete unread_state rows whose chat is absent from the served
    universe and old enough to be provably stale. Rows with a NULL
    last_read_at can't be aged, so they're left alone (they're already
    excluded from the badge by the universe scoping); rows carrying a
    different source prefix aren't ours to judge."""
    now = time.time()
    prefix = f"{source}:"
    doomed = []
    for key, (last_read_at, _marked) in pointer.items():
        if key.startswith(prefix):
            bare = key[len(prefix):]
        elif ":" not in key:
            bare = key
        else:
            continue
        if not bare or bare in universe:
            continue
        if last_read_at is None or (now - last_read_at) < _STALE_UNREAD_PURGE_GRACE_S:
            continue
        doomed.append(key)
    # Chunked under SQLite's ~999 host-param cap — the live DB carried
    # 400+ stale rows at fix time (unread_state was never cleaned on
    # chat delete), so the first purge is a big batch.
    BATCH = 400
    for i in range(0, len(doomed), BATCH):
        chunk = doomed[i:i + BATCH]
        placeholders = ",".join(["?"] * len(chunk))
        db.exec(
            f"DELETE FROM unread_state WHERE chat_id IN ({placeholders})",
            chunk,
        )


def compute_unread(
    *,
    db,
    state_db_path: Path,
    source: str = "parley",
) -> Dict:
    """Public entry point — TTL-cached wrapper. The heavy lifting lives
    in ``_compute_unread_uncached``; see its docstring for the SQL
    structure and history.

    Cache hit returns in microseconds; miss runs the full computation
    once and caches for ``_CACHE_TTL_S``. The PWA's drawer-refresh
    poll burst (multiple /unread calls per second) collapses to ~1
    full computation per TTL window, keeping the worker pool free for
    /items reads and other handlers.

    Tests and any caller that needs guaranteed fresh data should call
    ``_compute_unread_uncached`` directly (bypasses cache); production
    callers go through the cached entry point.
    """
    now = time.monotonic()
    cache_key = source
    with _cache_lock:
        cached = _cache.get(cache_key)
        if cached is not None:
            cached_at, value = cached
            if now - cached_at < _CACHE_TTL_S:
                return value
    # Miss (or expired) — compute outside the lock so concurrent misses
    # don't serialize; the last writer wins.
    result = _compute_unread_uncached(db=db, state_db_path=state_db_path, source=source)
    with _cache_lock:
        _cache[cache_key] = (now, result)
    return result


def _compute_unread_uncached(
    *,
    db,
    state_db_path: Path,
    source: str = "parley",
) -> Dict:
    """Return the same shape openclaw's compute_unread returns:
    ``{chats: [{chat_id, unread_count, marked_unread, last_read_at}],
       total: N}``.

    ⚠️  WARNING — DO NOT CALL FROM THE ASYNCIO LOOP THREAD.  ⚠️

    This function is structurally **O(history) per chat** — it loops
    over every chat_id and runs a recursive-CTE ``COUNT(*)`` against
    state.db (which can carry thousands of rows per chat) PLUS a
    parley.db scan per chat, all in synchronous Python. With ~30
    chats and a 5000-row chat in the mix, one call took ~8 seconds.

    On 2026-06-23 this function was the dominant cause of a gateway
    "loop-lag 8s" pattern — `handle_unread` (parley_routes.py) was
    awaiting it inline, which on an async def is identical to calling
    it synchronously on the loop thread. The PWA polls /unread on
    every drawer-list refresh, so the loop blocked for 8s on every
    poll and every other handler stalled into 8-25s tail latency.

    Fix (commit d10f62c): `handle_unread` now routes through
    ``parley_perf_trace.run_in_parley_worker`` (asyncio.Semaphore
    + asyncio.to_thread) so the work runs in a bounded worker thread.
    The regression test
    ``test_handle_unread_routes_compute_off_the_loop_thread`` in
    test_parley_unread.py asserts this stays true.

    If you add a new caller, route it through ``to_thread`` (or
    ``run_in_parley_worker`` to inherit the concurrency cap). Inline
    invocation from a coroutine WILL re-introduce the loop block.

    Counts assistant rows (tool-call orchestrators excluded) with
    timestamp > last_read_at, from TWO sources:
      * state.db ``messages`` — canonical post-turn-flush body store
      * parley.db ``msg_links`` unlinked entries — envelope-time
        writes that haven't been flushed to state.db yet

    The union is essential because hermes flushes state.db only at
    end-of-turn. A short "Checking." reply lands in msg_links seconds
    before its state.db twin; counting state.db only made the unread
    count return 0 for that brief window → PWA badge.ts:109's
    auto-markAllRead nuked the activity row as "stale".

    For sticky ``marked_unread=1``, returns at least 1 regardless of
    the timestamp comparison.
    """
    pointer = _read_state_unread_state(db)

    # Chat universe: EXACTLY the set the conversations route serves —
    # state.db sessions with a user_id for this source (the same root
    # resolution _summaries_by_user_id in parley_route_conversations
    # groups by; child/rotated sessions have user_id NULL and roll up
    # to these roots). The badge must be a sum over chats the drawer
    # can actually show, or an unservable chat becomes a permanent
    # unclearable +1 (field 2026-07-20: `parley:upgrade-probe-…` had
    # one msg_links row, no state.db session, and badged forever).
    #
    # msg_links chat_ids are deliberately NOT added to the universe —
    # they only contribute COUNTS (the envelope-only pre-flush window,
    # see the batch query below) for chats already in the universe.
    # Degraded fallback: when state.db is unreachable we keep the old
    # msg_links-derived universe rather than report 0 — a transient
    # read failure must not zero the badge (badge.ts treats total==0
    # as "everything read").
    chat_ids_set: set = set()
    state_reachable = state_db_path is not None and state_db_path.exists()
    if state_reachable:
        try:
            uri = f"file:{state_db_path}?mode=ro"
            with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=2.0)) as conn:
                rows = conn.execute(
                    "SELECT DISTINCT user_id FROM sessions WHERE source = ? AND user_id IS NOT NULL",
                    (source,),
                ).fetchall()
                for r in rows:
                    chat_ids_set.add(r[0])
        except Exception:
            state_reachable = False
    if state_reachable:
        # Opportunistic hygiene: unread_state rows for chats that fell
        # out of the universe (deleted chats, probe leftovers) are
        # inert now — purge the clearly-stale ones. Best-effort; a
        # failure here must never break the badge computation.
        try:
            _purge_stale_unread_state(db, pointer, chat_ids_set, source)
        except Exception:
            pass
    else:
        try:
            msg_chat_rows = db.fetchall(
                "SELECT DISTINCT chat_id FROM msg_links WHERE chat_id IS NOT NULL",
            )
            for r in msg_chat_rows:
                cid = r["chat_id"]
                if cid:
                    chat_ids_set.add(cid)
        except Exception:
            pass

    if not chat_ids_set:
        return {"chats": [], "total": 0}

    # Resolve each chat's threshold (last_read_at) + marked flag once
    # so the two batch queries below can use them.
    def _resolve_pointer(cid: str) -> Tuple[float, bool]:
        # unread_state is keyed by the PWA-facing prefixed form
        # (`{source}:{chat_id}`) since /v1/unread/seen POSTs send
        # whatever chat_id the PWA sends. Look up under both forms for
        # backwards-compat with bare ids that might have been written
        # historically.
        prefixed = f"{source}:{cid}"
        last_read_at, marked = (
            pointer.get(prefixed)
            or pointer.get(cid)
            or (None, False)
        )
        return ((last_read_at if last_read_at is not None else 0.0),
                bool(marked))

    chat_thresholds: Dict[str, float] = {}
    sticky_marked: List[Tuple[str, Optional[float]]] = []
    for cid in chat_ids_set:
        threshold, marked = _resolve_pointer(cid)
        chat_thresholds[cid] = threshold
        if marked:
            # Sticky-unread: count at least 1 regardless of msgs.
            sticky_marked.append((cid, chat_thresholds[cid] if threshold else None))

    # ── BATCH state.db query ───────────────────────────────────────
    #
    # Previously: a per-chat recursive-CTE + COUNT(*) was issued in a
    # Python for-loop (N queries for N chats — ~9s on Jonathan's
    # production data with ~170 chats). Each invocation reset the cache
    # TTL clock before the next one could land, so the TTL cache from
    # commit 13d8815 effectively never served.
    #
    # Now: one query feeds (chat_id, last_read_at) pairs via a
    # ``VALUES`` thresholds CTE and joins state.db's recursive
    # session-root walk against it. SQLite walks the messages table
    # once instead of N times. Measured 3.3× speedup on the live
    # 172-chat dataset (6.7s → 2.0s), and the TTL cache can now
    # actually serve repeat polls within the window.
    state_counts: Dict[str, int] = {}
    if state_reachable:
        try:
            values_clause = ",".join(["(?,?)"] * len(chat_thresholds))
            values_params: List = []
            for cid, threshold in chat_thresholds.items():
                values_params.extend([cid, float(threshold)])
            batch_sql = f"""
                WITH RECURSIVE
                  session_root(id, root_user_id, root_system_prompt) AS (
                    SELECT id, user_id, system_prompt
                      FROM sessions
                     WHERE user_id IS NOT NULL AND source = ?
                    UNION ALL
                    SELECT s.id, sr.root_user_id, sr.root_system_prompt
                      FROM sessions s
                      JOIN session_root sr ON s.parent_session_id = sr.id
                     WHERE s.user_id IS NULL
                       AND LENGTH(COALESCE(sr.root_system_prompt, '')) >= 200
                       AND SUBSTR(COALESCE(s.system_prompt, ''), 1, 200)
                           = SUBSTR(sr.root_system_prompt, 1, 200)
                  ),
                  thresholds(chat_id, last_read_at) AS (VALUES {values_clause})
                SELECT sr.root_user_id, COUNT(*) AS unread_count
                FROM messages m
                JOIN session_root sr ON m.session_id = sr.id
                JOIN thresholds t ON t.chat_id = sr.root_user_id
                WHERE m.role = 'assistant'
                  AND (m.tool_calls IS NULL OR m.tool_calls = '' OR m.tool_calls = '[]')
                  AND m.timestamp > t.last_read_at
                GROUP BY sr.root_user_id
            """
            uri = f"file:{state_db_path}?mode=ro"
            with contextlib.closing(
                sqlite3.connect(uri, uri=True, timeout=2.0)
            ) as conn:
                rows = conn.execute(
                    batch_sql, [source, *values_params],
                ).fetchall()
            for cid, cnt in rows:
                state_counts[cid] = int(cnt or 0)
        except Exception:
            # Conservative: empty state_counts → only envelopes drive
            # the badge for this call. Caller still gets correct shape.
            state_counts = {}

    # ── BATCH parley.db envelope-only query ──────────────────────
    #
    # Same shape as the state.db batch: one query feeds the per-chat
    # thresholds and counts msg_links rows with NULL agent_row_id (the
    # envelope-time write that hasn't been linked to a state.db twin
    # yet). Was N queries per call; now one.
    envelope_counts: Dict[str, int] = {}
    try:
        # SQLite imposes a max of ~999 host parameters per statement;
        # the (chat_id, threshold) pairs use 2 each so we cap at ~400
        # chats per batch and stitch results. Production accounts run
        # well under this; the loop is for safety not perf.
        chat_items = list(chat_thresholds.items())
        BATCH = 400
        for i in range(0, len(chat_items), BATCH):
            slice_ = chat_items[i:i + BATCH]
            placeholders = ",".join(["(?,?)"] * len(slice_))
            params: List = []
            for cid, threshold in slice_:
                params.extend([cid, float(threshold)])
            rows = db.fetchall(
                f"WITH thresholds(chat_id, last_read_at) AS (VALUES {placeholders}) "
                "SELECT msg_links.chat_id, COUNT(*) AS n "
                "FROM msg_links "
                "JOIN thresholds t ON t.chat_id = msg_links.chat_id "
                "WHERE msg_links.role = 'assistant' "
                "  AND msg_links.status = 'final' "
                "  AND msg_links.agent_row_id IS NULL "
                "  AND (msg_links.tool_calls IS NULL OR msg_links.tool_calls = '' "
                "       OR msg_links.tool_calls = '[]') "
                "  AND msg_links.created_at > t.last_read_at "
                "GROUP BY msg_links.chat_id",
                params,
            )
            for r in rows:
                envelope_counts[r["chat_id"]] = int(r["n"] or 0)
    except Exception:
        envelope_counts = {}

    # ── Assemble response ──────────────────────────────────────────
    out: List[Dict] = []
    total = 0
    # Sticky-marked first; they count at least 1 regardless.
    sticky_chat_ids = {cid for cid, _ in sticky_marked}
    for cid, last_read_at in sticky_marked:
        out.append({
            "chat_id": f"{source}:{cid}",
            "unread_count": 1,
            "marked_unread": True,
            "last_read_at": last_read_at,
        })
        total += 1
    # Then chats with computed unread > 0 (sticky already counted).
    for cid in chat_ids_set:
        if cid in sticky_chat_ids:
            continue
        count = state_counts.get(cid, 0) + envelope_counts.get(cid, 0)
        if count > 0:
            threshold, _ = _resolve_pointer(cid)
            out.append({
                "chat_id": f"{source}:{cid}",
                "unread_count": count,
                "marked_unread": False,
                "last_read_at": (threshold if threshold else None),
            })
            total += count

    return {"chats": out, "total": total}
