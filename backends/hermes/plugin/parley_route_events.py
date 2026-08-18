"""HTTP route handler for ``GET /v1/events`` + the publish side.

Extracted from ``__init__.py``. Owns both:

  - ``handle_events(adapter, request)`` — SSE reader
  - ``publish_out_of_turn(adapter, env)`` — broadcast writer used by
    every envelope-routing site (send, edit_message, the hook
    plumbing, the cross-device sync paths). Centralizing both halves
    of the /v1/events plumbing keeps the channel's invariants
    (Last-Event-ID monotonicity, chat_id normalization, drop-on-full)
    in one place.

State on the adapter:
  - ``_event_subscribers`` — set of ``asyncio.Queue`` instances
  - ``_event_replay_ring`` — bounded list of ``(eid, env)`` for the
    Last-Event-ID resume path
  - ``_event_id_counter`` — monotone publisher counter
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

# Guarded aiohttp import — see parley_route_conversations for why.
try:
    from aiohttp import web  # type: ignore[assignment]
except ImportError:  # pragma: no cover
    web = None  # type: ignore[assignment]

from .parley_ids import (
    SIDEKICK_SOURCE,
    _GATEWAY_ID_SEP,
    _format_gateway_id,
)


logger = logging.getLogger(__name__)

# Same cap as __init__.py's TURN_QUEUE_MAX. Per-subscriber Queue size;
# bounds the worst-case memory hit from a hung consumer.
_TURN_QUEUE_MAX = 64

# Bounded ring for /v1/events replay on Last-Event-ID resume.
EVENT_REPLAY_CAP = 256


def publish_out_of_turn(adapter, env: Dict[str, Any]) -> bool:
    """Push an envelope to /v1/events subscribers + the replay ring.

    Synchronous (asyncio.Queue.put_nowait is non-blocking). Drops
    envelopes for subscribers whose queue is full — protects the
    plugin from a hung consumer; the affected client gets gaps,
    which it can detect via Last-Event-ID skips on reconnect.

    Wire-side chat_id normalization: prefix bare chat_ids with
    ``parley:`` so the field matches the format the PWA pins via
    ``getViewed()`` (drawer rows + URLs use ``_format_gateway_id``,
    which always prefixes). Without this, post-tool-result `send()`
    envelopes (sk-* message ids) carry bare chat_ids and the PWA's
    handleReplyDelta gate drops them as off-screen — symptom: agent
    reply hangs behind the activity row until session-switch+back
    re-fetches via the prefixed `/v1/conversations/parley:.../items`
    path. Internal queue routing (in-turn path) keys on bare chat_id
    and is unaffected — only the wire field is rewritten.
    """
    chat_id = env.get("chat_id")
    if isinstance(chat_id, str) and chat_id and _GATEWAY_ID_SEP not in chat_id:
        env = {**env, "chat_id": _format_gateway_id(SIDEKICK_SOURCE, chat_id)}
    adapter._event_id_counter += 1
    eid = adapter._event_id_counter
    adapter._event_replay_ring.append((eid, env))
    if len(adapter._event_replay_ring) > EVENT_REPLAY_CAP:
        adapter._event_replay_ring.pop(0)

    delivered = False
    dead: List["asyncio.Queue"] = []
    for q in list(adapter._event_subscribers):
        try:
            q.put_nowait((eid, env))
            delivered = True
        except asyncio.QueueFull:
            logger.warning(
                "[parley] /v1/events subscriber queue full, dropping %s",
                env.get("type"),
            )
        except Exception:
            dead.append(q)
    for q in dead:
        adapter._event_subscribers.discard(q)
    return delivered


async def handle_events(adapter, request: "web.Request") -> "web.StreamResponse":
    """GET /v1/events — persistent SSE for out-of-turn envelopes."""
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")

    last_event_id = request.headers.get("Last-Event-ID", "")
    cursor: Optional[int] = None
    if last_event_id:
        try:
            cursor = int(last_event_id)
        except ValueError:
            cursor = None

    queue: "asyncio.Queue[Tuple[int, Dict[str, Any]]]" = (
        asyncio.Queue(maxsize=_TURN_QUEUE_MAX)
    )
    adapter._event_subscribers.add(queue)

    resp = web.StreamResponse(
        status=200,
        headers={
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
        },
    )
    await resp.prepare(request)

    async def write_evt(eid: int, event_name: str, data: Dict[str, Any]) -> None:
        await resp.write(
            f"id: {eid}\nevent: {event_name}\ndata: {json.dumps(data)}\n\n".encode("utf-8")
        )

    try:
        # Tight reconnect hint so a transient drop resumes sub-second.
        await resp.write(b"retry: 1000\n\n")
        # Replay anything from the ring strictly newer than cursor.
        for eid, env in list(adapter._event_replay_ring):
            if cursor is None or eid > cursor:
                await write_evt(eid, env.get("type", "event"), env)
        # Live envelopes.
        while True:
            eid, env = await queue.get()
            await write_evt(eid, env.get("type", "event"), env)
    except (asyncio.CancelledError, ConnectionResetError):
        pass
    except Exception as exc:
        logger.warning("[parley] /v1/events error: %s", exc)
    finally:
        adapter._event_subscribers.discard(queue)
        with contextlib.suppress(Exception):
            await resp.write_eof()
    return resp
