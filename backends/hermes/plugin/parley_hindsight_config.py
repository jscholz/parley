"""hindsight's OWN config file — ``$HERMES_HOME/hindsight/config.json``.

Design: ``docs/LOCAL_MODE.md`` §3 (Settings › Memory). This is a SEPARATE
file from hermes' ``config.yaml``/``.env`` (which route WHERE hindsight's
LLM calls go — see ``parley_runtime_profiles.py``): this one carries
hindsight's CLIENT-SIDE recall/retain behaviour — whether it runs at all,
how much it injects, how often it saves.

Verified in ``~/.hermes/hermes-agent/plugins/memory/hindsight/__init__.py``:

  * ``_load_config()`` (~line 236) reads ``$HERMES_HOME/hindsight/config.json``
    first, falling back to the legacy ``~/.hindsight/config.json``, then env
    vars. This module only ever writes the first (profile-scoped) path — the
    one a fresh install actually has.
  * ``auto_recall`` / ``recall_max_tokens`` / ``recall_budget`` are read in
    ``_apply_connection_settings`` / ``_apply_recall_settings`` (~lines
    700-770); ``auto_retain`` / ``retain_every_n_turns`` a few lines above
    that in the same block.
  * Both blocks run fresh every time a ``MemoryManager`` is constructed
    (``agent/agent_init.py`` ~line 1271), which happens per NEW agent/
    session, not once at process startup — so a write here needs no
    hindsight-server or hermes-gateway restart. Only agents/sessions created
    AFTER the write pick up the new values; a chat already open keeps
    whatever it read at construction time until it is evicted or reset.

``recall_max_tokens`` costs CONTEXT TOKENS, not latency: recall itself runs
in the background after a turn (``recall_sync`` defaults off) and the
result is injected into the NEXT turn's prompt, then replayed with that
turn on every later turn until the next compaction. ``auto_retain`` is the
expensive knob: each save runs fact extraction + consolidation on the
memory server's own LLM, which in local mode is the SAME GPU chat uses
(measured 42s of LLM time for one consolidation pass on 2026-09-07) — it
competes with turns, not just tokens.

~/.hermes/hindsight/config.json is commonly a SYMLINK into the owner's own
config repo (same trap as ``~/.hermes/config.yaml``/``.env`` — see the
symlink comments in ``parley_route_settings.py``): a writer that renames a
new file over the link would silently turn it into a plain file and orphan
whatever it pointed at. ``write_config`` below resolves the link and writes
the REAL target through hermes' own ``utils.atomic_json_write`` (temp file
in the same directory + ``os.replace``), the same call
``apply-memory-recall.sh`` used to make from a subprocess — now made
in-process so a profile switch and a Settings-panel edit share one path.

Path resolution: ``$HERMES_HOME/hindsight/config.json`` (hermes'
``get_hermes_home()``), overridable by ``PARLEY_HINDSIGHT_CONFIG`` for
tests — never point that override at a real install's file.
"""

from __future__ import annotations

import copy
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional

logger = logging.getLogger(__name__)


class HindsightConfigError(ValueError):
    """A hindsight config field failed validation. Callers map this to
    HTTP 400 (parley_route_settings.SettingsValidationError) or a
    ``ProfileError`` (parley_runtime_profiles), depending on caller."""


# hindsight's own defaults (plugins/memory/hindsight/__init__.py
# _load_config's fallback + the per-key ``cfg.get(key, default)`` reads) —
# used to fill in a value when the key or the whole file is absent, so the
# Settings schema never shows a blank.
DEFAULT_AUTO_RECALL = True
DEFAULT_RECALL_MAX_TOKENS = 4096
DEFAULT_RECALL_BUDGET = "mid"
DEFAULT_AUTO_RETAIN = True
DEFAULT_RETAIN_EVERY_N_TURNS = 1

RECALL_BUDGETS = ("low", "mid", "high")
RECALL_MAX_TOKENS_RANGE = (200, 16000)
RETAIN_EVERY_N_TURNS_RANGE = (1, 50)

# The exact JSON keys this module owns. Kept as named constants rather than
# string literals sprinkled through the route/profile modules — a rename
# here is a one-place change.
KEY_AUTO_RECALL = "auto_recall"
KEY_RECALL_MAX_TOKENS = "recall_max_tokens"
KEY_RECALL_BUDGET = "recall_budget"
KEY_AUTO_RETAIN = "auto_retain"
KEY_RETAIN_EVERY_N_TURNS = "retain_every_n_turns"

ALL_KEYS = (
    KEY_AUTO_RECALL, KEY_RECALL_MAX_TOKENS, KEY_RECALL_BUDGET,
    KEY_AUTO_RETAIN, KEY_RETAIN_EVERY_N_TURNS,
)


# ── path resolution ──────────────────────────────────────────────────────

def config_path() -> Path:
    """``$HERMES_HOME/hindsight/config.json``, overridable by
    ``PARLEY_HINDSIGHT_CONFIG`` for tests. Mirrors hindsight's own
    ``_load_config()`` resolution (module docstring) for the profile-scoped
    path — the one this module writes is exactly the one a freshly
    constructed ``MemoryManager`` reads."""
    override = os.environ.get("PARLEY_HINDSIGHT_CONFIG")
    if override:
        return Path(override).expanduser()
    from hermes_cli.config import get_hermes_home
    return get_hermes_home() / "hindsight" / "config.json"


# ── pure read/validate ───────────────────────────────────────────────────

def read_config(path: Optional[Path] = None) -> Dict[str, Any]:
    """Raw read of the JSON file, or ``{}`` when absent/unparseable. Never
    raises — a missing or corrupt file is "no config yet", not a 500; the
    caller decides how to describe that (readonly status text)."""
    p = path or config_path()
    try:
        if not p.exists():
            return {}
        return json.loads(p.read_text(encoding="utf-8")) or {}
    except Exception as e:
        logger.warning("[parley] hindsight config read failed at %s: %s", p, e)
        return {}


def config_exists(path: Optional[Path] = None) -> bool:
    return (path or config_path()).exists()


def _validate_bool(key: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise HindsightConfigError(f"{key} value must be true or false")
    return value


def validate_auto_recall(value: Any) -> bool:
    return _validate_bool(KEY_AUTO_RECALL, value)


def validate_auto_retain(value: Any) -> bool:
    return _validate_bool(KEY_AUTO_RETAIN, value)


def validate_recall_max_tokens(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise HindsightConfigError(
            f"{KEY_RECALL_MAX_TOKENS} must be an integer, got {value!r}"
        )
    lo, hi = RECALL_MAX_TOKENS_RANGE
    if not (lo <= n <= hi):
        raise HindsightConfigError(
            f"{KEY_RECALL_MAX_TOKENS} must be {lo}..{hi}, got {n}"
        )
    return n


def validate_recall_budget(value: Any) -> str:
    v = str(value or "").strip().lower()
    if v not in RECALL_BUDGETS:
        raise HindsightConfigError(
            f"{KEY_RECALL_BUDGET} must be one of {'/'.join(RECALL_BUDGETS)}, got {value!r}"
        )
    return v


def validate_retain_every_n_turns(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise HindsightConfigError(
            f"{KEY_RETAIN_EVERY_N_TURNS} must be an integer, got {value!r}"
        )
    lo, hi = RETAIN_EVERY_N_TURNS_RANGE
    if not (lo <= n <= hi):
        raise HindsightConfigError(
            f"{KEY_RETAIN_EVERY_N_TURNS} must be {lo}..{hi}, got {n}"
        )
    return n


_VALIDATORS: Dict[str, Callable[[Any], Any]] = {
    KEY_AUTO_RECALL: validate_auto_recall,
    KEY_RECALL_MAX_TOKENS: validate_recall_max_tokens,
    KEY_RECALL_BUDGET: validate_recall_budget,
    KEY_AUTO_RETAIN: validate_auto_retain,
    KEY_RETAIN_EVERY_N_TURNS: validate_retain_every_n_turns,
}


def plan_updates(cfg: Mapping[str, Any], updates: Mapping[str, Any]) -> Dict[str, Any]:
    """Pure: validate and apply one or more key/value pairs onto a COPY of
    *cfg*, preserving every unknown key untouched. All-or-nothing — the
    first invalid update raises before anything is applied, so a profile
    switch or a Settings POST never lands a partial write.
    """
    out = copy.deepcopy(dict(cfg))
    for key, value in updates.items():
        validator = _VALIDATORS.get(key)
        if validator is None:
            raise HindsightConfigError(f"unknown hindsight config key: {key}")
        out[key] = validator(value)
    return out


def plan_update(cfg: Mapping[str, Any], key: str, value: Any) -> Dict[str, Any]:
    """Pure: validate and apply a SINGLE key/value pair. Thin wrapper over
    :func:`plan_updates` for the common one-field-at-a-time case (the
    Settings panel POSTs one id at a time)."""
    return plan_updates(cfg, {key: value})


def effective_values(cfg: Mapping[str, Any]) -> Dict[str, Any]:
    """*cfg* with hermes' own defaults filled in for any missing key —
    what the Settings panel should treat as "the current value" even
    before the file has ever been written."""
    return {
        KEY_AUTO_RECALL: bool(cfg.get(KEY_AUTO_RECALL, DEFAULT_AUTO_RECALL)),
        KEY_RECALL_MAX_TOKENS: int(cfg.get(KEY_RECALL_MAX_TOKENS, DEFAULT_RECALL_MAX_TOKENS)),
        KEY_RECALL_BUDGET: str(cfg.get(KEY_RECALL_BUDGET) or DEFAULT_RECALL_BUDGET),
        KEY_AUTO_RETAIN: bool(cfg.get(KEY_AUTO_RETAIN, DEFAULT_AUTO_RETAIN)),
        KEY_RETAIN_EVERY_N_TURNS: int(cfg.get(KEY_RETAIN_EVERY_N_TURNS, DEFAULT_RETAIN_EVERY_N_TURNS)),
    }


def summary_line(cfg: Mapping[str, Any]) -> str:
    """Compact one-line status, e.g.
    ``recall on · 1500 tok · low | retain on · every 1 turn``."""
    v = effective_values(cfg)
    recall = "on" if v[KEY_AUTO_RECALL] else "off"
    retain = "on" if v[KEY_AUTO_RETAIN] else "off"
    turns = v[KEY_RETAIN_EVERY_N_TURNS]
    turn_word = "turn" if turns == 1 else "turns"
    return (
        f"recall {recall} · {v[KEY_RECALL_MAX_TOKENS]} tok · {v[KEY_RECALL_BUDGET]}"
        f" | retain {retain} · every {turns} {turn_word}"
    )


def status_text(path: Optional[Path] = None) -> str:
    """Readonly status line for the Settings panel: the compact summary
    when the file exists (even partially — missing keys fall back to
    hermes' defaults), or an explicit "not found at <path>" so a fresh
    install's Memory section says something true instead of guessing."""
    p = path or config_path()
    if not p.exists():
        return f"hindsight config not found at {p}"
    return summary_line(read_config(p))


# ── the one impure write ─────────────────────────────────────────────────

def write_config(cfg: Mapping[str, Any], path: Optional[Path] = None) -> None:
    """Persist *cfg* to the hindsight config file, symlink-preserving and
    2-space indented (module docstring). Creates the file (and its parent
    directory) cleanly when neither exists yet — a fresh install's first
    Settings-panel edit must not require the file to pre-exist."""
    p = path or config_path()
    real = p.resolve() if p.is_symlink() else p
    real.parent.mkdir(parents=True, exist_ok=True)
    from utils import atomic_json_write
    atomic_json_write(real, dict(cfg), indent=2)
