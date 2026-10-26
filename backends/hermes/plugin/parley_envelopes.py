"""The stream envelope types this plugin emits — declared once, checked
against the proxy's contract.

Mirror of ``proxy/parley/contract/envelopes.ts`` (UPSTREAM_ENVELOPE_TYPES).
The node contract test reads this tuple from the file and asserts it is a
subset of what the proxy fans out; ``publish_out_of_turn`` warns (once per
type) when something emits a type that is not listed here, so a new
envelope cannot silently disappear between the plugin and the PWA again
(2026-10-26 audit: ``job_run`` and ``activity_changed`` were dropped by the
proxy for months).

Add a type here AND to the TS contract in the same change.
"""
from __future__ import annotations

import logging
from typing import Set

logger = logging.getLogger(__name__)

ENVELOPE_TYPES = (
    # In-turn stream (also replayed through /v1/events when out of turn).
    "reply_delta",
    "reply_final",
    "tool_call",
    "tool_result",
    "typing",
    "status",
    "turn_start",
    "turn_end",
    "image",
    "notification",
    "session_changed",
    "user_message",
    # (``error`` is NOT emitted by the plugin: the proxy's OAI translator
    # synthesises it from ``response.error`` on /v1/responses.)
    # Out-of-turn, plugin-owned.
    "agent_question",
    "doc_show",
    "unread_changed",
    "pins_changed",
    "activity_changed",
    "conversation_deleted",
    "job_run",
)

_ENVELOPE_TYPE_SET = frozenset(ENVELOPE_TYPES)
_warned: Set[str] = set()


def is_envelope_type(t: object) -> bool:
    return isinstance(t, str) and t in _ENVELOPE_TYPE_SET


def warn_if_unknown(env_type: object) -> None:
    """Log once per unknown type. Never raises — a typo must not take the
    gateway down, it must show up in the log and the contract test."""
    if is_envelope_type(env_type):
        return
    key = str(env_type)
    if key in _warned:
        return
    _warned.add(key)
    logger.warning(
        "[parley] envelope type %r is not in parley_envelopes.ENVELOPE_TYPES — "
        "the proxy will drop it; add it to the contract (proxy/parley/contract/envelopes.ts) first",
        env_type,
    )
