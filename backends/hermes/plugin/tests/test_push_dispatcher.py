"""Push-dispatcher contract tests.

Coverage matrix:
  - Engagement gate suppresses push when chat is visible (within window).
  - Engagement window expires after ENGAGEMENT_WINDOW_MS.
  - Engagement key matches the chat_id form the dispatch path uses
    (UUID, no `parley:` prefix) — the route handler normalizes
    PWA-supplied prefixed ids before recording.
  - Per-kind pref toggle: `push_kind_agent_reply=False` silences
    reply_final; `push_kind_cron=False` silences cron notifications
    while leaving other kinds untouched.
  - Body shaping: cron content parsed, agent body LEADS, job_id
    demoted to trailing suffix; leading metadata lines stripped on
    generic notifications.
  - Reply buffer accumulates reply_delta cumulative text and drains
    on reply_final; self-heals on a new turn overwriting stale state.
  - Per-type / per-kind title icon discrimination.
  - Mute, not-eligible, missing-chat-id, no-subscribers skip paths.

Tests stub out pywebpush entirely (no network). The dispatcher's
sqlite-backed pref store is shared with the plugin's parley_state
module; we open a fresh in-memory DB per test for isolation.
"""

from __future__ import annotations

import pytest

from ..parley_dispatcher import (
    ENGAGEMENT_WINDOW_MS,
    EngagementState,
    PushDispatcher,
    ReplyBuffer,
    _approval_preview,
    _build_payload,
    _icon_for,
    is_approval_prompt,
    _is_kind_enabled,
    _is_push_eligible,
    _parse_cron_content,
    _strip_leading_metadata,
)
from ..parley_db import ParleyDB
from .. import parley_state as state


# ── Test fixtures ──────────────────────────────────────────────────────


@pytest.fixture
def db(tmp_path):
    """Fresh on-disk sqlite per test (in-memory sqlite doesn't play well
    with the dispatcher's commit-on-prefs semantics)."""
    db = ParleyDB(tmp_path / "parley.db")
    yield db
    db.close()


@pytest.fixture
def dispatcher(db, monkeypatch):
    """A dispatcher wired to a fresh DB with pywebpush stubbed.

    The webpush function is replaced with a counter so tests can
    assert delivery semantics without making HTTP calls.
    """
    from .. import parley_dispatcher as sd

    sent = []

    def fake_webpush(*, subscription_info, data, **kw):
        sent.append({"endpoint": subscription_info["endpoint"], "data": data})
        return None

    monkeypatch.setattr(sd, "webpush", fake_webpush)
    # ensure_vapid_keys writes a row to the db on first call; let it run.
    dispatcher = PushDispatcher(db, vapid_subject="mailto:test@example.com")
    dispatcher._sent = sent  # type: ignore[attr-defined]  # for assertions
    return dispatcher


def _add_sub(db, endpoint: str = "https://test/endpoint-1") -> None:
    """Insert one push subscription. Multiple calls = multiple subs."""
    state.upsert_subscription(
        db,
        endpoint=endpoint,
        p256dh="test-p256dh",
        auth="test-auth",
        user_agent="test-suite",
    )


# ── Engagement gate ────────────────────────────────────────────────────


def test_engagement_blocks_push_when_chat_visible(dispatcher, db):
    """User visible on chat X within the engagement window → push for
    chat X is suppressed."""
    _add_sub(db)
    dispatcher.engagement.mark_visible("abc-123")
    out = dispatcher.dispatch_envelope({
        "type": "reply_final", "chat_id": "abc-123",
    }, body_override="hello there")
    assert out == {"delivered": 0, "pruned": 0, "skipped": "user_engaged"}
    assert dispatcher._sent == []  # type: ignore[attr-defined]


def test_engagement_for_different_chat_does_not_block(dispatcher, db):
    """Engagement on chat A must not suppress push for chat B."""
    _add_sub(db)
    dispatcher.engagement.mark_visible("chat-A")
    out = dispatcher.dispatch_envelope({
        "type": "reply_final", "chat_id": "chat-B",
    }, body_override="hello")
    assert out["delivered"] == 1
    assert "skipped" not in out


def test_engagement_window_expires(dispatcher, db):
    """Past the engagement window, engagement no longer suppresses."""
    _add_sub(db)
    dispatcher.engagement.mark_visible("chat-X")
    import time as _t
    real_time = _t.time
    try:
        future = real_time() + (ENGAGEMENT_WINDOW_MS / 1000.0) + 1.0
        # The dispatch path reads time.time() inside is_engaged(now_ms=None);
        # we patch to force the expiry.
        _t.time = lambda: future
        out = dispatcher.dispatch_envelope({
            "type": "reply_final", "chat_id": "chat-X",
        }, body_override="hello")
    finally:
        _t.time = real_time
    assert out["delivered"] == 1


def test_engagement_hidden_clears_immediately(dispatcher, db):
    _add_sub(db)
    dispatcher.engagement.mark_visible("abc-123")
    dispatcher.engagement.mark_hidden("abc-123")
    out = dispatcher.dispatch_envelope({
        "type": "reply_final", "chat_id": "abc-123",
    }, body_override="hello")
    assert out["delivered"] == 1


def test_engagement_key_uses_stripped_chat_id(dispatcher, db):
    """Field bug 2026-05-18: visibility was recorded under the
    PWA-supplied `parley:<uuid>` form but the dispatch path checks
    the stripped form. The route handler now normalizes via
    `_strip_source_prefix`. This test pins the DISPATCH-side contract:
    engagement is keyed on the stripped chat_id, so a route handler
    that strips before calling mark_visible will produce a hit."""
    _add_sub(db)
    # Mimic the post-normalization shape — stripped UUID.
    dispatcher.engagement.mark_visible("abc-uuid")
    out = dispatcher.dispatch_envelope({
        "type": "reply_final", "chat_id": "abc-uuid",
    }, body_override="hello")
    assert out["skipped"] == "user_engaged"


def test_push_payload_url_routes_to_chat_and_message():
    payload = _build_payload({
        "type": "notification",
        "kind": "cron",
        "chat_id": "abc-uuid",
        "parley_id": "notif_123",
        "content": "Cron output",
    })
    assert payload["url"] == "/?chat=parley%3Aabc-uuid&msg=notif_123"
    assert "chat_id=" not in payload["url"]

    already_prefixed = _build_payload({
        "type": "reply_final",
        "chat_id": "parley:abc-uuid",
        "message_id": "msg_123",
    }, body_override="hello")
    assert already_prefixed["url"] == "/?chat=parley%3Aabc-uuid&msg=msg_123"


# ── Per-kind toggle ────────────────────────────────────────────────────


def test_per_kind_toggle_silences_agent_reply(dispatcher, db):
    """Setting push_kind_agent_reply=false silences reply_final for
    all chats while leaving notifications alone."""
    _add_sub(db)
    state.set_pref(db, "push_kind_agent_reply", False)
    # reply_final → silenced
    out = dispatcher.dispatch_envelope({
        "type": "reply_final", "chat_id": "x",
    }, body_override="agent text")
    assert out["skipped"] == "kind_disabled"
    # notification → still goes through
    out = dispatcher.dispatch_envelope({
        "type": "notification", "chat_id": "x",
        "kind": "cron", "content": "Cron output",
    })
    assert out["delivered"] == 1


def test_per_kind_toggle_silences_cron_only(dispatcher, db):
    """Setting push_kind_cron=false silences cron notifications but
    leaves agent_reply + other notification kinds untouched."""
    _add_sub(db)
    state.set_pref(db, "push_kind_cron", False)
    # cron notification → silenced
    out = dispatcher.dispatch_envelope({
        "type": "notification", "chat_id": "x",
        "kind": "cron", "content": "Cronjob Response: foo",
    })
    assert out["skipped"] == "kind_disabled"
    # reminder notification → still goes through
    out = dispatcher.dispatch_envelope({
        "type": "notification", "chat_id": "x",
        "kind": "reminder", "content": "Time for that thing",
    })
    assert out["delivered"] == 1
    # reply_final → still goes through
    out = dispatcher.dispatch_envelope({
        "type": "reply_final", "chat_id": "x",
    }, body_override="hi")
    assert out["delivered"] == 1


def test_per_kind_toggle_silences_approval_only(dispatcher, db):
    _add_sub(db)
    state.set_pref(db, "push_kind_approval", False)
    out = dispatcher.dispatch_envelope({
        "type": "notification", "chat_id": "x",
        "kind": "approval", "content": "Dangerous command requires approval",
    })
    assert out["skipped"] == "kind_disabled"
    out = dispatcher.dispatch_envelope({
        "type": "notification", "chat_id": "x",
        "kind": "cron", "content": "Cron output",
    })
    assert out["delivered"] == 1


def test_per_kind_default_is_enabled(dispatcher, db):
    """A fresh install (no prefs set) pushes everything."""
    _add_sub(db)
    out = dispatcher.dispatch_envelope({
        "type": "reply_final", "chat_id": "x",
    }, body_override="hi")
    assert out["delivered"] == 1


# ── Body shaping ───────────────────────────────────────────────────────


def test_cron_body_leads_with_agent_content_demotes_jobid():
    """Watch-banner-friendly: cron wrapper parsed → body LEADS with
    agent reply, job_id demoted to a trailing suffix."""
    raw = (
        "Cronjob Response: morning brief\n"
        "(job_id: abc-123-xyz)\n"
        "------------------\n"
        "\n"
        "Stocks up 2% in pre-market. Weather: clear.\n"
        "\n"
        "To stop or manage this job, send me a new message."
    )
    payload = _build_payload({
        "type": "notification", "chat_id": "x", "kind": "cron",
        "content": raw,
    })
    # Body must START with the agent content, not the boilerplate.
    assert payload["body"].startswith("Stocks up 2% in pre-market.")
    # job_id should appear LATER (trailing suffix) — and never lead.
    assert "abc-123-xyz" in payload["body"]
    assert payload["body"].index("Stocks") < payload["body"].index("abc-123-xyz")
    # Title carries task name + cron icon.
    assert "⏰" in payload["title"]
    assert "morning brief" in payload["title"]


def test_approval_prompt_classifier_and_preview():
    raw = (
        "⚠️ Dangerous command requires approval:\n\n"
        "set -euo pipefail\n"
        "rm -rf frames\n\n"
        "Reason: recursive delete\n"
        "Reply /approve to execute, /deny to cancel."
    )
    assert is_approval_prompt(raw)
    preview = _approval_preview(raw)
    assert preview.startswith("recursive delete:")
    assert "rm -rf frames" in preview
    assert "Reply /approve" not in preview


def test_approval_payload_uses_urgent_title_and_preview():
    raw = (
        "⚠️ Dangerous command requires approval:\n\n"
        "printf safe\n\n"
        "Reason: command approval test\n"
        "Reply /approve to execute."
    )
    payload = _build_payload({
        "type": "notification", "chat_id": "x", "kind": "approval",
        "content": raw,
    })
    assert payload["title"] == "⚠️ Approval required"
    assert payload["body"].startswith("command approval test:")
    assert "printf safe" in payload["body"]

def test_generic_notification_strips_leading_metadata():
    """Pure-text notifications with leading session_id/run_id lines
    get those stripped so the user-meaningful content leads."""
    raw = (
        "session_id: 1234abcd\n"
        "run_id: deadbeef\n"
        "------\n"
        "\n"
        "Reminder: stand-up at 10am."
    )
    payload = _build_payload({
        "type": "notification", "chat_id": "x", "kind": "reminder",
        "content": raw,
    })
    assert payload["body"].startswith("Reminder: stand-up at 10am.")
    assert "session_id" not in payload["body"]


def test_body_truncated_to_budget():
    """Long bodies hard-truncate to PUSH_BODY_MAX_CHARS with an
    ellipsis. Watch banner budget; cron suffix headroom is respected."""
    long_text = "x" * 1000
    payload = _build_payload({
        "type": "reply_final", "chat_id": "x",
    }, body_override=long_text)
    assert len(payload["body"]) <= 200
    assert payload["body"].endswith("…")


def test_body_override_wins_over_env_text():
    """body_override is what the caller passes after draining the
    reply buffer; it MUST win over env.text (which is typically empty
    on reply_final from the hermes adapter)."""
    payload = _build_payload(
        {"type": "reply_final", "chat_id": "x", "text": ""},
        body_override="from buffer",
    )
    assert payload["body"] == "from buffer"


# ── Reply buffer ───────────────────────────────────────────────────────


def test_reply_buffer_accumulates_delta_and_drains_on_final():
    """The cumulative reply text from reply_delta gets stashed
    per-chat; reply_final drains it."""
    buf = ReplyBuffer()
    buf.set_latest("chat-A", "Hello ")
    buf.set_latest("chat-A", "Hello world.")
    got = buf.take_and_clear("chat-A")
    assert got == "Hello world."
    # Drain clears.
    assert buf.take_and_clear("chat-A") == ""


def test_reply_buffer_isolates_chats():
    """Setting text for chat A must not leak into chat B's drain."""
    buf = ReplyBuffer()
    buf.set_latest("chat-A", "agent A talking")
    buf.set_latest("chat-B", "agent B talking")
    assert buf.take_and_clear("chat-A") == "agent A talking"
    assert buf.take_and_clear("chat-B") == "agent B talking"


def test_reply_buffer_self_heals_on_new_turn():
    """A new turn in the same chat overwrites the previous turn's
    buffered text (each delta carries cumulative for ITS reply only)."""
    buf = ReplyBuffer()
    buf.set_latest("x", "old turn text")
    # New turn starts before the previous final arrived.
    buf.set_latest("x", "new turn text so far")
    assert buf.take_and_clear("x") == "new turn text so far"


def test_dispatcher_observe_envelope_buffers_and_drains(dispatcher):
    """observe_envelope is the integration seam: it stashes deltas
    and returns the drained body on reply_final. Caller passes the
    return value to dispatch_envelope as body_override."""
    dispatcher.observe_envelope({
        "type": "reply_delta", "chat_id": "y",
        "text": "Hello partial",
    })
    dispatcher.observe_envelope({
        "type": "reply_delta", "chat_id": "y",
        "text": "Hello partial and the rest.",
    })
    body = dispatcher.observe_envelope({
        "type": "reply_final", "chat_id": "y",
    })
    assert body == "Hello partial and the rest."


# ── Icons ──────────────────────────────────────────────────────────────


def test_icon_picks_kind_first():
    """Concrete notification kinds use their own icons."""
    assert _icon_for({"type": "notification", "kind": "cron"}) == "⏰"
    assert _icon_for({"type": "notification", "kind": "approval"}) == "⚠️"


def test_icon_falls_back_to_type():
    """No kind → use type icon. reply_final → 💬."""
    assert _icon_for({"type": "reply_final"}) == "💬"


def test_icon_default_for_unknown():
    """Random/missing type → safe default."""
    assert _icon_for({"type": "_unknown_"}) == "💬"
    assert _icon_for({}) == "💬"


# ── Skip paths ─────────────────────────────────────────────────────────


def test_skip_not_eligible_for_non_pushable_type(dispatcher, db):
    """typing, tool_call, etc. never push by default."""
    _add_sub(db)
    out = dispatcher.dispatch_envelope({
        "type": "typing", "chat_id": "x",
    })
    assert out["skipped"] == "not_eligible"


def test_skip_missing_chat_id(dispatcher, db):
    """Push needs a chat_id (for engagement/mute/tag). Empty or
    missing → skip."""
    _add_sub(db)
    out = dispatcher.dispatch_envelope({
        "type": "reply_final",
    }, body_override="text")
    assert out["skipped"] == "missing_chat_id"


def test_skip_no_subscribers_when_db_empty(dispatcher):
    """Empty subscription list → skip dispatch. No webpush call."""
    out = dispatcher.dispatch_envelope({
        "type": "reply_final", "chat_id": "x",
    }, body_override="hi")
    assert out["skipped"] == "no_subscribers"


def test_skip_muted(dispatcher, db):
    """is_muted(db, chat_id) → skip even when otherwise eligible."""
    _add_sub(db)
    state.set_mute(db, "x", True)
    out = dispatcher.dispatch_envelope({
        "type": "reply_final", "chat_id": "x",
    }, body_override="hi")
    assert out["skipped"] == "muted"


def test_should_push_true_promotes_non_eligible_type(dispatcher, db):
    """Plugin can opt-in a normally-non-eligible envelope (e.g.
    tool-summary) by setting should_push=True."""
    _add_sub(db)
    out = dispatcher.dispatch_envelope({
        "type": "tool_call", "chat_id": "x",
        "should_push": True, "content": "Long-running tool finished.",
    })
    assert out["delivered"] == 1


def test_should_push_false_demotes_otherwise_eligible(dispatcher, db):
    """Plugin can suppress a reply_final that's just a tool-ack by
    setting should_push=False."""
    _add_sub(db)
    out = dispatcher.dispatch_envelope({
        "type": "reply_final", "chat_id": "x",
        "should_push": False,
    }, body_override="brief")
    assert out["skipped"] == "not_eligible"


# ── Parsers (pure functions) ───────────────────────────────────────────


def test_parse_cron_content_canonical():
    raw = (
        "Cronjob Response: my task\n"
        "(job_id: xyz)\n"
        "-----\n"
        "\n"
        "The body.\n"
        "\n"
        "To stop or manage this job, send me a new message."
    )
    p = _parse_cron_content(raw)
    assert p == {"task_name": "my task", "job_id": "xyz", "body": "The body."}


def test_parse_cron_content_unknown_shape_passes_through():
    p = _parse_cron_content("not a cron wrapper")
    assert p == {"task_name": "", "job_id": "", "body": "not a cron wrapper"}


def test_strip_leading_metadata():
    raw = (
        "session_id: abc\n"
        "run_id: 123\n"
        "\n"
        "---\n"
        "Actual content here.\n"
        "More content."
    )
    out = _strip_leading_metadata(raw)
    assert out.startswith("Actual content here.")


def test_strip_leading_metadata_only_strips_leading():
    """Mid-body metadata-looking lines must NOT be stripped — only
    the leading run."""
    raw = "Actual content.\nsession_id: ref\nMore content."
    out = _strip_leading_metadata(raw)
    assert out == raw


def test_is_push_eligible_should_push_overrides():
    assert _is_push_eligible({"type": "typing", "should_push": True})
    assert not _is_push_eligible({"type": "reply_final", "should_push": False})


def test_is_push_eligible_default_allowlist():
    assert _is_push_eligible({"type": "reply_final"})
    assert _is_push_eligible({"type": "notification"})
    assert not _is_push_eligible({"type": "typing"})
    assert not _is_push_eligible({"type": "tool_call"})


def test_is_push_eligible_agent_question():
    """The agent is parked waiting on an answer, so a missed push costs a
    stalled turn. Field bug 2026-08-23: questions logged
    `reason=not_eligible` and never reached a phone."""
    assert _is_push_eligible({"type": "agent_question"})
    # An explicit flag still wins in both directions.
    assert not _is_push_eligible({"type": "agent_question", "should_push": False})


def test_agent_question_has_no_kind_category_so_it_cannot_be_silenced(db):
    """An unmapped kind defaults to enabled. Mapping agent_question onto a
    push category would let a stale/false pref silence it the way the
    2026-07 all-false-prefs incident silenced every push."""
    assert _is_kind_enabled(db, {"type": "agent_question", "kind": "approval"})
    assert _is_kind_enabled(db, {"type": "agent_question", "kind": "clarify"})


# ── App-icon badge count (field bug 2026-07-08) ───────────────────────
#
# The OS app badge went stale-LOW while the PWA was closed: pushes
# arrived but nothing updated the badge until a page next opened and
# reconciled. Fix: the dispatch payload carries the server-computed
# unread total; sw.js calls setAppBadge(payload.badge) alongside
# showNotification. One clock (the plugin's compute_unread), three
# surfaces (sidebar, in-app, OS badge).


def test_build_payload_carries_badge_when_given():
    p = _build_payload({"type": "reply_final", "chat_id": "x", "text": "hi"}, badge=3)
    assert p["badge"] == 3


def test_build_payload_omits_badge_when_none():
    p = _build_payload({"type": "reply_final", "chat_id": "x", "text": "hi"})
    assert "badge" not in p


def test_dispatch_payload_includes_unread_total(db, monkeypatch):
    """dispatch_envelope injects the unread total via the injected
    unread_total_fn — floored at 1, because the push being dispatched
    IS an unread-worthy event even if the msg_links write-through
    hasn't landed when the count is computed."""
    import json as _json
    from .. import parley_dispatcher as sd

    sent = []
    monkeypatch.setattr(sd, "webpush", lambda *, subscription_info, data, **kw:
                        sent.append(data))
    d = PushDispatcher(db, vapid_subject="mailto:t@e.com",
                       unread_total_fn=lambda: 7)
    _add_sub(db)
    d.dispatch_envelope({"type": "reply_final", "chat_id": "abc", "text": "yo"})
    assert len(sent) == 1
    assert _json.loads(sent[0])["badge"] == 7

    sent.clear()
    d2 = PushDispatcher(db, vapid_subject="mailto:t@e.com",
                        unread_total_fn=lambda: 0)
    d2.dispatch_envelope({"type": "reply_final", "chat_id": "abc", "text": "yo"})
    assert _json.loads(sent[0])["badge"] == 1  # floor: this push is itself unread

    sent.clear()
    d3 = PushDispatcher(db, vapid_subject="mailto:t@e.com",
                        unread_total_fn=lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    d3.dispatch_envelope({"type": "reply_final", "chat_id": "abc", "text": "yo"})
    assert "badge" not in _json.loads(sent[0])  # compute failure never blocks the push
