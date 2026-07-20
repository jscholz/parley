"""HTTP route handlers for ``POST /v1/responses`` — turn dispatch.

The streaming + blocking paths together are the biggest single chunk
of the hermes plugin (~380 LOC). Extracted from ``__init__.py``
2026-05-17 alongside the items / events / conversations refactors.

Hot path. Risk surface:
  - Cancellation: client disconnects mid-stream → CancelledError /
    ConnectionResetError. Must release `_turn_queues[chat_id]` in
    the finally block.
  - Timeout: turn longer than TURN_TIMEOUT_S → asyncio.TimeoutError.
    Same cleanup path.
  - Reentry: a second POST for the same chat replaces the queue
    pre-emptively (defensive — proxy is expected to serialize per-
    chat).
  - State.db link write: `_write_msg_links_after_turn` runs in
    finally ONLY when reply_final actually completed; bails on
    timeout/error so we don't claim rows hermes never wrote.

The adapter still owns the upstream calls:
  - adapter._dispatch_message       — kicks off agent processing
  - adapter._safe_send_envelope     — envelope fan-out
  - adapter._coerce_input           — input shape validation
  - adapter._capture_msg_high_water_mark  — state.db id bookmark
  - adapter._write_msg_links_after_turn   — post-turn id linking
  - adapter._turn_buffer            — in-flight items mirror
  - adapter._turn_queues            — per-chat envelope queues
  - adapter._check_http_auth        — bearer-token gate

The route handler is the only public entry point. Helpers (_blocking,
_streaming, _build_envelope) stay module-private.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
import time
from typing import Any, Dict, Optional

# Guarded aiohttp import — see sidekick_route_conversations for why.
try:
    from aiohttp import web  # type: ignore[assignment]
except ImportError:  # pragma: no cover
    web = None  # type: ignore[assignment]

from .sidekick_ids import SIDEKICK_SOURCE, _parse_gateway_id


logger = logging.getLogger(__name__)

# Response-specific tuning. Bounds worst-case memory if a consumer
# hangs. Same values as the legacy module-level constants in
# __init__.py; co-located here because they're response-only.
_TURN_QUEUE_MAX = 1000          # per-chat envelope queue depth
_TURN_TIMEOUT_S = 120           # hold a /v1/responses turn open this long
# Cap on the result string we put into a tool_result envelope. Tools
# can return arbitrarily large blobs (web_extract / browse). The PWA
# does its own per-tool truncation for display, but we cap here too
# so a runaway result can't blow up the WS frame budget.
_TOOL_RESULT_MAX_BYTES = 50 * 1024


def _build_response_envelope(
    response_id: str, message_id: str,
    created_at: int, assembled: str,
) -> Dict[str, Any]:
    """Build the OpenAI Responses-API completed envelope."""
    return {
        "id": response_id,
        "object": "response",
        "status": "completed",
        "created_at": created_at,
        "model": "hermes",
        "output": [{
            "type": "message",
            "id": message_id,
            "role": "assistant",
            "content": [{"type": "output_text", "text": assembled}],
        }],
        "usage": {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
        },
    }


async def _handle_blocking(
    adapter,
    chat_id: str, text: str,
    queue: "asyncio.Queue[Dict[str, Any]]",
    response_id: str, message_id: str, created_at: int,
    attachments: Optional[list] = None,
    user_message_id: str = "",
) -> "web.Response":
    """Non-streaming /v1/responses path. Dispatch, drain the queue
    until reply_final, return single JSON envelope."""
    reply_final_seen = False
    try:
        # _dispatch_message kicks off agent processing; replies
        # arrive on `queue` via _safe_send_envelope's fan-out.
        asyncio.create_task(adapter._dispatch_message(
            chat_id=chat_id, text=text, attachments=attachments,
        ))
        assembled = ""
        while True:
            env = await asyncio.wait_for(queue.get(), timeout=_TURN_TIMEOUT_S)
            t = env.get("type")
            if t == "reply_delta":
                # Hermes emits the accumulated text on each chunk.
                # Track the latest; OAI-shape compaction below.
                assembled = env.get("text", assembled) or assembled
            elif t == "reply_final":
                reply_final_seen = True
                break
        return web.json_response(_build_response_envelope(
            response_id, message_id, created_at, assembled,
        ))
    except asyncio.TimeoutError:
        return web.json_response(
            {"error": {"type": "server_error", "message": "turn timed out"}},
            status=500,
        )
    finally:
        adapter._turn_queues.pop(chat_id, None)
        # Linking is now done by sidekick.db's content-fingerprint
        # match (Phase 3, see sidekick_state.reconcile_from_state_db).
        # The legacy `_write_msg_links_after_turn` heuristic is dead
        # code as of 2026-05-19 — kept on the class for one more
        # release so emergency rollback can re-enable it via a flag,
        # then deleted in the cleanup commit.


async def _handle_streaming(
    adapter,
    request: "web.Request",
    chat_id: str, text: str,
    queue: "asyncio.Queue[Dict[str, Any]]",
    response_id: str, message_id: str, created_at: int,
    attachments: Optional[list] = None,
    user_message_id: str = "",
) -> "web.StreamResponse":
    """Streaming /v1/responses. Emits OpenAI Responses-API SSE
    events as the agent produces output."""
    resp = web.StreamResponse(
        status=200,
        headers={
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
        },
    )
    await resp.prepare(request)

    async def write_sse(event: str, data: Dict[str, Any]) -> None:
        await resp.write(
            f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")
        )

    output_index = 0
    content_index = 0
    assembled = ""
    completed_emitted = False

    # Dispatch the message; replies flow back through `queue` via
    # _safe_send_envelope.
    asyncio.create_task(adapter._dispatch_message(
        chat_id=chat_id, text=text, attachments=attachments,
    ))

    try:
        while True:
            env = await asyncio.wait_for(queue.get(), timeout=_TURN_TIMEOUT_S)
            t = env.get("type")
            if t == "reply_delta":
                # Hermes streams accumulated text. First chunk
                # (no edit flag) might be empty or full; subsequent
                # chunks (edit=True) carry the running total.
                full = env.get("text", "") or ""
                if env.get("edit") and full.startswith(assembled):
                    delta_text = full[len(assembled):]
                elif env.get("edit"):
                    # Non-additive edit (rare). Bump content_index
                    # so the client knows to start fresh.
                    delta_text = full
                    content_index += 1
                    assembled = ""
                else:
                    # First (non-edit) delta — full content is the delta.
                    delta_text = full
                if delta_text:
                    await write_sse("response.output_text.delta", {
                        "type": "response.output_text.delta",
                        "item_id": message_id,
                        "output_index": output_index,
                        "content_index": content_index,
                        "delta": delta_text,
                    })
                    assembled += delta_text
            elif t == "reply_final":
                await write_sse("response.completed", {
                    "type": "response.completed",
                    "response": _build_response_envelope(
                        response_id, message_id, created_at, assembled,
                    ),
                })
                completed_emitted = True
                break
            elif t == "tool_call":
                output_index += 1
                args = env.get("args", {})
                args_str = (
                    json.dumps(args) if isinstance(args, dict)
                    else str(env.get("_args_repr") or args)
                )
                await write_sse("response.output_item.added", {
                    "type": "response.output_item.added",
                    "output_index": output_index,
                    "item": {
                        "type": "function_call",
                        "id": env.get("call_id", ""),
                        "name": env.get("tool_name", ""),
                        "arguments": args_str,
                    },
                })
            elif t == "tool_result":
                result = env.get("result", "")
                if isinstance(result, str):
                    result_out = result[:_TOOL_RESULT_MAX_BYTES]
                else:
                    try:
                        result_out = json.dumps(result)[:_TOOL_RESULT_MAX_BYTES]
                    except Exception:
                        result_out = str(result)[:_TOOL_RESULT_MAX_BYTES]
                await write_sse("response.output_item.done", {
                    "type": "response.output_item.done",
                    "output_index": output_index,
                    "item": {
                        "type": "function_call_output",
                        "call_id": env.get("call_id", ""),
                        "output": result_out,
                    },
                })
                # Bump for any subsequent output. Reset assembled
                # so a follow-up text item starts fresh.
                output_index += 1
                content_index = 0
                assembled = ""
            elif t == "typing":
                await write_sse("response.in_progress", {
                    "type": "response.in_progress",
                })
            # Other envelope types are out-of-turn and shouldn't
            # arrive here. If they do (defensive), skip silently
            # rather than corrupt the response stream.
    except asyncio.TimeoutError:
        if not completed_emitted:
            with contextlib.suppress(Exception):
                await write_sse("response.error", {
                    "type": "response.error",
                    "error": {"type": "server_error", "message": "turn timed out"},
                })
    except (ConnectionResetError, asyncio.CancelledError):
        # Client disconnected mid-stream. Cleanup in finally.
        pass
    except Exception as exc:
        logger.warning("[sidekick] /v1/responses error for %s: %s", chat_id, exc)
        with contextlib.suppress(Exception):
            await write_sse("response.error", {
                "type": "response.error",
                "error": {"type": "server_error", "message": str(exc)},
            })
    finally:
        adapter._turn_queues.pop(chat_id, None)
        with contextlib.suppress(Exception):
            await resp.write_eof()
        # Linking handled by reconcile_from_state_db on next items
        # endpoint enter. Legacy link-write call removed 2026-05-19.
    return resp


async def handle_responses(adapter, request: "web.Request") -> "web.StreamResponse":
    """POST /v1/responses — turn dispatch with optional streaming."""
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    try:
        body = await request.json()
    except (ValueError, json.JSONDecodeError):
        return web.json_response(
            {"error": {"type": "invalid_request_error",
                       "message": "body is not valid JSON"}},
            status=400,
        )

    conversation = body.get("conversation")
    input_field = body.get("input")
    stream = bool(body.get("stream", True))
    # Sidekick extension: optional `attachments` array — each entry
    # is `{type, mimeType, fileName, content}` where `content` is a
    # `data:<mime>;base64,<payload>` URL. NOT part of the OpenAI
    # Responses API today; tolerated as an additive field so a
    # raw OAI third-party speaking only the standard surface still
    # interoperates.
    raw_attachments = body.get("attachments")
    attachments = raw_attachments if isinstance(raw_attachments, list) else None
    # Sidekick extension: `voice: true` flags the input as dictated.
    # We prepend `[voice]` so the agent can recognise it (AGENTS.md
    # tells the agent to expect occasional STT errors in such turns
    # and to interpret them charitably). Lives in metadata
    # alongside user_message_id for OAI-blessed compatibility;
    # back-compat reads top-level `voice` from older PWA bundles.
    body_metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
    voice_flag = body_metadata.get("voice") == "true" or body.get("voice") is True

    if not isinstance(conversation, str) or not conversation:
        return web.json_response(
            {"error": {"type": "invalid_request_error",
                       "message": "missing or invalid `conversation`"}},
            status=400,
        )
    if input_field is None:
        return web.json_response(
            {"error": {"type": "invalid_request_error",
                       "message": "missing `input`"}},
            status=400,
        )
    text = adapter._coerce_input(input_field)
    if text is None:
        return web.json_response(
            {"error": {"type": "invalid_request_error",
                       "message": "`input` must be a string or array of {role, content}"}},
            status=400,
        )
    if voice_flag and text and not text.lstrip().startswith("[voice]"):
        text = f"[voice] {text}"

    # Decode the gateway-prefixed conversation id. The drawer hands
    # back ids of the form `${source}:${chat_id}` (see
    # _format_gateway_id rationale). Sidekick's /v1/responses path
    # only dispatches for sidekick-source chats — the composer is
    # read-only for any other source upstream — so reject prefixes
    # that aren't ours rather than silently routing to a wrong-chat
    # adapter. Bare ids (no prefix) are accepted for backward compat
    # with un-prefixed callers.
    parsed_source, chat_id = _parse_gateway_id(conversation)
    if parsed_source is not None and parsed_source != SIDEKICK_SOURCE:
        return web.json_response(
            {"error": {"type": "invalid_request_error",
                       "message": (f"`conversation` source `{parsed_source}` "
                                   "is read-only via sidekick plugin")}},
            status=400,
        )
    response_id = f"resp_{secrets.token_hex(12)}"
    message_id = f"msg_{secrets.token_hex(10)}"
    created_at = int(time.time())

    # Sidekick extension: PWA may pre-mint the user-message id and
    # ship it as `metadata.user_message_id` (OAI Responses API
    # `metadata: Dict[str, str]` — a documented extension point
    # vanilla servers preserve unchanged; we read ours out). The
    # bubble it broadcasts in the `user_message` envelope below
    # uses this id as the dedup key for cross-device sync. When
    # absent (raw OAI third-parties, legacy clients pre-2026-05)
    # we mint one server-side; the originating device just won't
    # dedup against the broadcast.
    #
    # Back-compat: also accept the legacy top-level
    # `user_message_id` for one release cycle.
    raw_user_msg_id = (
        body_metadata.get("user_message_id")
        or body.get("user_message_id")  # legacy top-level
    )
    if isinstance(raw_user_msg_id, str) and raw_user_msg_id:
        user_message_id = raw_user_msg_id
    else:
        user_message_id = f"umsg_{secrets.token_hex(10)}"

    # Cross-device user-message broadcast. Emit BEFORE dispatching
    # the turn so other connected PWA tabs render the user bubble
    # immediately (asymmetry fix: previously only the agent's reply
    # envelopes propagated to other devices, so the user's own
    # bubble was invisible until manual refresh). The originating
    # device dedups against this broadcast via `user_message_id`
    # (the optimistic bubble it already rendered shares the id).
    # Out-of-turn channel: this fires before _dispatch_message, so
    # there's no in-turn queue to bypass — _safe_send_envelope will
    # route it through _publish_out_of_turn which prefixes the
    # chat_id to `sidekick:<chat_id>` on the wire.
    await adapter._safe_send_envelope({
        "type": "user_message",
        "chat_id": chat_id,
        "message_id": user_message_id,
        "text": text,
    })

    # Register the turn queue. If a queue already exists for this
    # chat_id, replace it — the proxy is expected to serialize per-
    # chat (multiplexed via /api/sidekick/messages on the proxy
    # side), so this branch is purely defensive.
    queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=_TURN_QUEUE_MAX)
    adapter._turn_queues[chat_id] = queue

    # Transcript v3 Phase 1 (dark launch): capture the turn linker's
    # state.db watermark. MUST happen (a) before _dispatch_message can
    # run — nothing of THIS turn is in state.db yet, so the capture is
    # race-free — and (b) before the turn buffer below replaces the
    # previous TurnEntry, because the barrier inside (close any stale
    # open window as aborted) needs the PREVIOUS turn's call-id set.
    # No-op when SIDEKICK_TURN_LINKER=0. Writes shadow tables only.
    from . import sidekick_turn_linker as _linker  # noqa: WPS433
    try:
        await _linker.open_turn_watermark(
            adapter, chat_id, user_message_id, user_text=text,
        )
    except Exception as exc:
        logger.warning("[sidekick] turn-linker open failed: %s", exc)

    # Open the in-flight turn buffer. Source of truth for
    # /v1/conversations/{id}/items between POST receipt and
    # reply_final's link-write — the PWA's mid-flight reload
    # gets the user prompt + tool rows immediately.
    if adapter._turn_buffer is not None:
        adapter._turn_buffer.open_turn(
            chat_id=chat_id, user_message=text,
            user_message_id=user_message_id,
        )

    # pre_high_water + _capture_msg_high_water_mark removed 2026-05-19
    # with the Phase 3-4 migration — content-fingerprint linking +
    # state.db reconciliation make the watermark heuristic obsolete.
    adapter._reserve_response_message_id(chat_id, message_id)
    try:
        if not stream:
            return await _handle_blocking(
                adapter,
                chat_id, text, queue, response_id, message_id, created_at,
                attachments=attachments,
                user_message_id=user_message_id,
            )
        return await _handle_streaming(
            adapter,
            request, chat_id, text, queue, response_id, message_id, created_at,
            attachments=attachments,
            user_message_id=user_message_id,
        )
    finally:
        adapter._release_response_message_id(chat_id, message_id)
