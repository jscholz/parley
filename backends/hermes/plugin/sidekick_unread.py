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
import sqlite3
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .sidekick_state import list_unread_state


def _read_state_unread_state(db) -> Dict[str, Tuple[Optional[float], bool]]:
    """Pull last_read_at + marked_unread keyed by chat_id."""
    rows = list_unread_state(db)
    return {
        r["chatId"]: (r["lastReadAt"], bool(r["markedUnread"]))
        for r in rows
    }


def compute_unread(
    *,
    db,
    state_db_path: Path,
    source: str = "sidekick",
) -> Dict:
    """Return the same shape openclaw's compute_unread returns:
    ``{chats: [{chat_id, unread_count, marked_unread, last_read_at}],
       total: N}``.

    ⚠️  WARNING — DO NOT CALL FROM THE ASYNCIO LOOP THREAD.  ⚠️

    This function is structurally **O(history) per chat** — it loops
    over every chat_id and runs a recursive-CTE ``COUNT(*)`` against
    state.db (which can carry thousands of rows per chat) PLUS a
    sidekick.db scan per chat, all in synchronous Python. With ~30
    chats and a 5000-row chat in the mix, one call took ~8 seconds.

    On 2026-06-23 this function was the dominant cause of a gateway
    "loop-lag 8s" pattern — `handle_unread` (sidekick_routes.py) was
    awaiting it inline, which on an async def is identical to calling
    it synchronously on the loop thread. The PWA polls /unread on
    every drawer-list refresh, so the loop blocked for 8s on every
    poll and every other handler stalled into 8-25s tail latency.

    Fix (commit d10f62c): `handle_unread` now routes through
    ``sidekick_perf_trace.run_in_sidekick_worker`` (asyncio.Semaphore
    + asyncio.to_thread) so the work runs in a bounded worker thread.
    The regression test
    ``test_handle_unread_routes_compute_off_the_loop_thread`` in
    test_sidekick_unread.py asserts this stays true.

    If you add a new caller, route it through ``to_thread`` (or
    ``run_in_sidekick_worker`` to inherit the concurrency cap). Inline
    invocation from a coroutine WILL re-introduce the loop block.

    Counts assistant rows (tool-call orchestrators excluded) with
    timestamp > last_read_at, from TWO sources:
      * state.db ``messages`` — canonical post-turn-flush body store
      * sidekick.db ``msg_links`` unlinked entries — envelope-time
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

    # Chat set: union of state.db user_ids (existing behavior) + msg_links
    # chat_ids (catches envelope-only chats not yet in state.db).
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

    out: List[Dict] = []
    total = 0
    # Open state.db once (read-only) so per-chat queries don't re-connect.
    state_conn = None
    if state_reachable:
        try:
            uri = f"file:{state_db_path}?mode=ro"
            state_conn = sqlite3.connect(uri, uri=True, timeout=2.0)
        except Exception:
            state_conn = None
    try:
        for chat_id in chat_ids_set:
            # unread_state is keyed by the PWA-facing prefixed form
            # (`{source}:{chat_id}`) since /v1/unread/seen POSTs use
            # whatever chat_id the PWA sends — matches the sidebar
            # row. Look up under both forms for backwards-compat with
            # bare ids that might have been written historically.
            prefixed = f"{source}:{chat_id}"
            last_read_at, marked = pointer.get(prefixed) or pointer.get(chat_id) or (None, False)
            if marked:
                # Sticky-unread: count at least 1. Don't bother walking
                # the messages — sticky overrides regardless.
                out.append({
                    "chat_id": f"{source}:{chat_id}",
                    "unread_count": 1,
                    "marked_unread": True,
                    "last_read_at": last_read_at,
                })
                total += 1
                continue

            threshold = last_read_at if last_read_at is not None else 0

            # state.db count — flushed (post-turn) assistant rows.
            # Recursive CTE folds compaction-rotated child sessions.
            state_count = 0
            if state_conn is not None:
                try:
                    state_count_sql = """
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
                        SELECT COUNT(*) FROM messages m
                         JOIN session_root sr ON m.session_id = sr.id
                         WHERE m.role = 'assistant'
                           AND (m.tool_calls IS NULL OR m.tool_calls = '' OR m.tool_calls = '[]')
                           AND m.timestamp > ?
                    """
                    row = state_conn.execute(state_count_sql, (chat_id, source, threshold)).fetchone()
                    state_count = int(row[0]) if row else 0
                except Exception:
                    state_count = 0

            # Envelope-only count — msg_links rows that haven't been
            # linked to a state.db twin yet. Counted SEPARATELY from
            # state_count so linked rows (agent_row_id non-null) don't
            # get double-counted — linked rows are already in state_count
            # via the join above.
            envelope_count = 0
            try:
                row = db.fetchone(
                    "SELECT COUNT(*) AS n FROM msg_links "
                    "WHERE chat_id = ? "
                    "  AND role = 'assistant' "
                    "  AND status = 'final' "
                    "  AND agent_row_id IS NULL "
                    "  AND (tool_calls IS NULL OR tool_calls = '' OR tool_calls = '[]') "
                    "  AND created_at > ?",
                    (chat_id, threshold),
                )
                envelope_count = int(row["n"]) if row else 0
            except Exception:
                envelope_count = 0

            count = state_count + envelope_count
            if count > 0:
                out.append({
                    "chat_id": f"{source}:{chat_id}",
                    "unread_count": count,
                    "marked_unread": False,
                    "last_read_at": last_read_at,
                })
                total += count
    finally:
        if state_conn is not None:
            try:
                state_conn.close()
            except Exception:
                pass

    return {"chats": out, "total": total}
