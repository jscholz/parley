"""In-memory mirror of in-flight turns on the hermes side.

Parity with the openclaw plugin's ``src/turn-buffer.js``. Same shape,
same role: bridge the gap between POST receipt (user message known)
and state.db persistence (rows written, link table updated by
``_write_msg_links_after_turn`` at ``reply_final``). During that
window, ``/v1/conversations/{id}/items`` would return rows without
``parley_id`` (link table hasn't written), so the PWA can't dedup
the live SSE bubble against the items replay. Merging the buffer
fills the gap.

Keyed by ``chat_id`` (the hermes plugin enforces one turn per chat
at a time via ``_turn_queues``, matching the same constraint). Open
at ``_handle_responses``, observe envelopes via
``_safe_send_envelope``, close at ``reply_final``.
"""

from __future__ import annotations

import time
import uuid
from threading import Lock
from typing import Any, Dict, List, Optional


class TurnEntry:
    __slots__ = (
        "chat_id", "user_message", "user_message_id",
        "tool_calls", "tool_results",
        "assistant_text", "assistant_message_id",
        "started_at",
        # Additive (transcript v3 Phase 1 — turn-end deterministic
        # linker): the reply_final envelope's message_id and the set of
        # tool call_ids observed this turn (the tc:/tr: envelope id
        # space). close_turn_and_link reads both to pair the turn's
        # state.db rows with envelope ids WITHOUT content matching.
        "final_message_id", "call_ids",
    )

    def __init__(self, *, chat_id: str, user_message: str,
                 user_message_id: str, started_at: float):
        self.chat_id = chat_id
        self.user_message = user_message
        self.user_message_id = user_message_id
        self.tool_calls: List[Dict[str, Any]] = []
        self.tool_results: List[Dict[str, Any]] = []
        # Streaming assistant — cumulative text + the stable message_id
        # hermes assigns on the first reply_delta. The id is what links
        # the in-flight bubble to subsequent live-SSE deltas after a
        # mid-turn reconnect: `render_envelopes` emits a reply_delta
        # with this id, the PWA upserts a streaming bubble keyed on it,
        # and follow-up live envelopes update the SAME bubble instead
        # of forking a duplicate.
        self.assistant_text: str = ""
        self.assistant_message_id: str = ""
        self.started_at = started_at
        self.final_message_id: str = ""
        self.call_ids: set = set()


class TurnBuffer:
    """Per-chat in-memory turn mirror. Thread-safe because hermes
    hooks fire from worker threads via ``_schedule_envelope``."""

    def __init__(self) -> None:
        self._by_chat: Dict[str, TurnEntry] = {}
        self._lock = Lock()

    def open_turn(self, *, chat_id: str, user_message: str,
                  user_message_id: Optional[str] = None,
                  started_at: Optional[float] = None) -> TurnEntry:
        if started_at is None:
            started_at = time.time()
        entry = TurnEntry(
            chat_id=chat_id,
            user_message=user_message,
            user_message_id=user_message_id or f"umsg_{uuid.uuid4()}",
            started_at=started_at,
        )
        with self._lock:
            self._by_chat[chat_id] = entry
        return entry

    def observe_envelope(self, env: Dict[str, Any]) -> None:
        """Update the in-flight entry from an outbound envelope. Idempotent
        no-op when no turn is open for the chat."""
        chat_id = env.get("chat_id")
        if not chat_id:
            return
        with self._lock:
            entry = self._by_chat.get(chat_id)
            if not entry:
                return
            etype = env.get("type")
            if etype == "tool_call":
                entry.tool_calls.append({
                    "call_id": env.get("call_id", ""),
                    "tool_name": env.get("tool_name", ""),
                    "args": env.get("args"),
                    "ts": env.get("started_at") or time.time(),
                })
                call_id = env.get("call_id")
                if isinstance(call_id, str) and call_id:
                    entry.call_ids.add(call_id)
            elif etype == "tool_result":
                entry.tool_results.append({
                    "call_id": env.get("call_id", ""),
                    "tool_name": env.get("tool_name", ""),
                    "result": env.get("result"),
                    "ts": time.time(),
                })
                call_id = env.get("call_id")
                if isinstance(call_id, str) and call_id:
                    entry.call_ids.add(call_id)
            elif etype == "reply_final":
                # Turn-linker identity: the final assistant bubble's
                # stable id. Captured here (observe runs before
                # close_turn pops the entry in _safe_send_envelope).
                msg_id = env.get("message_id")
                if isinstance(msg_id, str) and msg_id:
                    entry.final_message_id = msg_id
            elif etype == "reply_delta":
                text = env.get("text")
                if isinstance(text, str):
                    # Hermes streams accumulated text — overwrite rather
                    # than concatenate. Same semantics as the proxy's
                    # SSE consumer.
                    entry.assistant_text = text
                # Capture the stable assistant message_id once. Used by
                # `render_envelopes` to emit a reply_delta with the same
                # id — keeps a reconnected PWA's bubble in sync with the
                # live SSE stream after replay.
                msg_id = env.get("message_id")
                if isinstance(msg_id, str) and msg_id and not entry.assistant_message_id:
                    entry.assistant_message_id = msg_id

    def close_turn(self, chat_id: str) -> Optional[TurnEntry]:
        with self._lock:
            return self._by_chat.pop(chat_id, None)

    def active_for_chat(self, chat_id: str) -> Optional[TurnEntry]:
        with self._lock:
            return self._by_chat.get(chat_id)

    def render_envelopes(self, entry: TurnEntry) -> List[Dict[str, Any]]:
        """Render the in-flight turn as a sequence of ``ParleyEnvelope``
        dicts (the live SSE wire shape — see ``proxy/parley/upstream.ts``
        ``ParleyEnvelope``). The PWA's ``backend.replayInflight()`` path
        feeds these through the same handlers the live SSE stream uses,
        so a reconnected client gets STREAMING bubbles (with the right
        ``message_id`` for follow-up dedup) instead of static finalized
        items.

        Replaces the older ``render_items`` items-merge approach, which
        produced finalized-shape rows that didn't dedup against subsequent
        live deltas (no ``parley_id`` on the in-flight assistant),
        causing a visible double-render on mid-turn reload."""
        out: List[Dict[str, Any]] = []
        # User message — drives the user bubble on a reconnected client.
        # Optimistic bubbles already in the DOM dedup against this via
        # message_id; mid-turn reload-with-empty-state-db relies on it
        # to put the prompt back at all.
        out.append({
            "type": "user_message",
            "chat_id": entry.chat_id,
            "message_id": entry.user_message_id,
            "text": entry.user_message,
        })
        # Tool calls + results interleaved by ts. Mirrors the live SSE
        # order (calls arrive before their matching results).
        tool_events: List[Dict[str, Any]] = []
        for c in entry.tool_calls:
            tool_events.append({"kind": "call", **c})
        for r in entry.tool_results:
            tool_events.append({"kind": "result", **r})
        tool_events.sort(key=lambda e: e.get("ts") or 0)
        for ev in tool_events:
            if ev["kind"] == "call":
                out.append({
                    "type": "tool_call",
                    "chat_id": entry.chat_id,
                    "call_id": ev.get("call_id", ""),
                    "tool_name": ev.get("tool_name", ""),
                    "args": ev.get("args"),
                })
            else:
                out.append({
                    "type": "tool_result",
                    "chat_id": entry.chat_id,
                    "call_id": ev.get("call_id", ""),
                    "tool_name": ev.get("tool_name", ""),
                    "result": ev.get("result"),
                })
        # Streaming assistant text. One reply_delta envelope with the
        # accumulated text — same shape the live SSE emits (additive
        # semantics, `edit: true` after the first one). The PWA upserts
        # a STREAMING bubble keyed on message_id; subsequent live deltas
        # for the same id update the same bubble. Skip when we haven't
        # captured a message_id yet (no reply_delta has fired) — without
        # the id there's no way to keep the live stream in sync, and
        # the user message + tool envelopes alone already cover the
        # most common mid-turn surfaces (tool-call in progress).
        if entry.assistant_text and entry.assistant_message_id:
            out.append({
                "type": "reply_delta",
                "chat_id": entry.chat_id,
                "message_id": entry.assistant_message_id,
                "text": entry.assistant_text,
                "edit": True,
            })
        return out

    def render_items(self, entry: TurnEntry, *, start_seq: int) -> List[Dict[str, Any]]:
        """Render the in-flight turn as ConversationItem dicts. Same
        shape ``_items_by_user_id`` produces. ``start_seq`` is the
        integer id to start at — choose a high value (e.g. 10**9) so
        in-flight items never collide with state.db row ids."""
        out: List[Dict[str, Any]] = []
        seq = start_seq
        out.append({
            "id": seq,
            "object": "message",
            "role": "user",
            "content": entry.user_message,
            "created_at": entry.started_at,
            "parley_id": entry.user_message_id,
        })
        seq += 1
        # Interleave tool calls + results by timestamp.
        tool_events: List[Dict[str, Any]] = []
        for c in entry.tool_calls:
            tool_events.append({"kind": "call", **c})
        for r in entry.tool_results:
            tool_events.append({"kind": "result", **r})
        tool_events.sort(key=lambda e: e.get("ts") or 0)
        for ev in tool_events:
            content = ev.get("args") if ev["kind"] == "call" else ev.get("result")
            if not isinstance(content, str):
                import json as _json
                try:
                    content = _json.dumps(content) if content is not None else ""
                except Exception:
                    content = str(content)
            out.append({
                "id": seq,
                "object": "message",
                "role": "tool",
                "content": content,
                "created_at": ev.get("ts") or entry.started_at,
                "tool_name": ev.get("tool_name", ""),
            })
            seq += 1
        if entry.assistant_text:
            out.append({
                "id": seq,
                "object": "message",
                "role": "assistant",
                "content": entry.assistant_text,
                "created_at": time.time(),
            })
            seq += 1
        return out
