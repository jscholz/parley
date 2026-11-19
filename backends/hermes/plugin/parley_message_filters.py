"""Message filters — one place that decides whether an agent/gateway line
is conversation, a pulse, or noise (2026-11-19).

Field: "I often get hindsight update messages as notifications at random
times in the turns, and they're never informative." Those are gateway
lifecycle notices hermes emits through the adapter's send() with the
``_interim_send`` marker — "👁️ Hindsight — recalled 55 memories",
"💾 Self-improvement review: Skill 'x' patched" — and until now Parley
had three separate pattern checks for such lines (the progress-heartbeat
pulse in the dispatcher, the /steer-injection predicate in parley_state,
nothing at all for the memory notices), each wired into a different
seam.

This module owns the rules; every seam asks it:

  * ``classify(text, role, metadata)`` → 'show' | 'pulse' | 'hide'
      - 'pulse': a working indicator (status envelope), never a bubble,
        never a push, never unread. The ⏳ heartbeat / lease-wait lines.
      - 'hide':  dropped before it reaches anything — no envelope, no
        bubble, no push, no unread, and skipped on every transcript
        read path (state.db rows and parley.db twins alike).
  * ``is_hidden(text, role)`` — the read-path predicate.

Rules are BUILT-IN (shipped here, matched as specifically as the real
lines allow) plus USER rules: regular expressions the user keeps in
``parley.message_filters`` (Settings → Notifications → Message filters).
A user rule hides assistant lines it matches anywhere in the text.

hermes' Discord adapter solves the same problem with a regex list plus a
``non_conversational`` metadata flag newer gateways set; the flag is
honoured here too, so a future hermes that marks its notices needs no
new pattern.
"""
from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

Action = str   # 'show' | 'pulse' | 'hide'
Role = str     # 'assistant' | 'user' | 'any'

MAX_USER_PATTERN_LEN = 200
MAX_USER_PATTERNS = 50


@dataclass(frozen=True)
class Rule:
    id: str
    pattern: "re.Pattern[str]"
    action: Action
    role: Role
    label: str
    source: str = "builtin"      # 'builtin' | 'user'

    def matches(self, text: str, role: Role) -> bool:
        if self.role != "any" and role != self.role:
            return False
        return bool(self.pattern.search(text))


def _rule(id_: str, pattern: str, action: Action, role: Role, label: str, flags: int = 0) -> Rule:
    return Rule(id=id_, pattern=re.compile(pattern, flags), action=action, role=role, label=label)


# ── Built-in rules ────────────────────────────────────────────────────
# Each pattern is pinned to the exact shape of a line seen in the field;
# tests carry the samples. Order matters only for the label reported.
BUILTIN_RULES: Tuple[Rule, ...] = (
    # Gateway progress pulse, every 15 s during a turn
    # ("⏳ Working — 3 min — iteration 4/60, terminal", "⏳ Still working… (3 min elapsed)")
    # and the cross-process lease wait ("⏳ Another Hermes process is using this
    # session; …", "⏳ Still waiting for the other Hermes process on this session (15s)...").
    _rule("progress-pulse",
          r"^\s*⏳\s*(Working|Still working|Still waiting|Another Hermes process)\b",
          "pulse", "assistant", "Progress and lease-wait pulses", re.IGNORECASE),
    # Memory recall indicator (hermes agent/memory_manager.describe_recall):
    # "<glyph> <Provider> — recalled N memories" / "recalled 1 memory" /
    # "recalled relevant memory"; several providers join with two spaces.
    _rule("memory-recall",
          r"^\s*\S{1,4}\s*[^\n—]{1,60}\s+—\s+recalled\s+(?:\d+\s+memor(?:y|ies)|relevant memory)\b",
          "hide", "assistant", "Memory recall notices (“Hindsight — recalled N memories”)"),
    # Background self-improvement review ("💾 Self-improvement review: Skill 'x'
    # patched · Skill 'y' patched (…)") and its shorter legacy form.
    _rule("self-improvement-review",
          r"^\s*💾\s*(?:Self-improvement review:|Skill\s+['\"].+?['\"]\s+(?:created|updated|improved|patched)\b)",
          "hide", "assistant", "Self-improvement review notices", re.IGNORECASE),
    # The model-facing copy of a mid-turn /steer: Parley already shows the
    # user's own words (parley_state._is_steer_injection, field 2026-11-06).
    _rule("steer-injection",
          r"^\s*(?:\[OUT-OF-BAND USER MESSAGE|Gateway message origin \(JSON data)",
          "hide", "user", "Mid-turn steer injections (model-facing copies)"),
)

# ── User rules ────────────────────────────────────────────────────────
_lock = threading.Lock()
_user_rules: Tuple[Rule, ...] = ()
_user_patterns: Tuple[str, ...] = ()
_user_loaded = False


class PatternError(ValueError):
    """A user pattern that cannot be used; the message names the pattern."""


def compile_user_patterns(patterns: Iterable[Any]) -> Tuple[List[str], Tuple[Rule, ...]]:
    """Validate + compile. Returns (cleaned strings, rules). Raises
    PatternError on the first bad entry so the settings route can 400."""
    cleaned: List[str] = []
    rules: List[Rule] = []
    seen = set()
    for entry in patterns:
        if not isinstance(entry, str):
            raise PatternError(f"message filter entries must be strings; got {type(entry).__name__}")
        p = entry.strip()
        if not p or p in seen:
            continue
        if len(p) > MAX_USER_PATTERN_LEN:
            raise PatternError(f"message filter too long ({len(p)} chars; max {MAX_USER_PATTERN_LEN})")
        try:
            compiled = re.compile(p, re.IGNORECASE)
        except re.error as err:
            raise PatternError(f"message filter {p!r} is not a valid regular expression: {err}") from err
        if compiled.search("") is not None:
            raise PatternError(f"message filter {p!r} matches every message")
        seen.add(p)
        cleaned.append(p)
        rules.append(Rule(id=f"user:{len(cleaned)}", pattern=compiled, action="hide", role="assistant",
                          label=p, source="user"))
        if len(cleaned) > MAX_USER_PATTERNS:
            raise PatternError(f"too many message filters (max {MAX_USER_PATTERNS})")
    return cleaned, tuple(rules)


def set_user_patterns(patterns: Iterable[Any]) -> List[str]:
    """Replace the in-process user rules (settings apply + boot). Returns
    the cleaned list that was installed."""
    global _user_rules, _user_patterns, _user_loaded
    cleaned, rules = compile_user_patterns(patterns)
    with _lock:
        _user_rules = rules
        _user_patterns = tuple(cleaned)
        _user_loaded = True
    return cleaned


def user_patterns() -> List[str]:
    _ensure_loaded()
    return list(_user_patterns)


def _ensure_loaded() -> None:
    """Lazy boot load from ``parley.message_filters`` in hermes'
    config.yaml. Never raises: a bad stored pattern is logged and
    skipped so one typo cannot take the filters down."""
    global _user_loaded
    if _user_loaded:
        return
    with _lock:
        if _user_loaded:
            return
        _user_loaded = True
    patterns: List[Any] = []
    try:
        from .parley_route_settings import read_hermes_config  # noqa: WPS433
        cfg = read_hermes_config()
        raw = (cfg.get("parley") or {}).get("message_filters") if isinstance(cfg, dict) else None
        if isinstance(raw, list):
            patterns = raw
    except Exception as err:  # config unreadable: built-ins only
        logger.debug("[parley] message filters: config read failed: %s", err)
    good: List[str] = []
    for p in patterns:
        try:
            compile_user_patterns([p])
            good.append(p)
        except PatternError as err:
            logger.warning("[parley] message filters: skipping stored pattern: %s", err)
    try:
        set_user_patterns(good)
    except PatternError:
        pass


def rules() -> Tuple[Rule, ...]:
    _ensure_loaded()
    with _lock:
        return BUILTIN_RULES + _user_rules


def match(text: Optional[str], role: Role = "assistant") -> Optional[Rule]:
    """The first rule the text matches for this role, or None."""
    if not isinstance(text, str) or not text:
        return None
    for r in rules():
        if r.matches(text, role):
            return r
    return None


def classify(text: Optional[str], role: Role = "assistant",
             metadata: Optional[Dict[str, Any]] = None) -> Action:
    """'show' | 'pulse' | 'hide'. A gateway that marks a send
    ``non_conversational`` (hermes' Discord convention) is hidden
    without needing a pattern."""
    if metadata and metadata.get("non_conversational") is True:
        return "hide"
    r = match(text, role)
    return r.action if r else "show"


def is_hidden(text: Optional[str], role: Role) -> bool:
    r = match(text, role)
    return bool(r and r.action == "hide")


def is_pulse(text: Optional[str]) -> bool:
    r = match(text, "assistant")
    return bool(r and r.action == "pulse")


def describe_builtin() -> str:
    """One line for the read-only settings row."""
    return " · ".join(r.label for r in BUILTIN_RULES)


def _reset_for_tests() -> None:
    global _user_rules, _user_patterns, _user_loaded
    with _lock:
        _user_rules = ()
        _user_patterns = ()
        _user_loaded = False
