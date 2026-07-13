"""HTTP route handlers for /v1/conversations* (list, delete, rename).

Extracted from ``__init__.py`` 2026-05-17. Covers:

  - ``GET /v1/conversations``               channel-only drawer
  - ``GET /v1/gateway/conversations``       cross-platform drawer
  - ``DELETE /v1/conversations/{id}``       cascade delete
  - ``PATCH /v1/conversations/{id}``        rename (sets sessions.title)
  - ``_summaries_by_user_id(...)``          state.db aggregation
  - ``delete_conversation_sync(...)``       worker-thread cascade
  - ``rename_conversation_sync(...)``       worker-thread title update
  - ``_purge_hindsight_for_session_uuids``  memory-store cleanup

Wiring contract: every public coroutine takes the calling
``SidekickAdapter`` instance + the aiohttp request. The mutation
handlers reach into ``adapter._state_db_path``,
``adapter._session_state_cache``, ``adapter._sid_to_chat_id_cache``,
and the envelope publishers (``_safe_send_envelope`` on the
adapter, and ``sidekick_route_events.publish_out_of_turn`` for the
out-of-turn channel).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import sqlite3
import time
from typing import Tuple

# aiohttp is the route handlers' return-type dep, but the sync
# helpers (delete_conversation_sync, rename_conversation_sync,
# _purge_hindsight_for_session_uuids) don't touch it. Guarding the
# import keeps lightweight unit tests (test_user_id_queries.py) able
# to load this module without pulling in the aiohttp runtime — they
# only exercise the sync helpers. Production loads aiohttp via
# __init__.py's import chain before any route handler runs.
try:
    from aiohttp import web  # type: ignore[assignment]
except ImportError:  # pragma: no cover
    web = None  # type: ignore[assignment]

from .sidekick_ids import (
    GATEWAY_DRAWER_SOURCES,
    SIDEKICK_SOURCE,
    _format_gateway_id,
    _parse_gateway_id,
)

logger = logging.getLogger(__name__)

# Session title cap on the PATCH path. 200 is well above what the drawer
# renders (~40 before ellipsis) but small enough that an abusive client
# can't bloat the sessions row. PWA UI already truncates at 80.
SESSION_TITLE_MAX_LEN = 200

# Sidekick-namespaced sessions.json key prefix. Matches
# ``build_session_key(SessionSource(platform=SIDEKICK, chat_id=X,
# chat_type='dm'))`` — ``agent:main:sidekick:dm:<chat_id>``.
SESSION_KEY_PREFIX = "agent:main:sidekick:dm:"


# ── TTL cache for _summaries_by_user_id ─────────────────────────────
#
# Drawer aggregation runs a recursive-CTE SQL with SIX correlated
# subqueries per session row — each subquery is a full pass over
# messages WHERE session_id = X. For a user with many sessions
# (compaction children stack high on long chats), that's
# O(sessions × messages_per_session) work per call, all in synchronous
# Python+SQL. PWA polls the drawer-list endpoint on every session
# switch + many drawer refresh paths. Under burst load this saturated
# the bounded worker pool and queued /items reads for 13s+ (caught
# 2026-06-23 via py-spy).
#
# 2-second TTL collapses a poll burst to ~1 full computation per
# window. Drawer UX tolerates ≤2s staleness fine — new chats appearing
# in the drawer 2s later is invisible compared to a 13s spinner.
import threading as _threading  # noqa: WPS433
_SUMMARIES_CACHE_TTL_S = float(
    os.environ.get("SIDEKICK_SUMMARIES_CACHE_TTL_MS", "5000") or 5000
) / 1000.0
_summaries_cache: dict = {}  # (sources_tuple, limit) → (cached_at, result)
_summaries_cache_lock = _threading.Lock()


def invalidate_summaries_cache() -> None:
    """Drop cached drawer-summaries. Called on delete / rename and on
    explicit cache-flush signals so the next list reflects mutations
    immediately. Bulk-flushes; granular per-source flush isn't worth
    the complexity given the tiny number of source tuples in play.
    """
    with _summaries_cache_lock:
        _summaries_cache.clear()


def _summaries_by_user_id(
    adapter, sources: Tuple[str, ...], limit: int,
) -> list:
    """Drawer aggregation grouped by ``(user_id, source)``.

    Returns ``[(chat_id, source, chat_type, title, message_count,
    turn_count, tool_count, last_active_at, created_at,
    first_user_message, session_ids), …]`` sorted most-recently-active
    first, bounded by ``limit``. ``session_ids`` is a space-joined
    string of every hermes session id that rolls up into the row
    (root + rotated/compacted children) so clients can match raw
    session ids in their session filter.

    ``turn_count`` is user-role messages (the user's mental model of
    "how many times have I said something"); ``tool_count`` is the
    opaque count of tool-call/result rows hermes inserted along the
    way. The drawer renders ``N turns · M tools`` when both are
    present (vs the misleading ``message_count`` which used to read
    as e.g. "39 msgs" when the user had only spoken twice and the
    agent had run 35 tool calls under the hood).

    ``sources`` is the platform allow-list — any non-empty
    ``sessions.source`` is included if its value is in this tuple.
    Pass ``("sidekick",)`` for the channel-only drawer; pass the
    full set (sidekick, telegram, slack, whatsapp, …) for the
    cross-platform gateway drawer.

    Results are TTL-cached (``_SUMMARIES_CACHE_TTL_S``); mutation
    paths (delete, rename) flush via ``invalidate_summaries_cache``.

    chat_type is fixed to "dm" because state.db doesn't carry it
    explicitly. The plugin's existing surface only exposed DM
    chats; group/channel inference would need an out-of-band
    signal (room id parsing) which lives in the platform adapters,
    not here.

    ``parent_session_id`` chains (compression forks) are walked
    via a recursive CTE that maps every session to its root
    user_id. The upstream hermes contract claims rotated sessions
    inherit user_id from the root, but in practice compaction
    creates child sessions with user_id=NULL. The CTE resolves the
    effective user_id by walking parent_session_id chains until we
    hit a session with user_id set; that root user_id is then used
    as the GROUP BY key for the drawer row.

    Where ORDER BY matters: ``ORDER BY started_at DESC LIMIT 1`` for
    the title pulls the *latest* session for the chat (whatever
    compression and session_reset did), which is what the drawer
    wants.
    """
    if adapter._state_db_path is None or not adapter._state_db_path.exists():
        return []
    if not sources:
        return []
    # ── TTL cache check ─────────────────────────────────────────────
    cache_key = (tuple(sorted(sources)), int(limit))
    now = time.monotonic()
    with _summaries_cache_lock:
        cached = _summaries_cache.get(cache_key)
        if cached is not None:
            cached_at, value = cached
            if now - cached_at < _SUMMARIES_CACHE_TTL_S:
                return value
    src_csv = ",".join(["?"] * len(sources))
    # Recursive CTE: session_root maps every session to its
    # effective (root_user_id, root_source) by walking
    # parent_session_id chains. Sessions with their own user_id
    # are their own root; sessions without inherit from their
    # parent's root. Hermes's compaction creates child sessions
    # with user_id=NULL, so this is the only way to roll them up
    # under the parent's user_id for drawer + history rendering.
    #
    # One row per resolved (root_user_id, source) pair:
    #   * MIN(started_at) — oldest session = drawer "created_at"
    #   * MAX over message timestamps — drawer "last_active_at"
    #   * SUM(COUNT(messages)) — total message_count across rotations
    #   * latest session's title (ORDER BY started_at DESC LIMIT 1)
    #   * very first user message ever (ORDER BY timestamp ASC LIMIT 1
    #     across all sessions that resolve to this user_id+source)
    # The system_prompt match in the recursive step distinguishes
    # compaction continuations (which INHERIT the parent's
    # sidekick-specific system_prompt) from delegate sub-task
    # sessions (which use hermes-agent's DEFAULT system_prompt
    # and just happen to share parent_session_id). Without this
    # gate the CTE over-includes delegate sub-task sessions that
    # share parent_session_id but use the default system_prompt.
    # PERF (2026-07-13, hermes-0.18.2 field regression — 7-10s drawer
    # lists, and the sync sqlite work blocked the gateway event loop
    # for the duration; measured back to 135ms after this rewrite):
    #  1. Carry only the 200-char prompt HEAD + length through the
    #     recursion, not the full system_prompt. Prompts average ~21KB
    #     (some 100KB+); dragging them through every recursion row and
    #     SUBSTR-ing per candidate burned CPU + overflow-page I/O.
    #     Semantics identical: the original also compared only the
    #     first 200 chars of the ROOT's prompt (propagated unchanged).
    #  2. CROSS JOIN pins the recursive step's join order to
    #     queue-row → children-by-parent (idx_sessions_parent). The
    #     planner otherwise drove from `user_id IS NULL` (hundreds of
    #     rows) and re-scanned the whole accumulated queue per
    #     candidate — quadratic. Worse, SQLite re-evaluates the CTE
    #     co-routine for EACH of the 3 references below (sr/sr2/sr3),
    #     so the quadratic step was paid three times per request.
    sql = f"""
        WITH RECURSIVE session_root(id, root_user_id, root_source, prompt_head, prompt_len) AS (
            SELECT id, user_id, source,
                   SUBSTR(COALESCE(system_prompt, ''), 1, 200),
                   LENGTH(COALESCE(system_prompt, ''))
              FROM sessions
             WHERE user_id IS NOT NULL
            UNION ALL
            SELECT s.id, sr.root_user_id, sr.root_source, sr.prompt_head, sr.prompt_len
              FROM session_root sr CROSS JOIN sessions s
             WHERE s.parent_session_id = sr.id
               AND s.user_id IS NULL
               AND sr.prompt_len >= 200
               AND SUBSTR(COALESCE(s.system_prompt, ''), 1, 200) = sr.prompt_head
        )
        SELECT
            sr.root_user_id AS user_id,
            sr.root_source AS source,
            MIN(COALESCE(s.started_at, 0)) AS created_at,
            COALESCE(MAX(
                (SELECT COALESCE(MAX(m.timestamp), s.started_at)
                   FROM messages m WHERE m.session_id = s.id)
            ), 0) AS last_active_at,
            SUM(
                (SELECT COUNT(*) FROM messages m
                   WHERE m.session_id = s.id)
            ) AS message_count,
            SUM(
                (SELECT COUNT(*) FROM messages m
                   WHERE m.session_id = s.id AND m.role = 'user')
            ) AS turn_count,
            SUM(
                (SELECT COUNT(*) FROM messages m
                   WHERE m.session_id = s.id AND m.role = 'tool')
            ) AS tool_count,
            (SELECT COALESCE(s2.title, '')
               FROM session_root sr2
               JOIN sessions s2 ON s2.id = sr2.id
               WHERE sr2.root_user_id = sr.root_user_id
                 AND sr2.root_source = sr.root_source
               ORDER BY s2.started_at DESC LIMIT 1) AS title,
            (SELECT m.content
               FROM messages m
               JOIN session_root sr3 ON m.session_id = sr3.id
               WHERE sr3.root_user_id = sr.root_user_id
                 AND sr3.root_source = sr.root_source
                 AND m.role = 'user'
               ORDER BY m.timestamp ASC, m.id ASC LIMIT 1
            ) AS first_user_message,
            GROUP_CONCAT(s.id, ' ') AS session_ids
        FROM session_root sr
        JOIN sessions s ON s.id = sr.id
        WHERE sr.root_source IN ({src_csv})
        GROUP BY sr.root_user_id, sr.root_source
        ORDER BY last_active_at DESC
        LIMIT ?
    """
    params = list(sources) + [limit]
    uri = f"file:{adapter._state_db_path}?mode=ro"
    with contextlib.closing(
        sqlite3.connect(uri, uri=True, timeout=2.0)
    ) as conn:
        rows = conn.execute(sql, params).fetchall()
    out = []
    for (user_id, source, created_at, last_active_at, mcount,
         turn_count, tool_count, title, first_user, session_ids) in rows:
        if not user_id:
            continue
        first_user_truncated = (first_user or "")[:80] or None
        display_title = _get_conversation_title_override(adapter, source, user_id) or title or ""
        out.append((
            user_id, source, "dm", display_title, int(mcount or 0),
            int(turn_count or 0), int(tool_count or 0),
            float(last_active_at or 0), float(created_at or 0),
            first_user_truncated, session_ids or "",
        ))
    # Populate the TTL cache. Concurrent misses just overwrite — last
    # writer wins, which is fine for a forward-progressing summary.
    with _summaries_cache_lock:
        _summaries_cache[cache_key] = (now, out)
    return out


def _rows_with_unread_included(adapter, sources, limit: int) -> list:
    """Window completeness: the drawer's recency LIMIT must never hide
    a chat with unread state.

    Field bug 2026-07-08: an unread reply on a session at position 72
    was invisible in the 50-row drawer, so the OS app badge — which
    badge.ts derives from the FULL unread set served by /v1/unread —
    read 1 while the sidebar read 0, permanently, with no way to find
    or clear it. The badge, the sidebar sum, and this list must all
    derive from the same visible set, so chats with unread_count > 0
    or sticky marked_unread are force-included here regardless of the
    window.

    Sync + O(heavy) (compute_unread + a possible wide re-query) — call
    ONLY through run_in_sidekick_worker, same rule as
    _summaries_by_user_id. Both underlying calls are TTL-cached, so
    the common no-missing-unread case costs one cache lookup extra.
    """
    rows = _summaries_by_user_id(adapter, sources, limit)
    try:
        from .sidekick_unread import compute_unread  # noqa: WPS433 (late import, cycle-safe)
        unread = compute_unread(
            db=adapter._sidekick_db,
            state_db_path=adapter._state_db_path,
            source=SIDEKICK_SOURCE,
        )
        # compute_unread emits the PWA-facing prefixed form
        # (`sidekick:<chat>`) while summary rows carry the bare
        # state.db user_id — normalize to bare before intersecting or
        # nothing ever matches (the exact trap this helper's first
        # draft fell into).
        prefix = f"{SIDEKICK_SOURCE}:"
        wanted = set()
        for c in unread.get("chats", []):
            if not (c.get("unread_count", 0) > 0 or c.get("marked_unread")):
                continue
            cid = c.get("chat_id") or ""
            if cid.startswith(prefix):
                cid = cid[len(prefix):]
            if cid:
                wanted.add(cid)
    except Exception as exc:
        logger.debug("[sidekick] unread force-include skipped: %s", exc)
        return rows
    have = {r[0] for r in rows}
    missing = {w for w in wanted if w and w not in have}
    if not missing:
        return rows
    # Pull the widest window the endpoint itself allows and lift the
    # missing rows out of it. An unread chat older than the 200th-most-
    # recent stays hidden — accepted edge; it would need a dedicated
    # per-chat summary query.
    wide = _summaries_by_user_id(adapter, sources, 200)
    extras = [r for r in wide if r[0] in missing]
    merged = rows + extras
    merged.sort(key=lambda r: r[7], reverse=True)  # last_active_at
    return merged


async def handle_list(adapter, request: "web.Request") -> "web.Response":
    """GET /v1/conversations — return the sidekick-only drawer list.

    Channel-only counterpart to the cross-platform
    ``/v1/gateway/conversations``. Single-channel agents (stub,
    third-party OAI-compat agents that aren't gateways) implement
    only this. The proxy probes the gateway endpoint first and
    falls back here on 404, stamping ``source: 'sidekick'``."""
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    try:
        limit = max(1, min(int(request.query.get("limit", "50")), 200))
    except ValueError:
        return web.Response(status=400, text="invalid limit")

    from . import sidekick_perf_trace as _perf  # noqa: WPS433
    rows = await _perf.run_in_sidekick_worker(
        _rows_with_unread_included, adapter, (SIDEKICK_SOURCE,), limit,
    )
    data = [
        {
            "id": chat_id,
            "object": "conversation",
            "created_at": int(created_at),
            "metadata": {
                "title": title or "",
                "message_count": message_count,
                "turn_count": turn_count,
                "tool_count": tool_count,
                "last_active_at": int(last_active_at),
                "first_user_message": first_user_message,
                "session_ids": session_ids,
            },
        }
        for (chat_id, _source, _chat_type, title, message_count,
             turn_count, tool_count,
             last_active_at, created_at, first_user_message,
             session_ids) in rows
    ]
    return web.json_response({"object": "list", "data": data})


async def handle_list_gateway(adapter, request: "web.Request") -> "web.Response":
    """GET /v1/gateway/conversations — cross-platform drawer list.

    Same OAI-compat row shape as ``/v1/conversations`` (``{id, object,
    created_at, metadata}``), but enumerates every platform in
    state.db (telegram / slack / whatsapp / sidekick / …) and adds
    ``source`` + ``chat_type`` to ``metadata`` so the proxy can render
    per-row badges. Sidekick's drawer relies on this for cross-
    platform visibility; non-sidekick rows are read-only.

    Backed by ``_summaries_by_user_id`` which groups state.db rows by
    ``(user_id, source)`` — chat_id IS user_id at the gateway. This
    means rotated session_ids (auto-reset, compression) all roll up
    into a single drawer entry; the previous sessions.json walk
    only saw the currently-active session per chat and lost the
    rest after rotation.

    Implementing this endpoint is what makes a plugin a "gateway" in
    sidekick's eyes. Single-channel agents (stub, openai-compat
    third-parties) leave it unimplemented and the proxy falls back
    to ``/v1/conversations``."""
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    try:
        limit = max(1, min(int(request.query.get("limit", "50")), 200))
    except ValueError:
        return web.Response(status=400, text="invalid limit")

    from . import sidekick_perf_trace as _perf  # noqa: WPS433
    rows = await _perf.run_in_sidekick_worker(
        # Same unread force-include as handle_list: unread state only
        # exists for sidekick-source chats, so the union is a no-op for
        # the other platforms' rows.
        _rows_with_unread_included, adapter, GATEWAY_DRAWER_SOURCES, limit,
    )
    data = [
        {
            # Prefixed `${source}:${chat_id}` — see _format_gateway_id
            # rationale in sidekick_ids.py. Clients treat as opaque;
            # per-chat handlers decode source-side via _parse_gateway_id.
            "id": _format_gateway_id(source, chat_id),
            "object": "conversation",
            "created_at": int(created_at),
            "metadata": {
                "title": title or "",
                "message_count": message_count,
                "turn_count": turn_count,
                "tool_count": tool_count,
                "last_active_at": int(last_active_at),
                "first_user_message": first_user_message,
                "source": source,
                "chat_type": chat_type,
                # Native chat_id (pre-prefix) preserved for clients
                # that need to display or correlate the platform-
                # native identifier (e.g. WhatsApp @lid badge, debug).
                "native_chat_id": chat_id,
                "session_ids": session_ids,
            },
        }
        for (chat_id, source, chat_type, title, message_count,
             turn_count, tool_count,
             last_active_at, created_at, first_user_message,
             session_ids) in rows
    ]
    return web.json_response({"object": "list", "data": data})


# ── mutation handlers ────────────────────────────────────────────────


async def handle_delete(adapter, request: "web.Request") -> "web.Response":
    """DELETE /v1/conversations/{id} — hard delete with full cascade.

    Cascade ordering:
      1. state.db (sessions + messages rows)
      2. ~/.hermes/sessions/sessions.json (key removal)
      3. ~/.hermes/sessions/<sid>.jsonl (transcript file)
      4. Hindsight bank (memory units tagged with this session UUID)

    Best-effort on each step — sql failure aborts (the cascade can't
    proceed without knowing which session_id to scrub), filesystem
    failures log + continue, hindsight failures log + continue
    (privacy bug if hindsight scrub fails, but a stranded memory
    row is less bad than a stranded session row that re-ghosts the
    drawer)."""
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    raw_id = request.match_info["id"]
    # Source-aware delete — without the prefix we'd default to
    # SIDEKICK_SOURCE and silently scrub the wrong session when
    # chat_ids collide across platforms.
    parsed_source, chat_id = _parse_gateway_id(raw_id)
    source = parsed_source if parsed_source is not None else SIDEKICK_SOURCE
    if parsed_source is None:
        # Surfaces any caller still using bare-id DELETE so we can
        # tighten this fallback (eventually 400) once all callers
        # migrate. The 2026-05-03 data-loss regression flowed through
        # this exact path: a stale frontend cleanup hit bare-id
        # DELETE, this fallback defaulted to sidekick, and a real
        # session was wiped silently. The frontend cleanup is now
        # local-IDB-only (src/main.ts cleanupAbandonedChat) — any
        # bare-id DELETE arriving here is unexpected and worth a log.
        logger.warning(
            "[sidekick] bare-id DELETE %s — defaulting source=sidekick. "
            "Caller should use prefixed id `sidekick:%s` to be explicit.",
            raw_id, chat_id,
        )
    # TERMINATE any active agent turn for this chat BEFORE removing its
    # rows (field 2026-07-13: a meeting-ingest turn survived its
    # session's deletion, replied minutes later, and the turn-end
    # persistence resurrected the session as a zombie). Deleting a chat
    # means "stop acting on my behalf in this context" — the interrupt
    # also stops the turn's remaining tool calls and token spend, not
    # just the reply. The tombstone below catches the in-flight tail
    # the interrupt can't (a reply already past the loop's last
    # interrupt check).
    try:
        for session_key in list(getattr(adapter, "_active_sessions", {}) or {}):
            if chat_id in session_key:
                await adapter.interrupt_session_activity(session_key, chat_id)
                logger.info(
                    "[sidekick] DELETE %s — interrupted active agent session %s",
                    chat_id, session_key,
                )
    except Exception as e:  # noqa: BLE001 — delete must proceed regardless
        logger.warning("[sidekick] DELETE %s — agent interrupt failed: %s", chat_id, e)
    mark_chat_deleted(adapter, chat_id)
    result = await asyncio.to_thread(
        delete_conversation_sync, adapter, chat_id, source,
    )
    if result == "not_found":
        return web.Response(status=404, text="conversation not found")
    if result == "error":
        return web.Response(status=500, text="delete failed")
    # Drop from in-process caches so the next list/poll doesn't
    # resurrect the row from stale state.
    adapter._session_state_cache.pop(chat_id, None)
    for sid in [s for s, c in adapter._sid_to_chat_id_cache.items() if c == chat_id]:
        adapter._sid_to_chat_id_cache.pop(sid, None)
    # Drop the summaries TTL cache — drawer list must reflect the
    # delete immediately on the next /v1/conversations poll. Without
    # this, the deleted chat would linger in the drawer for up to
    # `_SUMMARIES_CACHE_TTL_S` seconds.
    invalidate_summaries_cache()
    # Cross-device delete sync: emit conversation_deleted so other
    # connected PWAs drop the row from their sidebar without waiting
    # for a manual refresh. Without an envelope, the other device
    # only learns about the delete on its next sessions-list poll
    # (which is on a long cadence, hence the straggler).
    prefixed_chat_id = _format_gateway_id(source, chat_id)
    try:
        from . import sidekick_route_events as _route_events
        _route_events.publish_out_of_turn(adapter, {
            "type": "conversation_deleted",
            "chat_id": prefixed_chat_id,
            "source": source,
        })
    except Exception as exc:
        logger.debug("[sidekick] conversation_deleted publish failed: %s", exc)
    return web.json_response({"ok": True})


async def handle_rename(adapter, request: "web.Request") -> "web.Response":
    """PATCH /v1/conversations/{id} — set sessions.title.

    Body: ``{"title": "..."}`` — non-empty trimmed string ≤
    ``SESSION_TITLE_MAX_LEN`` chars. Updates every session row
    sharing ``(source, user_id=chat_id)`` so a chat that's been
    rotated by compression / auto-reset still surfaces the new
    title via ``_summaries_by_user_id`` (which picks the latest
    session's title).

    Sidekick-source-only today — telegram / slack / whatsapp don't
    expose a "rename" surface, and a sidekick-tab rename of a
    cross-source row would silently mutate state.db rows owned by
    a different platform. Rejected with 400 to make the boundary
    explicit.

    Emits a ``session_changed`` envelope so any other connected
    clients (PWA on a second device, the originating client's other
    tabs) see the live update via /v1/events. Same shape the
    compression poller uses; the event_id ring de-dupes if the
    poller's next tick observes the same change.
    """
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    raw_id = request.match_info["id"]
    parsed_source, chat_id = _parse_gateway_id(raw_id)
    source = parsed_source if parsed_source is not None else SIDEKICK_SOURCE
    if source != SIDEKICK_SOURCE:
        # Cross-source rename has no defined semantics yet — refuse
        # rather than silently mutate a non-sidekick session row.
        return web.json_response(
            {"error": "rename only supported for sidekick sessions"},
            status=400,
        )
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    title = body.get("title") if isinstance(body, dict) else None
    if not isinstance(title, str):
        return web.json_response(
            {"error": "title must be a string"}, status=400,
        )
    title = title.strip()
    if not title:
        return web.json_response(
            {"error": "title must be non-empty"}, status=400,
        )
    if len(title) > SESSION_TITLE_MAX_LEN:
        return web.json_response(
            {"error": f"title exceeds {SESSION_TITLE_MAX_LEN} chars"},
            status=400,
        )
    result = await asyncio.to_thread(
        rename_conversation_sync, adapter, chat_id, source, title,
    )
    if result == "not_found":
        return web.json_response(
            {"error": "conversation not found"}, status=404,
        )
    if result == "title_conflict":
        # state.db has a partial UNIQUE INDEX on title. Surfacing
        # 409 lets the PWA tell the user "another chat already
        # has that name" instead of crashing.
        return web.json_response(
            {"error": "another conversation already uses this title"},
            status=409,
        )
    if result == "error":
        return web.json_response({"error": "rename failed"}, status=500)
    # Surface to other connected clients. Use the same envelope
    # shape the compression poller emits — clients already know how
    # to consume it. session_id field is best-effort: we surface
    # whatever the poller has cached; downstream consumers key on
    # chat_id+title so a stale/empty session_id is harmless.
    cached_sid = (adapter._session_state_cache.get(chat_id) or ("", ""))[0]
    # Update the cache so the next poll tick doesn't immediately
    # re-emit a session_changed for the same (sid, title) pair.
    adapter._session_state_cache[chat_id] = (cached_sid, title)
    # Drawer summaries cache holds the old title — flush so the next
    # /v1/conversations poll reflects the new one immediately.
    invalidate_summaries_cache()
    await adapter._safe_send_envelope({
        "type": "session_changed",
        "chat_id": chat_id,
        "session_id": cached_sid,
        "title": title,
    })
    return web.json_response({"ok": True, "title": title})


# ── worker-thread helpers ────────────────────────────────────────────


_DELETED_CHAT_TTL_S = 600.0


def mark_chat_deleted(adapter, chat_id: str) -> None:
    """Tombstone a just-deleted chat on the ADAPTER so late agent output
    for it gets dropped instead of resurrecting the session (unified
    with the interrupt in handle_delete — this is the belt for the
    in-flight tail the interrupt can't reach). Read via
    ``is_chat_deleted``; entries self-evict after the TTL so a chat_id
    legitimately recreated later isn't suppressed forever."""
    store = getattr(adapter, "_deleted_chat_tombstones", None)
    if store is None:
        store = {}
        adapter._deleted_chat_tombstones = store
    store[chat_id] = time.time()


def is_chat_deleted(adapter, chat_id: str) -> bool:
    store = getattr(adapter, "_deleted_chat_tombstones", None)
    if not store:
        return False
    ts = store.get(chat_id)
    if ts is None:
        return False
    if time.time() - ts > _DELETED_CHAT_TTL_S:
        store.pop(chat_id, None)
        return False
    return True


def delete_conversation_sync(
    adapter, chat_id: str, source: str = SIDEKICK_SOURCE,
) -> str:
    """Synchronous cascade delete. Returns 'ok', 'not_found', or
    'error'. Worker-thread safe.

    Resolves the set of session_ids to scrub via
    ``WHERE user_id = chat_id AND source = ?`` — picks up every
    session that ever belonged to this `(source, chat_id)` pair
    (compression forks AND auto-reset rotations), no recursive
    parent-chain walk needed. ``source`` defaults to ``sidekick``
    for backward compat with un-prefixed delete callers."""
    if adapter._state_db_path is None or not adapter._state_db_path.exists():
        return "error"
    try:
        with contextlib.closing(
            sqlite3.connect(adapter._state_db_path, timeout=5.0)
        ) as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            with conn:
                # Recursive CTE walks parent_session_id chains so
                # compacted child sessions (user_id=NULL) are
                # included in the cascade — otherwise a delete
                # leaves orphan child sessions in state.db,
                # consuming disk + occasionally surfacing
                # ghost rows.
                rows = conn.execute("""
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
                    SELECT id FROM session_root
                """, (chat_id, source)).fetchall()
                fork_sids = [r[0] for r in rows]
                if not fork_sids:
                    return "not_found"
                placeholders = ",".join(["?"] * len(fork_sids))
                conn.execute(
                    f"DELETE FROM messages WHERE session_id IN ({placeholders})",
                    fork_sids,
                )
                conn.execute(
                    f"DELETE FROM sessions WHERE id IN ({placeholders})",
                    fork_sids,
                )
    except Exception as exc:
        logger.warning("[sidekick] state.db delete failed for chat_id=%s: %s", chat_id, exc)
        return "error"
    # sessions.json: scrub the sidekick key. SESSION_KEY_PREFIX is
    # the sidekick-namespaced prefix; for non-sidekick deletes the
    # sessions.json entry (if any) belongs to a different platform
    # adapter and isn't ours to scrub here. Skip when source isn't
    # sidekick — hermes-agent's other adapters own their own keys.
    # jsonl + hindsight cascades below still run for any source.
    if source == SIDEKICK_SOURCE:
        sessions_index = adapter._state_db_path.parent / "sessions" / "sessions.json"
        try:
            if sessions_index.exists():
                with open(sessions_index, encoding="utf-8") as f:
                    idx = json.load(f)
                key = f"{SESSION_KEY_PREFIX}{chat_id}"
                if isinstance(idx, dict) and key in idx:
                    del idx[key]
                    tmp = sessions_index.with_suffix(f".tmp.{os.getpid()}")
                    with open(tmp, "w", encoding="utf-8") as f:
                        json.dump(idx, f, indent=2)
                    os.replace(tmp, sessions_index)
        except Exception as exc:
            logger.warning("[sidekick] sessions.json scrub failed: %s", exc)
    # jsonl transcripts.
    for sid in fork_sids:
        jsonl = adapter._state_db_path.parent / "sessions" / f"{sid}.jsonl"
        try:
            if jsonl.exists():
                jsonl.unlink()
        except Exception as exc:
            logger.warning("[sidekick] jsonl unlink failed for sid=%s: %s", sid, exc)
    # Hindsight cascade (privacy-critical — closes the regression
    # introduced in the platform-adapter migration where the new
    # delete path skipped the hindsight scrub the legacy path had).
    try:
        _purge_hindsight_for_session_uuids(fork_sids)
    except Exception as exc:
        logger.warning("[sidekick] hindsight purge failed: %s", exc)
    return "ok"


def rename_conversation_sync(
    adapter, chat_id: str, source: str, title: str,
) -> str:
    """Synchronous rename. Returns 'ok', 'not_found', or 'error'.
    Worker-thread safe.

    Updates only the LATEST session row for ``(user_id=chat_id,
    source)`` — that's the row the drawer's ``_summaries_by_user_id``
    picks up via ``ORDER BY started_at DESC LIMIT 1``. We can't
    update all rotated sessions in one shot because hermes-agent's
    state.db schema has a partial UNIQUE INDEX on
    ``sessions(title) WHERE title IS NOT NULL`` — every other
    rotated session for this chat ALREADY holds a (likely auto-
    generated, distinct) title, and rewriting them all to the same
    new title violates that constraint. The drawer's read path
    already prefers the latest, so updating just that row is
    sufficient and constraint-safe.
    """
    if adapter._state_db_path is None or not adapter._state_db_path.exists():
        return "error"
    try:
        with contextlib.closing(
            sqlite3.connect(adapter._state_db_path, timeout=5.0)
        ) as conn:
            with conn:
                # Find the latest session for this chat using the same
                # effective-root semantics as _summaries_by_user_id().
                # Compression continuations often have user_id=NULL and
                # parent_session_id=<root>; the drawer surfaces the latest
                # continuation title, so rename must target that same row.
                lineage_sql = """
                    WITH RECURSIVE session_root(id, root_user_id, root_source, root_system_prompt) AS (
                        SELECT id, user_id, source, system_prompt
                          FROM sessions
                         WHERE user_id IS NOT NULL
                        UNION ALL
                        SELECT s.id, sr.root_user_id, sr.root_source, sr.root_system_prompt
                          FROM sessions s
                          JOIN session_root sr ON s.parent_session_id = sr.id
                         WHERE s.user_id IS NULL
                           AND LENGTH(COALESCE(sr.root_system_prompt, '')) >= 200
                           AND SUBSTR(COALESCE(s.system_prompt, ''), 1, 200)
                               = SUBSTR(sr.root_system_prompt, 1, 200)
                    )
                    SELECT s.id
                      FROM session_root sr
                      JOIN sessions s ON s.id = sr.id
                     WHERE sr.root_user_id = ?
                       AND sr.root_source = ?
                     ORDER BY s.started_at DESC LIMIT 1
                """
                row = conn.execute(lineage_sql, (chat_id, source)).fetchone()
                if row is None:
                    return "not_found"
                latest_sid = row[0]
                # If another session already holds this title,
                # the partial UNIQUE INDEX would reject the UPDATE.
                # Two cases to distinguish:
                #
                #  1. The conflicting row is a STALE SIBLING for the
                #     SAME chat_id+source — i.e. a prior rotation
                #     where the user had set this title before
                #     hermes' session compression minted a new row.
                #     The drawer only ever shows the latest row, so
                #     the sibling's title is functionally orphaned.
                #     Clear it so the latest row can take the name —
                #     matches the user's mental model of "this CHAT
                #     is named X" (not "this session_id is named X").
                #
                #  2. The conflicting row belongs to a DIFFERENT
                #     chat — genuine cross-chat collision; reject
                #     and let the caller surface a toast.
                #
                # Filtering on `id != latest_sid` so the idempotent
                # case (latest row already has this title) falls
                # through to a no-op UPDATE without spurious clear.
                existing = conn.execute(
                    "SELECT id, user_id, source, parent_session_id FROM sessions "
                    "WHERE title = ? AND id != ?",
                    (title, latest_sid),
                ).fetchone()
                if existing is not None:
                    other_id, other_user, other_source, _other_parent = existing
                    if other_source == source and _session_belongs_to_chat(
                        conn, other_id, chat_id, source,
                    ):
                        # Stale sibling — release its grip on the title.
                        conn.execute(
                            "UPDATE sessions SET title = NULL "
                            "WHERE id = ?",
                            (other_id,),
                        )
                    else:
                        return "title_conflict"
                conn.execute(
                    "UPDATE sessions SET title = ? WHERE id = ?",
                    (title, latest_sid),
                )
    except Exception as exc:
        logger.warning(
            "[sidekick] state.db rename failed for chat_id=%s: %s",
            chat_id, exc,
        )
        return "error"
    _set_conversation_title_override(adapter, source, chat_id, title)
    return "ok"


def _get_conversation_title_override(adapter, source: str, chat_id: str) -> str | None:
    db = getattr(adapter, "_sidekick_db", None)
    if db is None:
        return None
    try:
        row = db.fetchone(
            "SELECT title FROM conversation_titles WHERE source = ? AND chat_id = ?",
            (source, chat_id),
        )
        if row is None:
            return None
        title = str(row["title"] if hasattr(row, "keys") else row[0]).strip()
        return title or None
    except Exception as exc:
        logger.debug("[sidekick] title override read failed for %s:%s: %s", source, chat_id, exc)
        return None


def _set_conversation_title_override(adapter, source: str, chat_id: str, title: str) -> None:
    db = getattr(adapter, "_sidekick_db", None)
    if db is None:
        return
    try:
        db.exec(
            "INSERT INTO conversation_titles (source, chat_id, title, updated_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(source, chat_id) DO UPDATE SET "
            "title = excluded.title, updated_at = excluded.updated_at",
            (source, chat_id, title, time.time()),
        )
    except Exception as exc:
        logger.warning("[sidekick] title override write failed for %s:%s: %s", source, chat_id, exc)


def _session_belongs_to_chat(
    conn: sqlite3.Connection, session_id: str, chat_id: str, source: str,
) -> bool:
    """Return True if session_id resolves to chat_id/source via parent links."""
    row = conn.execute(
        """
        WITH RECURSIVE ancestors(id, user_id, source, parent_session_id, depth) AS (
            SELECT id, user_id, source, parent_session_id, 0
              FROM sessions WHERE id = ?
            UNION ALL
            SELECT p.id, p.user_id, p.source, p.parent_session_id, ancestors.depth + 1
              FROM sessions p
              JOIN ancestors ON ancestors.parent_session_id = p.id
             WHERE ancestors.depth < 20
        )
        SELECT 1 FROM ancestors
         WHERE user_id = ? AND source = ?
         LIMIT 1
        """,
        (session_id, chat_id, source),
    ).fetchone()
    return row is not None


def _purge_hindsight_for_session_uuids(session_uuids: list) -> None:
    """Delete hindsight memories tagged with any of these session
    UUIDs. Reads hindsight URL + bank from env; no-op if hindsight
    isn't configured (local-only deployments without a memory store).

    Best-effort: hindsight unreachable is logged but not fatal."""
    url = os.getenv("HINDSIGHT_URL", "").strip() or os.getenv("SIDEKICK_HINDSIGHT_URL", "").strip()
    if not url:
        return
    bank = os.getenv("HINDSIGHT_BANK", "").strip() or os.getenv("SIDEKICK_HINDSIGHT_BANK", "default").strip()
    api_key = os.getenv("HINDSIGHT_API_KEY", "").strip() or os.getenv("SIDEKICK_HINDSIGHT_API_KEY", "").strip()
    try:
        import urllib.error
        import urllib.parse
        import urllib.request
        headers = {"content-type": "application/json"}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        for sid in session_uuids:
            target = f"{url}/v1/default/banks/{urllib.parse.quote(bank, safe='')}/documents/{urllib.parse.quote(sid, safe='')}"
            req = urllib.request.Request(target, method="DELETE", headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=5.0) as resp:
                    if resp.status not in (200, 204, 404):
                        logger.warning("[sidekick] hindsight DELETE returned %s for sid=%s", resp.status, sid)
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    logger.warning("[sidekick] hindsight DELETE returned %s for sid=%s", e.code, sid)
            except Exception as exc:
                logger.warning("[sidekick] hindsight DELETE failed for sid=%s: %s", sid, exc)
    except Exception as exc:
        logger.warning("[sidekick] hindsight purge setup failed: %s", exc)
