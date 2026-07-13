"""HTTP route handlers for the hermes-side sidekick plugin's
unread + pins + push surface.

Mirrors the openclaw plugin's ``src/push-routes.js`` +
``src/unread-pins-routes.js``. All mutations broadcast an
``unread_changed`` / ``pins_changed`` envelope through the plugin's
out-of-turn channel so connected PWAs refresh.

Wiring contract: this module exports a `register_routes(app, ctx)`
function. `ctx` is the calling plugin's reference container with
fields:
  - db                : SidekickDB
  - dispatcher        : PushDispatcher (engagement.mark_visible used)
  - state_db_path     : Path to hermes state.db (for unread compute)
  - emit_envelope     : callable(env: Dict) → publishes to /v1/events
  - send_envelope     : optional async callable(env: Dict) → normal adapter fan-out
  - vapid_subject     : str (passed through for vapid-public-key)
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict

from aiohttp import web

from . import sidekick_state as state
from .sidekick_unread import compute_unread, invalidate_unread_cache
from .sidekick_state import vapid_public_key_b64url, ensure_vapid_keys
from .sidekick_ids import _parse_gateway_id


def _strip_source_prefix(chat_id: Any) -> str:
    """Normalize a chat_id to the form the plugin's envelope handlers
    use internally (no `<source>:` prefix). PWA-facing routes accept
    either shape — the sidekick proxy passes the FULL `sidekick:<uuid>`
    form, but the plugin's _safe_send_envelope downstream uses the
    stripped UUID. Without this normalization,
    EngagementState.mark_visible records under the prefixed key while
    is_engaged checks the stripped key → engagement gate never fires."""
    if not isinstance(chat_id, str) or not chat_id:
        return ""
    _, stripped = _parse_gateway_id(chat_id)
    return stripped


# ── Plumbing helpers ─────────────────────────────────────────────────

async def _read_json(request: web.Request) -> Dict[str, Any]:
    try:
        return await request.json()
    except Exception:
        return {}


def _json(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


# ── Push routes ──────────────────────────────────────────────────────

async def handle_vapid_public_key(ctx, request: web.Request) -> web.Response:
    v = ensure_vapid_keys(ctx.db, ctx.vapid_subject)
    return _json({
        "publicKey": vapid_public_key_b64url(v["public_key"]),
        "subject": v["subject"],
    })


async def handle_subscribe(ctx, request: web.Request) -> web.Response:
    body = await _read_json(request)
    endpoint = body.get("endpoint")
    keys = body.get("keys") or {}
    p256dh = keys.get("p256dh") or body.get("p256dh")
    auth = keys.get("auth") or body.get("auth")
    user_agent = body.get("userAgent") or body.get("user_agent") or ""
    if not endpoint or not p256dh or not auth:
        return _json({"error": "invalid_request", "message": "endpoint + keys.p256dh + keys.auth required"}, status=400)
    result = state.upsert_subscription(
        ctx.db, endpoint=endpoint, p256dh=p256dh, auth=auth, user_agent=user_agent,
    )
    total = len(state.list_subscriptions(ctx.db))
    return _json({"ok": True, **result, "total": total}, status=201 if result["created"] else 200)


async def handle_unsubscribe(ctx, request: web.Request) -> web.Response:
    body = await _read_json(request)
    endpoint = body.get("endpoint")
    if not endpoint:
        return _json({"error": "invalid_request"}, status=400)
    result = state.remove_subscription(ctx.db, endpoint)
    total = len(state.list_subscriptions(ctx.db))
    return _json({"ok": True, **result, "total": total})


async def handle_list_mutes(ctx, request: web.Request) -> web.Response:
    return _json({"mutes": state.list_mutes(ctx.db)})


async def handle_mute(ctx, request: web.Request) -> web.Response:
    body = await _read_json(request)
    chat_id = body.get("chat_id") or body.get("chatId")
    muted = bool(body.get("muted"))
    if not chat_id:
        return _json({"error": "invalid_request", "message": "chat_id required"}, status=400)
    state.set_mute(ctx.db, chat_id, muted)
    return _json({"ok": True, "chat_id": chat_id, "muted": muted})


async def handle_prefs(ctx, request: web.Request) -> web.Response:
    if request.method == "GET":
        return _json({"prefs": state.list_prefs(ctx.db)})
    body = await _read_json(request)
    key = body.get("key")
    if not key:
        return _json({"error": "invalid_request", "message": "key required"}, status=400)
    state.set_pref(ctx.db, key, body.get("value"))
    return _json({"ok": True, "key": key, "value": state.get_pref(ctx.db, key)})


async def handle_user_settings(ctx, request: web.Request) -> web.Response:
    if request.method == "GET":
        return _json({"settings": state.list_user_settings(ctx.db)})
    body = await _read_json(request)
    key = body.get("key")
    if not key:
        return _json({"error": "invalid_request", "message": "key required"}, status=400)
    state.set_user_setting(ctx.db, key, body.get("value"))
    return _json({"ok": True, "key": key, "value": state.get_user_setting(ctx.db, key)})


async def handle_visibility(ctx, request: web.Request) -> web.Response:
    body = await _read_json(request)
    raw_chat_id = body.get("chat_id") or body.get("chatId")
    visible = body.get("visible") is True or body.get("state") in ("visible", "focus")
    if not raw_chat_id:
        return _json({"error": "invalid_request", "message": "chat_id required"}, status=400)
    # Normalize before recording — dispatch path keys engagement on the
    # stripped chat_id. See _strip_source_prefix docstring for the
    # asymmetric-key normalization rationale.
    chat_id = _strip_source_prefix(raw_chat_id)
    if not chat_id:
        return _json({"error": "invalid_request", "message": "chat_id required"}, status=400)
    if visible:
        ctx.dispatcher.engagement.mark_visible(chat_id)
    else:
        ctx.dispatcher.engagement.mark_hidden(chat_id)
    return _json({"ok": True, "chat_id": chat_id, "visible": visible})


async def handle_test(ctx, request: web.Request) -> web.Response:
    body = await _read_json(request)
    chat_id = body.get("chat_id") or body.get("chatId") or "sidekick-test"
    kind = body.get("kind") if isinstance(body.get("kind"), str) else ""
    env_type = body.get("type") if isinstance(body.get("type"), str) else ""
    if not env_type:
        env_type = "reply_final" if kind == "agent_reply" else "notification"
    text = (
        body.get("text")
        or body.get("body")
        or body.get("content")
        or f"Test {kind or env_type} notification from hermes plugin"
    )
    env = {
        "type": env_type,
        "chat_id": chat_id,
        "content": text,
        "text": text,
        "should_push": body.get("should_push") if isinstance(body.get("should_push"), bool) else True,
    }
    if kind and env_type == "notification":
        env["kind"] = kind
    if env_type == "reply_final":
        msg_id = body.get("message_id") or body.get("messageId")
        env["message_id"] = msg_id if isinstance(msg_id, str) and msg_id else f"msg_test_{int(time.time() * 1000)}"
    if isinstance(body.get("speaker"), str):
        env["speaker"] = body.get("speaker")
    if isinstance(body.get("title"), str):
        env["title"] = body.get("title")
    if isinstance(body.get("urgent"), bool):
        env["urgent"] = body.get("urgent")
    sender = getattr(ctx, "send_envelope", None)
    if callable(sender):
        published = await sender(env)
        return _json({"ok": True, "envelope": env, "published": bool(published)})
    result = ctx.dispatcher.dispatch_envelope(env)
    return _json({"ok": True, "envelope": env, **result})


# ── Unread routes ────────────────────────────────────────────────────

async def handle_unread(ctx, request: web.Request) -> web.Response:
    # compute_unread loops over every chat running a recursive-CTE state.db
    # COUNT(*) query per chat — O(history) Python+SQL work per chat. Used
    # to run synchronously on the asyncio loop thread, which py-spy caught
    # 2026-06-23 as the dominant cause of the gateway's 8s loop-lag during
    # PWA bursts (the PWA polls /unread on every drawer-list refresh). Push
    # it to the sidekick worker pool so the loop stays responsive and the
    # SIDEKICK_WORKER_CONCURRENCY cap keeps the GIL pressure bounded.
    from . import sidekick_perf_trace as _perf  # noqa: WPS433
    data = await _perf.run_in_sidekick_worker(
        compute_unread,
        db=ctx.db, state_db_path=ctx.state_db_path, source="sidekick",
    )
    return _json(data)


async def handle_unread_seen(ctx, request: web.Request) -> web.Response:
    body = await _read_json(request)
    chat_id = body.get("chat_id") or body.get("chatId")
    if not chat_id:
        return _json({"error": "invalid_request", "message": "chat_id required"}, status=400)
    state.mark_seen(ctx.db, chat_id)
    # The compute_unread TTL cache would otherwise serve stale counts
    # for up to its TTL — explicit invalidation makes the very next
    # /unread poll reflect the seen-state immediately (which the PWA
    # depends on for the post-click badge clear).
    invalidate_unread_cache()
    ctx.emit_envelope({"type": "unread_changed", "chat_id": chat_id, "cause": "seen"})
    return _json({"ok": True, "chat_id": chat_id})


async def handle_unread_mark(ctx, request: web.Request) -> web.Response:
    body = await _read_json(request)
    chat_id = body.get("chat_id") or body.get("chatId")
    marked = body.get("marked") is True
    if not chat_id:
        return _json({"error": "invalid_request", "message": "chat_id required"}, status=400)
    state.set_marked(ctx.db, chat_id, marked)
    # See note in handle_unread_seen — drop the cache so the next poll
    # reflects this mutation immediately.
    invalidate_unread_cache()
    ctx.emit_envelope({"type": "unread_changed", "chat_id": chat_id, "cause": "mark" if marked else "unmark"})
    return _json({"ok": True, "chat_id": chat_id, "marked": marked})


# ── Pin routes ───────────────────────────────────────────────────────

async def handle_pins(ctx, request: web.Request) -> web.Response:
    if request.method == "GET":
        chat_id = request.rel_url.query.get("chat_id")
        return _json({"pins": state.list_pins(ctx.db, chat_id)})
    body = await _read_json(request)
    chat_id = body.get("chat_id")
    msg_id = body.get("msg_id")
    role = body.get("role")
    text = body.get("text")
    timestamp = body.get("timestamp")
    if not chat_id or not msg_id or not role or not isinstance(text, str):
        return _json({"error": "invalid_request", "message": "chat_id+msg_id+role+text required"}, status=400)
    state.upsert_pin(ctx.db, chat_id=chat_id, msg_id=msg_id, role=role, text=text, timestamp=timestamp)
    ctx.emit_envelope({"type": "pins_changed", "chat_id": chat_id, "cause": "pin", "msg_id": msg_id})
    return _json({"ok": True})


async def handle_pin_delete(ctx, request: web.Request) -> web.Response:
    chat_id = request.match_info.get("chat_id")
    msg_id = request.match_info.get("msg_id")
    if not chat_id or not msg_id:
        return _json({"error": "invalid_request"}, status=400)
    result = state.delete_pin(ctx.db, chat_id=chat_id, msg_id=msg_id)
    if result["removed"]:
        ctx.emit_envelope({"type": "pins_changed", "chat_id": chat_id, "cause": "unpin", "msg_id": msg_id})
    return _json({"ok": True, **result})


# ── Activity routes ──────────────────────────────────────────────────

def _activity_changed(ctx, chat_id: str | None, cause: str, item_id: str | None = None) -> None:
    ctx.emit_envelope({
        "type": "activity_changed",
        "chat_id": chat_id or "*",
        "cause": cause,
        "item_id": item_id,
    })


async def handle_activity(ctx, request: web.Request) -> web.Response:
    if request.method == "GET":
        try:
            limit = int(request.rel_url.query.get("limit", "200"))
        except Exception:
            limit = 200
        limit = max(1, min(limit, 500))
        return _json({"items": state.list_activity_items(ctx.db, limit=limit)})
    body = await _read_json(request)
    item_id = body.get("id")
    kind = body.get("kind")
    title = body.get("title")
    item_body = body.get("body")
    if not item_id or not kind or not isinstance(title, str) or not isinstance(item_body, str):
        return _json({"error": "invalid_request", "message": "id+kind+title+body required"}, status=400)
    chat_id = body.get("chat_id") or body.get("chatId")
    created_at = body.get("created_at") or body.get("createdAt")
    if isinstance(created_at, (int, float)) and created_at > 10_000_000_000:
        created_at = created_at / 1000.0
    state.upsert_activity_item(
        ctx.db,
        id=item_id,
        chat_id=chat_id if isinstance(chat_id, str) else None,
        kind=str(kind),
        title=title,
        body=item_body,
        created_at=created_at if isinstance(created_at, (int, float)) else None,
        urgent=body.get("urgent") is True,
        read=body.get("read") is True,
        message_id=body.get("message_id") or body.get("messageId"),
        resolved=body.get("resolved") if isinstance(body.get("resolved"), str) else None,
    )
    _activity_changed(ctx, chat_id if isinstance(chat_id, str) else None, "upsert", item_id)
    return _json({"ok": True})


async def handle_activity_resolve(ctx, request: web.Request) -> web.Response:
    body = await _read_json(request)
    item_id = body.get("id")
    resolution = body.get("resolution")
    if not item_id or not resolution:
        return _json({"error": "invalid_request", "message": "id+resolution required"}, status=400)
    result = state.resolve_activity_item(ctx.db, id=item_id, resolution=str(resolution))
    if result["updated"]:
        _activity_changed(ctx, None, "resolve", item_id)
    return _json({"ok": True, **result})


async def handle_activity_seen(ctx, request: web.Request) -> web.Response:
    body = await _read_json(request)
    chat_id = body.get("chat_id") or body.get("chatId")
    all_items = body.get("all") is True
    if not all_items and not isinstance(chat_id, str):
        return _json({"error": "invalid_request", "message": "chat_id or all=true required"}, status=400)
    result = state.mark_activity_seen(
        ctx.db,
        chat_id=chat_id if isinstance(chat_id, str) else None,
        all_items=all_items,
    )
    if result["updated"]:
        _activity_changed(ctx, chat_id if isinstance(chat_id, str) else None, "seen")
    return _json({"ok": True, **result})


async def handle_activity_delete(ctx, request: web.Request) -> web.Response:
    item_id = request.match_info.get("item_id")
    if not item_id:
        return _json({"error": "invalid_request"}, status=400)
    result = state.delete_activity_item(ctx.db, id=item_id)
    if result["removed"]:
        _activity_changed(ctx, None, "delete", item_id)
    return _json({"ok": True, **result})


async def handle_activity_clear(ctx, request: web.Request) -> web.Response:
    result = state.clear_dismissible_activity_items(ctx.db)
    if result["removed"]:
        _activity_changed(ctx, None, "clear")
    return _json({"ok": True, **result})


async def handle_question_answer(ctx, request: web.Request) -> web.Response:
    """POST /v1/questions/{question_id} — resolve a pending agent
    question (unified elicitation protocol, 2026-07-13).

    Body: ``{"response": "<choice text or free text>"}``. For
    kind='clarify' questions this resolves the blocking
    ``tools.clarify_gateway`` entry the agent thread is waiting on.
    404 when the entry is gone (answered elsewhere, expired, or a
    pre-0.18 hermes without the clarify tool) — the PWA renders that
    as the question having lapsed, the pop-up equivalent of
    "/approve → No pending command".
    """
    question_id = request.match_info.get("question_id", "")
    try:
        body = await request.json()
    except Exception:
        body = {}
    response = body.get("response")
    if not question_id or not isinstance(response, str) or not response:
        return _json({"ok": False, "error": "question_id + response required"}, status=400)
    try:
        from tools.clarify_gateway import resolve_gateway_clarify  # noqa: WPS433
    except Exception:
        return _json({"ok": False, "error": "clarify not supported by this hermes"}, status=404)
    try:
        resolved = resolve_gateway_clarify(question_id, response)
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": str(e)}, status=500)
    if not resolved:
        return _json({"ok": False, "error": "no pending question with that id"}, status=404)
    return _json({"ok": True})


# ── Registrar ────────────────────────────────────────────────────────

def register_routes(app: web.Application, ctx) -> None:
    """Mount the plugin's push + unread + pin routes."""
    app.router.add_get("/v1/push/vapid-public-key", lambda r: handle_vapid_public_key(ctx, r))
    app.router.add_post("/v1/push/subscribe", lambda r: handle_subscribe(ctx, r))
    app.router.add_post("/v1/push/unsubscribe", lambda r: handle_unsubscribe(ctx, r))
    app.router.add_get("/v1/push/mutes", lambda r: handle_list_mutes(ctx, r))
    app.router.add_post("/v1/push/mute", lambda r: handle_mute(ctx, r))
    app.router.add_get("/v1/push/prefs", lambda r: handle_prefs(ctx, r))
    app.router.add_post("/v1/push/prefs", lambda r: handle_prefs(ctx, r))
    app.router.add_post("/v1/push/visibility", lambda r: handle_visibility(ctx, r))
    app.router.add_post("/v1/push/test", lambda r: handle_test(ctx, r))

    app.router.add_get("/v1/user-settings", lambda r: handle_user_settings(ctx, r))
    app.router.add_post("/v1/user-settings", lambda r: handle_user_settings(ctx, r))

    app.router.add_get("/v1/unread", lambda r: handle_unread(ctx, r))
    app.router.add_post("/v1/unread/seen", lambda r: handle_unread_seen(ctx, r))
    app.router.add_post("/v1/unread/mark", lambda r: handle_unread_mark(ctx, r))

    app.router.add_get("/v1/pins", lambda r: handle_pins(ctx, r))
    app.router.add_post("/v1/pins", lambda r: handle_pins(ctx, r))
    app.router.add_delete("/v1/pins/{chat_id}/{msg_id}", lambda r: handle_pin_delete(ctx, r))

    app.router.add_post("/v1/questions/{question_id}", lambda r: handle_question_answer(ctx, r))

    app.router.add_get("/v1/activity", lambda r: handle_activity(ctx, r))
    app.router.add_post("/v1/activity", lambda r: handle_activity(ctx, r))
    app.router.add_post("/v1/activity/resolve", lambda r: handle_activity_resolve(ctx, r))
    app.router.add_post("/v1/activity/seen", lambda r: handle_activity_seen(ctx, r))
    app.router.add_post("/v1/activity/clear", lambda r: handle_activity_clear(ctx, r))
    app.router.add_delete("/v1/activity/{item_id}", lambda r: handle_activity_delete(ctx, r))
