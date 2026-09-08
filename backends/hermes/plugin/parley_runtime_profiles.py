"""Runtime profiles — "where every model call goes", as one named bundle.

Design: ``~/code/parley/docs/LOCAL_MODE.md`` §1. A *runtime profile* names
the model block, the auxiliary models, the fallback chain, the compression
overrides, hindsight's LLM env, and the cron model pin (``cron.model`` /
``cron.model_provider`` — what parley_route_jobs.py's "model for all jobs"
bulk endpoint writes) for one operating mode. Two ship by default:

  cloud  — seeded FROM THE LIVE CONFIG on first run (never hardcoded, so a
           box whose model differs from the doc's example keeps its own).
  local  — the doc's YAML: llama.cpp on 127.0.0.1:8000 (user unit
           ``parley-fallback-llm.service``, model alias ``qwen3.6-35b-a3b``,
           64K allocated window, vision projector loaded), no fallback
           chain, compaction pulled forward to 0.6.

They live in hermes config under ``parley.runtime_profiles``, with the
active one recorded at ``parley.runtime_profile``. That is deliberate:
profiles are backend data, and the PWA only ever sees an enum setting.

Everything here is pure except :func:`apply_runtime_profile`, which takes
all five side effects (preflight probe, config write, env write, memory
restart, memory-recall script) as injected callables so tests never touch
disk, the network or systemd. :func:`plan_apply` computes the *entire* change — the exact
config keys, the exact env keys, and the snapshot of the profile being
left — before anything is written, so the audit question "what does this
touch?" is answerable without running it.

Why the write order is load-bearing (LOCAL_MODE.md §1 rule 2): the active
profile marker is recorded LAST, so a crash mid-apply leaves the setting
reporting the profile that is actually live rather than one that is half
applied. The leaving profile's ``model`` is snapshotted FIRST so a switch
back restores the user's most recent picker choice, not a stale default.
"""

from __future__ import annotations

import copy
import json
import logging
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from . import parley_hindsight_config as hc

logger = logging.getLogger(__name__)

# ── config addresses ────────────────────────────────────────────────────

PARLEY_KEY = "parley"
ACTIVE_PROFILE_PATH = "parley.runtime_profile"
PROFILES_PATH = "parley.runtime_profiles"

DEFAULT_PROFILE = "cloud"
LOCAL_PROFILE = "local"

# hindsight reads these three from ~/.hermes/.env (EnvironmentFile= in
# hindsight-server.service), so they only take effect on a restart.
ENV_MEMORY_PROVIDER = "HINDSIGHT_API_LLM_PROVIDER"
ENV_MEMORY_MODEL = "HINDSIGHT_API_LLM_MODEL"
ENV_MEMORY_BASE_URL = "HINDSIGHT_API_LLM_BASE_URL"
MEMORY_ENV_KEYS = (ENV_MEMORY_PROVIDER, ENV_MEMORY_MODEL, ENV_MEMORY_BASE_URL)

# The only config roots a profile apply is allowed to touch. Asserted by
# plan_apply so a future profile key cannot quietly widen the blast radius
# of a setting that reroutes every model call the owner's agent makes.
ALLOWED_CONFIG_ROOTS = frozenset({
    "model", "auxiliary", "fallback_providers", "compression", PARLEY_KEY,
    "tools", "skills", "cron",
})

# `tools` and `skills` are widened roots (the local diet: fewer tool schemas,
# fewer skills in the index), but only ONE sub-path each is a profile's to
# touch — everything else under them is hermes/owner territory a runtime
# profile has no business rerouting. Enforced in plan_apply, not just by the
# root check above, so a profile that sneaks in e.g. `tools.mcp_servers` or
# `skills.disabled` (the GLOBAL list, as opposed to the per-platform one) is
# rejected outright rather than silently applied.
ALLOWED_TOOLS_SUBKEY = "tool_search"
ALLOWED_SKILLS_SUBKEY = "platform_disabled"

# `cron` is the same shape of widened root: a profile switch must not leave
# a stale "model for all jobs" pin from the profile being LEFT — a cloud
# model pinned into cron.model strands every cron job when the owner flips
# to `local` (no API key off-grid); the reverse strands crons on a small
# local model after flipping back. Restricted to model/model_provider (the
# two keys parley_route_jobs.py's bulk-model endpoint writes) so a profile
# cannot also silently repoint `cron.provider` (the SCHEDULER provider,
# unrelated) or flip `cron.model_drift_guard`/`cron.preflight` — those are
# hermes/owner territory, same rationale as tools/skills above. Both shipped
# profiles seed an EXPLICIT empty pin (docs/LOCAL_MODE.md §1 rule 7) so a
# switch always resets cron back to "follow this profile's model.default",
# never silently inherits whatever a bulk-model call last wrote.
ALLOWED_CRON_SUBKEYS = frozenset({"model", "model_provider"})

_PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")

# Seed values for the `local` profile (LOCAL_MODE.md §1). Only used when
# `parley.runtime_profiles` is MISSING entirely; once seeded the YAML is
# the editor (per-profile toolsets etc. are hand-edited there).
LOCAL_SERVER_BASE_URL = "http://127.0.0.1:8000/v1"
LOCAL_PROVIDER = "custom:local-fallback"      # `providers.local-fallback` in hermes config
LOCAL_MODEL = "qwen3.6-35b-a3b"               # llama-server --alias

# 8192, not a rounder 12000: hermes derives the compaction threshold from
# (context_length - max_tokens) * threshold_percent. At 12000 on the 64K
# allocated window that lands at 45,505 tokens, which the ~26k measured head
# plus the hard-coded 10k lean-tail floor can barely clear before the
# ineffective-compression breaker trips again; at 8192 it is 48,742 — see
# docs/LOCAL_MODE.md §2. Verified 2026-09-07 by constructing an agent.
LOCAL_MODEL_MAX_TOKENS = 8192

# The local diet (docs/LOCAL_MODE.md §2 "Low-context mode"): the fixed prompt
# head on a 64K window measures ~26k real tokens, most of it tool schemas and
# the skills index. `tool_search.defer` REPLACES hermes' curated default
# wholesale (tools/tool_search.py `_DEFAULT_DEFERRED_TOOLS`), so this list
# carries every one of those defaults plus the browser/delegate/voice tools
# that cost schema space but are rarely used from a phone chat. MCP tools
# (e.g. Notion's 24) are always deferrable and need no entry here.
LOCAL_TOOL_SEARCH = {
    "enabled": "on",
    "listing": "on",
    "listing_max_tokens": 1200,
    "defer": [
        "computer_use", "session_search", "image_generate", "todo_list", "process_manage",
        "cronjob_manage", "drive_preview", "gui_tour", "desktop_preview", "annotate_preview",
        "show_tip", "setup_mcp", "desktop_project", "close_terminal", "apply_layout",
        "read_terminal", "read_window_below", "focus_pane", "browser_back", "browser_cdp",
        "browser_click", "browser_console", "browser_dialog", "browser_exec", "browser_get_images",
        "browser_navigate", "browser_press", "browser_scroll", "browser_snapshot", "browser_type",
        "delegate_task", "text_to_speech", "skill_manage",
    ],
}

# Skill names hidden from the parley platform's skills index only (taken from
# the live skills index on 2026-09-07). Deliberately does NOT touch the
# software-development category — that call is the owner's, not this diet's.
LOCAL_SKILLS_HIDDEN_PARLEY = [
    "architecture-diagram", "ascii-art", "ascii-video", "baoyu-article-illustrator", "baoyu-comic",
    "baoyu-infographic", "claude-design", "comfyui", "design-md", "excalidraw", "humanizer",
    "ideation", "iterative-website-design", "manim-video", "p5js", "pixel-art",
    "minecraft-modpack-server", "pokemon-player", "gif-search", "heartmula", "songsee", "spotify",
    "video-rough-cutting", "youtube-content", "social-media-sweep", "xurl", "yuanbao", "openhue",
    "godmode", "evaluating-llms-harness", "weights-and-biases", "huggingface-hub", "llama-cpp",
    "obliteratus", "outlines", "serving-llms-vllm", "audiocraft-audio-generation",
    "segment-anything-model", "dspy", "axolotl", "fine-tuning-with-trl", "unsloth",
    "agent-client-bridges", "claude-code", "codex", "computer-use", "hermes-agent",
    "kanban-codex-lane", "opencode", "github-auth", "github-code-review", "github-issues",
    "github-pr-workflow", "github-repo-management", "kanban-orchestrator", "kanban-worker",
    "private-static-site-publishing", "webhook-subscriptions", "static-intelligence-dashboards",
    "pii-scrub-public-sync",
]

# hindsight's OWN recall/retain knobs (parley_hindsight_config.py, NOT
# hermes config.yaml/.env). Re-exported here so this module's public
# constants keep meaning what they said before that file existed; the
# validation itself now lives in parley_hindsight_config so the Settings
# panel and a profile switch agree on one set of rules.
DEFAULT_RECALL_MAX_TOKENS = hc.DEFAULT_RECALL_MAX_TOKENS
DEFAULT_RECALL_BUDGET = hc.DEFAULT_RECALL_BUDGET
_RECALL_BUDGETS = hc.RECALL_BUDGETS


class ProfileError(ValueError):
    """Profile could not be read/planned/applied.

    parley_route_settings re-raises this as SettingsValidationError so the
    PWA gets a 400 with the message verbatim; keeping a local type means
    this module has no import edge back into the route layer.
    """


# ── tiny pure helpers over a nested config dict ─────────────────────────

def _get_path(cfg: Mapping[str, Any], path: str) -> Any:
    cur: Any = cfg
    for part in path.split("."):
        if not isinstance(cur, Mapping) or part not in cur:
            return None
        cur = cur[part]
    return cur


def set_path(cfg: Dict[str, Any], path: str, value: Any) -> None:
    """Set a dotted path, creating intermediate dicts. Mutates *cfg*.

    A non-dict intermediate is replaced rather than crashing: hermes stores
    ``model:`` as either a scalar or a dict, and a scalar sitting where we
    need a mapping must not abort a profile switch half-way.
    """
    parts = path.split(".")
    cur = cfg
    for part in parts[:-1]:
        nxt = cur.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[part] = nxt
        cur = nxt
    cur[parts[-1]] = copy.deepcopy(value)


def apply_config_updates(cfg: Mapping[str, Any], updates: Mapping[str, Any]) -> Dict[str, Any]:
    """Pure: return a deep copy of *cfg* with every dotted *updates* key set."""
    out = copy.deepcopy(dict(cfg))
    for path, value in updates.items():
        set_path(out, path, value)
    return out


# ── profile shape ───────────────────────────────────────────────────────

def _model_block(cfg: Mapping[str, Any]) -> Dict[str, Any]:
    """The live ``model:`` block normalised to a dict.

    hermes accepts both ``model: <id>`` and ``model: {default, provider,
    base_url}``; build_settings_schema already handles both and so must the
    snapshot, or a scalar config would be snapshotted as a bare string and
    restored as one (losing the provider on the way back).
    """
    raw = cfg.get("model")
    if isinstance(raw, Mapping):
        return copy.deepcopy(dict(raw))
    if isinstance(raw, str) and raw.strip():
        return {"default": raw.strip()}
    return {}


def _aux_block(cfg: Mapping[str, Any], name: str) -> Dict[str, Any]:
    aux = cfg.get("auxiliary")
    entry = aux.get(name) if isinstance(aux, Mapping) else None
    return copy.deepcopy(dict(entry)) if isinstance(entry, Mapping) else {}


def seed_default_profiles(cfg: Mapping[str, Any], env: Mapping[str, str]) -> Dict[str, Any]:
    """Build the initial ``runtime_profiles`` block. Pure.

    ``cloud`` is a photograph of what this box is running RIGHT NOW —
    model block, the vision auxiliary, the fallback chain and hindsight's
    current LLM env. Hardcoding the doc's example values here would have
    silently rewritten a host whose live model differs (a real box might
    run gpt-5.6-sol while the doc's example says gpt-6-astra), which is
    exactly the class of bug a "seed from live" rule exists to prevent.

    ``local`` is the doc's YAML, the only place literals are legitimate:
    there is nothing live to copy until the profile has been used once.
    """
    cloud: Dict[str, Any] = {
        "model": _model_block(cfg),
        "auxiliary": {"vision": _aux_block(cfg, "vision")},
        "fallback_providers": copy.deepcopy(cfg.get("fallback_providers") or []),
        "memory": {
            "llm_provider": (env.get(ENV_MEMORY_PROVIDER) or "").strip(),
            "llm_model": (env.get(ENV_MEMORY_MODEL) or "").strip(),
            "llm_base_url": (env.get(ENV_MEMORY_BASE_URL) or "").strip(),
            "recall_max_tokens": DEFAULT_RECALL_MAX_TOKENS,
            "recall_budget": DEFAULT_RECALL_BUDGET,
        },
        # `{}` is not "no override" here, it is the explicit statement "use
        # hermes defaults" — plan_apply writes it wholesale either way, so a
        # switch back to cloud undoes whatever the local diet configured.
        "tools": {"tool_search": {}},
        "skills": {"platform_disabled": {"parley": []}},
        # Explicit empty pin (docs/LOCAL_MODE.md §1 rule 7): "follow this
        # profile's model.default." Written on every switch INTO cloud so a
        # "model for all jobs" bulk pin from a previous profile never
        # survives the switch silently — the owner has to re-pin explicitly
        # if they want cron different from the profile default again.
        "cron": {"model": "", "model_provider": ""},
    }
    # Only carry a compression override when the box actually sets one, so
    # switching back to cloud restores the value the user had rather than
    # pinning hermes' default into their config.
    threshold = _get_path(cfg, "compression.threshold")
    if isinstance(threshold, (int, float)):
        cloud["compression"] = {"threshold": threshold}

    local: Dict[str, Any] = {
        "model": {
            "default": LOCAL_MODEL,
            "provider": LOCAL_PROVIDER,
            "base_url": LOCAL_SERVER_BASE_URL,
            # Wholesale model replace (plan_apply writes the whole `model:`
            # block): a `max_tokens`/`context_length` a cloud model left
            # behind must NOT survive the switch, or the compaction math
            # below computes against the wrong output reservation.
            "max_tokens": LOCAL_MODEL_MAX_TOKENS,
        },
        # The server runs with --mmproj, so the same endpoint answers vision.
        # base_url is spelled out even though hermes can resolve it from the
        # `providers.local-fallback` entry: an explicit endpoint cannot be
        # broken by someone renaming that entry.
        "auxiliary": {
            "vision": {
                "provider": LOCAL_PROVIDER,
                "model": LOCAL_MODEL,
                "base_url": LOCAL_SERVER_BASE_URL,
            },
        },
        # Off-grid: there is nothing to fall back TO, and leaving the cloud
        # chain in place would silently phone home on the first local error.
        "fallback_providers": [],
        "memory": {
            # NOT hindsight's `llamacpp` provider: that one spawns its OWN
            # llama-cpp-python subprocess and downloads a second GGUF
            # (hindsight_api/engine/providers/llamacpp_llm.py — base_url is
            # ignored), which would fight the 4090 for VRAM. `lmstudio` is
            # hindsight's generic "OpenAI-compatible local server, no auth"
            # provider: it honours base_url and needs no API key, so nothing
            # leaks to the local process. If retain JSON ever gets flaky,
            # `openai` + the same base_url is the alternative (it adds
            # response_format=json_object, but requires an api key).
            "llm_provider": "lmstudio",
            "llm_model": LOCAL_MODEL,
            "llm_base_url": LOCAL_SERVER_BASE_URL,
            # hindsight injects up to this many tokens of recalled facts into
            # every non-trivial turn (docs/LOCAL_MODE.md §2); capped lower
            # than cloud's default so recall does not eat the diet's savings.
            "recall_max_tokens": 1500,
            "recall_budget": "low",
        },
        # 64K allocated window: compact earlier than the cloud default.
        "compression": {"threshold": 0.6},
        "tools": {"tool_search": copy.deepcopy(LOCAL_TOOL_SEARCH)},
        "skills": {"platform_disabled": {"parley": list(LOCAL_SKILLS_HIDDEN_PARLEY)}},
        # Same reset guarantee as cloud's: a cloud-pinned "model for all
        # jobs" must not survive a flip to local (no API key off-grid).
        "cron": {"model": "", "model_provider": ""},
    }
    return {DEFAULT_PROFILE: cloud, LOCAL_PROFILE: local}


def profiles_block_present(cfg: Mapping[str, Any]) -> bool:
    raw = _get_path(cfg, PROFILES_PATH)
    return isinstance(raw, Mapping) and bool(raw)


def read_profiles(
    cfg: Mapping[str, Any], env: Mapping[str, str], *, strict: bool = False,
) -> Dict[str, Any]:
    """Profiles from config, seeded from live values when absent. Pure.

    A partially-populated block is honoured as-is (the YAML is the editor);
    only a wholly missing/blank block triggers the seed.

    ``strict`` guards the seed's one unsafe case. Seeding assumes the live
    config IS the cloud profile, which is true on first run and only then:
    the block is written in the FIRST step of every switch, before the
    active-profile marker, so "no profiles block" and "active profile is not
    cloud" cannot both be true unless someone hand-edited the config. If
    they are, seeding would photograph the LOCAL routing into the ``cloud``
    profile and the cloud configuration would be gone for good. Callers that
    are about to WRITE pass strict=True and get a refusal instead; readers
    (the settings schema) pass strict=False and get a cosmetically-wrong
    description of a state that should not exist.
    """
    raw = _get_path(cfg, PROFILES_PATH)
    if isinstance(raw, Mapping) and raw:
        out: Dict[str, Any] = {}
        for name, body in raw.items():
            if isinstance(name, str) and _PROFILE_NAME_RE.match(name) and isinstance(body, Mapping):
                out[name] = copy.deepcopy(dict(body))
        if out:
            return out
    active = read_active_profile(cfg)
    if strict and active != DEFAULT_PROFILE:
        raise ProfileError(
            f"{PROFILES_PATH} is missing but the active profile is {active!r}; "
            f"the live config describes {active!r}, not {DEFAULT_PROFILE!r}, so the "
            f"profiles block cannot be seeded from it. Restore it by hand in "
            f"hermes config.yaml (docs/LOCAL_MODE.md §1) before switching."
        )
    return seed_default_profiles(cfg, env)


def read_active_profile(cfg: Mapping[str, Any]) -> str:
    """The profile the agent is running under. Absent = ``cloud``: every
    box predating this feature is, by definition, in cloud mode."""
    raw = _get_path(cfg, ACTIVE_PROFILE_PATH)
    if isinstance(raw, str) and _PROFILE_NAME_RE.match(raw.strip()):
        return raw.strip()
    return DEFAULT_PROFILE


# ── the plan ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class MemorySpec:
    """hindsight's routing AND behaviour for a profile.

    ``provider``/``model``/``base_url`` are the LLM-routing half — hermes'
    ``.env`` (``HINDSIGHT_API_LLM_*``), applied by the ops script and
    requiring a hindsight-server restart (``restart_memory``).

    ``recall_max_tokens``/``recall_budget``/``auto_recall``/``auto_retain``/
    ``retain_every_n_turns`` are a SEPARATE hindsight knob — the JSON file
    ``parley_hindsight_config.py`` owns, not the LLM env — carried on the
    same dataclass because they travel with the same profile switch. No
    restart: hindsight rereads that file fresh per new agent/session.
    ``recall_max_tokens``/``recall_budget`` are filled with hermes' defaults
    by plan_apply whenever the profile names only one of the pair, so those
    two only ever arrive as a complete pair or ``None, None``. The other
    three are independent optionals — a profile may set any subset.
    """
    provider: str
    model: str
    base_url: str = ""
    recall_max_tokens: Optional[int] = None
    recall_budget: Optional[str] = None
    auto_recall: Optional[bool] = None
    auto_retain: Optional[bool] = None
    retain_every_n_turns: Optional[int] = None

    def as_args(self) -> List[str]:
        return [self.provider, self.model] + ([self.base_url] if self.base_url else [])

    def recall_args(self) -> List[str]:
        return [str(self.recall_max_tokens), str(self.recall_budget)]

    def hindsight_file_updates(self) -> Dict[str, Any]:
        """The subset of `parley_hindsight_config`'s keys THIS spec names,
        ready to hand to ``hc.plan_updates``. Empty when the profile named
        none of them (LLM-routing-only switch)."""
        updates: Dict[str, Any] = {}
        if self.recall_max_tokens is not None:
            updates[hc.KEY_RECALL_MAX_TOKENS] = self.recall_max_tokens
        if self.recall_budget is not None:
            updates[hc.KEY_RECALL_BUDGET] = self.recall_budget
        if self.auto_recall is not None:
            updates[hc.KEY_AUTO_RECALL] = self.auto_recall
        if self.auto_retain is not None:
            updates[hc.KEY_AUTO_RETAIN] = self.auto_retain
        if self.retain_every_n_turns is not None:
            updates[hc.KEY_RETAIN_EVERY_N_TURNS] = self.retain_every_n_turns
        return updates

    def has_hindsight_file_updates(self) -> bool:
        return bool(self.hindsight_file_updates())


@dataclass(frozen=True)
class ApplyPlan:
    """Everything a switch will do, computed before anything is written.

    Three separate config writes, not one, so each doc-mandated step is
    durable on its own:

      1. ``snapshot_updates`` — seed + the leaving profile's live model.
      2. ``config_updates``   — the target profile's routing.
      3. env + memory restart (``env_updates`` / ``memory``).
      4. ``marker_updates``   — the active profile, LAST.
    """
    target: str
    leaving: str
    snapshot_updates: Dict[str, Any]
    config_updates: Dict[str, Any]
    env_updates: Dict[str, Optional[str]]
    marker_updates: Dict[str, Any]
    memory: Optional[MemorySpec]
    restart_memory: bool
    profile: Dict[str, Any] = field(default_factory=dict)

    def touched_config_paths(self) -> List[str]:
        return sorted(set(self.snapshot_updates) | set(self.config_updates) | set(self.marker_updates))

    def touched_env_keys(self) -> List[str]:
        return sorted(self.env_updates)

    def as_dict(self) -> Dict[str, Any]:
        """JSON-able view — used by the read-only audit and the logs."""
        return {
            "target": self.target,
            "leaving": self.leaving,
            "snapshot_updates": self.snapshot_updates,
            "config_updates": self.config_updates,
            "env_updates": self.env_updates,
            "marker_updates": self.marker_updates,
            "memory": None if self.memory is None else {
                "provider": self.memory.provider,
                "model": self.memory.model,
                "base_url": self.memory.base_url,
                "recall_max_tokens": self.memory.recall_max_tokens,
                "recall_budget": self.memory.recall_budget,
                "auto_recall": self.memory.auto_recall,
                "auto_retain": self.memory.auto_retain,
                "retain_every_n_turns": self.memory.retain_every_n_turns,
            },
            "restart_memory": self.restart_memory,
            "touched_config_paths": self.touched_config_paths(),
            "touched_env_keys": self.touched_env_keys(),
        }


def _parsed_recall(profile_name: str, mem: Mapping[str, Any]) -> Tuple[Optional[int], Optional[str]]:
    """Validate & default-fill the profile's hindsight recall knobs.

    Neither key present -> ``(None, None)`` (recall untouched by this
    switch). Either key present -> BOTH are returned, filling the missing
    half with hermes' own defaults (4096 / mid) and logging that it did —
    a profile that means to cap tokens but forgets budget must not leave
    it half-configured. Validation itself is delegated to
    ``parley_hindsight_config`` so a profile switch and a Settings-panel
    edit reject the same bad values the same way.
    """
    has_tokens = "recall_max_tokens" in mem
    has_budget = "recall_budget" in mem
    if not has_tokens and not has_budget:
        return None, None

    try:
        tokens = hc.validate_recall_max_tokens(mem.get("recall_max_tokens", DEFAULT_RECALL_MAX_TOKENS))
        budget = hc.validate_recall_budget(mem.get("recall_budget", DEFAULT_RECALL_BUDGET))
    except hc.HindsightConfigError as e:
        raise ProfileError(f"profile {profile_name!r} memory.{e}")

    if not has_tokens:
        logger.info(
            "[parley] profile %r names recall_budget but not recall_max_tokens; "
            "filling recall_max_tokens=%d (hermes default)", profile_name, tokens,
        )
    if not has_budget:
        logger.info(
            "[parley] profile %r names recall_max_tokens but not recall_budget; "
            "filling recall_budget=%r (hermes default)", profile_name, budget,
        )
    return tokens, budget


_BOOL_FLAG_VALIDATORS = {
    hc.KEY_AUTO_RECALL: hc.validate_auto_recall,
    hc.KEY_AUTO_RETAIN: hc.validate_auto_retain,
}


def _parsed_bool_flag(profile_name: str, mem: Mapping[str, Any], key: str) -> Optional[bool]:
    """Validate an independent hindsight boolean the profile MAY carry
    (``auto_recall``/``auto_retain``) — unlike the recall pair, these have
    no "fill the other half" partner: a profile can set either, both, or
    neither."""
    if key not in mem:
        return None
    try:
        return _BOOL_FLAG_VALIDATORS[key](mem[key])
    except hc.HindsightConfigError as e:
        raise ProfileError(f"profile {profile_name!r} memory.{e}")


def _parsed_retain_every_n_turns(profile_name: str, mem: Mapping[str, Any]) -> Optional[int]:
    if hc.KEY_RETAIN_EVERY_N_TURNS not in mem:
        return None
    try:
        return hc.validate_retain_every_n_turns(mem[hc.KEY_RETAIN_EVERY_N_TURNS])
    except hc.HindsightConfigError as e:
        raise ProfileError(f"profile {profile_name!r} memory.{e}")


def plan_apply(cfg: Mapping[str, Any], env: Mapping[str, str], target: str) -> ApplyPlan:
    """Pure: the exact writes a switch to *target* would perform.

    Nothing here reads the clock, the network, the filesystem or systemd —
    which is what makes "does this touch anything outside model /
    auxiliary / fallback_providers / compression / parley.runtime_profile(s)
    and the three HINDSIGHT_API_LLM_* keys?" a unit-testable question.
    """
    name = (target or "").strip()
    if not _PROFILE_NAME_RE.match(name):
        raise ProfileError(f"invalid runtime profile name: {target!r}")
    profiles = read_profiles(cfg, env, strict=True)
    if name not in profiles:
        raise ProfileError(
            f"unknown runtime profile {name!r}; known: {', '.join(sorted(profiles)) or 'none'}"
        )
    profile = profiles[name]
    leaving = read_active_profile(cfg)

    # 1. Snapshot. Copy the LIVE model block over the leaving profile's, so
    #    a later switch back restores the user's most recent picker choice
    #    (LOCAL_MODE.md §1 rule 2.2 / rule 3). The whole profiles block is
    #    the write target because on first run it also has to be seeded.
    snapshot = copy.deepcopy(profiles)
    if leaving in snapshot:
        live_model = _model_block(cfg)
        if live_model:
            snapshot[leaving]["model"] = live_model
    snapshot_updates: Dict[str, Any] = {PROFILES_PATH: snapshot}

    # 2. Target routing. Ordered dict — the audit prints it in write order.
    config_updates: Dict[str, Any] = {}
    model_block = profile.get("model")
    if isinstance(model_block, Mapping) and model_block:
        # Whole-block replace, not merge: a leftover cloud base_url under a
        # local provider would route every turn at the wrong endpoint.
        config_updates["model"] = copy.deepcopy(dict(model_block))
    aux = profile.get("auxiliary")
    if isinstance(aux, Mapping):
        for aux_name, aux_body in aux.items():
            if not isinstance(aux_body, Mapping):
                continue
            # Leaf-level writes: only the keys the profile names, so the
            # sibling `timeout` / `api_key` / `extra_body` hermes maintains
            # on each auxiliary entry survive the switch.
            for key, value in aux_body.items():
                config_updates[f"auxiliary.{aux_name}.{key}"] = copy.deepcopy(value)
    if "fallback_providers" in profile:
        config_updates["fallback_providers"] = copy.deepcopy(profile.get("fallback_providers") or [])
    comp = profile.get("compression")
    if isinstance(comp, Mapping):
        for key, value in comp.items():
            config_updates[f"compression.{key}"] = copy.deepcopy(value)

    # 2b. tools.tool_search — wholesale replace of that ONE subtree. `{}`
    #     restores hermes defaults; any other key under `tools` is refused
    #     (widening `tools`/`skills` must not silently widen past the one
    #     sub-path each was widened for).
    tools = profile.get("tools")
    if isinstance(tools, Mapping):
        extra = set(tools) - {ALLOWED_TOOLS_SUBKEY}
        if extra:
            raise ProfileError(
                f"profile {name!r} may only set tools.{ALLOWED_TOOLS_SUBKEY!r}; "
                f"found unexpected tools.* key(s): {', '.join(sorted(extra))}"
            )
        if ALLOWED_TOOLS_SUBKEY in tools:
            tool_search = tools[ALLOWED_TOOLS_SUBKEY]
            if not isinstance(tool_search, Mapping):
                raise ProfileError(
                    f"profile {name!r} tools.{ALLOWED_TOOLS_SUBKEY} must be a mapping "
                    f"(use {{}} for hermes defaults), got {type(tool_search).__name__}"
                )
            config_updates[f"tools.{ALLOWED_TOOLS_SUBKEY}"] = copy.deepcopy(dict(tool_search))
    elif tools is not None:
        raise ProfileError(f"profile {name!r} tools must be a mapping, got {type(tools).__name__}")

    # 2c. skills.platform_disabled.<platform> — leaf-level, like auxiliary:
    #     only the named platform's list is replaced, siblings (other
    #     platforms, the GLOBAL skills.disabled list) survive untouched.
    skills = profile.get("skills")
    if isinstance(skills, Mapping):
        extra = set(skills) - {ALLOWED_SKILLS_SUBKEY}
        if extra:
            raise ProfileError(
                f"profile {name!r} may only set skills.{ALLOWED_SKILLS_SUBKEY!r}; "
                f"found unexpected skills.* key(s): {', '.join(sorted(extra))}"
            )
        if ALLOWED_SKILLS_SUBKEY in skills:
            platform_disabled = skills[ALLOWED_SKILLS_SUBKEY]
            if not isinstance(platform_disabled, Mapping):
                raise ProfileError(
                    f"profile {name!r} skills.{ALLOWED_SKILLS_SUBKEY} must be a mapping "
                    f"of platform -> skill names, got {type(platform_disabled).__name__}"
                )
            for platform, names in platform_disabled.items():
                if not isinstance(platform, str) or not platform.strip():
                    raise ProfileError(
                        f"profile {name!r} skills.{ALLOWED_SKILLS_SUBKEY} has an invalid "
                        f"platform key: {platform!r}"
                    )
                if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
                    raise ProfileError(
                        f"profile {name!r} skills.{ALLOWED_SKILLS_SUBKEY}[{platform!r}] must "
                        f"be a list of skill names"
                    )
                config_updates[f"skills.{ALLOWED_SKILLS_SUBKEY}.{platform}"] = copy.deepcopy(list(names))
    elif skills is not None:
        raise ProfileError(f"profile {name!r} skills must be a mapping, got {type(skills).__name__}")

    # 2d. cron.model / cron.model_provider — leaf-level, restricted to the
    #     two keys parley_route_jobs.py's bulk-model endpoint writes (LOCAL_
    #     MODE.md §1 rule 7). Everything else under `cron` (model_provider's
    #     scheduler-side sibling `provider`, `model_drift_guard`,
    #     `preflight`, chronos settings, …) is owner/hermes territory and
    #     survives untouched, same as auxiliary's leaf merge.
    cron = profile.get("cron")
    if isinstance(cron, Mapping):
        extra = set(cron) - ALLOWED_CRON_SUBKEYS
        if extra:
            raise ProfileError(
                f"profile {name!r} may only set cron.{{{', '.join(sorted(ALLOWED_CRON_SUBKEYS))}}}; "
                f"found unexpected cron.* key(s): {', '.join(sorted(extra))}"
            )
        for key, value in cron.items():
            if not isinstance(value, str):
                raise ProfileError(
                    f"profile {name!r} cron.{key} must be a string, got {type(value).__name__}"
                )
            config_updates[f"cron.{key}"] = value
    elif cron is not None:
        raise ProfileError(f"profile {name!r} cron must be a mapping, got {type(cron).__name__}")

    # 3. hindsight env. An absent/blank base_url is written as None =
    #    REMOVE THE KEY: hindsight reads `os.getenv(...) or None`, so an
    #    empty line is equivalent, but removing it keeps .env honest about
    #    what is actually set (the cloud profile has no base_url at all).
    mem = profile.get("memory") if isinstance(profile.get("memory"), Mapping) else {}
    memory: Optional[MemorySpec] = None
    env_updates: Dict[str, Optional[str]] = {}
    provider = str(mem.get("llm_provider") or "").strip()
    model = str(mem.get("llm_model") or "").strip()
    base_url = str(mem.get("llm_base_url") or "").strip()

    # 3b. hindsight's OWN config file (parley_hindsight_config.py — a
    #     DIFFERENT file than the env above, no restart). A profile may
    #     name any subset of these five; the recall pair fills its missing
    #     half with hermes' defaults (see _parsed_recall), the other three
    #     are independent optionals.
    recall_max_tokens, recall_budget = _parsed_recall(name, mem)
    auto_recall = _parsed_bool_flag(name, mem, hc.KEY_AUTO_RECALL)
    auto_retain = _parsed_bool_flag(name, mem, hc.KEY_AUTO_RETAIN)
    retain_every_n_turns = _parsed_retain_every_n_turns(name, mem)
    has_hindsight_file_updates = any(x is not None for x in (
        recall_max_tokens, auto_recall, auto_retain, retain_every_n_turns,
    ))

    if provider or model:
        env_updates[ENV_MEMORY_PROVIDER] = provider
        env_updates[ENV_MEMORY_MODEL] = model
        env_updates[ENV_MEMORY_BASE_URL] = base_url or None
    if provider or model or has_hindsight_file_updates:
        memory = MemorySpec(
            provider=provider, model=model, base_url=base_url,
            recall_max_tokens=recall_max_tokens, recall_budget=recall_budget,
            auto_recall=auto_recall, auto_retain=auto_retain,
            retain_every_n_turns=retain_every_n_turns,
        )

    # Restart only when hindsight would actually see something new: a
    # pointless restart drops in-flight retains and shows up in the health
    # digest as an unexplained bounce.
    def _current(key: str) -> Optional[str]:
        raw = env.get(key)
        raw = raw.strip() if isinstance(raw, str) else raw
        return raw or None

    restart = any(_current(k) != (v or None) for k, v in env_updates.items())

    plan = ApplyPlan(
        target=name,
        leaving=leaving,
        snapshot_updates=snapshot_updates,
        config_updates=config_updates,
        env_updates=env_updates,
        marker_updates={ACTIVE_PROFILE_PATH: name},
        memory=memory,
        restart_memory=restart,
        profile=copy.deepcopy(profile),
    )

    # Blast-radius assertion. Cheap, and it turns "someone added a profile
    # key that writes agent.max_turns" into a loud failure instead of a
    # silent rewrite of the owner's live agent.
    for path in plan.touched_config_paths():
        root = path.split(".", 1)[0]
        if root not in ALLOWED_CONFIG_ROOTS:
            raise ProfileError(f"profile {name!r} would write outside the allowed config roots: {path}")
    for key in plan.touched_env_keys():
        if key not in MEMORY_ENV_KEYS:
            raise ProfileError(f"profile {name!r} would write an unexpected env key: {key}")
    return plan


# ── local-server probe (the only network in this module) ────────────────

def _http_get(url: str, timeout: float) -> Tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 - loopback only
            return int(resp.status or 0), resp.read()
    except urllib.error.HTTPError as e:  # a 4xx/5xx is still an answer
        return int(e.code or 0), b""


def _server_root(base_url: str) -> str:
    """``http://host:port/v1`` -> ``http://host:port`` — /health is served
    at the server root, /v1/models under the OpenAI-compatible prefix."""
    root = (base_url or "").strip().rstrip("/")
    return root[: -len("/v1")] if root.endswith("/v1") else root


@dataclass(frozen=True)
class ServerProbe:
    ok: bool
    detail: str
    models: Tuple[str, ...] = ()


def probe_model_server(
    base_url: str,
    model_id: str = "",
    *,
    timeout: float = 2.0,
    http_get: Callable[[str, float], Tuple[int, bytes]] = _http_get,
) -> ServerProbe:
    """GET /health then /v1/models. Never raises — the caller decides
    whether a dead server is a rejection (preflight) or a description
    ("server not responding" in the enum option)."""
    root = _server_root(base_url)
    if not root:
        return ServerProbe(False, "no base_url configured for this profile")
    try:
        status, _ = http_get(f"{root}/health", timeout)
    except Exception as e:
        return ServerProbe(False, f"{root} is not answering ({type(e).__name__})")
    if status != 200:
        return ServerProbe(False, f"{root}/health returned HTTP {status}")
    try:
        status, body = http_get(f"{root}/v1/models", timeout)
        payload = json.loads(body.decode("utf-8", "replace")) if body else {}
    except Exception as e:
        return ServerProbe(False, f"{root}/v1/models is not answering ({type(e).__name__})")
    if status != 200:
        return ServerProbe(False, f"{root}/v1/models returned HTTP {status}")
    models = tuple(
        str(m.get("id") or "").strip()
        for m in (payload.get("data") or [])
        if isinstance(m, Mapping) and str(m.get("id") or "").strip()
    )
    if model_id and model_id not in models:
        return ServerProbe(
            False,
            f"{root} is up but does not serve {model_id!r} (has: {', '.join(models) or 'nothing'})",
            models,
        )
    return ServerProbe(True, f"{root} ready", models)


def local_model_id(profile: Mapping[str, Any]) -> str:
    model = profile.get("model")
    return str(model.get("default") or "").strip() if isinstance(model, Mapping) else ""


def local_base_url(profile: Mapping[str, Any]) -> str:
    model = profile.get("model")
    return str(model.get("base_url") or "").strip() if isinstance(model, Mapping) else ""


def preflight_profile(
    target: str,
    profile: Mapping[str, Any],
    *,
    probe: Callable[..., ServerProbe] = probe_model_server,
) -> None:
    """LOCAL_MODE.md §1 rule 2.1 — you cannot toggle into a dead mode.

    ``local`` demands /health 200 AND the profile's model in /v1/models.
    ``cloud`` has no preflight: its endpoint is the internet, and refusing
    the switch because a probe timed out would strand the box in a mode it
    is trying to leave (that is what the fallback chain is for).
    """
    if target != LOCAL_PROFILE:
        return
    result = probe(local_base_url(profile), local_model_id(profile))
    if not result.ok:
        raise ProfileError(
            f"cannot switch to the local profile: {result.detail}. "
            f"Start the local model server (systemctl --user start parley-fallback-llm.service) "
            f"and try again."
        )


# ── the one impure entry point ──────────────────────────────────────────

def apply_runtime_profile(
    target: str,
    *,
    preflight: Callable[[str, Mapping[str, Any]], None],
    write_config: Callable[[Dict[str, Any]], None],
    write_env: Callable[[Mapping[str, Optional[str]]], None],
    restart_memory: Callable[[MemorySpec], None],
    apply_memory_recall: Callable[[MemorySpec], None],
    load: Callable[[], Tuple[Dict[str, Any], Dict[str, str]]],
) -> ApplyPlan:
    """Switch runtime profiles. Every side effect is injected.

    Order is the doc's, and each step is its own durable write:

      preflight -> snapshot(+seed) -> target config -> env + restart
                -> hindsight file (recall/retain) -> active-profile marker LAST

    Three ``write_config`` calls rather than one is deliberate. save_config
    is atomic, so each step lands or doesn't; a crash after the env write
    but before the marker leaves the agent routed at the new profile with
    the setting still reporting the old one — visibly wrong and one click
    from correct. The reverse (marker first) would report a mode the agent
    is not in, which is the failure the doc's rule 5 exists to prevent.

    ``apply_memory_recall`` runs whenever the profile named ANY of the five
    hindsight-file keys (unlike ``restart_memory``, which only fires when
    the LLM env would actually change): that file
    (``parley_hindsight_config.py``) needs no restart, so re-running it
    with the same values is just an idempotent no-op, not a cost worth
    guarding against.

    Returns the plan that was executed, for logging and for the route's
    response.
    """
    cfg, env = load()
    plan = plan_apply(cfg, env, target)

    preflight(plan.target, plan.profile)

    cfg = apply_config_updates(cfg, plan.snapshot_updates)
    write_config(cfg)

    cfg = apply_config_updates(cfg, plan.config_updates)
    write_config(cfg)

    if plan.env_updates:
        write_env(plan.env_updates)
    if plan.restart_memory and plan.memory is not None:
        restart_memory(plan.memory)
    if plan.memory is not None and plan.memory.has_hindsight_file_updates():
        apply_memory_recall(plan.memory)

    cfg = apply_config_updates(cfg, plan.marker_updates)
    write_config(cfg)

    logger.info(
        "[parley] runtime profile %s -> %s (config=%s env=%s restart_memory=%s hindsight=%s)",
        plan.leaving, plan.target, plan.touched_config_paths(),
        plan.touched_env_keys(), plan.restart_memory,
        None if plan.memory is None else plan.memory.hindsight_file_updates() or None,
    )
    return plan
