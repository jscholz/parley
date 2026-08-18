"""Shared ID-encoding helpers for the hermes-side parley plugin.

Extracted from ``__init__.py`` 2026-05-17 so route-handler submodules
(``parley_route_*``) can import the same encoding logic without a
circular dep on the package init. ``__init__.py`` re-exports these
symbols for backward compat with any code that still references them
from the package root.

Don't add stateful objects here — this module is import-cheap on
purpose. Functions only, plus the source-name constants.

# ── Gateway id encoding ─────────────────────────────────────────────
# The agent contract guarantees ``ConversationSummary.id`` is globally
# unique. Hermes natively keys sessions by ``(source, user_id)`` —
# ``user_id`` IS the platform chat_id, and the same chat_id can recur
# across sources (e.g. a parley test session that happens to use a
# WhatsApp ``@lid`` as its chat_id, or a telegram numeric id that
# coincides with a parley UUID). Exposing user_id alone as ``id``
# violates uniqueness; the drawer then renders two LIs with the same
# ``data-chat-id``, click activates both, and history fetches go
# through ``_resolve_source_for_chat_id`` which picks one source
# arbitrarily — wrong session content appears in the right row.
#
# Encode ``(source, chat_id)`` into a single contract-unique id:
#   ``${source}:${chat_id}``  e.g. ``whatsapp:199999999999999@lid``
#
# Sources are internal constants (no colons); chat_ids in the wild
# don't contain colons in any platform we support. We split on FIRST
# ``:`` — chat_ids containing colons would still round-trip correctly.
# Frontend treats ``id`` as opaque. Per-chat URLs (``/v1/conversations/
# {id}/items``, DELETE) decode the prefix server-side to disambiguate.
#
# Backward compat: if an ``id`` arrives at the per-chat handler WITHOUT
# a prefix, fall through to ``_resolve_source_for_chat_id`` so legacy
# callers (channel-only ``/v1/conversations`` consumers, ad-hoc curls)
# keep working. New callers should always use prefixed ids.
"""

from __future__ import annotations

from typing import Optional, Tuple


# Channel-source whitelist — anything not in this set is dropped at
# query time by the cross-platform drawer (``/v1/gateway/
# conversations``). Canonical hermes-agent platform set as of the
# platform-adapter migration; if hermes adds a new platform, drop it
# in here.
GATEWAY_DRAWER_SOURCES: Tuple[str, ...] = (
    "sidekick",
    "telegram",
    "whatsapp",
    "slack",
    "signal",
    "discord",
    "webhook",
    "openclaw",
)

# Parley's own source — used by the channel-only ``/v1/conversations``
# endpoint and by tool-event hook resolution (which only cares about
# parley sessions; non-parley tool calls never make it past the
# adapter's filter).
# Legacy name + value, predates the Parley rename: "sidekick" is the
# source stamped on every existing row in the live DBs and embedded in
# session keys (agent:main:sidekick:dm:<chat_id>) — renaming the VALUE
# orphans all history. Keep constant name and value together.
SIDEKICK_SOURCE: str = "sidekick"

_GATEWAY_ID_SEP = ":"


def _format_gateway_id(source: str, chat_id: str) -> str:
    """Encode (source, chat_id) into a contract-unique identifier."""
    return f"{source}{_GATEWAY_ID_SEP}{chat_id}"


def _parse_gateway_id(id_str: str) -> Tuple[Optional[str], str]:
    """Split a gateway id back into (source, chat_id). Returns
    ``(None, id_str)`` for legacy un-prefixed ids — callers fall back
    to source-resolution-by-chat_id in that case."""
    if _GATEWAY_ID_SEP not in id_str:
        return (None, id_str)
    src, _, chat = id_str.partition(_GATEWAY_ID_SEP)
    if src not in GATEWAY_DRAWER_SOURCES:
        # Unrecognized prefix — treat as a chat_id that happens to
        # contain a colon. Defensive against future chat_id formats.
        return (None, id_str)
    return (src, chat)
