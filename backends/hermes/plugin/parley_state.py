"""Push subs / mutes / prefs / pins / unread / VAPID CRUD against
the supplemental sqlite. Python parity of the openclaw plugin's
``src/push-storage.js`` + ``src/pins-storage.js`` + ``src/unread-storage.js``.

Keep this module pure: storage operations only. Dispatch logic
(engagement filter, web-push call) lives in ``parley_dispatcher.py``.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Dict, List, Optional

import base64
import os
from .parley_env import env_get

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
        value = int(env_get("PARLEY_ACTIVITY_MAX_ITEMS", str(DEFAULT_ACTIVITY_MAX_ITEMS)))
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


# ── Legacy push-prefs shape migration ──────────────────────────────────
#
# Two pref shapes historically coexisted in push_prefs:
#   canonical: one row per kind — key `push_kind_<kind>`, value bool.
#              This is the ONLY shape the dispatcher reads
#              (parley_dispatcher._kind_pref_enabled).
#   legacy:    one row keyed `kinds` holding a JSON object (the proxy's
#              PushKinds blob, pre-2026-05-20 delegate which forwarded
#              the nested object unflattened). Dead on every read path —
#              the delegate's normalizePluginPrefs overwrites `kinds`
#              from the per-key rows — but a live-DB row of this shape
#              survived into 2026-07 (push-outage audit).
#
# expand_kinds_pref_value + migrate_legacy_push_prefs converge writes
# and stored rows onto the canonical shape. Idempotent: per-key rows
# already present always win; a second run is a no-op.

LEGACY_KINDS_PREF_KEY = "kinds"

# Proxy-side legacy semantics (prefs.ts mergeWithDefaults): the broad
# `notification` toggle drove cron + approval; agent_reply was its own
# key even back then.
_LEGACY_BROAD_KIND_TARGETS = ("cron", "approval")
_CANONICAL_KIND_NAMES = ("agent_reply", "cron", "approval")


def expand_kinds_pref_value(value: Any) -> Dict[str, bool]:
    """Flatten a legacy `kinds` object into canonical per-kind bools.
    Unknown kind names are dropped (conservative: never mint pref rows
    the dispatcher would not read)."""
    out: Dict[str, bool] = {}
    if not isinstance(value, dict):
        return out
    for kind, enabled in value.items():
        if kind == "notification":
            for target in _LEGACY_BROAD_KIND_TARGETS:
                out[target] = bool(enabled)
        elif kind in _CANONICAL_KIND_NAMES:
            out[kind] = bool(enabled)
    return out


def migrate_legacy_push_prefs(db) -> bool:
    """One-shot (idempotent) convergence of push_prefs onto the
    canonical per-key shape. Translates a legacy `kinds` row into
    `push_kind_*` rows — only for kinds with NO existing per-key row,
    so a user's live per-key toggles are never clobbered — then deletes
    the legacy row. Returns True when a legacy row was found."""
    row = db.fetchone(
        "SELECT value_json FROM push_prefs WHERE key = ?", (LEGACY_KINDS_PREF_KEY,)
    )
    if row is None:
        return False
    try:
        legacy_value = json.loads(row["value_json"])
    except Exception:
        legacy_value = None
    migrated = []
    for kind, enabled in expand_kinds_pref_value(legacy_value).items():
        per_key = f"push_kind_{kind}"
        existing = db.fetchone("SELECT 1 FROM push_prefs WHERE key = ?", (per_key,))
        if existing is None:
            set_pref(db, per_key, enabled)
            migrated.append(f"{per_key}={enabled}")
    db.exec("DELETE FROM push_prefs WHERE key = ?", (LEGACY_KINDS_PREF_KEY,))
    logging.getLogger("hermes.parley.push").info(
        "[parley] migrated legacy push_prefs `kinds` row → canonical shape "
        "(wrote: %s; existing per-key rows preserved)",
        ", ".join(migrated) or "nothing — all per-key rows already present",
    )
    return True


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


class UserSettingConflict(Exception):
    """Raised by set_user_setting when the caller's ``base_updated_at``
    doesn't match the row's current updated_at (compare-and-swap
    failure). Carries the row's CURRENT state so the route can return
    it in the 409 body — the client 3-way-merges against it and
    retries. Added after the 2026-07-31 keyterms clobber incident
    (stale phone mirror overwrote a newer server row via LWW)."""

    def __init__(self, key: str, value, updated_at):
        super().__init__(f"user_settings CAS conflict on {key!r}")
        self.key = key
        self.value = value            # decoded row value, None if row absent
        self.updated_at = updated_at  # row updated_at, None if row absent


# Sentinel distinguishing "caller sent no base" (unconditional write —
# old-client LWW compatibility) from "caller sent base null" (row must
# not exist). `None` can't serve both meanings.
_CAS_UNSET = object()


def set_user_setting(db, key: str, value, base_updated_at=_CAS_UNSET) -> float:
    """Upsert one setting; returns the row's NEW updated_at.

    ``base_updated_at`` opts into compare-and-swap:
      - omitted        → unconditional write (last-write-wins; what old
                         clients that predate CAS still get)
      - None           → write only if the row does NOT exist yet
                         (first-device adoption of a legacy local list)
      - float          → write only if it equals the row's current
                         updated_at EXACTLY (the client echoes the value
                         it last read; JSON float round-trip is exact)
    On mismatch raises UserSettingConflict with the current row state.
    """
    row = db.fetchone(
        "SELECT value, updated_at FROM user_settings WHERE key = ?", (key,))
    if base_updated_at is not _CAS_UNSET:
        current_ts = row["updated_at"] if row else None
        if current_ts != base_updated_at:
            current_value = None
            if row:
                try:
                    current_value = json.loads(row["value"])
                except Exception:
                    current_value = None
            raise UserSettingConflict(key, current_value, current_ts)
    ts = time.time()
    # Strictly-increasing guard: updated_at doubles as the CAS token, so
    # two writes must never share a timestamp (same-tick float collision
    # would make a stale base "match" the newer row).
    if row and ts <= row["updated_at"]:
        ts = row["updated_at"] + 1e-6
    db.exec(
        "INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
        "updated_at = excluded.updated_at",
        (key, json.dumps(value), ts),
    )
    return ts


def list_user_settings(db) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for row in db.fetchall("SELECT key, value FROM user_settings"):
        try:
            out[row["key"]] = json.loads(row["value"])
        except Exception:
            out[row["key"]] = None
    return out


def list_user_settings_meta(db) -> Dict[str, float]:
    """{key: updated_at} companion to list_user_settings. Served as a
    sibling map in the GET response (additive — old clients ignore it)
    so clients can track the CAS base for their next write."""
    return {
        row["key"]: row["updated_at"]
        for row in db.fetchall("SELECT key, updated_at FROM user_settings")
    }


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


# Activity ids minted by the envelope path embed their creation time:
# ``notif_<epoch-ms>_<hex>`` (see __init__._persist_activity_for_push).
# 13 digits pins epoch-milliseconds (2001-2286) so a shorter/longer
# digit run (some other id scheme) never parses as a bogus timestamp.
_ACTIVITY_ID_MINT_RE = re.compile(r"^notif_(\d{13})_")


def mint_time_from_activity_id(item_id: Any) -> Optional[float]:
    """Epoch-seconds mint time embedded in a ``notif_<13-digit-ms>_…``
    activity id, or None when the id doesn't carry one. Lets a
    replayed/pruned-then-reinserted notification land at its TRUE time
    instead of the replay batch's time.time() (field 2026-07-20: four
    cron items with mints spanning Jul 18-20 all re-inserted with one
    identical replay-batch created_at)."""
    if not isinstance(item_id, str):
        return None
    m = _ACTIVITY_ID_MINT_RE.match(item_id)
    if not m:
        return None
    return int(m.group(1)) / 1000.0


def upsert_activity_item(db, *, id: str, chat_id: Optional[str], kind: str, title: str,
                         body: str, created_at: Optional[float] = None,
                         urgent: bool = False, read: bool = False,
                         message_id: Optional[str] = None,
                         resolved: Optional[str] = None) -> None:
    # ON CONFLICT is one-way for user-visible progress: a replayed
    # envelope (gateway restart re-emitting the notification path) must
    # never UN-read an item, wipe a resolution, or move created_at.
    # ``read`` only ratchets 0→1; ``resolved`` keeps the first non-NULL
    # value; ``created_at`` is insert-time only (deliberately absent
    # from the update set — pinned by test_replay_upsert_preserves_created_at).
    now = time.time()
    db.exec(
        "INSERT INTO activity_items (id, chat_id, kind, title, body, created_at, urgent, read, message_id, resolved) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET "
        "  chat_id = excluded.chat_id, kind = excluded.kind, title = excluded.title, "
        "  body = excluded.body, urgent = excluded.urgent, "
        "  read = MAX(activity_items.read, excluded.read), "
        "  message_id = excluded.message_id, "
        "  resolved = COALESCE(activity_items.resolved, excluded.resolved)",
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


def mark_activity_seen(db, *, chat_id: Optional[str] = None, all_items: bool = False,
                       exclude_open_approvals: bool = False) -> Dict[str, Any]:
    """Mark activity items read. ``exclude_open_approvals=True`` is for
    IMPLICIT seen paths (opening a chat via /v1/unread/seen): approval
    items with resolved IS NULL are blocking workflow events and must
    never be auto-read as a side effect — only an explicit pane action
    (default, exclude_open_approvals=False) may read them."""
    guard = " AND NOT (kind = 'approval' AND resolved IS NULL)" if exclude_open_approvals else ""
    if all_items:
        cur = db.exec(f"UPDATE activity_items SET read = 1 WHERE read = 0{guard}")
    elif chat_id:
        cur = db.exec(
            f"UPDATE activity_items SET read = 1 WHERE chat_id = ? AND read = 0{guard}",
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
# have a parley.db twin get inserted with `legacy:<state_id>` keys.
# Runs at items-endpoint enter time, before the read, so the response
# always reflects the union.
#
# Pagination cursor: parley.db.msg_links's implicit `rowid`. SQLite
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
            "SELECT rowid AS rowid, id AS parley_id, role, content, kind, "
            "       tool_name, tool_call_id, tool_calls, agent_row_id, created_at, status "
            "FROM msg_links WHERE chat_id = ? "
            "ORDER BY created_at ASC, rowid ASC"
        )
        params: tuple = (chat_id,)
    else:
        # `before_rowid` is actually a millis cursor; convert back.
        cursor_ts = before_rowid / 1000.0
        sql = (
            "SELECT rowid AS rowid, id AS parley_id, role, content, kind, "
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
            "parley_id": r["parley_id"],
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


# State.db rowids stay small (~10^5 after a year); envelope-only rows are
# keyed by created_at epoch-millis (~1.8e12). Anything at/above this
# threshold is an envelope-space cursor.
_ENVELOPE_CURSOR_THRESHOLD = 10**11


# Compaction machinery rows hermes-core writes into the transcript.
# ``[CONTEXT COMPACTION`` is the child-session seed marker; ``[PRIOR
# CONTEXT —`` is the compressor's merged-summary header
# (agent/context_compressor.py _MERGED_PRIOR_CONTEXT_HEADER), which
# lands in the SAME session when a post-compaction turn-end flush
# re-persists the rebuilt context (field 2026-07-15). Neither is a real
# message; both are dropped from reads and reconcile.
_COMPACTION_SEED_PREFIXES = ("[CONTEXT COMPACTION", "[PRIOR CONTEXT —")


def _is_compaction_seed(content) -> bool:
    text = content or ""
    return any(text.startswith(p) for p in _COMPACTION_SEED_PREFIXES)


# Max |timestamp − flush-anchor timestamp| for a relaxed-identity match
# to count as a PROVABLE replay duplicate (droppable from reads). The
# flush stamps every re-persisted row with one captured time — both
# field batches (2026-07-15 ts 1784148228.04, 2026-07-16 ts
# 1784208910.7255x) spread <1ms across 60-129 rows — so 2s is generous
# slack without letting an unrelated same-content repeat (which lands
# minutes-to-days later) match.
_REPLAY_FLUSH_ANCHOR_EPS_S = 2.0


def _classify_replay_duplicate_state_ids(state_rows) -> tuple:
    """Identify state.db rows that are compaction-replay duplicates of
    an earlier row in the same session walk.

    hermes-core's context compressor rebuilds the in-memory transcript
    and strips the ``_db_persisted`` markers; the next turn-end flush
    then re-appends the ENTIRE rebuilt context to the SAME session
    (field 2026-07-15, session 20260715_190037: rows 74423-74555 were
    re-persisted copies of 74380-74422 plus summarized copies of
    compacted-away turns, flushed in one batch). Reconcile must treat
    those rows as already-present — linking to them or minting
    ``legacy:`` twins for them re-materializes messages the user
    already has (duplicate bubbles) and feeds the order-fallback
    linker bogus candidates (cross-assigned umsg ids).

    A row is a duplicate when an EARLIER row (lower id — ``state_rows``
    arrives ORDER BY id ASC) matches its logical identity:

      * tool rows: same ``tool_call_id`` — unique per call by
        construction, so this also catches summarized replays whose
        content was rewritten by the compressor;
      * other rows: same ``(role, content, timestamp)`` exactly (replay
        copies of user rows keep their original timestamps), OR same
        ``(role, content, tool_calls)`` when content or tool_calls is
        non-empty — replay copies of assistant rows get re-stamped
        with the flush time, so identity can't rely on the timestamp.

    Returns ``(dup_ids, provable_dup_ids)`` — both sets of stringified
    state.db row ids, ``provable_dup_ids ⊆ dup_ids``:

      * ``dup_ids`` is the AGGRESSIVE set reconcile uses for linking
        decisions (no order-fallback target, no Pass 2 legacy insert).
        Trade-off: a user/assistant legitimately repeating the exact
        same non-empty text later in a session dedupes against the
        first occurrence here, so the repeat gets no msg_links twin.
        That costs only the parley_id annotation on the v2 read path
        (the state.db row itself still surfaces) — strictly better
        than the failure mode this guards against.

      * ``provable_dup_ids`` is the strictly narrower set the READ
        path may DROP (field 2026-07-16: the items API served both
        copies of every duplicated message until cleaned). Hiding a
        legitimate repeat from the transcript is a worse failure than
        an unlinked annotation, so a relaxed (timestamp-blind) match
        only counts as provable when the row is ANCHORED to a
        compaction flush — its timestamp within
        ``_REPLAY_FLUSH_ANCHOR_EPS_S`` of a machinery-seed row's
        (``[PRIOR CONTEXT``/``[CONTEXT COMPACTION`` rows are stamped
        with the flush time and are structural to every replay batch:
        the rebuilt context always contains its compaction seed).
        Tool-call-id and strict (timestamp-included) matches are
        provable unconditionally: tool_call_ids are unique per call by
        construction, and two genuinely distinct messages never share
        an identical float timestamp AND content.

    Machinery-seed rows in ``state_rows`` are used only as flush-time
    anchors — they're never marked and never contribute identity keys
    (both callers filter them out of everything separately).
    """
    anchor_ts = [
        float(r["timestamp"])
        for r in state_rows
        if r["timestamp"] is not None and _is_compaction_seed(r["content"])
    ]

    def _near_flush_anchor(ts) -> bool:
        if ts is None:
            return False
        ts = float(ts)
        return any(abs(ts - a) <= _REPLAY_FLUSH_ANCHOR_EPS_S for a in anchor_ts)

    seen_tool_call_ids: set = set()
    seen_strict: set = set()
    seen_relaxed: set = set()
    dup_ids: set = set()
    provable_dup_ids: set = set()
    for r in state_rows:
        content = r["content"] or ""
        if _is_compaction_seed(content):
            continue
        role = r["role"]
        tool_call_id = r["tool_call_id"] or ""
        tool_calls = (r["tool_calls"] if "tool_calls" in r.keys() else None) or ""
        if role == "tool" and tool_call_id:
            if tool_call_id in seen_tool_call_ids:
                dup_ids.add(str(r["id"]))
                provable_dup_ids.add(str(r["id"]))
            else:
                seen_tool_call_ids.add(tool_call_id)
            continue
        strict_key = (role, content, r["timestamp"], tool_calls)
        relaxed_key = (role, content, tool_calls)
        has_identity = bool(content.strip()) or bool(tool_calls)
        if strict_key in seen_strict:
            dup_ids.add(str(r["id"]))
            provable_dup_ids.add(str(r["id"]))
            continue
        if has_identity and relaxed_key in seen_relaxed:
            dup_ids.add(str(r["id"]))
            if _near_flush_anchor(r["timestamp"]):
                provable_dup_ids.add(str(r["id"]))
            continue
        seen_strict.add(strict_key)
        if has_identity:
            seen_relaxed.add(relaxed_key)
    return dup_ids, provable_dup_ids


def _find_replay_duplicate_state_ids(state_rows) -> set:
    """Aggressive (linking-side) replay-duplicate set — see
    ``_classify_replay_duplicate_state_ids``."""
    return _classify_replay_duplicate_state_ids(state_rows)[0]


def _order_fallback_content_compatible(env_content, state_content) -> bool:
    """True when an order-fallback pairing between an envelope row and
    a state.db row is plausible for the SAME logical message.

    Order-fallback (Pass 1.b) exists for three documented drift shapes:
    whitespace drift, small hermes-side post-edits, and the
    empty-final-reply path. It must never pair two unrelated messages —
    the field incident (2026-07-15) had it zip slash-command envelopes
    (``/start``…) onto replayed transcript rows (``did this turn
    die?``…), permanently attaching umsg ids to the wrong content.
    Linking correctly matters less than not mis-linking: an unlinked
    envelope row surfaces fine; a cross-linked one corrupts identity.
    """
    a = (env_content or "").strip()
    b = (state_content or "").strip()
    if not b:
        # Empty STATE content matches ONLY an empty/whitespace envelope.
        # Ephemeral gateway status bubbles ("⏳ Working — 3 min…",
        # "💾 Self-improvement review", "📦 Pre-API compression") have
        # no state twin; letting them match empty state rows zipped
        # durable ids onto orchestration rows (v3 soak forensics
        # 2026-07: the 31-case RECONCILE mislink class — every true
        # divergence in the 3-day window).
        return not a
    if not a:
        # Empty ENVELOPE, non-empty state: the empty-final-reply path
        # (reply_final with no text while state holds the flushed
        # body) — deliberately kept permissive, pinned by
        # test_order_fallback_still_links_under_benign_drift.
        return True
    if a == b:
        return True
    na = " ".join(a.split())
    nb = " ".join(b.split())
    if na == nb:
        return True  # pure whitespace drift.
    shorter, longer = (na, nb) if len(na) <= len(nb) else (nb, na)
    if longer.startswith(shorter):
        return True  # truncation / trailing-punctuation drift.
    import difflib
    return difflib.SequenceMatcher(None, na[:2000], nb[:2000]).ratio() >= 0.7


def _resolve_cursor_sort_key(state_db_path, cursor_id):
    """Resolve a pagination cursor to its ``(created_at, id)`` sort tuple.

    Items carry ids from TWO spaces: state.db rowids (small ints) and
    envelope-only rows keyed by ``int(created_at * 1000)`` (epoch
    millis). A raw ``id >/< cursor`` compare across the spaces is
    meaningless — an epoch cursor excludes every state.db row forever
    (field bug 2026-07-04: a delta cursor that landed on an envelope-only
    tail row made every durable row invisible to the PWA until reconcile
    healed the link — the agent's long reply "vanished"). Cursors must be
    compared in the merged sort-key space ``(created_at, id)`` — the
    exact key ``_build_chronological_items`` sorts by.

    Epoch-shaped cursors are timestamps by construction. State-shaped
    cursors need a one-row indexed ts lookup. Returns ``None`` when the
    cursor row is gone (deleted / compacted away) — callers fall back to
    the legacy raw-id compare, which is correct for pure-durable pages.
    """
    import contextlib
    import sqlite3

    if cursor_id is None:
        return None
    cursor_id = int(cursor_id)
    if cursor_id >= _ENVELOPE_CURSOR_THRESHOLD:
        return (cursor_id // 1000, cursor_id)
    if state_db_path is None or not state_db_path.exists():
        return None
    try:
        with contextlib.closing(
            sqlite3.connect(f"file:{state_db_path}?mode=ro", uri=True, timeout=2.0)
        ) as conn:
            row = conn.execute(
                "SELECT timestamp FROM messages WHERE id = ?", (cursor_id,)
            ).fetchone()
    except Exception:
        return None
    if not row or row[0] is None:
        return None
    return (int(row[0]), cursor_id)


def list_messages_for_chat_with_state_db_source(
    parley_db,
    state_db_path,
    chat_id: str,
    source: str,
    *,
    limit: int = 200,
    before_id: Optional[int] = None,
) -> Dict[str, Any]:
    """B2 read path: state.db is the canonical message body store;
    parley.db.msg_links surfaces parley_id + kind as annotations.

    Replaces the dual-body model that v1 (``list_messages_for_chat``)
    implements. With v1, parley.db.msg_links stored a full copy of
    every message body, and reconcile failures could leave the same
    logical message stored twice — once via envelope write-through,
    once via state.db backfill — surfaced to the PWA as duplicate
    bubbles.

    With v2, the items endpoint reads state.db.messages (the canonical
    server-side store) and joins parley.db.msg_links *as a side
    table* keyed by ``agent_row_id``. Parley-id linkage + push/pin
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
    cursor_key = _resolve_cursor_sort_key(state_db_path, before_id)
    items = _build_chronological_items(
        parley_db, state_db_path, chat_id, source,
        direction="older", cursor_id=before_id,
        cursor_ts=(cursor_key[0] if cursor_key else None),
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
        if cursor_key is not None:
            # Sort-key-space compare — see _resolve_cursor_sort_key. A raw
            # id compare across the two id spaces let every durable row
            # (including NEWER ones) pass `< epoch-cursor`.
            items = [
                it for it in items if (it["created_at"], it["id"]) < cursor_key
            ]
        else:
            items = [it for it in items if it["id"] < before_id]
    if len(items) > limit:
        items = items[-limit:]
        has_more = True
    else:
        has_more = False
    first_id = items[0]["id"] if items else None

    return {"items": items, "first_id": first_id, "has_more": has_more}


def list_messages_around_for_chat_with_state_db_source(
    parley_db,
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
    *centered* on ``target`` (matched by parley_id or by the integer
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
        parley_db, state_db_path, chat_id, source
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
        if str(it.get("parley_id") or "") == target_str or str(it["id"]) == target_str:
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
    parley_db,
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
    cursor_key = _resolve_cursor_sort_key(state_db_path, after_id)
    items = _build_chronological_items(
        parley_db, state_db_path, chat_id, source,
        direction="newer", cursor_id=after_id,
        cursor_ts=(cursor_key[0] if cursor_key else None),
        fetch_limit=limit + ITEMS_FETCH_ELISION_MARGIN + 1,
    )
    if cursor_key is not None:
        # Sort-key-space compare — see _resolve_cursor_sort_key. A raw id
        # compare made an epoch (envelope-row) cursor exclude EVERY durable
        # row forever: new turns never reached the PWA and its tail-merge
        # dropped the rows it did have (2026-07-04 vanishing-reply bug).
        items = [it for it in items if (it["created_at"], it["id"]) > cursor_key]
    else:
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
    parley_db,
    state_db_path,
    chat_id: str,
    source: str,
    *,
    direction: Optional[str] = None,
    cursor_id: Optional[int] = None,
    cursor_ts: Optional[int] = None,
    fetch_limit: Optional[int] = None,
) -> list:
    """Build a chronological item list for a chat from state.db (canonical
    bodies) merged with parley.db.msg_links (parley_id + kind
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
    # When the caller resolved the cursor's (created_at, id) sort key
    # (see _resolve_cursor_sort_key), bound the SQL window by TIMESTAMP
    # with an id tie-break instead of by raw id: raw-id bounds are
    # meaningless against an envelope-space (epoch-millis) cursor, and
    # the id tie-break keeps a turn-end batch (many rows sharing one
    # timestamp) paging forward instead of stalling. The float-second
    # slack in the ts branch makes the SQL window a small SUPERSET of
    # the caller's exact (created_at, id) tuple filter — int-truncated
    # created_at vs float m.timestamp can disagree by <1s.
    if fetch_limit is None:
        # Full transcript (around-target reader). Callers slice in Python
        # so they share one identical chronological view.
        sql = cte + select_cols + " ORDER BY m.timestamp ASC, m.id ASC"
    elif direction == "newer":
        sql = cte + select_cols
        if cursor_ts is not None:
            sql += " WHERE (m.timestamp > ?) OR (m.timestamp > ? - 1.0 AND m.id > ?)"
            params.extend([cursor_ts, cursor_ts, cursor_id if cursor_id is not None else 0])
        elif cursor_id is not None:
            sql += " WHERE m.id > ?"
            params.append(cursor_id)
        sql += " ORDER BY m.timestamp ASC, m.id ASC LIMIT ?"
        params.append(fetch_limit)
    else:  # 'older' (tail / before-cursor)
        sql = cte + select_cols
        if cursor_ts is not None:
            sql += " WHERE (m.timestamp < ?) OR (m.timestamp < ? + 1.0 AND m.id < ?)"
            params.extend([cursor_ts, cursor_ts, cursor_id if cursor_id is not None else 0])
        elif cursor_id is not None:
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
    # ``_items_by_user_id`` in parley_route_items.py for the full
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
        if not _is_compaction_seed(r["content"])
        and not (
            (drop_through := compaction_head_end_per_session.get(r["session_id"])) is not None
            and r["id"] <= drop_through
        )
    ]

    # Drop compaction-replay duplicate rows (hermes-core's post-
    # compaction turn-end flush re-appends the whole rebuilt context
    # into the SAME session — field 2026-07-16, session
    # 20260715_133109: the items API served both copies of every
    # duplicated message). Two complementary sources, same elision
    # mechanics as the machinery filter above (callers slice AFTER
    # this, and the fetch over-fetches by ITEMS_FETCH_ELISION_MARGIN,
    # so has_more/first_id contracts hold):
    #   1. `replay_dups` — the provable set reconcile persisted from
    #      its whole-session walk. Needed because a duplicate's
    #      ORIGINAL row often falls OUTSIDE the bounded window fetched
    #      here (re-deriving it would mean re-fetching the session's
    #      full content on every read: ~680ms on the largest live
    #      chat, vs one indexed parley.db lookup).
    #   2. An in-window classification pass over the rows already in
    #      hand (~0.3ms at window size) — closes the freshness gap for
    #      damage newer than the last reconcile when both copies (and
    #      the flush's machinery anchor) sit inside the window, which
    #      is exactly the tail-read-right-after-the-flush case.
    # Only PROVABLE duplicates are dropped — see
    # _classify_replay_duplicate_state_ids; legitimately repeated
    # identical messages keep serving.
    replay_drop_ids: set = set()
    try:
        dup_rows = parley_db.fetchall(
            "SELECT agent_row_id FROM replay_dups WHERE chat_id = ?",
            (chat_id,),
        )
        replay_drop_ids = {str(r["agent_row_id"]) for r in dup_rows}
    except Exception:
        pass  # parley.db unavailable — in-window pass still applies.
    replay_drop_ids |= _classify_replay_duplicate_state_ids(
        sorted(rows, key=lambda r: r["id"])
    )[1]
    if replay_drop_ids:
        surviving = [
            r for r in surviving if str(r["id"]) not in replay_drop_ids
        ]

    # Fetch parley.db.msg_links rows for these state.db ids in one
    # query, then merge in Python. This is the "JOIN" that gives the
    # PWA its parley_id / kind annotations without the dual-body
    # consistency problem v1 had.
    state_ids = [str(r["id"]) for r in surviving]
    link_by_state_id: Dict[str, Dict[str, Any]] = {}
    if state_ids:
        placeholders = ",".join("?" * len(state_ids))
        try:
            link_rows = parley_db.fetchall(
                f"SELECT id AS parley_id, agent_row_id, kind "
                f"FROM msg_links "
                f"WHERE chat_id = ? AND agent_row_id IN ({placeholders})",
                (chat_id, *state_ids),
            )
            for lr in link_rows:
                agent_row_id = lr["agent_row_id"]
                if agent_row_id:
                    link_by_state_id[str(agent_row_id)] = dict(lr)
        except Exception:
            # parley.db unavailable — fall through with empty
            # link map. State.db rows still surface; they just won't
            # carry parley_id annotations.
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
            item["parley_id"] = link["parley_id"]
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
    # write-through) lands rows on parley.db at SSE-emit time, often
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
    # parley_id (msg_xxx/umsg_xxx/notif_xxx/tc:*/tr:*) drives the PWA
    # bubble's data-key.
    try:
        unlinked = parley_db.fetchall(
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
            "parley_id": r["id"],
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


# ── Transcript v3 read path (Phase 3, PARLEY_ITEMS_V3) ──────────────
#
# parley.db owns bodies + identity; state.db is consulted ONLY through
# msg_links.agent_row_id, as a liveness oracle (v3 design core moves
# 2/3/6). Serving rule, per msg_links row of the chat:
#
#   * linked (agent_row_id set): serve iff the state row still exists
#     and was not user-retracted. hermes-core's mutations map to:
#       - /retry, explicit delete, prune → rows DELETEd → the link
#         orphans → retracted. The rewrite turn's rows arrive via fresh
#         links (relink-forward, decision memo 2026-07-28 — no content
#         re-adoption, ever).
#       - /undo → soft-delete: active=0 AND compacted=0 → retracted.
#       - in-place compaction → active=0 AND compacted=1 on the archived
#         ORIGINALS (hermes_state.archive_and_compact) — those are the
#         user's real scrollback and keep serving; the re-flushed copies
#         have no envelope → no link → invisible by construction.
#     Additionally hidden, for exact v2-read parity: provable replay
#     duplicates (the persisted replay_dups set) and compaction-child
#     seed-block rows (id <= the child session's [CONTEXT COMPACTION]
#     marker — the one v2 elision a linked row can still fall in).
#   * unlinked (agent_row_id NULL): serve iff status='final' — the
#     envelope-only set (slash-command replies, gateway status bubbles,
#     rows in the envelope→flush window, notifications pre-link).
#     Streaming rows (tc:* call-args, an aborted reply_delta) never
#     serve; the in-flight turn overlays via the TurnBuffer at the
#     route, exactly as on the legacy read.
#   * unlinked STATE rows are never served — invisible by construction.
#     Failure direction is invisibility + alert, never invention
#     (decision memo 2026-07-28, decision 3).
#
# Ordering: parley.db's own FROZEN per-row key (created_at, rowid) —
# both columns are write-once in msg_links (upsert never touches
# created_at), so nothing hermes-core does after import can reorder
# served items; the 07-16 class (state.db re-stamps reordering the
# transcript at read time) is dead because state.db timestamps are
# never consulted. Raw rowid alone is NOT usable as the sequence:
# reconcile mints rows LATE relative to message time — the whole legacy
# backfill of a pre-write-through chat (live chat ae6435b5: 518 rows
# displaced past later turns) and every turn's orchestration legacy
# twin (minted at the post-turn reconcile, after the turn's envelope
# rows) — which would scramble transcripts and break the PWA's
# activity-row fold (tool args attach only when the orchestration row
# precedes its tool results). Same trap v1 documented in
# list_messages_for_chat.
#
# Wire shape is byte-identical to the v2 reader for a healthy migrated
# chat (pinned by test_items_v3_read_path): linked rows serve
# id=int(agent_row_id), envelope-only rows id=int(created_at*1000);
# same field insertion order. The PWA is untouched.

# IN-clause chunk for the liveness batch — comfortably under every
# SQLITE_MAX_VARIABLE_NUMBER build default.
_V3_LIVENESS_CHUNK = 500


def _fetch_v3_liveness(state_db_path, linked_ids):
    """Liveness snapshot for the linked state ids, in one read-only
    batch (chunked IN queries over the messages PK — no per-row
    queries, per the ~20ms read budget).

    Returns ``(live, head_end)`` where ``live`` maps state-id-string →
    ``{active, compacted, session_id, is_child}`` (absent key = row
    deleted) and ``head_end`` maps compaction-child session_id → the
    max [CONTEXT COMPACTION] marker id (the v2 seed-block elision
    bound). Returns ``None`` when state.db is unreachable — callers
    serve NOTHING rather than guess: a transient hiccup must not
    resurrect retracted rows (and the legacy reader's unreachable
    contract is the same empty read).

    ``is_child`` uses (user_id IS NULL AND parent_session_id IS NOT
    NULL) instead of the recursive chain walk: linked rows belong to
    the chat's chain by construction (reconcile only ever links chain
    rows), so chain membership needs no re-proof here."""
    import contextlib
    import sqlite3

    if state_db_path is None or not state_db_path.exists():
        return None
    live: Dict[str, Dict[str, Any]] = {}
    child_sessions: set = set()
    head_end: Dict[str, int] = {}
    # Dedupe (a pre-heal mislink can double-claim one state id) while
    # keeping non-numeric ids out of the PK batch — a non-numeric link
    # simply never resolves live and stays hidden.
    ids = list(dict.fromkeys(i for i in linked_ids if str(i).isdigit()))
    try:
        uri = f"file:{state_db_path}?mode=ro"
        with contextlib.closing(
            sqlite3.connect(uri, uri=True, timeout=2.0)
        ) as conn:
            conn.row_factory = sqlite3.Row
            for start in range(0, len(ids), _V3_LIVENESS_CHUNK):
                chunk = ids[start:start + _V3_LIVENESS_CHUNK]
                placeholders = ",".join("?" * len(chunk))
                base = (
                    "SELECT m.id, m.session_id, {cols} "
                    "(s.user_id IS NULL AND s.parent_session_id IS NOT NULL) "
                    "AS is_child "
                    "FROM messages m JOIN sessions s ON s.id = m.session_id "
                    "WHERE m.id IN (" + placeholders + ")"
                )
                try:
                    got = conn.execute(
                        base.format(cols="m.active, m.compacted,"), chunk,
                    ).fetchall()
                except sqlite3.OperationalError:
                    # Pre-0.18 schema without active/compacted (old
                    # fixtures): every existing row counts as live.
                    got = conn.execute(
                        base.format(cols="1 AS active, 0 AS compacted,"),
                        chunk,
                    ).fetchall()
                for r in got:
                    live[str(r["id"])] = {
                        "active": bool(r["active"]),
                        "compacted": bool(r["compacted"]),
                        "session_id": r["session_id"],
                        "is_child": bool(r["is_child"]),
                    }
                    if r["is_child"]:
                        child_sessions.add(r["session_id"])
            if child_sessions:
                placeholders = ",".join("?" * len(child_sessions))
                agg = conn.execute(
                    "SELECT session_id, MAX(id) AS head_end FROM messages "
                    f"WHERE session_id IN ({placeholders}) "
                    "AND content LIKE '[CONTEXT COMPACTION%' "
                    "GROUP BY session_id",
                    sorted(child_sessions),
                ).fetchall()
                head_end = {
                    a["session_id"]: int(a["head_end"])
                    for a in agg if a["head_end"] is not None
                }
    except Exception:
        return None
    return live, head_end


def _build_v3_items(parley_db, state_db_path, chat_id: str) -> tuple:
    """Serve-list build for one chat on the v3 rule (see the block
    comment above). Returns ``(items, cursor_index)``:

      * ``items`` — full chronological wire-shape list; callers slice
        (same division of labor as ``_build_chronological_items``).
      * ``cursor_index`` — served id → list position, ALSO keyed by
        each row's envelope-space alias ``int(created_at*1000)``. A
        client cursor minted while a row was envelope-only keeps
        resolving after reconcile links it (its served id changes to
        the state id — the raw-compare form of the 2026-07-04
        vanishing-reply bug otherwise returns in v3 dress).
    """
    try:
        rows = parley_db.fetchall(
            "SELECT id AS parley_id, role, content, kind, "
            "       tool_name, tool_call_id, tool_calls, created_at, "
            "       status, agent_row_id "
            "FROM msg_links WHERE chat_id = ? "
            "ORDER BY created_at ASC, rowid ASC",
            (chat_id,),
        )
    except Exception:
        return [], {}

    linked_ids = [
        str(r["agent_row_id"]) for r in rows if r["agent_row_id"] is not None
    ]
    live: Dict[str, Dict[str, Any]] = {}
    head_end: Dict[str, int] = {}
    if linked_ids:
        snapshot = _fetch_v3_liveness(state_db_path, linked_ids)
        if snapshot is None:
            return [], {}
        live, head_end = snapshot

    replay_drop: set = set()
    try:
        dup_rows = parley_db.fetchall(
            "SELECT agent_row_id FROM replay_dups WHERE chat_id = ?",
            (chat_id,),
        )
        replay_drop = {str(r["agent_row_id"]) for r in dup_rows}
    except Exception:
        pass

    items: list = []
    cursor_index: Dict[int, int] = {}
    for r in rows:
        content = r["content"] or ""
        # Machinery bodies never serve regardless of linkage (a pre-
        # filter-era legacy import could carry one).
        if _is_compaction_seed(content):
            continue
        ts = float(r["created_at"]) if r["created_at"] is not None else 0.0
        arid = r["agent_row_id"]
        if arid is None:
            if (r["status"] or "") != "final":
                continue
            item_id = int(ts * 1000) if ts else 0
        else:
            arid_s = str(arid)
            st = live.get(arid_s)
            if st is None:
                continue  # state row gone → retracted (/retry, prune, delete).
            if not st["active"] and not st["compacted"]:
                continue  # /undo soft-delete → retracted.
            if arid_s in replay_drop:
                continue  # provable compaction-replay copy (v2 parity).
            bound = head_end.get(st["session_id"]) if st["is_child"] else None
            if bound is not None and int(arid_s) <= bound:
                continue  # compaction-child seed block (v2 parity).
            item_id = int(arid_s)
        item: Dict[str, Any] = {
            "id": item_id,
            "object": "message",
            "role": r["role"],
            "content": content,
            "created_at": int(ts) if ts else 0,
            "parley_id": r["parley_id"],
        }
        if r["kind"]:
            item["kind"] = r["kind"]
        if r["tool_name"]:
            item["tool_name"] = r["tool_name"]
        if r["tool_call_id"]:
            item["tool_call_id"] = r["tool_call_id"]
        if r["tool_calls"]:
            item["tool_calls"] = r["tool_calls"]
        pos = len(items)
        cursor_index.setdefault(item_id, pos)
        alias = int(ts * 1000) if ts else 0
        cursor_index.setdefault(alias, pos)
        items.append(item)
    return items, cursor_index


def _v3_cursor_pos(cursor_index: Dict[int, int], cursor) -> Optional[int]:
    try:
        return cursor_index.get(int(cursor))
    except (TypeError, ValueError):
        return None


def list_messages_for_chat_v3(
    parley_db,
    state_db_path,
    chat_id: str,
    *,
    limit: int = 200,
    before_id: Optional[int] = None,
) -> Dict[str, Any]:
    """v3 tail / before-cursor read. Same wire contract as the v2
    reader (``{items, first_id, has_more}``, tail-side slicing so a
    before-page returns the ``limit`` items nearest the cursor)."""
    items, index = _build_v3_items(parley_db, state_db_path, chat_id)
    if before_id is not None:
        pos = _v3_cursor_pos(index, before_id)
        if pos is not None:
            items = items[:pos]
        else:
            # Cursor row retracted between pages — raw id-space compare
            # (correct for durable cursors; the epoch alias above covers
            # the linked-transition case, so this is the residual v2
            # fallback only).
            items = [it for it in items if it["id"] < before_id]
    if len(items) > limit:
        items = items[-limit:]
        has_more = True
    else:
        has_more = False
    return {
        "items": items,
        "first_id": items[0]["id"] if items else None,
        "has_more": has_more,
    }


def list_messages_around_for_chat_v3(
    parley_db,
    state_db_path,
    chat_id: str,
    *,
    target: str,
    limit: int = 200,
    context_before: Optional[int] = None,
    context_after: Optional[int] = None,
) -> Dict[str, Any]:
    """v3 deep-target drill — same bounded-window semantics and budget
    split as ``list_messages_around_for_chat_with_state_db_source``."""
    items, _index = _build_v3_items(parley_db, state_db_path, chat_id)
    empty = {
        "items": [], "first_id": None, "has_more": False,
        "last_id": None, "has_more_newer": False, "target_found": False,
    }
    if not items:
        return dict(empty)
    target_str = str(target)
    idx = None
    for i, it in enumerate(items):
        if str(it.get("parley_id") or "") == target_str or str(it["id"]) == target_str:
            idx = i
            break
    if idx is None:
        return dict(empty)
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


def list_messages_after_for_chat_v3(
    parley_db,
    state_db_path,
    chat_id: str,
    *,
    after_id: int,
    limit: int = 200,
) -> Dict[str, Any]:
    """v3 load-newer read — same contract as the v2 after-cursor reader
    (``has_more`` always present and False; oldest ``limit`` items above
    the cursor so the prepend side stays contiguous)."""
    items, index = _build_v3_items(parley_db, state_db_path, chat_id)
    pos = _v3_cursor_pos(index, after_id)
    if pos is not None:
        items = items[pos + 1:]
    else:
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


def _legacy_row_get(row, key, default=None):
    """Field access for sqlite3.Row AND plain dicts, tolerating absent
    columns (the linker's window rows don't select tool_name)."""
    try:
        if key in row.keys():
            return row[key]
    except AttributeError:
        pass
    return default


def insert_legacy_twin(db, chat_id: str, row) -> bool:
    """Insert the ``legacy:<state_id>`` msg_links twin for ONE state.db
    row — THE single legacy-import representation. Reconcile's Pass 2,
    the Phase-2 backfill (via reconcile), the Phase-4 linker's
    orchestration mint, and the Phase-5 orphan-adopt all share this
    shape so there is exactly one importer to reason about.

    INSERT OR IGNORE keyed on the legacy id — idempotent by
    construction. Returns True when a new row was actually written
    (rowcount > 0), False when the twin already existed. sqlite errors
    propagate; callers own their best-effort policy.
    """
    state_id = str(_legacy_row_get(row, "id"))
    ts_raw = _legacy_row_get(row, "timestamp")
    ts = float(ts_raw) if ts_raw is not None else time.time()
    cur = db.exec(
        "INSERT OR IGNORE INTO msg_links "
        "(id, chat_id, role, content, kind, tool_name, tool_call_id, "
        " tool_calls, created_at, updated_at, status, agent_row_id) "
        "VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'final', ?)",
        (
            f"legacy:{state_id}", chat_id,
            _legacy_row_get(row, "role") or "",
            _legacy_row_get(row, "content") or "",
            _legacy_row_get(row, "tool_name"),
            _legacy_row_get(row, "tool_call_id"),
            _legacy_row_get(row, "tool_calls"),
            ts, ts, state_id,
        ),
    )
    return bool(cur.rowcount and cur.rowcount > 0)


def reconcile_from_state_db(
    db, state_db_path, chat_id: str, source: str = "parley",
    *, force_full: bool = False,
) -> int:
    """Bidirectional reconciliation between state.db and parley.db
    for one chat. Runs at items-endpoint enter and on session_changed.

    ⚠️  WARNING — DO NOT CALL FROM THE ASYNCIO LOOP THREAD.  ⚠️

    The full path is **O(state_rows + linked_rows)** per call: a full
    recursive-CTE walk of state.db.messages for the chat plus a Python
    set build over parley.db.msg_links plus multi-pass scans. For a
    5000-row chat the full pass takes ~700ms of GIL-held Python work.

    History: this function is one of TWO parley O(history)-per-chat
    callers (the other is parley_unread.compute_unread). Both used to
    leak onto the loop thread under load. The 2026-06-23 incident
    report:
      - compute_unread blocked the loop directly via handle_unread
        (fix: commit d10f62c — routed through run_in_parley_worker)
      - reconcile_from_state_db piled up via _spawn_background_reconcile
        firing N concurrent to_threads under the PWA drawer fan-out
        (fix: commits bbfd784 worker-pool cap + b62bd3d no-drift
        fast-path so the per-call cost on no-drift chats is O(few-ms)
        instead of O(history))

    The fast-path (see "Fast-path: skip the O(history) full-sync..."
    block below) keeps no-drift calls cheap. The full path remains
    O(history) — callers MUST wrap it in ``asyncio.to_thread`` /
    ``run_in_parley_worker`` if they're calling from a coroutine.
    Inline-await from an async def re-introduces the loop block.

    Three-pass operation:
      1. **Link pass (Phase 3)**: each unlinked parley.db row
         (agent_row_id IS NULL) finds a state.db row with matching
         role + content that hasn't been claimed yet. Earliest match
         wins; duplicates resolved in chronological order.
      2. **Insert pass**: state.db rows still without a parley.db
         twin get inserted as ``legacy:<state_id>`` (INSERT OR IGNORE).
      3. **Orphan-drop pass (Phase 4)**: parley.db rows with
         ``agent_row_id`` pointing at a state.db row that no longer
         exists (i.e. ``/retry``, ``/undo``, ``/compress`` rewrote
         the session; explicit delete dropped it; 90-day prune ran)
         get removed. Rows with NULL agent_row_id are NEVER dropped
         — they're either in-flight or pre-link, both legitimate.

    Pass 3 (self-heal): state.db is authoritative for whole-session
    mutations, so any
    parley.db row linked to a vanished state.db row is provably
    stale. The orphan check runs every reconcile (cheap O(N) set
    ops on already-fetched data) which means /retry-style mutations
    self-heal on the next PWA poll without a separate trigger.

    Returns count of (linked + inserted + dropped) rows changed.
    Best-effort: sqlite errors return 0 without raising; the items
    endpoint still returns whatever's in parley.db.

    SAFETY: if state.db is unreachable (file missing, locked), the
    function returns 0 *without dropping anything* — the early
    return on `not state_rows` covers this. Brand-new chats where
    state.db hasn't flushed yet keep their envelope-written rows
    intact because those rows have NULL agent_row_id (not orphan
    candidates).
    """
    import contextlib
    import sqlite3
    from . import parley_perf_trace as _perf  # noqa: WPS433
    _t_recon_start = time.monotonic()
    if state_db_path is None:
        return 0

    # ── Fast-path: skip the O(history) full-sync on no-drift chats. ──
    #
    # Reconcile is structurally O(state_rows + linked_rows) on EVERY
    # call (full recursive-CTE walk of state.db messages + Python set
    # build over parley.db msg_links + multi-pass scans). For
    # [pitch deck] with 5389 messages and zero drift, each call burned
    # ~700ms of GIL-held Python work producing zero updates. Under a
    # PWA drawer-prefetch burst (N chats fan-out) the cumulative
    # GIL pressure starved the asyncio loop (caught via
    # PARLEY_PERF_TRACE loop-lag watcher 2026-06-23).
    #
    # Fast-path: three cheap indexed checks. If state.db has no rows
    # newer than the highest agent_row_id we've already linked AND no
    # envelope rows are pending a link, there's nothing to do — return
    # immediately. Orphan-drop (Pass 3) is NOT performed on this path
    # — orphans only originate from /retry, /undo, /compress whole-
    # session rewrites + the 90-day prune. Callers that need orphan
    # cleanup (the periodic sweep, the unit-test suite) pass
    # ``force_full=True`` to bypass the fast-path. The /items route's
    # opportunistic per-read reconcile spawn does NOT need orphan
    # cleanup on every call — a separate periodic sweep handles it
    # at a lower cadence, which is well within v1 self-heal latency.
    if not force_full:
        try:
            # 1) Highest state.db id we've already linked for this chat.
            max_linked_row = db.fetchone(
                "SELECT MAX(CAST(agent_row_id AS INTEGER)) AS m FROM msg_links "
                "WHERE chat_id = ? AND agent_row_id IS NOT NULL",
                (chat_id,),
            )
            max_linked = (max_linked_row and max_linked_row["m"]) or 0
            # 2) state.db rows newer than the watermark? Guard on
            # max_linked>0 so a chat-with-no-linked-rows-yet falls through
            # to the full reconcile (to migrate / link initial rows).
            #
            # Note: we deliberately DON'T gate on `has_unlinked` (the
            # presence of envelope rows with NULL agent_row_id). Many
            # production chats carry persistently-unlinked legacy
            # envelopes that the linker has tried and failed to match
            # across many prior reconciles — gating on has_unlinked
            # means the fast-path NEVER engages for those chats, even
            # when state.db has no new work to do. The semantic is
            # safe: if state.db hasn't gained rows since our watermark,
            # the linker has no new candidates regardless of how many
            # unlinked envelopes exist. The next state.db growth event
            # (state_has_newer=True) trips the full pass and the
            # linker gets its chance.
            if max_linked > 0:
                uri = f"file:{state_db_path}?mode=ro"
                state_has_newer = True  # conservative default on error
                watermark_orphaned = True  # conservative default on error
                try:
                    with contextlib.closing(
                        sqlite3.connect(uri, uri=True, timeout=2.0)
                    ) as conn:
                        # Two cheap point queries: (a) anything newer
                        # than our watermark? (b) does the watermark row
                        # itself still exist? (b) catches the
                        # all-rows-deleted / partial-session-mutation
                        # orphan case where state.db lost rows but no
                        # new rows arrived to trip (a).
                        newer_row = conn.execute(
                            """
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
                            SELECT 1 FROM messages m
                            JOIN session_root sr ON m.session_id = sr.id
                            WHERE m.id > ?
                            LIMIT 1
                            """,
                            (chat_id, source, max_linked),
                        ).fetchone()
                        state_has_newer = newer_row is not None
                        # Watermark-row existence check: primary-key
                        # lookup on messages.id — O(log n). If our
                        # highest linked row vanished from state.db,
                        # orphans exist below it and we MUST do the
                        # full reconcile to drop them.
                        wm_row = conn.execute(
                            "SELECT 1 FROM messages WHERE id = ? LIMIT 1",
                            (max_linked,),
                        ).fetchone()
                        watermark_orphaned = wm_row is None
                except Exception:
                    # State.db unreachable → conservatively fall through
                    # to the full path. The full path's early-return on
                    # state-unreachable handles the failure mode without
                    # dropping anything.
                    pass
                if not state_has_newer and not watermark_orphaned:
                    _recon_wall_ms = (time.monotonic() - _t_recon_start) * 1000.0
                    if _perf._is_enabled() and _recon_wall_ms >= 5.0:
                        _perf.logger.info(
                            "[perf-trace] reconcile chat=%s source=%s wall=%.0fms "
                            "FAST-PATH no-drift (max_linked=%d)",
                            chat_id[:24], source, _recon_wall_ms, max_linked,
                        )
                    return 0
        except Exception:
            # Any parley.db error → fall through to the full reconcile.
            # Conservative: better to do the work than skip and lose linking.
            pass
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

    # Compaction-replay duplicates: rows hermes-core re-persisted into
    # the same session after an in-place compaction (see
    # _classify_replay_duplicate_state_ids). Classified on the RAW row
    # set — the machinery rows filtered just below are the flush-time
    # anchors the provable classification needs. The aggressive set is
    # NOT a link target for order-fallback and NOT a candidate for
    # Pass 2 legacy inserts — both would re-materialize messages that
    # already exist. The rows stay in `state_rows` for everything
    # else: Pass 1.a exact-content linking (harmless — same content
    # either way), Pass 3's live-row set (a link pointing at a replay
    # row must not be orphan-dropped while the row exists).
    replay_dup_ids, provable_replay_dup_ids = (
        _classify_replay_duplicate_state_ids(state_rows)
    )

    # Drop compaction machinery rows (the `[CONTEXT COMPACTION]` seed
    # marker + the compressor's `[PRIOR CONTEXT —]` merged-summary
    # header — never surfaced to the PWA).
    state_rows = [
        r for r in state_rows
        if not _is_compaction_seed(r["content"])
    ]

    # Persist the PROVABLE subset so the v2 read path can filter its
    # bounded window against it (field 2026-07-16: the read served
    # both copies of every duplicated message — the duplicate's
    # ORIGINAL often falls outside the window the read fetched, so the
    # read can't re-derive this set cheaply itself; reconcile already
    # walks the whole session chain). Full sync per chat: stale
    # entries (rows a cleanup deleted / rows no longer classified
    # provable) are removed so the set never outlives its evidence.
    # Best-effort — a parley.db hiccup must not fail the heal.
    try:
        existing_dup_rows = db.fetchall(
            "SELECT agent_row_id FROM replay_dups WHERE chat_id = ?",
            (chat_id,),
        )
        existing_dups = {str(r["agent_row_id"]) for r in existing_dup_rows}
        for sid in provable_replay_dup_ids - existing_dups:
            db.exec(
                "INSERT OR IGNORE INTO replay_dups "
                "(chat_id, agent_row_id, detected_at) VALUES (?, ?, ?)",
                (chat_id, sid, time.time()),
            )
        stale_dups = existing_dups - provable_replay_dup_ids
        if stale_dups:
            placeholders = ",".join("?" * len(stale_dups))
            db.exec(
                f"DELETE FROM replay_dups WHERE chat_id = ? "
                f"AND agent_row_id IN ({placeholders})",
                (chat_id, *sorted(stale_dups)),
            )
    except Exception:
        pass

    # Linked agent_row_ids already in parley.db.
    linked_rows = db.fetchall(
        "SELECT agent_row_id FROM msg_links WHERE chat_id = ? AND agent_row_id IS NOT NULL",
        (chat_id,),
    )
    claimed_state_ids = {str(r["agent_row_id"]) for r in linked_rows}

    # ── Pass 1: link unlinked parley.db rows.
    #
    # Two-pronged: (1.a) exact (role, content) fingerprint claims the
    # easy cases — same string both sides means same logical message.
    # (1.b) Order-fallback within (chat, role) for role in {user,
    # assistant}: walk remaining unlinked envelope rows and unclaimed
    # state.db rows in append-only order and pair 1:1.
    #
    # Why order-fallback is the right primitive: hermes' state.db
    # writes for a session are append-only in turn order; parley's
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
        "SELECT id, role, content, tool_call_id FROM msg_links "
        "WHERE chat_id = ? AND agent_row_id IS NULL "
        "ORDER BY created_at ASC, rowid ASC",
        (chat_id,),
    )
    links = 0
    if unlinked:
        # Pass 1.a — exact identity match. TOOL rows pair by exact
        # tool_call_id ONLY: a ``tr:<call_id>`` envelope links to the
        # state row carrying that call id, never by content — tool
        # CONTENT is not identity (field, v3 soak forensics: two
        # ``{"total_count": 0}`` results collided across different
        # call ids and the fingerprint crossed the links). Of the
        # rows carrying the call id, prefer the copy the read path
        # serves: the first occurrence (later same-call-id copies are
        # replay dups the v2 read drops). ``tc:<call_id>`` (call-args)
        # envelopes legitimately have NO state twin — state.db keeps
        # one tool row per call — and never link here. Everything
        # else pairs by exact (role, content) fingerprint.
        candidates: Dict[tuple, List[str]] = {}
        tool_by_call_id: Dict[str, List[str]] = {}
        for r in state_rows:
            sid = str(r["id"])
            if sid in claimed_state_ids:
                continue
            if r["role"] == "tool":
                cid = r["tool_call_id"] or ""
                if cid:
                    tool_by_call_id.setdefault(cid, []).append(sid)
                continue
            key = (r["role"], r["content"] or "")
            candidates.setdefault(key, []).append(sid)
        still_unlinked: List[Dict[str, Any]] = []
        for sk in unlinked:
            sk_id = str(sk["id"])
            if sk["role"] == "tool":
                # Tool envelopes never enter the fingerprint map or
                # order-fallback: tr: links by exact call id or not
                # at all; tc:/other shapes stay unlinked by design.
                if not sk_id.startswith("tr:"):
                    continue
                cid = (sk["tool_call_id"] or "") or sk_id[3:]
                queue = [
                    s for s in tool_by_call_id.get(cid, ())
                    if s not in claimed_state_ids
                ]
                preferred = [
                    s for s in queue if s not in replay_dup_ids
                ] or queue
                if not preferred:
                    continue
                state_id = preferred[0]
                try:
                    db.exec(
                        "UPDATE msg_links SET agent_row_id = ?, updated_at = ? "
                        "WHERE id = ?",
                        (state_id, time.time(), sk["id"]),
                    )
                    claimed_state_ids.add(state_id)
                    links += 1
                except Exception:
                    pass
                continue
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
        # above). Both append-only sequences, so per-role in-order
        # pairing matches them — but ONLY content-compatible pairs
        # link (see _order_fallback_content_compatible): an envelope
        # row with no plausible twin stays unlinked rather than being
        # zipped positionally onto unrelated text (field 2026-07-15:
        # slash-command envelopes cross-assigned onto compaction-replay
        # rows). A refused pairing does not consume the state row, so
        # a later envelope can still claim it; the scan pointer only
        # moves forward, preserving append-only order.
        #
        # Orchestration rows (non-empty tool_calls) are NEVER
        # candidates: they have no envelope twin by construction (the
        # linker treats them as msg_id=NULL machinery), and their
        # typically-empty content made them zip targets for ephemeral
        # gateway status bubbles — Pass 2.5 then healed tool_calls
        # onto the mislinked envelope row, corrupting durable identity
        # (v3 soak forensics 2026-07: the 31-case mislink class).
        for role_to_fallback in ("user", "assistant"):
            env_queue = [sk for sk in still_unlinked if sk["role"] == role_to_fallback]
            state_queue = [
                (str(r["id"]), r["content"] or "") for r in state_rows
                if r["role"] == role_to_fallback
                and str(r["id"]) not in claimed_state_ids
                and str(r["id"]) not in replay_dup_ids
                and not ((r["tool_calls"] if "tool_calls" in r.keys() else None) or "")
            ]
            next_idx = 0
            for sk in env_queue:
                match_idx = None
                for j in range(next_idx, len(state_queue)):
                    if _order_fallback_content_compatible(
                        sk["content"], state_queue[j][1]
                    ):
                        match_idx = j
                        break
                if match_idx is None:
                    continue  # link correctly or not at all.
                state_id = state_queue[match_idx][0]
                try:
                    db.exec(
                        "UPDATE msg_links SET agent_row_id = ?, updated_at = ? "
                        "WHERE id = ?",
                        (state_id, time.time(), sk["id"]),
                    )
                    claimed_state_ids.add(state_id)
                    links += 1
                    next_idx = match_idx + 1
                except Exception:
                    continue

    # ── Pass 2: insert state.db rows that still have no parley.db
    # twin. These are legacy chats from before Phase 1's write-through,
    # OR rows that drifted (parley.db write-path bug missed them).
    # Compaction-replay duplicates are skipped: their logical message
    # already exists (linked or about-to-be-inserted via its first
    # occurrence), so a legacy: twin here would double every replayed
    # bubble (field 2026-07-15: legacy:74535 duplicating msg_ab2a→74402).
    inserted = 0
    dup_skipped = 0
    for r in state_rows:
        state_id = str(r["id"])
        if state_id in claimed_state_ids:
            continue
        if state_id in replay_dup_ids:
            dup_skipped += 1
            continue
        # Shared legacy-import representation (insert_legacy_twin) —
        # state.db's tool_calls column rides along so the PWA
        # projection's parseToolCalls() can populate tool-row names +
        # args on reload; without it, reconciled chats render as
        # "(unknown)" + args="{}".
        try:
            insert_legacy_twin(db, chat_id, r)
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
    # parley.db rows with agent_row_id set but the state.db row gone
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
    if dropped or healed_tc or dup_skipped:
        # Log every heal event — write-path bugs and whole-session
        # mutations both surface here. Threshold for alerting is a
        # future concern; for now bake into a single warning line a
        # grep can find. dup_skipped>0 means hermes-core double-
        # persisted a compaction replay into the session (upstream
        # behavior the heal now tolerates instead of amplifying).
        import logging as _logging
        _logging.getLogger(__name__).warning(
            "[parley] heal chat=%s links=%d inserted=%d dropped=%d "
            "tc_healed=%d dup_skipped=%d",
            chat_id, links, inserted, dropped, healed_tc, dup_skipped,
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
# Phase 1 of the parley.db-as-message-store migration. Every outbound
# envelope routed through ``_safe_send_envelope`` is recorded here at
# emit time. Items endpoint still reads from state.db in Phase 1;
# Phase 2 switches the read path. See top-of-file design block in
# ``parley_db.py``.
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
    """Upsert parley.db row for one outbound envelope.

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
        row_id = env.get("parley_id") or env.get("message_id") or env.get("notif_id") \
            or f"notif_{int(now * 1000)}_{chat_id[:8]}"
        env["parley_id"] = row_id
        upsert_msg_link(
            db, id=row_id, chat_id=chat_id, role="assistant",
            content=env.get("content") or env.get("text") or "",
            status="final",
            kind=env.get("kind"),
            agent_row_id=env.get("agent_row_id"),
        )
        return row_id

    return None
