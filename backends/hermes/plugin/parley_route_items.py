"""HTTP route handler for ``GET /v1/conversations/{id}/items``.

Extracted from ``__init__.py`` 2026-05-17 — the items endpoint plus
its two private helpers (``_resolve_source_for_chat_id``,
``_items_by_user_id``) are large enough (~260 LOC) to warrant their
own module. The endpoint is read-only, hits only hermes ``state.db``
+ the plugin's in-memory turn buffer, so the extraction is
mechanically safe.

Wiring contract: ``handle_get_items(adapter, request)`` takes the
calling ``ParleyAdapter`` instance and the aiohttp request. The
handler reads ``adapter._state_db_path``, ``adapter._turn_buffer``,
``adapter._check_http_auth`` — same fields the original method
referenced via ``self``.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from .parley_env import env_get
import secrets
import sqlite3
import sys as _sys
import time as _time
from typing import Any, Dict, Optional, Tuple

# aiohttp guard mirrors parley_route_conversations — keeps unit
# tests loading without the aiohttp runtime. Production loads it
# before any route handler runs.
try:
    from aiohttp import web  # type: ignore[assignment]
except ImportError:  # pragma: no cover
    web = None  # type: ignore[assignment]

from .parley_ids import SIDEKICK_SOURCE, _parse_gateway_id


# Per-chat reconcile throttle. ``reconcile_from_state_db`` runs a full
# recursive-CTE pass over state.db plus an O(N) parley.db scan; before
# this it ran on EVERY /items enter, and on long sessions that O(history)
# work (GIL-bound) saturated a core and starved the event loop (30-90s
# read/reply latency). Reads themselves come from state.db directly, so
# reconcile only maintains msg_links linkage + orphan drops — those
# tolerate a few seconds of staleness. We skip reconcile when it ran for
# this chat within the window. Kept in the route (not the function) so the
# unit tests that call reconcile_from_state_db directly are unaffected.
_RECONCILE_THROTTLE_S = float(env_get("PARLEY_RECONCILE_THROTTLE_S", "20") or 20)
_last_reconcile_at: Dict[str, float] = {}
# Background reconcile is fire-and-forget: the /items read is correct from
# state.db alone (reconcile only maintains parley.db msg_links linkage +
# orphan drops, which tolerate a few seconds of staleness). Running its
# O(history) recursive-CTE pass INLINE on the read path cost ~8s per cold
# chat and — under a resume burst that touches many distinct chats — those
# 8s passes piled up and dragged even trivial reads to 10-45s. So we spawn
# it detached and let the read return immediately. This set is the
# single-flight guard so a chat never has two background passes at once;
# the detached-task references are held so they aren't GC'd mid-flight.
_reconcile_inflight: set = set()
_reconcile_tasks: set = set()


def _items_v3_flag() -> bool:
    """PARLEY_ITEMS_V3 read-flip flag (Phase 3, B2 playbook)."""
    return env_get("PARLEY_ITEMS_V3", "").strip().lower() in (
        "1", "true", "yes",
    )


def _spawn_background_reconcile(adapter, chat_id: str, source: str) -> None:
    """Fire reconcile_from_state_db off the read path (see notes above).
    No-ops if a pass for this chat is already running."""
    # Diagnostic kill switch — set PARLEY_RECONCILE_BG_DISABLED=1 to
    # short-circuit the spawn entirely. Used during perf investigation
    # to attribute loop-lag causes. Reads are correct from state.db
    # alone (msg_links provides annotations only); skipping reconcile
    # only delays msg_links linkage updates, which the periodic sweep
    # picks up.
    if env_get("PARLEY_RECONCILE_BG_DISABLED", "").lower() in ("1", "true", "yes"):
        return
    if chat_id in _reconcile_inflight:
        return
    from . import parley_state as _sstate

    from . import parley_perf_trace as _perf  # noqa: WPS433

    async def _run() -> None:
        try:
            # Transcript v3 Phase 4 (2026-07-30): for chats v3 actually
            # serves — PARLEY_ITEMS_V3 on + a current-version
            # migration marker + PARLEY_RECONCILE_RETIRED (default
            # on) — the content reconcile is RETIRED from this chain.
            # Steady state is covered by write-through bodies + the
            # turn linker's write-time links (it stamps
            # msg_links.agent_row_id at turn close now); Phase 5's
            # divergence monitor takes reconcile's slot here (alert
            # only, no timers — same items-poll cadence + throttle) and
            # replaces the linker-soak compare for these chats. The
            # legacy chain below keeps running unchanged for unmarked
            # chats — including the one-shot force_full legacy import
            # inside the migration backfill — and is the instant revert
            # path: flip PARLEY_RECONCILE_RETIRED=0 (or unset
            # PARLEY_ITEMS_V3) and every chat is back on the Phase-3
            # chain without touching serving. Reconcile itself survives
            # as the offline repair tool
            # (parley_chat_migration.repair_chat_sync).
            from . import parley_chat_migration as _migration  # noqa: WPS433
            from . import parley_turn_linker as _linker  # noqa: WPS433
            if (
                adapter._parley_db is not None
                and _items_v3_flag()
                and _linker.reconcile_retired()
            ):
                _marked = await _perf.run_in_parley_worker(
                    _migration.get_migration, adapter._parley_db, chat_id,
                )
                if _marked is not None:
                    from . import parley_transcript_monitor as _monitor  # noqa: WPS433
                    await _perf.run_in_parley_worker(
                        _monitor.sweep_chat_sync,
                        adapter._parley_db, adapter._state_db_path,
                        chat_id, source,
                    )
                    return
            # The turn linker's soak comparison (below) only judges
            # observations closed before reconcile started — a turn
            # closing DURING the pass would be diffed against stale
            # msg_links and, once past the per-chat compare high-water
            # mark, never re-compared.
            _reconcile_started_at = _time.time()
            await _perf.run_in_parley_worker(
                _sstate.reconcile_from_state_db,
                adapter._parley_db, adapter._state_db_path, chat_id, source,
            )
            # Transcript v3 Phase 2 (dark): one-time legacy import +
            # migration marker for this chat. Runs BEFORE the compare
            # so the sweep judges post-heal links (the pre-fix
            # status-bubble mislinks it heals were exactly the stale
            # diverge noise). One indexed marker lookup once migrated;
            # serving is untouched until Phase 3 consults the marker.
            # No-op when PARLEY_CHAT_MIGRATION=0.
            from . import parley_chat_migration as _migration  # noqa: WPS433
            if _migration.enabled() and adapter._parley_db is not None:
                await _perf.run_in_parley_worker(
                    _migration.backfill_chat_sync,
                    adapter._parley_db, adapter._state_db_path,
                    chat_id, source,
                )
            # Transcript v3 Phase 1 (dark launch): diff the turn
            # linker's shadow links against the reconcile pass that
            # just ran and emit one linker-soak journal line per chat
            # when there are new turns or divergences. No-op when
            # PARLEY_TURN_LINKER=0.
            from . import parley_turn_linker as _linker  # noqa: WPS433
            if _linker.enabled() and adapter._parley_db is not None:
                await _perf.run_in_parley_worker(
                    _linker.compare_and_log,
                    adapter._parley_db, chat_id,
                    state_db_path=adapter._state_db_path,
                    closed_before=_reconcile_started_at,
                )
        except Exception:
            pass
        finally:
            _reconcile_inflight.discard(chat_id)

    _reconcile_inflight.add(chat_id)
    task = asyncio.ensure_future(_run())
    _reconcile_tasks.add(task)
    task.add_done_callback(_reconcile_tasks.discard)


def _resolve_source_for_chat_id(adapter, chat_id: str) -> Optional[str]:
    """Pick a ``sessions.source`` for this chat_id.

    Used by the per-chat history handler, which doesn't carry a
    source on the URL. Prefers ``parley`` on a collision so the
    composer-editable behavior in the PWA stays consistent for
    parley-native chats; falls back to whatever source state.db
    has for the user_id otherwise (telegram, slack, etc.).

    Returns ``None`` when no session exists for the chat_id (treated
    as 404 by the caller).
    """
    if adapter._state_db_path is None or not adapter._state_db_path.exists():
        return None
    uri = f"file:{adapter._state_db_path}?mode=ro"
    with contextlib.closing(
        sqlite3.connect(uri, uri=True, timeout=2.0)
    ) as conn:
        rows = conn.execute(
            "SELECT DISTINCT source FROM sessions WHERE user_id = ?",
            (chat_id,),
        ).fetchall()
    sources = [r[0] for r in rows if r and r[0]]
    if not sources:
        return None
    if SIDEKICK_SOURCE in sources:
        return SIDEKICK_SOURCE
    return sources[0]


def _items_by_user_id(
    adapter,
    chat_id: str,
    source: str,
    limit: int,
    before_id: Optional[int],
) -> Optional[Tuple[list, Optional[int], bool]]:
    """Transcript replay across every session that ever belonged
    to ``(user_id=chat_id, source)``.

    Returns ``(items, first_id, has_more)`` or ``None`` when no
    sessions exist for the pair (treated as 404 by the route handler).

    Honors ``before_id`` for lazy paging: when set, only messages
    with ``id < before_id`` are returned.
    """
    if adapter._state_db_path is None or not adapter._state_db_path.exists():
        return None
    # Recursive CTE: walk parent_session_id chains so compacted
    # child sessions (user_id=NULL) get rolled up under the
    # requested chat_id. Without this, the transcript returns
    # only the root session's messages — any messages persisted
    # to a compaction-rotated child are invisible.
    sql = """
        WITH RECURSIVE session_root(id, root_system_prompt, is_compaction_child) AS (
            SELECT id, system_prompt, 0 FROM sessions
             WHERE user_id = ? AND source = ?
            UNION ALL
            SELECT s.id, sr.root_system_prompt, 1
              FROM sessions s
              JOIN session_root sr ON s.parent_session_id = sr.id
             WHERE s.user_id IS NULL
               AND LENGTH(COALESCE(sr.root_system_prompt, '')) >= 200
               AND SUBSTR(COALESCE(s.system_prompt, ''), 1, 200)
                   = SUBSTR(sr.root_system_prompt, 1, 200)
        )
        SELECT m.id, m.session_id, sr.is_compaction_child, m.role, m.content, m.tool_name,
               m.tool_call_id, m.tool_calls, m.timestamp,
               sml.sidekick_id, sml.kind
        FROM messages m
        JOIN session_root sr ON m.session_id = sr.id
        LEFT JOIN sidekick_msg_links sml ON sml.state_db_id = m.id
    """
    params: list = [chat_id, source]
    if before_id is not None:
        sql += " WHERE m.id < ?"
        params.append(before_id)
    sql += " ORDER BY m.timestamp ASC, m.id ASC"
    uri = f"file:{adapter._state_db_path}?mode=ro"
    with contextlib.closing(
        sqlite3.connect(uri, uri=True, timeout=2.0)
    ) as conn:
        # Existence check first so we can return 404 vs. an empty
        # but valid transcript. A user_id with no messages yet
        # (e.g. just-created chat that hasn't sent its first turn)
        # still exists; the items list will be empty. We check the
        # root sessions table directly — if the chat_id has at
        # least one session with that user_id, it exists.
        exists_row = conn.execute(
            "SELECT 1 FROM sessions WHERE user_id = ? AND source = ? LIMIT 1",
            (chat_id, source),
        ).fetchone()
        if exists_row is None:
            return None
        rows = list(conn.execute(sql, params).fetchall())
    # Hermes context-compaction injects a synthesized history block at
    # the head of every child session: a verbatim copy of the original
    # user prompt + replay of recent assistant/tool rows + a
    # `[CONTEXT COMPACTION — REFERENCE ONLY]` marker. All rows are
    # inserted at the same millisecond timestamp (the moment the child
    # session was minted). Used by hermes' context-window seed; should
    # never reach the user-facing transcript.
    #
    # The original prompt appears in the parent session AND again in
    # the compaction-injected seed block at the head of the child
    # session — the user would see their own prompt twice plus dupe
    # assistant/tool rows in between, producing an incoherent transcript.
    #
    # Fix: per child session, find the LAST row whose content starts
    # with `[CONTEXT COMPACTION`, drop that marker AND every row in
    # the same session with `id <= marker_id` (the synthesized seed
    # block always sits at the head of the child session, before any
    # real new content). Parent-session rows are never touched.
    #
    # `compaction_head_end_per_session[session_id] = max row id to
    # drop`. Built in a single pre-scan; lookup is O(1) per row.
    compaction_head_end_per_session: Dict[str, int] = {}
    for row_id, session_id, is_compaction_child, role, content, *_rest in rows:
        if is_compaction_child and (content or "").startswith("[CONTEXT COMPACTION"):
            # Latest marker wins. A single child session can only have
            # one compaction event per minting; the LAST id in
            # ascending-id order is the most permissive drop bound.
            cur = compaction_head_end_per_session.get(session_id, 0)
            if row_id > cur:
                compaction_head_end_per_session[session_id] = row_id

    items = []
    for row_id, session_id, _is_compaction_child, role, content, tool_name, tool_call_id, tool_calls, ts, sidekick_id, kind in rows:
        text = (content or "")
        # Drop marker rows everywhere; drop the synthesized-history
        # seed block only for compaction child sessions. Root sessions
        # may contain an internal compaction marker after real content;
        # those earlier root rows are user-visible and must survive.
        drop_through = compaction_head_end_per_session.get(session_id)
        if text.startswith("[CONTEXT COMPACTION"):
            continue
        if drop_through is not None and row_id <= drop_through:
            continue
        item: Dict[str, Any] = {
            "id": int(row_id),
            "object": "message",
            "role": role,
            "content": text,
            "created_at": int(ts) if ts else 0,
        }
        if tool_name:
            item["tool_name"] = tool_name
        # Tool-call linkage. Surfaced so the PWA can reconstruct
        # activity rows from history on reload (SSOT-rebuild path).
        # Hermes' core schema
        # already persists these columns; we just propagate them
        # in the wire response. No new storage, no schema change.
        #
        #   - role='tool' rows carry `tool_call_id` referencing
        #     back to the assistant message that issued the call.
        #     PWA routes these to activityRow.appendToolResult.
        #   - role='assistant' rows that orchestrated tool calls
        #     carry `tool_calls` (JSON array of OpenAI-shape
        #     function-call entries). PWA parses and feeds each
        #     entry to activityRow.appendToolCall.
        if tool_call_id:
            item["tool_call_id"] = tool_call_id
        if tool_calls:
            # Already a JSON string on disk; pass through verbatim.
            # PWA parses with try/catch so a malformed payload
            # degrades to "tool-call row drops out of activity row"
            # rather than crashing renderHistoryMessage.
            item["tool_calls"] = tool_calls
        # SSE-shape id (umsg_*/msg_*/notif_*) when this row was
        # persisted by a parley turn (or cron delivery — see
        # _persist_notification) that recorded its link. Absent
        # for legacy messages, messages from other channels, and
        # tool/system rows.
        if sidekick_id:
            item["sidekick_id"] = sidekick_id
        # Notification kind (cron / reminder / approval / etc.).
        # Plumbed through from sidekick_msg_links.kind — only set
        # on rows _persist_notification wrote. The PWA reads this
        # to discriminate notification rows from regular assistant
        # replies for rendering purposes.
        if kind:
            item["kind"] = kind
        items.append(item)
    # Same pagination semantics as the legacy path:
    #  * before_id=None → most-recent `limit` items, has_more=True
    #    when we truncated.
    #  * before_id set → user is paging backward; return up to
    #    `limit` items older than the cursor, has_more=True if a
    #    full page came back.
    first_id = items[0]["id"] if items else None
    if before_id is None and len(items) > limit:
        items = items[-limit:]
        first_id = items[0]["id"] if items else None
        has_more = True
    elif before_id is not None and len(items) >= limit:
        items = items[:limit]
        has_more = True
    else:
        has_more = False
    return (items, first_id, has_more)


async def handle_get_items(adapter, request: "web.Request") -> "web.Response":
    """GET /v1/conversations/{id}/items — transcript replay.

    Phase 2 (2026-05-19): read source is parley.db.msg_links, not
    state.db. Before each read, an opportunistic reconciliation pulls
    any state.db rows that don't have a parley.db twin into the
    message store with `legacy:<state_id>` keys. The aggregation
    across compaction-rotated sessions is done INSIDE the reconciler
    via the same recursive CTE the legacy path used.

    Pagination cursor: parley.db.msg_links's implicit rowid. PWA
    treats it as an integer (same wire shape as before); the cursor's
    monotonicity is sqlite-guaranteed.

    Returns 404 only when the chat has zero rows in parley.db AND
    state.db has no session for the chat AND no in-flight turn buffer
    exists — i.e. genuinely unknown chat. A chat with parley.db rows
    (envelope-time writes from Phase 1) always responds with a list.
    """
    _trace_id = secrets.token_hex(3)
    _t0 = _time.monotonic()
    # Gap between aiohttp accepting the request and the handler actually
    # entering. Set by the perf_arrival_middleware; if absent (middleware
    # disabled / different code path) we fall back to "0ms" and lose
    # visibility into asyncio dispatch lag, which is the whole reason
    # this trace exists. See parley_perf_trace.perf_arrival_middleware.
    _t_arrived = request.get("t_perf_arrived")
    _dispatch_gap_ms = int((_t0 - _t_arrived) * 1000) if _t_arrived is not None else None
    # Items-trace prints to stderr (and through journald). Each print
    # with flush=True is a blocking syscall on the loop thread — under
    # a burst of parallel /items requests (drawer prefetch fan-out) the
    # cumulative back-pressure from journald is a primary suspect for
    # event-loop stalls. Gated behind PARLEY_ITEMS_TRACE so we can
    # toggle without a code change; default OFF to keep the loop clear.
    # When investigating, set PARLEY_ITEMS_TRACE=1 in the systemd
    # drop-in to re-enable the legacy verbose breadcrumbs.
    _items_trace_on = env_get("PARLEY_ITEMS_TRACE", "").lower() in ("1", "true", "yes")
    if _items_trace_on:
        def _trace(event: str, extra: str = "") -> None:
            ms = int((_time.monotonic() - _t0) * 1000)
            print(f"[items-trace {_trace_id}] +{ms}ms {event}{' ' + extra if extra else ''}", flush=True, file=_sys.stderr)
    else:
        def _trace(event: str, extra: str = "") -> None:
            return None
    if _dispatch_gap_ms is not None and _dispatch_gap_ms >= 5:
        # Only log when the gap is non-trivial — 5ms threshold filters
        # the steady-state noise but catches anything that looks like
        # event-loop starvation.
        _trace("dispatch-gap", f"queue_ms={_dispatch_gap_ms}")
    _trace("enter")
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    raw_id = request.match_info["id"]
    try:
        limit = max(1, min(int(request.query.get("limit", "200")), 500))
    except ValueError:
        return web.Response(status=400, text="invalid limit")
    before = request.query.get("before")
    before_id: Optional[int]
    if before is None:
        before_id = None
    else:
        try:
            before_id = int(before)
        except ValueError:
            return web.Response(status=400, text="invalid before cursor")

    # `around=<sidekick_id|int id>` — deep-target drill. Returns a single
    # BOUNDED window centered on the target (context above + below, capped
    # at `limit`) instead of making the PWA page backward N times to reach
    # it. Mutually exclusive with `before` (a cursor page); if both are
    # sent, `around` wins.
    around = request.query.get("around")

    # `after=<int id>` — load-newer cursor, symmetric counterpart of
    # `before`. Used when the user scrolls DOWN past the bottom of a
    # bounded deep-jump window toward the live tail.
    after = request.query.get("after")
    after_id: Optional[int]
    if after is None:
        after_id = None
    else:
        try:
            after_id = int(after)
        except ValueError:
            return web.Response(status=400, text="invalid after cursor")

    # Source resolution still hits state.db — it's the canonical
    # mapping of chat_id → source (parley / telegram / slack /…).
    # Track whether state.db has ANY session for this chat so the
    # final 404-vs-empty decision can incorporate it.
    parsed_source, chat_id = _parse_gateway_id(raw_id)
    state_db_knows_chat = parsed_source is not None
    if parsed_source is not None:
        source = parsed_source
        _trace("source-from-prefix", f"source={source} chat={chat_id[:24]}")
    else:
        _trace("source-resolve-start", f"chat={chat_id[:24]}")
        source = await asyncio.to_thread(_resolve_source_for_chat_id, adapter, chat_id)
        _trace("source-resolve-end", f"source={source}")
        state_db_knows_chat = source is not None
        if source is None:
            source = "sidekick"  # assume parley for the reconcile/query below

    from . import parley_state as _sstate
    from . import parley_perf_trace as _perf  # noqa: WPS433 (worker semaphore)

    # Opportunistic reconciliation: pull any state.db rows missing from
    # parley.db. The read below is correct from state.db ALONE, so this
    # runs DETACHED (fire-and-forget) and never blocks the response — see
    # _spawn_background_reconcile. Throttled per-chat (see
    # _RECONCILE_THROTTLE_S) so a busy poll/multi-device read pattern
    # doesn't re-spawn the full-history pass on every enter.
    _now = _time.monotonic()
    _prev = _last_reconcile_at.get(chat_id)
    if _prev is not None and (_now - _prev) < _RECONCILE_THROTTLE_S:
        _trace("reconcile-skip", f"age={_now - _prev:.1f}s")
    else:
        _last_reconcile_at[chat_id] = _now
        _spawn_background_reconcile(adapter, chat_id, source)
        _trace("reconcile-bg", "spawned")

    # B2 / v2 read path: state.db is the canonical body store;
    # parley.db.msg_links surfaces sidekick_id + kind as annotations.
    # ON by default 2026-05-29 (v2 ship — paired with the deterministic
    # link shim in reconcile_from_state_db Pass 1.b). Set
    # PARLEY_ITEMS_READ_FROM_STATE_DB=0 to fall back to the legacy v1
    # path (mirrors bodies in parley.db; dupes on link miss).
    _b2_enabled = env_get("PARLEY_ITEMS_READ_FROM_STATE_DB", "1").lower() in ("1", "true", "yes")
    # Transcript v3 read flip (Phase 3, 2026-07-30): for chats holding a
    # current-SCHEMA_VERSION chat_migrations marker, serve parley.db
    # bodies + identity (msg_links), consulting state.db only through
    # links for liveness — see parley_state._build_v3_items. Default
    # OFF; flag on + unmarked (or stale-version) chat falls through to
    # the legacy read untouched. Per-chat automatic fallback; global
    # instant revert by unsetting PARLEY_ITEMS_V3 (B2 playbook). The
    # background chain above runs the Phase-5 divergence monitor for
    # chats this flag serves (Phase 4 retired the content reconcile
    # there — the turn linker writes the links at turn close now) and
    # the unchanged legacy chain for everything else.
    _v3_flag = _items_v3_flag()
    _use_v3 = False
    if _v3_flag and adapter._parley_db is not None:
        from . import parley_chat_migration as _migration  # noqa: WPS433
        _use_v3 = (
            await _perf.run_in_parley_worker(
                _migration.get_migration, adapter._parley_db, chat_id,
            )
        ) is not None
    _trace("query-start", f"limit={limit} before={before_id} after={after_id} around={around or ''} b2={_b2_enabled} v3={_use_v3}")
    target_found = None
    last_id = None
    has_more_newer = None
    if around is not None and (_b2_enabled or _use_v3):
        # Deep-target drill: one BOUNDED window centered on the target.
        # Only on the B2/v3 paths (the v1 fallback's millis cursor doesn't
        # map cleanly to an "around" window; the PWA falls back to its
        # serial load-earlier drill when target_found is False / the field
        # is absent).
        if _use_v3:
            result = await _perf.run_in_parley_worker(
                _sstate.list_messages_around_for_chat_v3,
                adapter._parley_db, adapter._state_db_path, chat_id,
                target=around, limit=limit,
            )
        else:
            result = await _perf.run_in_parley_worker(
                _sstate.list_messages_around_for_chat_with_state_db_source,
                adapter._parley_db, adapter._state_db_path, chat_id, source,
                target=around, limit=limit,
            )
        target_found = bool(result.get("target_found"))
        last_id = result.get("last_id")
        has_more_newer = bool(result.get("has_more_newer"))
    elif after_id is not None and (_b2_enabled or _use_v3):
        # Load-newer page (symmetric counterpart of before paging).
        if _use_v3:
            result = await _perf.run_in_parley_worker(
                _sstate.list_messages_after_for_chat_v3,
                adapter._parley_db, adapter._state_db_path, chat_id,
                after_id=after_id, limit=limit,
            )
        else:
            result = await _perf.run_in_parley_worker(
                _sstate.list_messages_after_for_chat_with_state_db_source,
                adapter._parley_db, adapter._state_db_path, chat_id, source,
                after_id=after_id, limit=limit,
            )
        last_id = result.get("last_id")
        has_more_newer = bool(result.get("has_more_newer"))
    elif _use_v3:
        result = await _perf.run_in_parley_worker(
            _sstate.list_messages_for_chat_v3,
            adapter._parley_db, adapter._state_db_path, chat_id,
            limit=limit, before_id=before_id,
        )
    elif _b2_enabled:
        result = await _perf.run_in_parley_worker(
            _sstate.list_messages_for_chat_with_state_db_source,
            adapter._parley_db, adapter._state_db_path, chat_id, source,
            limit=limit, before_id=before_id,
        )
    else:
        result = await _perf.run_in_parley_worker(
            _sstate.list_messages_for_chat,
            adapter._parley_db, chat_id,
            limit=limit, before_rowid=before_id,
        )
    items = result["items"]
    first_id = result["first_id"]
    # `has_more` (older-direction) is the only key whose presence varies
    # across the four query branches — the load-newer (`after`) result
    # omits it. Read defensively: a missing key must never 500 a
    # transcript read for the whole app.
    has_more = result.get("has_more", False)
    _trace("query-end", f"rows={len(items)} target_found={target_found}")

    inflight_entry = None
    inflight_envelopes: list = []
    if adapter._turn_buffer is not None:
        inflight_entry = adapter._turn_buffer.active_for_chat(chat_id)
        if inflight_entry is not None:
            inflight_envelopes = adapter._turn_buffer.render_envelopes(inflight_entry)

    # 404 only when truly unknown chat: no parley.db rows + no
    # state.db session + no in-flight turn. Preserves the original
    # cmdk drill-to-message fall-through behavior.
    if not items and not inflight_envelopes and not state_db_knows_chat:
        return web.Response(status=404, text="conversation not found")

    body: Dict[str, Any] = {
        "object": "list",
        "data": items,
        "first_id": first_id,
        "has_more": has_more,
    }
    # Echo whether the around-target was located so the PWA can fall back
    # to its serial load-earlier drill on a stale pin (target_found=False).
    if target_found is not None:
        body["target_found"] = target_found
    # Load-newer boundary — set on the bounded around-window + the after
    # cursor paths so the PWA knows whether scroll-down can fetch more
    # toward the live tail (and where to resume from).
    if last_id is not None:
        body["last_id"] = last_id
    if has_more_newer is not None:
        body["has_more_newer"] = has_more_newer
    if inflight_envelopes:
        body["inflight"] = inflight_envelopes
    response = web.json_response(body)
    _trace("response-built")
    return response
