from __future__ import annotations

import pytest

from ..parley_db import ParleyDB
from .. import parley_state as state


@pytest.fixture
def db(tmp_path):
    db = ParleyDB(tmp_path / "parley.db")
    yield db
    db.close()


def _ids(db):
    return {r["id"] for r in db.fetchall("SELECT id FROM activity_items")}


def test_activity_retention_caps_dismissible_items_and_preserves_open_approvals(db):
    for i in range(205):
        state.upsert_activity_item(
            db,
            id=f"reply-{i:03d}",
            chat_id="chat-a",
            kind="agent_reply",
            title="Reply",
            body=str(i),
            created_at=1000 + i,
        )
    for i in range(3):
        state.upsert_activity_item(
            db,
            id=f"approval-open-{i}",
            chat_id="chat-a",
            kind="approval",
            title="Approval",
            body="needs action",
            created_at=1 + i,
        )

    rows = db.fetchall("SELECT kind, resolved FROM activity_items")
    dismissible = [r for r in rows if not (r["kind"] == "approval" and r["resolved"] is None)]
    open_approvals = [r for r in rows if r["kind"] == "approval" and r["resolved"] is None]

    assert len(dismissible) == state.DEFAULT_ACTIVITY_MAX_ITEMS
    assert len(open_approvals) == 3
    ids = _ids(db)
    assert "reply-000" not in ids
    assert "reply-004" not in ids
    assert "reply-005" in ids
    assert "reply-204" in ids
    assert {"approval-open-0", "approval-open-1", "approval-open-2"} <= ids


def test_resolving_approval_makes_it_dismissible_for_retention(db):
    for i in range(state.DEFAULT_ACTIVITY_MAX_ITEMS):
        state.upsert_activity_item(
            db,
            id=f"reply-{i:03d}",
            chat_id="chat-a",
            kind="agent_reply",
            title="Reply",
            body=str(i),
            created_at=1000 + i,
        )
    state.upsert_activity_item(
        db,
        id="approval-old",
        chat_id="chat-a",
        kind="approval",
        title="Approval",
        body="needs action",
        created_at=1,
    )

    assert "approval-old" in _ids(db)
    out = state.resolve_activity_item(db, id="approval-old", resolution="denied")

    assert out == {"updated": True}
    assert "approval-old" not in _ids(db)
    assert len(db.fetchall("SELECT id FROM activity_items")) == state.DEFAULT_ACTIVITY_MAX_ITEMS
