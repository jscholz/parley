"""Turn lifecycle from hermes' own processing hooks.

hermes brackets every inbound message it processes with
``BasePlatformAdapter.on_processing_start(event)`` and
``on_processing_complete(event, outcome)`` — the hooks Slack's 👀
reaction rides on. They fire for idle-session messages, for follow-ups
drained in-band while a turn is running (nested: start B, complete B,
then complete A), and on every exit path: SUCCESS, FAILURE (exception
or undeliverable reply), CANCELLED (/stop, interrupt).

Before this module the plugin never implemented them and the PWA
inferred "is the agent working?" from typing pulses, reply_finals,
heartbeats and open tool rows. Any of those arriving late (a typing
tick racing the final, a tool row with no result) resurrected
"Thinking" on a chat that was long done (field 2026-09-13, -15, -23).
This is the fact those guesses were standing in for.

Pure bookkeeping: no I/O, no asyncio. The adapter turns the dicts
returned by ``start``/``complete`` into ``turn_start``/``turn_end``
envelopes; the items endpoint reads ``is_active`` / ``acks``.

State is in-memory. A gateway restart forgets it — which is correct
for ``is_active`` (nothing survives a restart) and merely drops the
recent ✓/✗ marks for ``acks``.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any, Dict, Optional

# Recent outcomes kept per chat, so a reload still shows ✓/✗ on the last
# few messages. Bounded: marks for older messages are simply absent.
_RECENT_OUTCOMES_PER_CHAT = 50

OUTCOME_SUCCESS = "success"
OUTCOME_FAILURE = "failure"
OUTCOME_CANCELLED = "cancelled"


def outcome_name(outcome: Any) -> str:
    """hermes ``ProcessingOutcome`` (enum, value or name) → wire string."""
    raw = getattr(outcome, "value", None) or getattr(outcome, "name", None) or outcome
    text = str(raw or "").strip().lower()
    if text in (OUTCOME_SUCCESS, OUTCOME_FAILURE, OUTCOME_CANCELLED):
        return text
    return OUTCOME_FAILURE if text in ("error", "failed") else OUTCOME_SUCCESS


class TurnLifecycle:
    def __init__(self) -> None:
        # chat_id → turn_id → {"user_message_id", "started_at", "replied"}
        self._active: Dict[str, "OrderedDict[str, Dict[str, Any]]"] = {}
        # chat_id → user_message_id → outcome (insertion-ordered, bounded)
        self._recent: Dict[str, "OrderedDict[str, str]"] = {}
        # hermes event.message_id → parley user_message_id. hermes rebuilds
        # MessageEvent for /queue and /steer follow-ups, keeping message_id
        # but not metadata, so this map is what survives the rebuild.
        self._umid_by_event: "OrderedDict[str, str]" = OrderedDict()

    # ── dispatch side ─────────────────────────────────────────────────
    def remember_event(self, event_message_id: str, user_message_id: str) -> None:
        if not event_message_id or not user_message_id:
            return
        self._umid_by_event[event_message_id] = user_message_id
        while len(self._umid_by_event) > 500:
            self._umid_by_event.popitem(last=False)

    def user_message_id_for(self, event: Any) -> str:
        meta = getattr(event, "metadata", None) or {}
        umid = meta.get("parley_user_message_id") if isinstance(meta, dict) else None
        if umid:
            return str(umid)
        emid = str(getattr(event, "message_id", "") or "")
        return self._umid_by_event.get(emid, "")

    # ── hooks ─────────────────────────────────────────────────────────
    def start(self, chat_id: str, turn_id: str, user_message_id: str = "",
              now: Optional[float] = None) -> Dict[str, Any]:
        turns = self._active.setdefault(chat_id, OrderedDict())
        turns[turn_id] = {
            "user_message_id": user_message_id,
            "started_at": time.time() if now is None else now,
            "replied": False,
        }
        return {"type": "turn_start", "chat_id": chat_id, "turn_id": turn_id,
                "user_message_id": user_message_id}

    def complete(self, chat_id: str, turn_id: str, outcome: Any) -> Dict[str, Any]:
        """Close ``turn_id``. Unknown ids (a complete with no start —
        hermes guarantees pairing, but a plugin reload mid-turn breaks it)
        still produce a well-formed ``turn_end`` so the client can settle."""
        name = outcome_name(outcome)
        turns = self._active.get(chat_id)
        entry = turns.pop(turn_id, None) if turns else None
        if turns is not None and not turns:
            self._active.pop(chat_id, None)
        umid = (entry or {}).get("user_message_id", "")
        replied = bool((entry or {}).get("replied"))
        if umid:
            recent = self._recent.setdefault(chat_id, OrderedDict())
            recent.pop(umid, None)
            recent[umid] = name
            while len(recent) > _RECENT_OUTCOMES_PER_CHAT:
                recent.popitem(last=False)
        return {"type": "turn_end", "chat_id": chat_id, "turn_id": turn_id,
                "user_message_id": umid, "outcome": name, "replied": replied,
                # Other turns still running in this chat (a nested
                # follow-up closing inside its parent) — the client keeps
                # the indicator up until this reaches 0.
                "active_turns": len(self._active.get(chat_id) or ())}

    def note_reply(self, chat_id: str) -> None:
        """A user-visible, non-interim reply was sent: every turn running
        in the chat has now answered (a nested follow-up and its parent
        share one reply stream)."""
        for entry in (self._active.get(chat_id) or {}).values():
            entry["replied"] = True

    # ── reads ─────────────────────────────────────────────────────────
    def is_active(self, chat_id: str) -> bool:
        return bool(self._active.get(chat_id))

    def acks(self, chat_id: str) -> Dict[str, str]:
        """``user_message_id → processing|success|failure|cancelled`` for
        the chat's running turns and its recent finished ones."""
        out: Dict[str, str] = dict(self._recent.get(chat_id) or {})
        for entry in (self._active.get(chat_id) or {}).values():
            if entry["user_message_id"]:
                out[entry["user_message_id"]] = "processing"
        return out
