"""Env access for the plugin's ``PARLEY_*`` variables.

Historical note: from the 2026-08 Sidekick → Parley rename until the
identity purge later that month, this module resolved a legacy
``SIDEKICK_*`` fallback spelling for every var. The purge flipped every
deployment surface (``~/.hermes/.env``, systemd units, the gateway
drop-in) to ``PARLEY_*``, which met the documented removal condition, so
the fallback is gone. ``env_get``/``env_is_set`` remain as the single
call-site convention.

JS twin: ``proxy/env.mjs``. A copy of this module lives at
``audio-bridge/parley_env.py`` (standalone service, no shared package) —
keep the three in sync.
"""

from __future__ import annotations

import os
from typing import Mapping, Optional


def env_get(name: str, default=None, *, environ: Optional[Mapping[str, str]] = None):
    """Read an env var by its ``PARLEY_*`` name (presence-based)."""
    env = os.environ if environ is None else environ
    if name in env:
        return env[name]
    return default


def env_is_set(name: str, *, environ: Optional[Mapping[str, str]] = None) -> bool:
    """True when the var is defined (even as an empty string)."""
    sentinel = object()
    return env_get(name, sentinel, environ=environ) is not sentinel
