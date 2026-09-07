"""Mid-turn replay must not crash when tool_call ``started_at`` (ISO string
from the adapter) meets tool_result ``ts`` (epoch float) — field 2026-09-07:
every GET /items for an in-flight turn with ≥1 call+result raised TypeError."""
import datetime as dt
import time

from ..parley_turn_buffer import TurnBuffer, _epoch

CHAT = "chat-ts"


def _open() -> TurnBuffer:
    tb = TurnBuffer()
    tb.open_turn(chat_id=CHAT, user_message="q", user_message_id="u1")
    return tb


def _iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, tz=dt.timezone.utc).isoformat()


def test_epoch_coercion():
    now = time.time()
    assert _epoch(now) == now
    assert abs(_epoch(_iso(now)) - now) < 1e-3
    assert abs(_epoch(_iso(now).replace("+00:00", "Z")) - now) < 1e-3
    assert _epoch("garbage") >= now
    assert _epoch(None) >= now
    assert _epoch(True) >= now


def test_render_envelopes_orders_iso_call_before_float_result():
    tb = _open()
    t0 = time.time() - 5
    tb.observe_envelope({"type": "tool_call", "chat_id": CHAT, "call_id": "c1",
                         "tool_name": "terminal", "args": {"command": "ls"},
                         "started_at": _iso(t0)})
    tb.observe_envelope({"type": "tool_result", "chat_id": CHAT, "call_id": "c1",
                         "tool_name": "terminal", "result": "ok"})
    tb.observe_envelope({"type": "tool_call", "chat_id": CHAT, "call_id": "c2",
                         "tool_name": "read_file", "args": {"path": "x"},
                         "started_at": _iso(time.time() + 1)})
    entry = tb.active_for_chat(CHAT)
    envs = tb.render_envelopes(entry)          # used to raise TypeError
    kinds = [(e["type"], e.get("call_id")) for e in envs if e["type"].startswith("tool_")]
    assert kinds == [("tool_call", "c1"), ("tool_result", "c1"), ("tool_call", "c2")]
    items = tb.render_items(entry, start_seq=1)  # same sort in the legacy path
    assert [it["tool_name"] for it in items if it["role"] == "tool"] == ["terminal", "terminal", "read_file"]
    for it in items:
        if it["role"] == "tool":
            assert isinstance(it["created_at"], float)


def test_missing_started_at_still_sorts():
    tb = _open()
    tb.observe_envelope({"type": "tool_call", "chat_id": CHAT, "call_id": "c1", "tool_name": "t"})
    tb.observe_envelope({"type": "tool_result", "chat_id": CHAT, "call_id": "c1", "tool_name": "t", "result": "r"})
    envs = tb.render_envelopes(tb.active_for_chat(CHAT))
    assert [e["type"] for e in envs][:3] == ["user_message", "tool_call", "tool_result"]
