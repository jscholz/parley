"""Env-var compat shim for the Sidekick → Parley rename (2026-08).

Every env var the plugin reads is named ``PARLEY_*`` going forward, but
deployed machines (the hermes-gateway systemd drop-in, ``~/.hermes/.env``)
still export the legacy ``SIDEKICK_*`` spellings — SIDEKICK_ITEMS_V3,
SIDEKICK_CHAT_MIGRATION, SIDEKICK_TURN_LINKER, SIDEKICK_TEST_GUARD, etc.
This module is the ONE place the fallback lives; do not scatter
``os.environ.get(new) or os.environ.get(old)`` chains at call sites.

Resolution: the first *defined* value wins, checked new-name-first
(presence-based, not truthiness — an empty string set on the new name
shadows the legacy name).

Removal condition: delete the fallback once no deployment exports
``SIDEKICK_*`` anymore.

JS twin: ``proxy/env.mjs``. A copy of this module lives at
``audio-bridge/parley_env.py`` (standalone service, no shared package) —
keep the three in sync.
"""

from __future__ import annotations

import os
from typing import List, Mapping, MutableMapping, Optional

_NEW_PREFIX = "PARLEY_"
_LEGACY_PREFIX = "SIDEKICK_"


def legacy_env_name(name: str) -> Optional[str]:
    """Legacy (SIDEKICK_*) spelling for a PARLEY_* name, else None."""
    if name.startswith(_NEW_PREFIX):
        return _LEGACY_PREFIX + name[len(_NEW_PREFIX):]
    return None


def env_get(name: str, default=None, *, environ: Optional[Mapping[str, str]] = None):
    """Read an env var by its PARLEY_* name, honoring the legacy
    SIDEKICK_* spelling as a fallback. New name wins when both are set."""
    env = os.environ if environ is None else environ
    if name in env:
        return env[name]
    legacy = legacy_env_name(name)
    if legacy is not None and legacy in env:
        return env[legacy]
    return default


def env_is_set(name: str, *, environ: Optional[Mapping[str, str]] = None) -> bool:
    """True when either spelling is defined."""
    sentinel = object()
    return env_get(name, sentinel, environ=environ) is not sentinel


def bridge_legacy_env(*names: str, environ: Optional[MutableMapping[str, str]] = None) -> List[str]:
    """Materialize legacy ``SIDEKICK_*`` values under their ``PARLEY_*`` names.

    ``env_get`` covers every var the plugin reads itself, but some values
    are consumed by code we hand a var *name* to rather than a value —
    notably hermes' platform registry (``allow_all_env=`` /
    ``allowed_users_env=``), which stores the string and later does a raw
    ``os.getenv`` on it. That lookup never routes through ``env_get``, so
    the legacy spelling is invisible to it.

    Copy the old value forward at startup so an upgraded deployment whose
    ``.env`` still says ``SIDEKICK_PLATFORM_ALLOW_ALL_USERS`` keeps
    working. Without this, hermes finds the declared name unset, falls
    through to default-deny, and locks the owner out of every chat behind
    pairing codes (2026-08-20 incident). Returns the names bridged.
    """
    env = os.environ if environ is None else environ
    bridged: List[str] = []
    for name in names:
        if name in env:
            continue
        legacy = legacy_env_name(name)
        if legacy is not None and legacy in env:
            env[name] = env[legacy]
            bridged.append(name)
    return bridged
