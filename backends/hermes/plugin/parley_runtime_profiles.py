"""Runtime profiles — "where every model call goes", as one named bundle.

Design: ``~/code/parley/docs/LOCAL_MODE.md`` §1. A *runtime profile* names
the model block, the auxiliary models, the fallback chain, the compression
overrides and hindsight's LLM env for one operating mode. Two ship by
default:

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
all four side effects (preflight probe, config write, env write, memory
restart) as injected callables so tests never touch disk, the network or
systemd. :func:`plan_apply` computes the *entire* change — the exact
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
})

_PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")

# Seed values for the `local` profile (LOCAL_MODE.md §1). Only used when
# `parley.runtime_profiles` is MISSING entirely; once seeded the YAML is
# the editor (per-profile toolsets etc. are hand-edited there).
LOCAL_SERVER_BASE_URL = "http://127.0.0.1:8000/v1"
LOCAL_PROVIDER = "custom:local-fallback"      # `providers.local-fallback` in hermes config
LOCAL_MODEL = "qwen3.6-35b-a3b"               # llama-server --alias


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
    silently rewritten a host whose live model differs (galatea runs
    gpt-5.6-sol, the doc says gpt-6-astra), which is exactly the class of
    bug a "seed from live" rule exists to prevent.

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
        },
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
        },
        # 64K allocated window: compact earlier than the cloud default.
        "compression": {"threshold": 0.6},
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
    """hindsight's LLM routing for a profile — the script's three args."""
    provider: str
    model: str
    base_url: str = ""

    def as_args(self) -> List[str]:
        return [self.provider, self.model] + ([self.base_url] if self.base_url else [])


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
            },
            "restart_memory": self.restart_memory,
            "touched_config_paths": self.touched_config_paths(),
            "touched_env_keys": self.touched_env_keys(),
        }


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
    if provider or model:
        memory = MemorySpec(provider=provider, model=model, base_url=base_url)
        env_updates[ENV_MEMORY_PROVIDER] = provider
        env_updates[ENV_MEMORY_MODEL] = model
        env_updates[ENV_MEMORY_BASE_URL] = base_url or None

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
    load: Callable[[], Tuple[Dict[str, Any], Dict[str, str]]],
) -> ApplyPlan:
    """Switch runtime profiles. Every side effect is injected.

    Order is the doc's, and each step is its own durable write:

      preflight -> snapshot(+seed) -> target config -> env + restart
                -> active-profile marker LAST

    Three ``write_config`` calls rather than one is deliberate. save_config
    is atomic, so each step lands or doesn't; a crash after the env write
    but before the marker leaves the agent routed at the new profile with
    the setting still reporting the old one — visibly wrong and one click
    from correct. The reverse (marker first) would report a mode the agent
    is not in, which is the failure the doc's rule 5 exists to prevent.

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

    cfg = apply_config_updates(cfg, plan.marker_updates)
    write_config(cfg)

    logger.info(
        "[parley] runtime profile %s -> %s (config=%s env=%s restart_memory=%s)",
        plan.leaving, plan.target, plan.touched_config_paths(),
        plan.touched_env_keys(), plan.restart_memory,
    )
    return plan
