"""Badge ↔ notifications-pane unread consistency (field diagnosis
2026-07-20 against the live sidekick.db).

The dock badge derives from ``unread_state`` via ``compute_unread``
(chat-level truth); the notifications pane derives from
``activity_items.read`` (a second unread ontology). Three bugs let the
two disagree permanently:

BUG A — ghost chat: a chat with a ``msg_links`` row but no state.db
session (``sidekick:upgrade-probe-1783926444`` in the field) is counted
by ``compute_unread`` but never served by ``/v1/conversations`` — a
permanent, unclearable +1 on the dock badge.

BUG B — resurrection: the notification envelope path upserts an
activity item with ``created_at=time.time()`` and ``read=False``; the
upsert's ON CONFLICT clobbered ``read`` and ``resolved``. A gateway
restart replaying the notification path (a) reset read items to
unread, (b) wiped resolutions, (c) re-inserted PRUNED items at
created_at=now (field: 4 cron items with id mints spanning Jul 18-20
all re-inserted at the identical replay-batch timestamp, read=0).

BUG C — missing coupling: ``handle_unread_seen`` (fired when the user
opens a chat) updated ``unread_state`` but not ``activity_items`` —
pane items for a chat the user just read stayed unread server-side
unless a separate client call landed (field: 8 unread activity items
with created_at <= their chat's last_read_at).

Invariant across all fixes: approval-kind items with resolved IS NULL
are blocking workflow events and must NEVER be auto-read.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from ..sidekick_db import SidekickDB
from .. import sidekick_state as state
from ..sidekick_unread import _compute_unread_uncached


CHAT_ID = "c0a01ab1-bee2-4d5e-6f70-8090a0b0c0d0"
CHAT_PREFIXED = f"sidekick:{CHAT_ID}"
GHOST_CHAT = "upgrade-probe-1783926444"

# A 13-digit epoch-ms mint like the plugin embeds in notif_* ids.
MINT_MS = 1_752_000_000_000
MINT_S = MINT_MS / 1000.0


@pytest.fixture
def db(tmp_path):
    db = SidekickDB(tmp_path / "sidekick.db")
    yield db
    db.close()


@pytest.fixture
def state_db(tmp_path):
    path = tmp_path / "state.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            user_id TEXT,
            system_prompt TEXT,
            parent_session_id TEXT,
            started_at REAL NOT NULL
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_name TEXT,
            tool_call_id TEXT,
            tool_calls TEXT,
            timestamp REAL,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
        """
    )
    conn.commit()
    conn.close()
    return path


def _add_session(state_db, sid, chat_id=CHAT_ID, source="sidekick"):
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, system_prompt, "
        "parent_session_id, started_at) VALUES (?, ?, ?, ?, ?, ?)",
        (sid, source, chat_id, None, None, time.time()),
    )
    conn.commit()
    conn.close()


def _add_msg(state_db, sid, role, content, ts):
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) "
        "VALUES (?, ?, ?, ?)",
        (sid, role, content, ts),
    )
    conn.commit()
    conn.close()


def _item(db, item_id):
    for it in state.list_activity_items(db, limit=500):
        if it["id"] == item_id:
            return it
    return None


# ── BUG B — idempotent activity upsert ───────────────────────────────


def test_replay_upsert_never_unreads_an_item(db):
    """A re-emitted envelope (gateway restart replaying the notification
    path) upserts the same item id with read=False. The upsert must
    never flip an already-read item back to unread."""
    state.upsert_activity_item(
        db, id="notif_x", chat_id=CHAT_PREFIXED, kind="cron",
        title="Cron", body="tick", created_at=1000.0,
    )
    state.mark_activity_seen(db, chat_id=CHAT_PREFIXED)
    assert _item(db, "notif_x")["read"] is True
    # Replay: same id, read=False.
    state.upsert_activity_item(
        db, id="notif_x", chat_id=CHAT_PREFIXED, kind="cron",
        title="Cron", body="tick", created_at=1000.0, read=False,
    )
    assert _item(db, "notif_x")["read"] is True, (
        "replay upsert reset a read item to unread — the ON CONFLICT "
        "clause must never un-read"
    )


def test_replay_upsert_never_wipes_a_resolution(db):
    """Same replay shape against a resolved approval: the ON CONFLICT
    clause must not null out ``resolved`` (which would resurrect the
    approval as blocking + unread)."""
    state.upsert_activity_item(
        db, id="appr_x", chat_id=CHAT_PREFIXED, kind="approval",
        title="Approval required", body="rm -rf?", created_at=1000.0,
    )
    state.resolve_activity_item(db, id="appr_x", resolution="approved")
    # Replay: envelope path always sends resolved=None.
    state.upsert_activity_item(
        db, id="appr_x", chat_id=CHAT_PREFIXED, kind="approval",
        title="Approval required", body="rm -rf?", created_at=1000.0,
        read=False, resolved=None,
    )
    it = _item(db, "appr_x")
    assert it["resolved"] == "approved", (
        "replay upsert wiped the resolution — approval resurrected"
    )
    assert it["read"] is True


def test_replay_upsert_preserves_created_at(db):
    """Pins the existing conflict behavior: created_at is set at first
    insert and never overwritten by a later upsert."""
    state.upsert_activity_item(
        db, id="notif_x", chat_id=CHAT_PREFIXED, kind="cron",
        title="Cron", body="tick", created_at=1000.0,
    )
    state.upsert_activity_item(
        db, id="notif_x", chat_id=CHAT_PREFIXED, kind="cron",
        title="Cron", body="tick", created_at=9999.0,
    )
    assert _item(db, "notif_x")["createdAt"] == 1000.0


# ── BUG B — envelope path: true mint time + born-read coverage ───────


def _bare_adapter(db):
    """SidekickAdapter with just enough state for
    ``_persist_activity_for_push`` (bypasses the real __init__, which
    wires the gateway/threads/servers)."""
    from .. import SidekickAdapter
    adapter = SidekickAdapter.__new__(SidekickAdapter)
    adapter._sidekick_db = db
    # publish_out_of_turn plumbing (best-effort inside the persist path).
    adapter._event_id_counter = 0
    adapter._event_replay_ring = []
    adapter._event_subscribers = []
    return adapter


def _persist_notification(adapter, *, item_id, kind="cron", chat_id=CHAT_ID):
    env = {
        "type": "notification",
        "kind": kind,
        "chat_id": chat_id,
        "sidekick_id": item_id,
        "title": "Cron notification",
        "content": "tick",
    }
    adapter._persist_activity_for_push(env, dispatch_result={"delivered": 1})
    return env


def test_envelope_replay_lands_at_id_mint_time_not_now(db):
    """Field shape: 4 cron items with id mints spanning Jul 18-20 were
    re-inserted (post-prune) with identical created_at = the replay
    batch time. The envelope path must derive created_at from the
    ``notif_<13-digit-ms>_…`` id mint so a replayed item lands at its
    true time."""
    adapter = _bare_adapter(db)
    item_id = f"notif_{MINT_MS}_abc123"
    _persist_notification(adapter, item_id=item_id)
    it = _item(db, item_id)
    assert it is not None
    assert it["createdAt"] == pytest.approx(MINT_S), (
        f"created_at {it['createdAt']} != id mint time {MINT_S} — "
        "a pruned-then-replayed notification resurrects at 'now'"
    )


def test_envelope_without_mint_shape_falls_back_to_now(db):
    adapter = _bare_adapter(db)
    t0 = time.time()
    _persist_notification(adapter, item_id="msg_no_mint_shape")
    it = _item(db, "msg_no_mint_shape")
    assert it is not None
    assert t0 <= it["createdAt"] <= time.time() + 1.0


def test_envelope_born_read_when_covered_by_chat_last_read(db):
    """An item whose created_at <= its chat's last_read_at is
    effectively read: the user already opened the chat past that
    point. Inserting it unread (the pruned-item replay case) would
    resurrect a phantom unread the user cannot clear from the chat."""
    adapter = _bare_adapter(db)
    # User read the chat well after the notification's mint time.
    state.mark_seen(db, CHAT_PREFIXED, now=MINT_S + 500.0)
    item_id = f"notif_{MINT_MS}_cov001"
    _persist_notification(adapter, item_id=item_id)
    it = _item(db, item_id)
    assert it is not None
    assert it["read"] is True, (
        "covered item (created_at <= chat last_read_at) inserted unread"
    )


def test_envelope_not_born_read_when_newer_than_last_read(db):
    adapter = _bare_adapter(db)
    state.mark_seen(db, CHAT_PREFIXED, now=MINT_S - 500.0)
    item_id = f"notif_{MINT_MS}_new001"
    _persist_notification(adapter, item_id=item_id)
    assert _item(db, item_id)["read"] is False


def test_envelope_open_approval_never_born_read(db):
    """Approval-kind items with resolved IS NULL are blocking workflow
    events — coverage by last_read_at must NOT auto-read them."""
    adapter = _bare_adapter(db)
    state.mark_seen(db, CHAT_PREFIXED, now=MINT_S + 500.0)
    item_id = f"notif_{MINT_MS}_appr01"
    _persist_notification(adapter, item_id=item_id, kind="approval")
    it = _item(db, item_id)
    assert it is not None
    assert it["read"] is False, "open approval was auto-read at insert"
    assert it["resolved"] is None


# ── BUG C — handle_unread_seen couples pane items to chat unread ─────


def _run_unread_seen(db, chat_id):
    from .. import sidekick_routes
    ctx = MagicMock()
    ctx.db = db
    request = MagicMock()
    request.json = AsyncMock(return_value={"chat_id": chat_id})
    asyncio.run(sidekick_routes.handle_unread_seen(ctx, request))
    return ctx


def test_unread_seen_marks_chat_pane_items_read(db):
    """Opening a chat (POST /v1/unread/seen) must clear that chat's
    pane items server-side, atomically with the chat unread — not rely
    on a separate client call landing."""
    state.upsert_activity_item(
        db, id="n1", chat_id=CHAT_PREFIXED, kind="cron",
        title="Cron", body="tick", created_at=1000.0,
    )
    state.upsert_activity_item(
        db, id="n2", chat_id="sidekick:other-chat", kind="cron",
        title="Cron", body="tock", created_at=1000.0,
    )
    ctx = _run_unread_seen(db, CHAT_PREFIXED)
    assert _item(db, "n1")["read"] is True, (
        "pane item for the just-opened chat stayed unread server-side"
    )
    assert _item(db, "n2")["read"] is False, "unrelated chat's item was cleared"
    # Other clients repaint off the activity_changed envelope.
    types = [c.args[0].get("type") for c in ctx.emit_envelope.call_args_list]
    assert "activity_changed" in types, (
        f"no activity_changed emitted — other clients won't repaint; got {types}"
    )


def test_unread_seen_accepts_bare_chat_id_form(db):
    """Routes accept both the prefixed (`sidekick:<id>`) and bare id
    forms; activity rows store the prefixed form. The coupling must
    clear items regardless of which form the client sent."""
    state.upsert_activity_item(
        db, id="n1", chat_id=CHAT_PREFIXED, kind="cron",
        title="Cron", body="tick", created_at=1000.0,
    )
    _run_unread_seen(db, CHAT_ID)  # bare form
    assert _item(db, "n1")["read"] is True


def test_unread_seen_never_reads_open_approvals(db):
    state.upsert_activity_item(
        db, id="appr1", chat_id=CHAT_PREFIXED, kind="approval",
        title="Approval required", body="rm -rf?", created_at=1000.0,
    )
    state.upsert_activity_item(
        db, id="appr2", chat_id=CHAT_PREFIXED, kind="approval",
        title="Approval required", body="done", created_at=1000.0,
        resolved="approved", read=True,
    )
    ctx = _run_unread_seen(db, CHAT_PREFIXED)
    assert _item(db, "appr1")["read"] is False, (
        "opening the chat auto-read a blocking unresolved approval"
    )
    # No unread pane items actually changed → no activity_changed spam.
    types = [c.args[0].get("type") for c in ctx.emit_envelope.call_args_list]
    assert "unread_changed" in types


# ── BUG A — ghost chats must not badge ───────────────────────────────


def test_ghost_chat_absent_from_conversations_universe_contributes_zero(db, state_db):
    """Field shape: chat ``sidekick:upgrade-probe-1783926444`` has one
    msg_links row, no state.db session, and is not served by
    /v1/conversations — yet compute_unread counted it: a permanent
    unclearable +1 on the dock badge. The chat universe must be scoped
    to chats the conversations route serves (state.db sessions with a
    user_id for this source)."""
    # Live chat: session + one unread assistant reply.
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "assistant", "hello", ts=1000.0)
    # Ghost: envelope row only, no session anywhere in state.db.
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": GHOST_CHAT,
        "message_id": "msg_ghost_1", "text": "probe reply",
    })
    unread = _compute_unread_uncached(db=db, state_db_path=state_db, source="sidekick")
    chat_ids = [c["chat_id"] for c in unread["chats"]]
    assert f"sidekick:{GHOST_CHAT}" not in chat_ids, (
        f"ghost chat still counted: {unread}"
    )
    assert unread["total"] == 1
    assert chat_ids == [CHAT_PREFIXED]


def test_ghost_chat_with_sticky_mark_contributes_zero(db, state_db):
    """A marked_unread=1 unread_state row for a chat the conversations
    route can't serve must not badge either — the user has no row to
    click to clear it."""
    _add_session(state_db, "s1")
    state.set_marked(db, f"sidekick:{GHOST_CHAT}", True)
    unread = _compute_unread_uncached(db=db, state_db_path=state_db, source="sidekick")
    assert unread["total"] == 0, f"sticky ghost badged: {unread}"


def test_envelope_only_rows_still_count_for_live_chats(db, state_db):
    """Scoping must not regress the pre-flush window: a chat WITH a
    state.db session whose latest reply exists only in msg_links (end-
    of-turn flush hasn't happened) still counts."""
    _add_session(state_db, "s1")
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_pre_flush", "text": "Checking.",
    })
    unread = _compute_unread_uncached(db=db, state_db_path=state_db, source="sidekick")
    assert unread["total"] >= 1
    assert [c["chat_id"] for c in unread["chats"]] == [CHAT_PREFIXED]


def test_stale_unread_state_for_ghost_chat_is_purged(db, state_db):
    """Opportunistic hygiene: an unread_state row whose chat is absent
    from the conversations universe (and old enough to be outside any
    pre-flush race window) gets purged; live chats' rows and fresh rows
    are untouched."""
    _add_session(state_db, "s1")
    now = time.time()
    state.mark_seen(db, CHAT_PREFIXED, now=now - 7200.0)          # live chat — keep
    state.mark_seen(db, "sidekick:ghost-old", now=now - 7200.0)   # stale ghost — purge
    state.mark_seen(db, "sidekick:ghost-fresh", now=now)          # fresh — keep (grace)
    _compute_unread_uncached(db=db, state_db_path=state_db, source="sidekick")
    remaining = {r["chatId"] for r in state.list_unread_state(db)}
    assert "sidekick:ghost-old" not in remaining, "stale ghost row survived"
    assert CHAT_PREFIXED in remaining, "live chat's unread_state was purged"
    assert "sidekick:ghost-fresh" in remaining, (
        "fresh row purged — breaks the new-chat pre-flush race guard"
    )
