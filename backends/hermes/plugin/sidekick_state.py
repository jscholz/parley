"""Push subs / mutes / prefs / pins / unread / VAPID CRUD against
the supplemental sqlite. Python parity of the openclaw plugin's
``src/push-storage.js`` + ``src/pins-storage.js`` + ``src/unread-storage.js``.

Keep this module pure: storage operations only. Dispatch logic
(engagement filter, web-push call) lives in ``sidekick_dispatcher.py``.
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

import base64
import os

from py_vapid import Vapid
from cryptography.hazmat.primitives.serialization import (
    load_pem_public_key, load_pem_private_key,
    Encoding, PublicFormat, PrivateFormat, NoEncryption,
)
from cryptography.hazmat.primitives.asymmetric import ec


DEFAULT_ACTIVITY_MAX_ITEMS = 200

# Steady-state /items reads fetch only a bounded window of state.db rows
# (page size + this margin + 1) instead of the whole transcript, so reads
# are O(page) not O(history). The margin absorbs compaction-seed rows that
# are elided after the fetch, so a page still fills to `limit` survivors
# even when it straddles a compaction boundary.
ITEMS_FETCH_ELISION_MARGIN = 64


def activity_retention_limit() -> int:
    try:
        value = int(os.environ.get("SIDEKICK_ACTIVITY_MAX_ITEMS", str(DEFAULT_ACTIVITY_MAX_ITEMS)))
    except (TypeError, ValueError):
        value = DEFAULT_ACTIVITY_MAX_ITEMS
    return max(1, value)


# ── VAPID ─────────────────────────────────────────────────────────────

def _b64url_to_raw(b64url: str) -> bytes:
    """base64url-no-pad → raw bytes (Web Push VAPID format)."""
    pad = "=" * ((4 - len(b64url) % 4) % 4)
    return base64.urlsafe_b64decode(b64url + pad)


def _raw_to_b64url(raw: bytes) -> str:
    """raw bytes → base64url-no-pad (Web Push VAPID format)."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def ensure_vapid_keys(db, subject: str) -> Dict[str, str]:
    """Return the active VAPID identity. On first call:
      1. If env vars VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY are present
         (the proxy's legacy config), import them — keeps existing
         push subscriptions valid after the parity switchover.
      2. Otherwise generate fresh keys.
    Subsequent calls return the persisted row.

    Storage format: base64url-no-pad raw bytes for both halves.
    pywebpush accepts this directly via `vapid_private_key`; sending
    the public to the PWA via /v1/push/vapid-public-key wraps it
    through `vapid_public_key_b64url` (which is a no-op for already-
    encoded values).
    """
    row = db.fetchone("SELECT public_key, private_key, subject FROM vapid_keys WHERE id = 1")
    if row:
        return {"public_key": row["public_key"], "private_key": row["private_key"], "subject": row["subject"]}
    env_pub = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    env_priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    if env_pub and env_priv:
        public_b64 = env_pub
        private_b64 = env_priv
    else:
        vapid = Vapid()
        vapid.generate_keys()
        # Convert generated PEM keys to raw b64url for storage.
        pub_key = load_pem_public_key(vapid.public_pem())
        public_b64 = _raw_to_b64url(
            pub_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        )
        priv_key = load_pem_private_key(vapid.private_pem(), password=None)
        private_b64 = _raw_to_b64url(
            priv_key.private_numbers().private_value.to_bytes(32, "big")
        )
    db.exec(
        "INSERT INTO vapid_keys (id, public_key, private_key, subject, created_at) "
        "VALUES (1, ?, ?, ?, ?)",
        (public_b64, private_b64, subject, time.time()),
    )
    return {"public_key": public_b64, "private_key": private_b64, "subject": subject}


def vapid_public_key_b64url(public_key: str) -> str:
    """Return the public key in base64url-no-pad form (what the PWA's
    ``PushManager.subscribe({applicationServerKey})`` expects).

    Our storage format already IS base64url (see ``ensure_vapid_keys``);
    this function exists as the stable contract the route handler
    calls — independent of internal storage decisions."""
    return public_key


# ── Push subscriptions ────────────────────────────────────────────────

def upsert_subscription(db, *, endpoint: str, p256dh: str, auth: str, user_agent: str = "") -> Dict[str, Any]:
    existing = db.fetchone("SELECT created_at FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
    now = time.time()
    if existing:
        db.exec(
            "UPDATE push_subscriptions SET p256dh = ?, auth = ?, user_agent = ? WHERE endpoint = ?",
            (p256dh, auth, user_agent, endpoint),
        )
        return {"created": False}
    db.exec(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, last_used_at) "
        "VALUES (?, ?, ?, ?, ?, NULL)",
        (endpoint, p256dh, auth, user_agent, now),
    )
    return {"created": True}


def remove_subscription(db, endpoint: str) -> Dict[str, Any]:
    cur = db.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
    return {"removed": cur.rowcount > 0}


def list_subscriptions(db) -> List[Dict[str, Any]]:
    rows = db.fetchall(
        "SELECT endpoint, p256dh, auth, user_agent AS userAgent, created_at, last_used_at AS lastUsedAt "
        "FROM push_subscriptions ORDER BY created_at ASC"
    )
    return [dict(r) for r in rows]


def mark_subscription_used(db, endpoint: str) -> None:
    db.exec("UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?", (time.time(), endpoint))


# ── Mutes / prefs ─────────────────────────────────────────────────────

def set_mute(db, chat_id: str, muted: bool) -> None:
    if muted:
        db.exec(
            "INSERT OR IGNORE INTO push_mutes (chat_id, muted_at) VALUES (?, ?)",
            (chat_id, time.time()),
        )
    else:
        db.exec("DELETE FROM push_mutes WHERE chat_id = ?", (chat_id,))


def is_muted(db, chat_id: str) -> bool:
    return db.fetchone("SELECT 1 FROM push_mutes WHERE chat_id = ?", (chat_id,)) is not None


def list_mutes(db) -> List[Dict[str, Any]]:
    return [dict(r) for r in db.fetchall(
        "SELECT chat_id AS chatId, muted_at AS mutedAt FROM push_mutes ORDER BY muted_at DESC"
    )]


def get_pref(db, key: str, fallback=None):
    row = db.fetchone("SELECT value_json FROM push_prefs WHERE key = ?", (key,))
    if not row:
        return fallback
    try:
        return json.loads(row["value_json"])
    except Exception:
        return fallback


def set_pref(db, key: str, value) -> None:
    db.exec(
        "INSERT INTO push_prefs (key, value_json) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        (key, json.dumps(value)),
    )


def list_prefs(db) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for row in db.fetchall("SELECT key, value_json FROM push_prefs"):
        try:
            out[row["key"]] = json.loads(row["value_json"])
        except Exception:
            out[row["key"]] = None
    return out


# ── User settings (synced, cross-device) ──────────────────────────────
# Distinct from push_prefs above: this is the PWA's user-facing settings
# surface (STT key-terms today; theme/voice/etc. as the migration lands).
# `value` is a JSON blob, so a key can hold a scalar, object, or list.

def get_user_setting(db, key: str, fallback=None):
    row = db.fetchone("SELECT value FROM user_settings WHERE key = ?", (key,))
    if not row:
        return fallback
    try:
        return json.loads(row["value"])
    except Exception:
        return fallback


def set_user_setting(db, key: str, value) -> None:
    db.exec(
        "INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
        "updated_at = excluded.updated_at",
        (key, json.dumps(value), time.time()),
    )


def list_user_settings(db) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for row in db.fetchall("SELECT key, value FROM user_settings"):
        try:
            out[row["key"]] = json.loads(row["value"])
        except Exception:
            out[row["key"]] = None
    return out


# ── Pins ──────────────────────────────────────────────────────────────

def list_pins(db, chat_id: Optional[str] = None) -> List[Dict[str, Any]]:
    if chat_id:
        rows = db.fetchall(
            "SELECT chat_id AS chatId, msg_id AS msgId, role, text, timestamp, "
            "pinned_at AS pinnedAt FROM pins WHERE chat_id = ? ORDER BY pinned_at DESC",
            (chat_id,),
        )
    else:
        rows = db.fetchall(
            "SELECT chat_id AS chatId, msg_id AS msgId, role, text, timestamp, "
            "pinned_at AS pinnedAt FROM pins ORDER BY pinned_at DESC"
        )
    return [dict(r) for r in rows]


def upsert_pin(db, *, chat_id: str, msg_id: str, role: str, text: str, timestamp: Optional[float] = None) -> None:
    now = time.time()
    db.exec(
        "INSERT INTO pins (chat_id, msg_id, role, text, timestamp, pinned_at) "
        "VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(chat_id, msg_id) DO UPDATE SET "
        "  role = excluded.role, text = excluded.text, timestamp = excluded.timestamp",
        (chat_id, msg_id, role, text, timestamp if timestamp is not None else now, now),
    )


def delete_pin(db, *, chat_id: str, msg_id: str) -> Dict[str, Any]:
    cur = db.exec("DELETE FROM pins WHERE chat_id = ? AND msg_id = ?", (chat_id, msg_id))
    return {"removed": cur.rowcount > 0}


# ── Activity items ────────────────────────────────────────────────────

def _activity_row_to_dict(row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "chatId": row["chatId"],
        "kind": row["kind"],
        "title": row["title"],
        "body": row["body"],
        "createdAt": row["createdAt"],
        "urgent": bool(row["urgent"]),
        "read": bool(row["read"]),
        "messageId": row["messageId"],
        "resolved": row["resolved"],
    }


def list_activity_items(db, *, limit: int = 200) -> List[Dict[str, Any]]:
    rows = db.fetchall(
        "SELECT id, chat_id AS chatId, kind, title, body, created_at AS createdAt, "
        "       urgent, read, message_id AS messageId, resolved "
        "FROM activity_items ORDER BY "
        "  CASE WHEN kind = 'approval' AND resolved IS NULL THEN 1 ELSE 0 END DESC, "
        "  created_at DESC LIMIT ?",
        (limit,),
    )
    return [_activity_row_to_dict(r) for r in rows]


def prune_activity_items(db, *, limit: Optional[int] = None) -> Dict[str, Any]:
    """Keep unresolved approvals, cap every other Activity item.

    Activity is a recoverable notification queue, not an append-only audit
    log. Unresolved approvals are blocking workflow events and must survive
    until actioned; everything else is dismissible history and should stay
    bounded server-side so browser-profile caches cannot disagree about
    retention.
    """
    keep = activity_retention_limit() if limit is None else max(1, int(limit))
    cur = db.exec(
        "DELETE FROM activity_items WHERE id IN ("
        "  SELECT id FROM activity_items "
        "  WHERE NOT (kind = 'approval' AND resolved IS NULL) "
        "  ORDER BY created_at DESC, id DESC "
        "  LIMIT -1 OFFSET ?"
        ")",
        (keep,),
    )
    return {"removed": cur.rowcount, "limit": keep}


def upsert_activity_item(db, *, id: str, chat_id: Optional[str], kind: str, title: str,
                         body: str, created_at: Optional[float] = None,
                         urgent: bool = False, read: bool = False,
                         message_id: Optional[str] = None,
                         resolved: Optional[str] = None) -> None:
    now = time.time()
    db.exec(
        "INSERT INTO activity_items (id, chat_id, kind, title, body, created_at, urgent, read, message_id, resolved) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET "
        "  chat_id = excluded.chat_id, kind = excluded.kind, title = excluded.title, "
        "  body = excluded.body, urgent = excluded.urgent, read = excluded.read, "
        "  message_id = excluded.message_id, resolved = excluded.resolved",
        (id, chat_id, kind, title, body, created_at if created_at is not None else now,
         1 if urgent else 0, 1 if read else 0, message_id, resolved),
    )
    prune_activity_items(db)


def resolve_activity_item(db, *, id: str, resolution: str) -> Dict[str, Any]:
    cur = db.exec(
        "UPDATE activity_items SET read = 1, resolved = ? WHERE id = ?",
        (resolution, id),
    )
    if cur.rowcount > 0:
        prune_activity_items(db)
    return {"updated": cur.rowcount > 0}


def mark_activity_seen(db, *, chat_id: Optional[str] = None, all_items: bool = False) -> Dict[str, Any]:
    if all_items:
        cur = db.exec("UPDATE activity_items SET read = 1 WHERE read = 0")
    elif chat_id:
        cur = db.exec(
            "UPDATE activity_items SET read = 1 WHERE chat_id = ? AND read = 0",
            (chat_id,),
        )
    else:
        return {"updated": 0}
    return {"updated": cur.rowcount}


def delete_activity_item(db, *, id: str) -> Dict[str, Any]:
    cur = db.exec("DELETE FROM activity_items WHERE id = ?", (id,))
    return {"removed": cur.rowcount > 0}


def clear_dismissible_activity_items(db) -> Dict[str, Any]:
    cur = db.exec(
        "DELETE FROM activity_items WHERE NOT (kind = 'approval' AND resolved IS NULL)"
    )
    return {"removed": cur.rowcount}


# ── Unread state ──────────────────────────────────────────────────────

def mark_seen(db, chat_id: str, *, now: Optional[float] = None) -> None:
    if now is None:
        now = time.time()
    db.exec(
        "INSERT INTO unread_state (chat_id, last_read_at, marked_unread) "
        "VALUES (?, ?, 0) "
        "ON CONFLICT(chat_id) DO UPDATE SET "
        "  last_read_at = excluded.last_read_at, marked_unread = 0",
        (chat_id, now),
    )


def set_marked(db, chat_id: str, marked: bool) -> None:
    db.exec(
        "INSERT INTO unread_state (chat_id, last_read_at, marked_unread) "
        "VALUES (?, NULL, ?) "
        "ON CONFLICT(chat_id) DO UPDATE SET marked_unread = excluded.marked_unread",
        (chat_id, 1 if marked else 0),
    )


def get_unread_row(db, chat_id: str) -> Optional[Dict[str, Any]]:
    row = db.fetchone(
        "SELECT chat_id AS chatId, last_read_at AS lastReadAt, marked_unread AS markedUnread "
        "FROM unread_state WHERE chat_id = ?",
        (chat_id,),
    )
    return dict(row) if row else None


def list_unread_state(db) -> List[Dict[str, Any]]:
    return [dict(r) for r in db.fetchall(
        "SELECT chat_id AS chatId, last_read_at AS lastReadAt, marked_unread AS markedUnread "
        "FROM unread_state"
    )]


# ── msg_links (in-flight → durable id bridge) ────────────────────────

def upsert_msg_link(db, *, id: str, chat_id: str, role: str, content: str,
                    agent_row_id: Optional[str] = None,
                    status: str = "final",
                    kind: Optional[str] = None,
                    tool_name: Optional[str] = None,
                    tool_call_id: Optional[str] = None,
                    tool_calls: Optional[str] = None) -> None:
    now = time.time()
    db.exec(
        "INSERT INTO msg_links (id, chat_id, role, content, kind, tool_name, "
        "                       tool_call_id, tool_calls, "
        "                       created_at, updated_at, status, agent_row_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET "
        "  content = excluded.content, "
        "  kind = COALESCE(excluded.kind, msg_links.kind), "
        "  tool_name = COALESCE(excluded.tool_name, msg_links.tool_name), "
        "  tool_call_id = COALESCE(excluded.tool_call_id, msg_links.tool_call_id), "
        "  tool_calls = COALESCE(excluded.tool_calls, msg_links.tool_calls), "
        "  updated_at = excluded.updated_at, "
        "  status = excluded.status, "
        "  agent_row_id = COALESCE(excluded.agent_row_id, msg_links.agent_row_id)",
        (id, chat_id, role, content, kind, tool_name, tool_call_id, tool_calls,
         now, now, status, agent_row_id),
    )


def list_msg_links_for_chat(db, chat_id: str, *, limit: int = 500) -> List[Dict[str, Any]]:
    rows = db.fetchall(
        "SELECT id, chat_id AS chatId, role, content, kind, tool_name AS toolName, "
        "       tool_call_id AS toolCallId, agent_row_id AS agentRowId, "
        "       created_at AS createdAt, updated_at AS updatedAt, status "
        "FROM msg_links WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?",
        (chat_id, limit),
    )
    return [dict(r) for r in rows]


# ── Items-endpoint reads + state.db reconciliation (Phase 2) ──────────
#
# `list_messages_for_chat` returns rows in the wire shape the items
# endpoint hands to the PWA. `reconcile_from_state_db` is the
# opportunistic backfill: any state.db rows for this chat that don't
# have a sidekick.db twin get inserted with `legacy:<state_id>` keys.
# Runs at items-endpoint enter time, before the read, so the response
# always reflects the union.
#
# Pagination cursor: sidekick.db.msg_links's implicit `rowid`. SQLite
# guarantees monotonicity ("ROWID of any new row will be one larger
# than the largest ROWID that has ever before existed in that same
# table"). PWA passes `before` cursor as an integer rowid; we filter
# `WHERE rowid < ?`.

def list_messages_for_chat(
    db, chat_id: str, *,
    limit: int = 200,
    before_rowid: Optional[int] = None,
) -> Dict[str, Any]:
    """Paginate the message store for one chat in chronological order.

    Returns ``{items, first_id, has_more}``.

    Ordering is by ``created_at`` ASC (wallclock timestamp), with
    ``rowid`` ASC as a deterministic tiebreaker. We can't use rowid
    alone because reconcile inserts legacy: rows from state.db in
    state-db-id order, which is NOT chronological for chats that
    pre-date Phase 1's write-through — a reload would push the just-
    sent envelope row out of the "recent" window behind the historic
    backfill — a fresh user message can end up hidden behind legacy
    inserts that arrived during reconcile.

    Cursor (`before_rowid`, kept named for wire-back-compat) is the
    millisecond-precision timestamp of the cursor item:
    ``int(created_at * 1000)``. PWA treats it as an opaque integer.
    """
    if before_rowid is None:
        sql = (
            "SELECT rowid AS rowid, id AS sidekick_id, role, content, kind, "
            "       tool_name, tool_call_id, tool_calls, agent_row_id, created_at, status "
            "FROM msg_links WHERE chat_id = ? "
            "ORDER BY created_at ASC, rowid ASC"
        )
        params: tuple = (chat_id,)
    else:
        # `before_rowid` is actually a millis cursor; convert back.
        cursor_ts = before_rowid / 1000.0
        sql = (
            "SELECT rowid AS rowid, id AS sidekick_id, role, content, kind, "
            "       tool_name, tool_call_id, tool_calls, agent_row_id, created_at, status "
            "FROM msg_links WHERE chat_id = ? AND created_at < ? "
            "ORDER BY created_at ASC, rowid ASC"
        )
        params = (chat_id, cursor_ts)
    rows = db.fetchall(sql, params)
    rows_list = [dict(r) for r in rows]
    first_id: Optional[int] = None
    has_more = False
    if before_rowid is None:
        if len(rows_list) > limit:
            rows_list = rows_list[-limit:]
            has_more = True
    else:
        if len(rows_list) >= limit:
            rows_list = rows_list[:limit]
            has_more = True
    if rows_list:
        first_id = int(float(rows_list[0]["created_at"]) * 1000)
    items = []
    for r in rows_list:
        ts_ms = int(float(r["created_at"]) * 1000) if r["created_at"] else 0
        item: Dict[str, Any] = {
            "id": ts_ms,
            "object": "message",
            "role": r["role"],
            "content": r["content"] or "",
            "created_at": int(r["created_at"]) if r["created_at"] else 0,
            "sidekick_id": r["sidekick_id"],
        }
        if r["kind"]:
            item["kind"] = r["kind"]
        if r["tool_name"]:
            item["tool_name"] = r["tool_name"]
        if r["tool_call_id"]:
            item["tool_call_id"] = r["tool_call_id"]
        if r["tool_calls"]:
            # PWA projection's parseToolCalls reads this OpenAI-shape
            # JSON to populate tool-row names + args on reload.
            item["tool_calls"] = r["tool_calls"]
        items.append(item)
    return {"items": items, "first_id": first_id, "has_more": has_more}


def list_messages_for_chat_with_state_db_source(
    sidekick_db,
    state_db_path,
    chat_id: str,
    source: str,
    *,
    limit: int = 200,
    before_id: Optional[int] = None,
) -> Dict[str, Any]:
    """B2 read path: state.db is the canonical message body store;
    sidekick.db.msg_links surfaces sidekick_id + kind as annotations.

    Replaces the dual-body model that v1 (``list_messages_for_chat``)
    implements. With v1, sidekick.db.msg_links stored a full copy of
    every message body, and reconcile failures could leave the same
    logical message stored twice — once via envelope write-through,
    once via state.db backfill — surfaced to the PWA as duplicate
    bubbles.

    With v2, the items endpoint reads state.db.messages (the canonical
    server-side store) and joins sidekick.db.msg_links *as a side
    table* keyed by ``agent_row_id``. Sidekick-id linkage + push/pin
    metadata still surfaces; message bodies are never duplicated.

    Returns ``{items, first_id, has_more}`` with the same wire shape
    v1 produces. Pagination cursor is ``state.db.messages.id`` (an
    integer; same opaque-to-PWA contract).

    Returns ``items=[]`` when state.db is unreachable — the caller
    treats that the same way it treats "chat unknown" and falls back
    on its 404 logic. (The legacy v1 returned an empty list in the
    same shape, so callers tolerate this.)
    """
    # Bounded fetch: pull only the newest `limit` (+ elision margin) state
    # rows at/below the cursor instead of the whole transcript. The Python
    # filter + slice below still runs over the merged set so envelope-only
    # rows (millis-keyed ids, never SQL-filtered) keep their existing
    # pagination semantics.
    items = _build_chronological_items(
        sidekick_db, state_db_path, chat_id, source,
        direction="older", cursor_id=before_id,
        fetch_limit=limit + ITEMS_FETCH_ELISION_MARGIN + 1,
    )

    # Pagination semantics:
    #  * before_id=None → most-recent `limit` items, has_more=True when we
    #    truncated older history off the head.
    #  * before_id set → user is paging backward; return the limit items
    #    nearest to (but older than) the cursor. v1/legacy mistakenly
    #    returned the OLDEST limit items instead (items[:limit]) — that
    #    bug surfaced as "load-earlier on a long chat keeps showing the
    #    same earliest page forever" because the cursor's neighborhood
    #    was never reached. v2 fixes by slicing tail-side in both cases.
    if before_id is not None:
        items = [it for it in items if it["id"] < before_id]
    if len(items) > limit:
        items = items[-limit:]
        has_more = True
    else:
        has_more = False
    first_id = items[0]["id"] if items else None

    return {"items": items, "first_id": first_id, "has_more": has_more}


def list_messages_around_for_chat_with_state_db_source(
    sidekick_db,
    state_db_path,
    chat_id: str,
    source: str,
    *,
    target: str,
    limit: int = 200,
    context_before: Optional[int] = None,
    context_after: Optional[int] = None,
) -> Dict[str, Any]:
    """Deep-target read: return a BOUNDED window of the transcript
    *centered* on ``target`` (matched by sidekick_id or by the integer
    state.db id) — context above AND below it — that does NOT run to the
    live tail.

    Why: the PWA's pin/activity "open in chat" drill used to reach a deep
    message by paging backward N times from the newest page — N serial
    round trips that could be slow on high-latency connections. The first
    fix made the drill one round trip but tail-contiguous: a pin near the
    TOP of a long session pulled back everything from the target to the
    tail. This bounds the payload to ``limit`` rows regardless of how
    deep/old the target is, at the cost of leaving a gap between the
    window's newest row and the live tail.

    The gap is the PWA's job to bridge: the window REPLACES the rendered
    transcript (it isn't prepended onto the loaded tail), scroll-up loads
    older via ``has_more``/``first_id``, and scroll-down loads newer via
    ``has_more_newer``/``last_id`` (the ``after=`` cursor). A "jump to
    latest" affordance re-resumes the chat to the tail.

    Returns ``{items, first_id, has_more, last_id, has_more_newer,
    target_found}``. When the target isn't in the transcript at all (stale
    pin / wrong chat), returns ``target_found=False`` with an empty list so
    the caller can fall back to its standard pagination drill.
    """
    items = _build_chronological_items(
        sidekick_db, state_db_path, chat_id, source
    )
    empty = {
        "items": [], "first_id": None, "has_more": False,
        "last_id": None, "has_more_newer": False, "target_found": False,
    }
    if not items:
        return dict(empty)

    target_str = str(target)
    idx = None
    for i, it in enumerate(items):
        if str(it.get("sidekick_id") or "") == target_str or str(it["id"]) == target_str:
            idx = i
            break
    if idx is None:
        return dict(empty)

    # Split the budget above/below the target — a bit more above so the
    # user lands with reading context leading INTO the target. The window
    # is bounded by the budget, never the distance to the tail, so the
    # payload stays O(limit) for any depth.
    ctx_before = context_before if context_before is not None else max(20, (limit * 2) // 3)
    ctx_after = context_after if context_after is not None else max(10, limit // 3)
    start = max(0, idx - ctx_before)
    end = min(len(items), idx + ctx_after + 1)
    window = items[start:end]

    return {
        "items": window,
        "first_id": window[0]["id"] if window else None,
        "has_more": start > 0,
        "last_id": window[-1]["id"] if window else None,
        "has_more_newer": end < len(items),
        "target_found": True,
    }


def list_messages_after_for_chat_with_state_db_source(
    sidekick_db,
    state_db_path,
    chat_id: str,
    source: str,
    *,
    after_id: int,
    limit: int = 200,
) -> Dict[str, Any]:
    """Load-newer read: return up to ``limit`` items NEWER than ``after_id``
    (the symmetric counterpart of ``before_id`` paging).

    Used when the user scrolls DOWN past the bottom of a bounded deep-jump
    window (see ``list_messages_around_*``) toward the live tail. Returns
    the OLDEST ``limit`` items above the cursor so the prepend-side stays
    contiguous with what's already loaded; ``has_more_newer`` is True when
    more remain between this page and the tail.

    Returns ``{items, first_id, has_more, last_id, has_more_newer}`` —
    ``has_more`` (older-direction) is always False here: this is a
    load-NEWER page, so the older side is governed by the around-window
    response the caller already holds, not by this page. The key must
    still be present because the items route reads it unconditionally
    for every branch.
    """
    items = _build_chronological_items(
        sidekick_db, state_db_path, chat_id, source,
        direction="newer", cursor_id=after_id,
        fetch_limit=limit + ITEMS_FETCH_ELISION_MARGIN + 1,
    )
    items = [it for it in items if it["id"] > after_id]
    if len(items) > limit:
        items = items[:limit]
        has_more_newer = True
    else:
        has_more_newer = False
    return {
        "items": items,
        "first_id": items[0]["id"] if items else None,
        "has_more": False,
        "last_id": items[-1]["id"] if items else None,
        "has_more_newer": has_more_newer,
    }


def _build_chronological_items(
    sidekick_db,
    state_db_path,
    chat_id: str,
    source: str,
    *,
    direction: Optional[str] = None,
    cursor_id: Optional[int] = None,
    fetch_limit: Optional[int] = None,
) -> list:
    """Build a chronological item list for a chat from state.db (canonical
    bodies) merged with sidekick.db.msg_links (sidekick_id + kind
    annotations + envelope-only rows).

    When ``fetch_limit`` is None (the around-target reader) the WHOLE
    transcript is returned, sorted ascending — callers slice it in Python.

    When ``fetch_limit`` is set, only a BOUNDED window of state.db rows is
    fetched so steady-state reads are O(page) not O(history):
      * ``direction='older'`` — the newest ``fetch_limit`` rows whose id is
        ``< cursor_id`` (or the live tail when ``cursor_id`` is None),
        fetched descending. Used by the tail / before-cursor read.
      * ``direction='newer'`` — the oldest ``fetch_limit`` rows whose id is
        ``> cursor_id``, fetched ascending. Used by the after-cursor read.
    The envelope-only union (small, link-lag-bounded set) and the merged
    re-sort are unchanged, so the bounded window interleaves with live-edge
    envelope rows exactly as the full build did.

    Returns ``[]`` when state.db is unreachable (callers fall back to
    their 404 logic). Does NOT paginate — that's the caller's job."""
    import contextlib
    import sqlite3

    if state_db_path is None or not state_db_path.exists():
        return []

    # Same recursive CTE as the legacy ``_items_by_user_id``: roll up
    # any messages that landed in compaction-rotated child sessions
    # (user_id=NULL but parent's system_prompt matches) under the
    # requested chat_id. Without this, compacted-out turns are
    # invisible.
    cte = """
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
    """
    select_cols = (
        "SELECT m.id, m.session_id, sr.is_compaction_child, m.role, "
        "m.content, m.tool_name, m.tool_call_id, m.tool_calls, m.timestamp "
        "FROM messages m JOIN session_root sr ON m.session_id = sr.id"
    )
    params: list = [chat_id, source]
    if fetch_limit is None:
        # Full transcript (around-target reader). Callers slice in Python
        # so they share one identical chronological view.
        sql = cte + select_cols + " ORDER BY m.timestamp ASC, m.id ASC"
    elif direction == "newer":
        sql = cte + select_cols
        if cursor_id is not None:
            sql += " WHERE m.id > ?"
            params.append(cursor_id)
        sql += " ORDER BY m.timestamp ASC, m.id ASC LIMIT ?"
        params.append(fetch_limit)
    else:  # 'older' (tail / before-cursor)
        sql = cte + select_cols
        if cursor_id is not None:
            sql += " WHERE m.id < ?"
            params.append(cursor_id)
        # Newest-first so LIMIT keeps the rows nearest the cursor; the
        # final merged re-sort restores ascending order.
        sql += " ORDER BY m.timestamp DESC, m.id DESC LIMIT ?"
        params.append(fetch_limit)

    uri = f"file:{state_db_path}?mode=ro"
    compaction_head_end_per_session: Dict[str, int] = {}
    try:
        with contextlib.closing(
            sqlite3.connect(uri, uri=True, timeout=2.0)
        ) as conn:
            conn.row_factory = sqlite3.Row
            rows = list(conn.execute(sql, params).fetchall())
            # Per-session compaction head-end. In the FULL fetch every
            # marker row is present, so derive the map from `rows` below.
            # In a BOUNDED fetch the marker can sit OUTSIDE the window, so
            # when the window holds any compaction-child rows run a cheap
            # aggregate (runs entirely in C / GIL-released, returns one
            # row per child session) to recover each session's max marker
            # id. Guarded by child-row presence so non-compacted tail
            # reads skip the scan entirely.
            if fetch_limit is not None and any(r["is_compaction_child"] for r in rows):
                agg = conn.execute(
                    cte
                    + "SELECT m.session_id AS sid, MAX(m.id) AS head_end "
                    "FROM messages m JOIN session_root sr ON m.session_id = sr.id "
                    "WHERE sr.is_compaction_child = 1 "
                    "AND m.content LIKE '[CONTEXT COMPACTION%' "
                    "GROUP BY m.session_id",
                    [chat_id, source],
                ).fetchall()
                for a in agg:
                    if a["head_end"] is not None:
                        compaction_head_end_per_session[a["sid"]] = a["head_end"]
    except Exception:
        return []

    # Drop compaction-injected seed rows (same logic as v1, see
    # ``_items_by_user_id`` in sidekick_route_items.py for the full
    # explanation of the [CONTEXT COMPACTION] marker + per-session
    # head-block elision).
    if fetch_limit is None:
        for r in rows:
            if r["is_compaction_child"] and (r["content"] or "").startswith("[CONTEXT COMPACTION"):
                cur = compaction_head_end_per_session.get(r["session_id"], 0)
                if r["id"] > cur:
                    compaction_head_end_per_session[r["session_id"]] = r["id"]
    surviving = [
        r for r in rows
        if not (r["content"] or "").startswith("[CONTEXT COMPACTION")
        and not (
            (drop_through := compaction_head_end_per_session.get(r["session_id"])) is not None
            and r["id"] <= drop_through
        )
    ]

    # Fetch sidekick.db.msg_links rows for these state.db ids in one
    # query, then merge in Python. This is the "JOIN" that gives the
    # PWA its sidekick_id / kind annotations without the dual-body
    # consistency problem v1 had.
    state_ids = [str(r["id"]) for r in surviving]
    link_by_state_id: Dict[str, Dict[str, Any]] = {}
    if state_ids:
        placeholders = ",".join("?" * len(state_ids))
        try:
            link_rows = sidekick_db.fetchall(
                f"SELECT id AS sidekick_id, agent_row_id, kind "
                f"FROM msg_links "
                f"WHERE chat_id = ? AND agent_row_id IN ({placeholders})",
                (chat_id, *state_ids),
            )
            for lr in link_rows:
                agent_row_id = lr["agent_row_id"]
                if agent_row_id:
                    link_by_state_id[str(agent_row_id)] = dict(lr)
        except Exception:
            # sidekick.db unavailable — fall through with empty
            # link map. State.db rows still surface; they just won't
            # carry sidekick_id annotations.
            pass

    # Merge into the wire shape.
    items: list = []
    for r in surviving:
        item: Dict[str, Any] = {
            "id": int(r["id"]),
            "object": "message",
            "role": r["role"],
            "content": r["content"] or "",
            "created_at": int(r["timestamp"]) if r["timestamp"] else 0,
        }
        link = link_by_state_id.get(str(r["id"]))
        if link:
            item["sidekick_id"] = link["sidekick_id"]
            if link["kind"]:
                item["kind"] = link["kind"]
        if r["tool_name"]:
            item["tool_name"] = r["tool_name"]
        if r["tool_call_id"]:
            item["tool_call_id"] = r["tool_call_id"]
        if r["tool_calls"]:
            item["tool_calls"] = r["tool_calls"]
        items.append(item)

    # ── Envelope-only rows: surface unlinked msg_links entries.
    #
    # State.db is hermes' POST-TURN flush; the envelope path (Phase-1
    # write-through) lands rows on sidekick.db at SSE-emit time, often
    # seconds-to-minutes ahead of state.db. Without this union, a brand-
    # new chat (state.db has no session yet) or a streaming mid-turn
    # chat (state.db row not yet flushed) would surface as ZERO messages
    # via v2 read — breaking activity-row drill ("no longer has a
    # session"), pinned-message open, and any other path that addresses
    # a freshly-arrived message.
    #
    # Pull msg_links rows with NULL agent_row_id (unmatched to any
    # state.db row) for this chat and project them into the same wire
    # shape as state.db rows. Their `id` is the created_at millis cursor
    # (same convention v1 used so pagination semantics stay sane); the
    # sidekick_id (msg_xxx/umsg_xxx/notif_xxx/tc:*/tr:*) drives the PWA
    # bubble's data-key.
    try:
        unlinked = sidekick_db.fetchall(
            "SELECT id, role, content, kind, tool_name, tool_call_id, "
            "       tool_calls, created_at "
            "FROM msg_links "
            "WHERE chat_id = ? AND agent_row_id IS NULL AND status = 'final' "
            "ORDER BY created_at ASC, rowid ASC",
            (chat_id,),
        )
    except Exception:
        unlinked = []
    for r in unlinked:
        ts = float(r["created_at"]) if r["created_at"] is not None else 0.0
        item = {
            "id": int(ts * 1000) if ts else 0,
            "object": "message",
            "role": r["role"],
            "content": r["content"] or "",
            "created_at": int(ts) if ts else 0,
            "sidekick_id": r["id"],
        }
        if r["kind"]:
            item["kind"] = r["kind"]
        if r["tool_name"]:
            item["tool_name"] = r["tool_name"]
        if r["tool_call_id"]:
            item["tool_call_id"] = r["tool_call_id"]
        if r["tool_calls"]:
            item["tool_calls"] = r["tool_calls"]
        items.append(item)

    # Re-sort the merged set — state.db rows came back timestamp ASC
    # from the CTE, unlinked rows are appended at the end; chronological
    # interleave is the wire contract callers depend on.
    items.sort(key=lambda it: (it["created_at"], it["id"]))

    return items


def reconcile_from_state_db(
    db, state_db_path, chat_id: str, source: str = "sidekick",
) -> int:
    """Bidirectional reconciliation between state.db and sidekick.db
    for one chat. Runs at items-endpoint enter and on session_changed.

    Three-pass operation:
      1. **Link pass (Phase 3)**: each unlinked sidekick.db row
         (agent_row_id IS NULL) finds a state.db row with matching
         role + content that hasn't been claimed yet. Earliest match
         wins; duplicates resolved in chronological order.
      2. **Insert pass**: state.db rows still without a sidekick.db
         twin get inserted as ``legacy:<state_id>`` (INSERT OR IGNORE).
      3. **Orphan-drop pass (Phase 4)**: sidekick.db rows with
         ``agent_row_id`` pointing at a state.db row that no longer
         exists (i.e. ``/retry``, ``/undo``, ``/compress`` rewrote
         the session; explicit delete dropped it; 90-day prune ran)
         get removed. Rows with NULL agent_row_id are NEVER dropped
         — they're either in-flight or pre-link, both legitimate.

    Pass 3 (self-heal): state.db is authoritative for whole-session
    mutations, so any
    sidekick.db row linked to a vanished state.db row is provably
    stale. The orphan check runs every reconcile (cheap O(N) set
    ops on already-fetched data) which means /retry-style mutations
    self-heal on the next PWA poll without a separate trigger.

    Returns count of (linked + inserted + dropped) rows changed.
    Best-effort: sqlite errors return 0 without raising; the items
    endpoint still returns whatever's in sidekick.db.

    SAFETY: if state.db is unreachable (file missing, locked), the
    function returns 0 *without dropping anything* — the early
    return on `not state_rows` covers this. Brand-new chats where
    state.db hasn't flushed yet keep their envelope-written rows
    intact because those rows have NULL agent_row_id (not orphan
    candidates).
    """
    import contextlib
    import sqlite3
    from . import sidekick_perf_trace as _perf  # noqa: WPS433
    _t_recon_start = time.monotonic()
    if state_db_path is None:
        return 0
    # Reachability gate: only proceed with pass 3 (orphan drops) when
    # state.db opened cleanly. A locked / missing state.db means
    # `state_reachable=False` and orphan drops are skipped — otherwise
    # a transient state.db hiccup would wipe legitimate rows.
    state_reachable = False
    try:
        uri = f"file:{state_db_path}?mode=ro"
        with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=2.0)) as conn:
            conn.row_factory = sqlite3.Row
            sql = """
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
                SELECT m.id, m.role, m.content, m.tool_name,
                       m.tool_call_id, m.tool_calls, m.timestamp
                FROM messages m
                JOIN session_root sr ON m.session_id = sr.id
                ORDER BY m.id ASC
            """
            state_rows = list(conn.execute(sql, (chat_id, source)).fetchall())
            state_reachable = True
    except Exception:
        return 0

    # Drop compaction-injected seed rows (the `[CONTEXT COMPACTION]`
    # marker that hermes injects when minting a child session — never
    # surfaced to the PWA).
    state_rows = [
        r for r in state_rows
        if not (r["content"] or "").startswith("[CONTEXT COMPACTION")
    ]

    # Linked agent_row_ids already in sidekick.db.
    linked_rows = db.fetchall(
        "SELECT agent_row_id FROM msg_links WHERE chat_id = ? AND agent_row_id IS NOT NULL",
        (chat_id,),
    )
    claimed_state_ids = {str(r["agent_row_id"]) for r in linked_rows}

    # ── Pass 1: link unlinked sidekick.db rows.
    #
    # Two-pronged: (1.a) exact (role, content) fingerprint claims the
    # easy cases — same string both sides means same logical message.
    # (1.b) Order-fallback within (chat, role) for role in {user,
    # assistant}: walk remaining unlinked envelope rows and unclaimed
    # state.db rows in append-only order and pair 1:1.
    #
    # Why order-fallback is the right primitive: hermes' state.db
    # writes for a session are append-only in turn order; sidekick's
    # envelope writes are append-only in stream order. The two
    # sequences correspond. Content fingerprint fails on whitespace
    # drift / hermes-side post-edit / empty-final-reply paths even
    # though the underlying message is the same — order linking
    # catches those. (Skipped for role='tool' because both tc:* and
    # tr:* envelope rows share role='tool' but state.db only ever
    # has a single tool row per call; the content fingerprint claims
    # the tr:* row correctly and tc:* legitimately has no twin.)
    #
    # Old behavior — content match only — left envelope rows
    # unlinked under drift, which made Pass 2 insert a parallel
    # `legacy:<state_id>` row and downstream consumers (activity drill,
    # push tag, projection key) had to deal with two id shapes for
    # one logical message. The shim closes that class.
    unlinked = db.fetchall(
        "SELECT id, role, content FROM msg_links "
        "WHERE chat_id = ? AND agent_row_id IS NULL "
        "ORDER BY created_at ASC, rowid ASC",
        (chat_id,),
    )
    links = 0
    if unlinked:
        # Pass 1.a — exact (role, content) match.
        candidates: Dict[tuple, List[str]] = {}
        for r in state_rows:
            sid = str(r["id"])
            if sid in claimed_state_ids:
                continue
            key = (r["role"], r["content"] or "")
            candidates.setdefault(key, []).append(sid)
        still_unlinked: List[Dict[str, Any]] = []
        for sk in unlinked:
            key = (sk["role"], sk["content"] or "")
            queue = candidates.get(key)
            if not queue:
                still_unlinked.append(dict(sk))
                continue
            state_id = queue.pop(0)
            try:
                db.exec(
                    "UPDATE msg_links SET agent_row_id = ?, updated_at = ? "
                    "WHERE id = ?",
                    (state_id, time.time(), sk["id"]),
                )
                claimed_state_ids.add(state_id)
                links += 1
            except Exception:
                still_unlinked.append(dict(sk))

        # Pass 1.b — order-fallback within (chat, role) for the two
        # roles where envelope and state.db are 1:1 by construction.
        # state_rows came back ORDER BY id ASC (see the CTE query);
        # still_unlinked is in created_at ASC, rowid ASC (the SELECT
        # above). Both append-only sequences, so per-role zip pairs them.
        for role_to_fallback in ("user", "assistant"):
            env_queue = [sk for sk in still_unlinked if sk["role"] == role_to_fallback]
            state_queue = [
                str(r["id"]) for r in state_rows
                if r["role"] == role_to_fallback and str(r["id"]) not in claimed_state_ids
            ]
            for sk, state_id in zip(env_queue, state_queue):
                try:
                    db.exec(
                        "UPDATE msg_links SET agent_row_id = ?, updated_at = ? "
                        "WHERE id = ?",
                        (state_id, time.time(), sk["id"]),
                    )
                    claimed_state_ids.add(state_id)
                    links += 1
                except Exception:
                    continue

    # ── Pass 2: insert state.db rows that still have no sidekick.db
    # twin. These are legacy chats from before Phase 1's write-through,
    # OR rows that drifted (sidekick.db write-path bug missed them).
    inserted = 0
    for r in state_rows:
        state_id = str(r["id"])
        if state_id in claimed_state_ids:
            continue
        sk_id = f"legacy:{state_id}"
        ts = float(r["timestamp"]) if r["timestamp"] is not None else time.time()
        # state.db's tool_calls column lives on assistant rows that
        # orchestrated tool calls. Propagating it to sidekick.db means
        # PWA projection's parseToolCalls() can populate tool-row
        # names + args on reload — without this, reconciled chats
        # render as "(unknown)" + args="{}".
        tool_calls_raw = r["tool_calls"] if "tool_calls" in r.keys() else None
        try:
            db.exec(
                "INSERT OR IGNORE INTO msg_links "
                "(id, chat_id, role, content, kind, tool_name, tool_call_id, "
                " tool_calls, created_at, updated_at, status, agent_row_id) "
                "VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'final', ?)",
                (
                    sk_id, chat_id, r["role"], r["content"] or "",
                    r["tool_name"], r["tool_call_id"], tool_calls_raw,
                    ts, ts, state_id,
                ),
            )
            inserted += 1
        except Exception:
            continue

    # ── Pass 2.5: heal tool_calls on existing legacy: rows that
    # were inserted by a previous reconcile before this column was
    # propagated. Bumps any row whose tool_calls is NULL but state.db
    # has it. One-shot during the rollout window; idempotent.
    healed_tc = 0
    for r in state_rows:
        raw_tc = r["tool_calls"] if "tool_calls" in r.keys() else None
        if not raw_tc:
            continue
        state_id = str(r["id"])
        try:
            cur = db.exec(
                "UPDATE msg_links SET tool_calls = ?, updated_at = ? "
                "WHERE chat_id = ? AND agent_row_id = ? AND tool_calls IS NULL",
                (raw_tc, time.time(), chat_id, state_id),
            )
            if cur.rowcount > 0:
                healed_tc += cur.rowcount
        except Exception:
            continue

    # ── Pass 3: orphan drop (Phase 4 self-heal).
    # sidekick.db rows with agent_row_id set but the state.db row gone
    # are provable orphans: hermes did a whole-session DELETE (/retry,
    # /undo, /compress rewrote the transcript; explicit delete; 90-day
    # prune). Drop them so the next read doesn't show stale bubbles.
    #
    # Skipped when state.db wasn't reachable (state_reachable=False
    # already returned 0 above) — defensive against a sqlite hiccup
    # wiping legitimate rows.
    dropped = 0
    if state_reachable:
        live_state_ids = {str(r["id"]) for r in state_rows}
        linked_now = db.fetchall(
            "SELECT id, agent_row_id FROM msg_links "
            "WHERE chat_id = ? AND agent_row_id IS NOT NULL",
            (chat_id,),
        )
        for row in linked_now:
            arid = str(row["agent_row_id"])
            if arid in live_state_ids:
                continue
            try:
                db.exec("DELETE FROM msg_links WHERE id = ?", (row["id"],))
                dropped += 1
            except Exception:
                continue
    if dropped or healed_tc:
        # Log every heal event — write-path bugs and whole-session
        # mutations both surface here. Threshold for alerting is a
        # future concern; for now bake into a single warning line a
        # grep can find.
        import logging as _logging
        _logging.getLogger(__name__).warning(
            "[sidekick] heal chat=%s links=%d inserted=%d dropped=%d tc_healed=%d",
            chat_id, links, inserted, dropped, healed_tc,
        )
    # Perf-investigation breadcrumb. Logs at INFO when reconcile takes
    # longer than 50ms; helps distinguish no-op reconciles (should be
    # ms-scale on chats with no drift) from heavy ones, and lets us
    # quantify how much cumulative time the route's fire-and-forget
    # background reconciles burn over a long gateway uptime.
    _recon_wall_ms = (time.monotonic() - _t_recon_start) * 1000.0
    if _perf._is_enabled() and _recon_wall_ms >= 50.0:
        _perf.logger.info(
            "[perf-trace] reconcile chat=%s source=%s wall=%.0fms "
            "state_rows=%d links=%d inserted=%d dropped=%d tc_healed=%d",
            chat_id[:24], source, _recon_wall_ms,
            len(state_rows), links, inserted, dropped, healed_tc,
        )
    return links + inserted + dropped + healed_tc


# ── Envelope → row upsert ────────────────────────────────────────────
#
# Phase 1 of the sidekick.db-as-message-store migration. Every outbound
# envelope routed through ``_safe_send_envelope`` is recorded here at
# emit time. Items endpoint still reads from state.db in Phase 1;
# Phase 2 switches the read path. See top-of-file design block in
# ``sidekick_db.py``.
#
# Envelope → row mapping:
#
#   * ``user_message``  → role='user',      content=env.text,
#                         status='final',   id=message_id
#   * ``reply_delta``   → role='assistant', content=env.text (cumulative),
#                         status='streaming', id=message_id
#                         (subsequent deltas overwrite content)
#   * ``reply_final``   → role='assistant', content=env.text OR last
#                         delta's accumulated text, status='final',
#                         id=message_id
#   * ``tool_call``     → role='tool',      content=JSON-encoded args,
#                         tool_name=env.tool_name,
#                         tool_call_id=env.call_id,
#                         status='streaming', id='tc:'+call_id
#   * ``tool_result``   → role='tool',      content=env.result (string),
#                         tool_name=env.tool_name,
#                         tool_call_id=env.call_id,
#                         status='final',   id='tr:'+call_id
#   * ``notification``  → role='assistant', content=env.content,
#                         kind=env.kind,    status='final',
#                         id=env.message_id or minted notif_*
#
# Other envelope types (typing, session_changed, error, image,
# unread_changed) are intentionally NOT persisted — they're transient
# UI signals, not message rows.

_PERSISTED_ENVELOPE_TYPES = frozenset({
    "user_message",
    "reply_delta",
    "reply_final",
    "tool_call",
    "tool_result",
    "notification",
})


def record_envelope(db, env: Dict[str, Any]) -> Optional[str]:
    """Upsert sidekick.db row for one outbound envelope.

    Returns the row id written (for tests/diagnostics), or None when
    the envelope type isn't a persisted one (typing, etc.).

    Idempotent: re-recording the same envelope updates the row in place.
    Reply_delta accumulation: each delta overwrites content with its
    own text (envelope-stream convention — deltas carry cumulative text,
    not deltas).
    """
    etype = env.get("type")
    if etype not in _PERSISTED_ENVELOPE_TYPES:
        return None
    chat_id = env.get("chat_id")
    if not isinstance(chat_id, str) or not chat_id:
        return None
    # Strip any source-prefix the dispatcher added; rows are keyed by
    # the bare chat_id internally. (Matches items-endpoint parse_gateway_id
    # normalization upstream.)
    if ":" in chat_id:
        _, _, chat_id = chat_id.partition(":")
    now = time.time()

    if etype == "user_message":
        row_id = env.get("message_id")
        if not isinstance(row_id, str) or not row_id:
            return None
        upsert_msg_link(
            db, id=row_id, chat_id=chat_id, role="user",
            content=env.get("text") or "", status="final",
        )
        return row_id

    if etype == "reply_delta":
        row_id = env.get("message_id")
        if not isinstance(row_id, str) or not row_id:
            return None
        upsert_msg_link(
            db, id=row_id, chat_id=chat_id, role="assistant",
            content=env.get("text") or "", status="streaming",
        )
        return row_id

    if etype == "reply_final":
        row_id = env.get("message_id")
        if not isinstance(row_id, str) or not row_id:
            return None
        # Pull the latest accumulated text from the existing row if the
        # final envelope itself omits text (some adapters terminate
        # with an empty payload; the cumulative content lives on the
        # last delta).
        text = env.get("text")
        if not text:
            existing = db.fetchone(
                "SELECT content FROM msg_links WHERE id = ?", (row_id,),
            )
            if existing and existing["content"]:
                text = existing["content"]
        upsert_msg_link(
            db, id=row_id, chat_id=chat_id, role="assistant",
            content=text or "", status="final",
        )
        return row_id

    if etype == "tool_call":
        call_id = env.get("call_id")
        if not isinstance(call_id, str) or not call_id:
            return None
        row_id = f"tc:{call_id}"
        args = env.get("args")
        try:
            args_str = json.dumps(args) if args is not None else ""
        except Exception:
            args_str = str(args) if args is not None else ""
        upsert_msg_link(
            db, id=row_id, chat_id=chat_id, role="tool",
            content=args_str, status="streaming",
            tool_name=env.get("tool_name") or "",
            tool_call_id=call_id,
        )
        return row_id

    if etype == "tool_result":
        call_id = env.get("call_id")
        if not isinstance(call_id, str) or not call_id:
            return None
        row_id = f"tr:{call_id}"
        result = env.get("result")
        if not isinstance(result, str):
            try:
                result = json.dumps(result) if result is not None else ""
            except Exception:
                result = str(result) if result is not None else ""
        upsert_msg_link(
            db, id=row_id, chat_id=chat_id, role="tool",
            content=result, status="final",
            tool_name=env.get("tool_name") or "",
            tool_call_id=call_id,
        )
        return row_id

    if etype == "notification":
        # Notifications minted by cron/scheduler don't always carry a
        # message_id on the wire; fall back to a synthesized one tied
        # to the timestamp + chat (good enough for dedup since the
        # plugin never re-sends the same notification).
        row_id = env.get("sidekick_id") or env.get("message_id") or env.get("notif_id") \
            or f"notif_{int(now * 1000)}_{chat_id[:8]}"
        env["sidekick_id"] = row_id
        upsert_msg_link(
            db, id=row_id, chat_id=chat_id, role="assistant",
            content=env.get("content") or env.get("text") or "",
            status="final",
            kind=env.get("kind"),
        )
        return row_id

    return None
