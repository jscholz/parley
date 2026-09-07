"""HTTP route handlers for the optional settings extension.

Extracted from ``__init__.py`` 2026-05-17. Covers four endpoints
plus their settings-apply logic (the largest single chunk in this
refactor — ~700 LOC):

  - GET  /v1/settings/schema             list user-facing knobs
  - POST /v1/settings/{id}               apply one setting
  - GET  /v1/parley/auxiliary-models   surface aux vision model
  - GET  /v1/parley/model-capabilities models.dev caps lookup

Plus the helpers:

  - read_hermes_config        snapshot ~/.hermes/config.yaml
  - read_hermes_env           snapshot ~/.hermes/.env
  - read_preferred_models     resolve the model-picker glob filter
  - build_settings_schema     compose the SettingDef[] list
  - apply_setting             dispatch by setting id
  - apply_preferred_models    persist the glob list
  - apply_model_setting       persist model.default + provider
  - apply_runtime_profile_setting   switch runtime profiles (LOCAL_MODE.md §1)
  - apply_memory_toggle       hermes memory.* booleans

Two feature groups landed here 2026-09-07 (docs/LOCAL_MODE.md):

  * ``runtime_profile`` — an enum that reroutes EVERY model call (chat,
    auxiliary, crons, hindsight) between the cloud stack and the local
    llama.cpp server. The mechanics live in parley_runtime_profiles.py;
    this file only declares the setting and injects the side effects.
  * category ``Memory`` — two hermes toggles plus three ``readonly``
    text fields describing what memory is doing and with what.

And the exception classes that route _apply_setting failures to
HTTP 400 / 404 in the handler.

Wiring contract: each handler takes ``(adapter, request)`` where
adapter is the calling ``ParleyAdapter`` instance. The helpers
also take ``adapter`` first when they need access to the live
state.db path / etc.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path
from .parley_env import env_get
from typing import Any, Dict, List, Optional, Set

from . import parley_runtime_profiles as rp

# Guarded aiohttp import — see parley_route_conversations for why.
try:
    from aiohttp import web  # type: ignore[assignment]
except ImportError:  # pragma: no cover
    web = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)


class SettingsValidationError(ValueError):
    """Raised by apply_setting when the value is invalid for the
    declared type. Maps to HTTP 400 in handle_update."""


class SettingsNotFoundError(KeyError):
    """Raised by apply_setting when the setting id isn't declared.
    Maps to HTTP 404 in handle_update."""


def read_hermes_config() -> Dict[str, Any]:
    """Snapshot of ~/.hermes/config.yaml as a dict (or {} on failure).
    Used by every settings read so we work from one consistent
    view per request. Raw read — no normalization."""
    try:
        import yaml
        from hermes_cli.config import get_config_path
        cfg_path = get_config_path()
        if not cfg_path.exists():
            return {}
        with open(cfg_path, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception as e:
        logger.warning("[parley] settings: read hermes config failed: %s", e)
        return {}


def read_preferred_models(cfg: Dict[str, Any]) -> List[str]:
    """Resolve the preferred-models glob list. Source of truth:
    ``parley.preferred_models:`` in ~/.hermes/config.yaml (a yaml
    list of glob strings). Falls back to PARLEY_PREFERRED_MODELS
    env (comma-separated) for env-only deployments. Empty result
    = no filter (full catalog)."""
    sk = cfg.get("parley") if isinstance(cfg.get("parley"), dict) else {}
    raw = sk.get("preferred_models")
    if isinstance(raw, list):
        out = [str(g).strip() for g in raw if isinstance(g, str) and str(g).strip()]
        if out:
            return out
    env_raw = (env_get("PARLEY_PREFERRED_MODELS") or "").strip()
    if env_raw:
        return [g.strip() for g in env_raw.split(",") if g.strip()]
    return []


# Probing the local model server on every schema build is deliberate: the
# `local` option's description has to tell the truth about whether the box
# can serve it right now, and a stale cached answer is exactly how you get a
# toggle that says "ready" for a server that died an hour ago. Loopback, so
# both the up and the connection-refused answers are effectively instant; the
# timeout only bounds a HUNG server.
_LOCAL_PROBE_TIMEOUT = 1.5


def read_hermes_env() -> Dict[str, str]:
    """Snapshot of ~/.hermes/.env as a dict (or {} on failure).

    Deliberately the dotenv file rather than ``os.environ``: the .env is what
    ``hindsight-server.service`` loads via ``EnvironmentFile=`` and what the
    memory-profile script writes, so it is the only view that agrees with
    what a restart would pick up. A value inherited into the gateway's
    process environment at boot can be arbitrarily stale.
    """
    try:
        from hermes_cli.config import load_env
        return dict(load_env() or {})
    except Exception as e:
        logger.warning("[parley] settings: read hermes env failed: %s", e)
        return {}


def _probe_local_server(profile: Dict[str, Any]) -> "rp.ServerProbe":
    """Readiness of the local model server described by *profile*.
    Split out as a module-level seam so tests can inject an answer without
    a socket."""
    return rp.probe_model_server(
        rp.local_base_url(profile), rp.local_model_id(profile),
        timeout=_LOCAL_PROBE_TIMEOUT,
    )


def _cloud_model_catalog(
    cfg: Dict[str, Any], preferred: List[str],
    current_provider: str, model_cfg: Any,
) -> List[Dict[str, Any]]:
    """Model-picker options for cloud-routed profiles — unchanged behaviour,
    lifted out of build_settings_schema 2026-09-07 so the local profile can
    swap in a different catalog without paying for OpenRouter round-trips it
    cannot reach while off-grid."""
    import fnmatch
    # Openrouter catalog. Defensive parse: shape can be tuple,
    # dict, or string depending on hermes version. Degrade to "no
    # options" instead of 500ing the whole settings panel.
    catalog: List[Dict[str, Any]] = []
    try:
        from hermes_cli.models import fetch_openrouter_models
        raw = fetch_openrouter_models() or []
        for entry in raw:
            if isinstance(entry, tuple) and len(entry) >= 1:
                mid = str(entry[0] or "").strip()
                tag = str(entry[1] or "").strip() if len(entry) >= 2 else ""
            elif isinstance(entry, dict):
                mid = str(entry.get("id") or "").strip()
                tag = ""
            elif isinstance(entry, str):
                mid = entry.strip()
                tag = ""
            else:
                continue
            if not mid:
                continue
            label = f"{mid} ({tag})" if tag else mid
            catalog.append({"value": mid, "label": label, "group": "OpenRouter"})
    except Exception as e:
        logger.warning("[parley] settings: openrouter catalog fetch failed: %s", e)

    # Filter catalog by preferred globs (empty = no filter).
    if preferred and catalog:
        catalog = [
            e for e in catalog
            if any(fnmatch.fnmatch(e["value"], g) for g in preferred)
        ]

    # Supplement with the LIVE openrouter catalog for any preferred
    # glob whose pattern matched nothing in hermes' curated list.
    # The curated list lags reality — e.g. google/gemma-4* never
    # made it in. The user's explicit glob is authoritative.
    if preferred:
        try:
            import urllib.request
            req = urllib.request.Request(
                "https://openrouter.ai/api/v1/models",
                headers={"Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                payload = json.loads(resp.read().decode())
            live_ids = [
                str(item.get("id") or "").strip()
                for item in (payload.get("data") or [])
                if isinstance(item, dict)
            ]
            seen = {e["value"] for e in catalog}
            for mid in live_ids:
                if not mid or mid in seen:
                    continue
                if any(fnmatch.fnmatch(mid, g) for g in preferred):
                    catalog.append({"value": mid, "label": mid, "group": "OpenRouter"})
                    seen.add(mid)
        except Exception as e:
            logger.warning(
                "[parley] settings: live openrouter supplement failed: %s", e,
            )

    # Pull EVERY other authenticated provider's curated model list
    # (Codex OAuth, Copilot OAuth, Anthropic API key, etc.).
    sk_cfg = cfg.get("parley", {}) if isinstance(cfg.get("parley"), dict) else {}
    exclude_providers = set()
    for p in (sk_cfg.get("exclude_providers") or []):
        if isinstance(p, str):
            exclude_providers.add(p.strip().lower())
    exclude_models_globs = []
    for m in (sk_cfg.get("exclude_models") or []):
        if isinstance(m, str) and m.strip():
            exclude_models_globs.append(m.strip())
    try:
        from hermes_cli.model_switch import list_authenticated_providers
        for prov in list_authenticated_providers(
            current_provider=current_provider,
            current_base_url=str((model_cfg or {}).get("base_url", "") if isinstance(model_cfg, dict) else ""),
            user_providers=cfg.get("providers"),
            custom_providers=cfg.get("custom_providers"),
        ) or []:
            slug = (prov.get("slug") or "").strip()
            name = (prov.get("name") or slug).strip()
            if not slug or slug == "openrouter":
                continue
            if slug.lower() in exclude_providers:
                continue
            for mid in (prov.get("models") or []):
                mid_s = str(mid).strip()
                if not mid_s:
                    continue
                encoded = f"{slug}:{mid_s}"
                if exclude_models_globs and any(
                    fnmatch.fnmatch(encoded, g) for g in exclude_models_globs
                ):
                    continue
                catalog.append({
                    "value": encoded,
                    "label": mid_s,
                    "group": name,
                })
    except Exception as e:
        logger.warning(
            "[parley] settings: list_authenticated_providers failed: %s", e,
        )

    # Ordering + the "always show the current value" insert are the
    # caller's job now: both are shared with the local catalog.
    return catalog


def _local_model_catalog(
    profile: Dict[str, Any], probe: "rp.ServerProbe",
) -> List[Dict[str, Any]]:
    """Model-picker options in the ``local`` profile: whatever the local
    server actually lists (LOCAL_MODE.md §1 rule 3). Values are bare model
    ids — the provider comes from the profile, not from a ``<slug>:`` prefix,
    because the local provider slug (``custom:local-fallback``) already
    contains a colon and would not survive apply_model_setting's decoder."""
    ids = list(probe.models)
    if not ids:
        # Server down: still show what the profile is pinned to, so the
        # picker reports the truth rather than an empty dropdown.
        pinned = rp.local_model_id(profile)
        ids = [pinned] if pinned else []
    return [{"value": mid, "label": mid, "group": "Local server"} for mid in ids]


def _runtime_profile_setting(
    active: str, profiles: Dict[str, Any], probe: "rp.ServerProbe",
) -> Dict[str, Any]:
    """The one enum that reroutes every model call (LOCAL_MODE.md §1 rule 1).

    Option descriptions are built from the profiles' OWN values, so a box
    whose cloud profile points somewhere unusual describes itself correctly.
    """
    def _summary(name: str) -> str:
        model = (profiles.get(name) or {}).get("model") or {}
        if not isinstance(model, dict):
            return ""
        mid = str(model.get("default") or "").strip()
        prov = str(model.get("provider") or "").strip()
        return " · ".join(x for x in (prov, mid) if x)

    options = []
    for name in sorted(profiles):
        desc = _summary(name)
        if name == rp.LOCAL_PROFILE:
            # The doc's rule: you cannot toggle into a dead mode, so say up
            # front whether it is alive. The preflight enforces it; this is
            # only so the user is not guessing before they click.
            desc = f"{desc} — {'ready' if probe.ok else 'server not responding'}".strip(" —")
        elif name == rp.DEFAULT_PROFILE:
            desc = f"{desc} — needs the internet".strip(" —")
        options.append({
            "value": name,
            "label": name.capitalize(),
            "description": desc or name,
        })
    return {
        "id": "runtime_profile",
        "label": "Runtime profile",
        "description": (
            "Where every model call goes — chat, auxiliary models, crons and "
            "memory. New conversations pick the change up immediately; a "
            "conversation that is already open keeps its current model until "
            "the agent is evicted (same caveat as the model picker)."
        ),
        "category": "Agent",
        # Sub-heading within the Agent category (LOCAL_MODE.md §1 rule 1).
        # The PWA renders `group` as a heading above the first setting
        # carrying it — see the protocol's Setting fields.
        "group": "Runtime",
        "type": "enum",
        "value": active,
        "options": options,
    }


# hermes config paths behind the two writable Memory toggles.
_MEMORY_TOGGLES = {
    "memory_enabled": "memory.memory_enabled",
    "memory_user_profile": "memory.user_profile_enabled",
}
# Declared but never accepted on POST. The PWA renders `readonly: true` as a
# value line and never submits it; apply_setting rejects one anyway, because
# "the client won't do that" is not a validation strategy.
_MEMORY_READONLY = ("memory_llm", "memory_embeddings", "memory_status")


def _memory_settings(cfg: Dict[str, Any], env: Dict[str, str]) -> List[Dict[str, Any]]:
    """Settings › Memory (LOCAL_MODE.md §3): what memory is doing, with what,
    and the two switches that turn it off."""
    mem = cfg.get("memory") if isinstance(cfg.get("memory"), dict) else {}

    def _txt(sid: str, label: str, value: str, description: str) -> Dict[str, Any]:
        return {
            "id": sid, "label": label, "description": description,
            "category": "Memory", "type": "text", "value": value,
            "readonly": True,
        }

    llm = " · ".join(x for x in (
        (env.get(rp.ENV_MEMORY_PROVIDER) or "").strip(),
        (env.get(rp.ENV_MEMORY_MODEL) or "").strip(),
    ) if x) or "not configured"
    base = (env.get(rp.ENV_MEMORY_BASE_URL) or "").strip()
    if base:
        llm = f"{llm} @ {base}"

    embeddings = " · ".join(x for x in (
        (env.get("HINDSIGHT_API_EMBEDDINGS_PROVIDER") or "").strip(),
        (env.get("HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL") or "").strip(),
    ) if x) or "not configured"

    return [
        {
            "id": "memory_enabled",
            "label": "Memory",
            "description": "Retain facts from conversations and recall them later.",
            "category": "Memory",
            "type": "toggle",
            "value": bool(mem.get("memory_enabled", True)),
        },
        {
            "id": "memory_user_profile",
            "label": "User profile",
            "description": "Maintain a running profile of the user from retained facts.",
            "category": "Memory",
            "type": "toggle",
            "value": bool(mem.get("user_profile_enabled", True)),
        },
        _txt("memory_llm", "Extraction model", llm,
             "Follows the runtime profile — change it there, not here."),
        _txt("memory_embeddings", "Embeddings", embeddings,
             "Stays on OpenAI in every profile: the stored vectors are "
             "1536-d, so changing the embedder needs a full re-index."),
        _txt("memory_status", "Status", memory_status_text(),
             "hindsight-server, its last retain, and LLM errors in 24h."),
    ]


def build_settings_schema() -> List[Dict[str, Any]]:
    """Build the SettingDef[] list. Reads hermes config.yaml for
    the current model + the preferred-models glob filter (under
    ``parley.preferred_models:``). Picker options merge OpenRouter
    (filtered by user's preferred-globs) with EVERY other
    authenticated provider's curated model list (e.g. openai-codex
    OAuth, copilot, anthropic). Provider is encoded into the option
    value: OpenRouter entries stay bare (vendor/model), every other
    provider prefixes with ``<slug>:`` (e.g. ``openai-codex:gpt-5.5``).
    apply_model_setting parses the prefix back to route the switch
    to the right provider.

    In the ``local`` runtime profile the picker instead lists the local
    server's own /v1/models (LOCAL_MODE.md §1 rule 3) — the cloud catalog
    is not just wrong there, it is unreachable off-grid."""
    cfg = read_hermes_config()
    env = read_hermes_env()

    # Current model + provider — hermes stores model as scalar
    # (``model: google/gemma-4-26b-a4b-it``) or dict (``model:
    # {default: ..., provider: ...}``); handle both. Default
    # provider when unset is "openrouter" (matches hermes default).
    current_model = ""
    current_provider = "openrouter"
    model_cfg = cfg.get("model")
    if isinstance(model_cfg, dict):
        current_model = (model_cfg.get("default") or "").strip()
        current_provider = (model_cfg.get("provider") or "openrouter").strip()
    elif isinstance(model_cfg, str):
        current_model = model_cfg.strip()
    if current_provider == "openrouter" or not current_model:
        current_value = current_model
    else:
        current_value = f"{current_provider}:{current_model}"

    preferred = read_preferred_models(cfg)

    active_profile = rp.read_active_profile(cfg)
    profiles = rp.read_profiles(cfg, env)
    local_profile = profiles.get(rp.LOCAL_PROFILE) or {}
    probe = _probe_local_server(local_profile)

    if active_profile == rp.LOCAL_PROFILE:
        # The local picker's values are bare model ids (the local provider
        # slug already contains a colon and cannot be prefix-encoded), so
        # the current value has to be bare too or nothing matches and the
        # picker shows a phantom "Current" row.
        current_value = current_model
        catalog = _local_model_catalog(local_profile, probe)
    else:
        catalog = _cloud_model_catalog(cfg, preferred, current_provider, model_cfg)

    # Always include the current model in options[] so the picker
    # can show "what's set now" even if the catalog filter excluded
    # it. Use the encoded value (with provider prefix for non-
    # openrouter) so the picker matches what's stored.
    if current_value and not any(e["value"] == current_value for e in catalog):
        catalog.insert(0, {
            "value": current_value,
            "label": current_value,
            "group": "Current",
        })

    _GROUP_RANK = {"Current": 0, "Local server": 0, "OpenRouter": 1}
    catalog.sort(key=lambda e: (
        _GROUP_RANK.get(e.get("group", ""), 2),
        (e.get("group") or "").lower(),
        (e.get("label") or "").lower(),
    ))

    return [
        {
            "id": "model",
            "label": "Model",
            "description": "LLM used for replies",
            "category": "Agent",
            "type": "enum",
            "value": current_value,
            "options": catalog,
        },
        {
            "id": "preferred_models",
            "label": "Preferred models",
            "description": (
                "Glob patterns that filter the model dropdown above "
                "(e.g. anthropic/*, google/gemini-*). Empty = full "
                "openrouter catalog."
            ),
            "category": "Agent",
            "type": "string-list",
            "value": preferred,
            "placeholder": "e.g. anthropic/* + Enter",
        },
        _runtime_profile_setting(active_profile, profiles, probe),
        *_memory_settings(cfg, env),
    ]


def apply_setting(sid: str, value: Any) -> Dict[str, Any]:
    """Apply one setting and return the updated def. Synchronous —
    called from a thread executor since switch_model + config
    write are blocking. Raises SettingsValidationError /
    SettingsNotFoundError to map to 400 / 404 respectively."""
    if sid == "model":
        return apply_model_setting(value)
    if sid == "preferred_models":
        return apply_preferred_models_setting(value)
    if sid == "runtime_profile":
        return apply_runtime_profile_setting(value)
    if sid in _MEMORY_TOGGLES:
        return apply_memory_toggle(sid, value)
    if sid in _MEMORY_READONLY:
        # Declared with ``readonly: true``; the PWA never POSTs one, but a
        # 400 beats silently accepting a write we have nowhere to put.
        raise SettingsValidationError(f"{sid} is read-only")
    raise SettingsNotFoundError(f"unknown setting: {sid}")


def _updated_def(sid: str, fallback: Dict[str, Any]) -> Dict[str, Any]:
    """Re-derive the schema and return one def — the contract's "return the
    full def so the agent can surface side-effects"."""
    for s_def in build_settings_schema():
        if s_def.get("id") == sid:
            return s_def
    return fallback


def apply_preferred_models_setting(value: Any) -> Dict[str, Any]:
    """Persist the preferred-models glob list to ~/.hermes/config.yaml
    under ``parley.preferred_models:``. The next /v1/settings/schema
    response uses the new list to filter the catalog. Already-cached
    agents are unaffected — this knob is purely a UI filter, not an
    agent-runtime setting."""
    if not isinstance(value, list):
        raise SettingsValidationError("preferred_models value must be a list of strings")
    cleaned: List[str] = []
    seen: Set[str] = set()
    for entry in value:
        if not isinstance(entry, str):
            raise SettingsValidationError(
                f"preferred_models entries must be strings; got {type(entry).__name__}"
            )
        t = entry.strip()
        if not t or t in seen:
            continue
        if any(ch in t for ch in (" ", "\t", "\n", "\r")):
            raise SettingsValidationError(
                f"preferred_models entry has whitespace: {t!r}"
            )
        seen.add(t)
        cleaned.append(t)
    try:
        import yaml
        from hermes_cli.config import get_config_path
        cfg_path = get_config_path()
        cfg: Dict[str, Any] = {}
        if cfg_path.exists():
            with open(cfg_path, encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
        sk = cfg.get("parley")
        if not isinstance(sk, dict):
            sk = {}
            cfg["parley"] = sk
        sk["preferred_models"] = cleaned
        from hermes_cli.config import save_config
        save_config(cfg)
    except Exception as e:
        logger.exception("[parley] preferred_models persist failed")
        raise SettingsValidationError(f"failed to write hermes config: {e}")
    new_schema = build_settings_schema()
    for s in new_schema:
        if s["id"] == "preferred_models":
            return s
    return {
        "id": "preferred_models",
        "label": "Preferred models",
        "category": "Agent",
        "type": "string-list",
        "value": cleaned,
    }


def _mirror_model_into_active_profile(cfg: Dict[str, Any]) -> None:
    """Copy the just-resolved ``model:`` block into the ACTIVE profile.

    LOCAL_MODE.md §1 rule 3: "a profile switch never silently forgets a
    picker choice". The leaving-profile snapshot in apply_runtime_profile
    covers the switch itself; this covers the other order — pick a model,
    switch away, switch back — without depending on the snapshot having run.

    Seeds the whole profiles block when it is missing, from live values, so
    the mirror has somewhere to land on a box that has never switched.
    """
    try:
        env = read_hermes_env()
        # strict: refuse to invent a cloud profile out of local routing.
        profiles = rp.read_profiles(cfg, env, strict=True)
        active = rp.read_active_profile(cfg)
        if active in profiles:
            profiles[active]["model"] = dict(cfg.get("model") or {})
        rp.set_path(cfg, rp.PROFILES_PATH, profiles)
    except Exception as e:  # never fail a model switch over the mirror
        logger.warning("[parley] runtime-profile model mirror skipped: %s", e)


def _apply_local_model_setting(model_id: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Model switch inside the ``local`` profile.

    switch_model is deliberately bypassed. Its provider resolution is built
    around catalogs and ``<slug>:<model>`` encodings; the local endpoint has
    neither (its slug contains a colon, and its catalog is the one live
    /v1/models answer we already validated the value against). Writing the
    profile's own provider/base_url with the chosen id is both simpler and
    the only thing that can be correct here — the profile IS the authority
    for where local calls go.
    """
    profile = rp.read_profiles(cfg, read_hermes_env()).get(rp.LOCAL_PROFILE) or {}
    block = profile.get("model") if isinstance(profile.get("model"), dict) else {}
    new_model = dict(block)
    new_model["default"] = model_id
    if not new_model.get("provider"):
        raise SettingsValidationError(
            "the local runtime profile has no model.provider configured"
        )
    cfg["model"] = new_model
    _mirror_model_into_active_profile(cfg)
    try:
        _write_hermes_config(cfg)
    except Exception as e:
        logger.exception("[parley] local model persist failed")
        raise SettingsValidationError(f"failed to write hermes config: {e}")
    return _updated_def("model", {
        "id": "model", "label": "Model", "category": "Agent",
        "type": "enum", "value": model_id, "options": [],
    })


def apply_model_setting(value: Any) -> Dict[str, Any]:
    """Persist a new default model to hermes config.yaml, mirroring
    what ``/model <name> --global`` does in chat. Cached agents on
    existing sessions keep their model until evicted (typical
    case: next conversation start). New conversations pick up
    the new default immediately on next /v1/responses dispatch.

    The PWA may submit either ``<vendor>/<model>`` (OpenRouter, no
    prefix) or ``<provider-slug>:<model>`` (e.g. ``openai-codex:gpt-5.5``,
    ``copilot:gpt-5.4``). The colon prefix is the cue to route the
    switch via switch_model's ``explicit_provider`` arg so we don't
    have to detect-by-name. Provider names with colons in them
    would break this — the local profile's ``custom:local-fallback``
    is exactly such a name, which is why the ``local`` branch below
    never goes near this decoder.

    Two additions 2026-09-07 (LOCAL_MODE.md §1 rule 3):

      * in the ``local`` profile the value is a bare id from the local
        server's /v1/models and the provider comes from the profile;
      * whichever profile is active, the resolved model is mirrored into
        ``parley.runtime_profiles.<active>.model`` so a profile switch
        never silently forgets a picker choice.
    """
    # Log caller context for model-switch attribution.
    try:
        import traceback as _tb
        frames = _tb.format_stack(limit=8)
        logger.info(
            "[parley] apply_model_setting called value=%r frames=%s",
            value,
            " <- ".join(f.strip().splitlines()[0] for f in frames[:-1]),
        )
    except Exception:
        pass
    if not isinstance(value, str) or not value.strip():
        raise SettingsValidationError("model value must be a non-empty string")
    raw_value = value.strip()

    # Validate against the declared options[]. Re-derive to avoid
    # a round-trip through the schema endpoint.
    schema = build_settings_schema()
    model_def = next((s for s in schema if s["id"] == "model"), None)
    if model_def is None:
        raise SettingsNotFoundError("model setting not declared")
    valid_values = {o["value"] for o in (model_def.get("options") or [])}
    if raw_value not in valid_values:
        raise SettingsValidationError(
            f"value not in options[]: {raw_value!r}"
        )

    cfg_for_profile = read_hermes_config()
    if rp.read_active_profile(cfg_for_profile) == rp.LOCAL_PROFILE:
        return _apply_local_model_setting(raw_value, cfg_for_profile)

    # Decode ``<slug>:<model>`` if present. Bare values (no colon)
    # are treated as openrouter-routed. OpenRouter IDs CAN contain
    # colons in the suffix (e.g. ``:free``), but those always have
    # a ``/`` BEFORE the colon. Provider-slug prefixes never contain
    # ``/``. So: strip the prefix only when the part before ``:``
    # has no slash.
    #
    # explicit_provider="openrouter" for bare values is load-bearing:
    # without it switch_model defaults to current_provider, which
    # rejects the model whenever current is a non-OpenRouter
    # provider.
    if ":" in raw_value and "/" not in raw_value.split(":", 1)[0]:
        slug, _, mid = raw_value.partition(":")
        explicit_provider = slug.strip()
        new_model = mid.strip()
    else:
        explicit_provider = "openrouter"
        new_model = raw_value

    # Read current state to feed switch_model.
    try:
        import yaml
        from hermes_cli.config import get_config_path
        cfg_path = get_config_path()
        cfg: Dict[str, Any] = {}
        if cfg_path.exists():
            with open(cfg_path, encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
        raw_model = cfg.get("model")
        if isinstance(raw_model, dict):
            model_cfg = raw_model
        elif isinstance(raw_model, str):
            model_cfg = {"default": raw_model}
        else:
            model_cfg = {}
        current_model = (model_cfg.get("default") or "").strip()
        current_provider = (model_cfg.get("provider") or "openrouter").strip()
        current_base_url = (model_cfg.get("base_url") or "").strip()
        user_provs = cfg.get("providers")
        try:
            from hermes_cli.config import get_compatible_custom_providers
            custom_provs = get_compatible_custom_providers(cfg)
        except Exception:
            custom_provs = cfg.get("custom_providers")
    except Exception as e:
        raise SettingsValidationError(
            f"failed to read hermes config: {e}"
        )

    # Delegate provider resolution via switch_model. Despite the
    # is_global flag's name, switch_model does NOT write config
    # itself — we do that below.
    try:
        from hermes_cli.model_switch import switch_model
        result = switch_model(
            raw_input=new_model,
            current_provider=current_provider,
            current_model=current_model,
            current_base_url=current_base_url,
            current_api_key="",
            is_global=True,
            explicit_provider=explicit_provider,
            user_providers=user_provs,
            custom_providers=custom_provs,
        )
    except Exception as e:
        logger.exception("[parley] switch_model raised")
        raise SettingsValidationError(f"switch_model failed: {e}")
    if not result.success:
        raise SettingsValidationError(
            result.error_message or "model switch rejected"
        )

    # Persist resolved model+provider+base_url to config.yaml so
    # the change survives restart.
    try:
        from hermes_cli.config import save_config
        cfg.setdefault("model", {})
        if not isinstance(cfg["model"], dict):
            cfg["model"] = {"default": cfg["model"]}
        cfg["model"]["default"] = result.new_model
        if result.target_provider:
            cfg["model"]["provider"] = result.target_provider
        if result.base_url:
            cfg["model"]["base_url"] = result.base_url
        _mirror_model_into_active_profile(cfg)
        save_config(cfg)
    except Exception as e:
        logger.warning("[parley] failed to persist model to config.yaml: %s", e)

    new_schema = build_settings_schema()
    return next((s for s in new_schema if s["id"] == "model"), schema[0])


# ── Memory status (Settings › Memory, LOCAL_MODE.md §3) ─────────────────

# The unit hindsight runs under, and the grep patterns that decide whether it
# is healthy. Both are lifted verbatim from hermes-agent-private's
# scripts/health-hermes.sh (`c_hindsight_server` / `c_hindsight_llm`) so the
# Memory section and the daily digest cannot disagree about what "an LLM
# error" is — two definitions of the same thing is how a check silently
# stops covering the failure it was written for.
_MEMORY_UNIT = "hindsight-server"
_MEMORY_ERROR_RE = re.compile(
    r"extraction failed|LLM error|refresh failed|Codex 401|AuthenticationError"
    r"|RateLimitError|APIStatusError|Failed to load",
    re.IGNORECASE,
)
_MEMORY_RETAIN_MARKER = "RETAIN_BATCH START"
_MEMORY_JOURNAL_WINDOW = "24 hours ago"
_MEMORY_PROBE_TIMEOUT = 5.0


def _run(argv: List[str], timeout: float) -> Optional[subprocess.CompletedProcess]:
    """Run a probe command. None when the binary is absent or it blew the
    timeout — i.e. "we do not know", which is a different answer from "it is
    broken" and must not be rendered as one. Tests and non-systemd hosts take
    this path."""
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as e:
        logger.debug("[parley] memory status probe %s unavailable: %s", argv[0], e)
        return None


def _service_active(unit: str) -> Optional[bool]:
    proc = _run(["systemctl", "--user", "is-active", unit], _MEMORY_PROBE_TIMEOUT)
    if proc is None:
        return None
    return (proc.stdout or "").strip() == "active"


def _journal(unit: str, since: str) -> Optional[List[str]]:
    # -o short-iso, not health.sh's -o cat: the Memory line has to say WHEN
    # the last retain happened, and `cat` throws the timestamps away.
    proc = _run(
        ["journalctl", "--user", "-u", unit, "--since", since, "--no-pager", "-o", "short-iso"],
        _MEMORY_PROBE_TIMEOUT,
    )
    if proc is None or proc.returncode != 0:
        return None
    return (proc.stdout or "").splitlines()


def _iso_stamp(line: str) -> Optional[datetime]:
    stamp = line.split(" ", 1)[0]
    try:
        return datetime.fromisoformat(stamp)
    except ValueError:
        return None


def _ago(then: datetime, now: Optional[datetime] = None) -> str:
    now = now or datetime.now(then.tzinfo)
    secs = max(0, int((now - then).total_seconds()))
    if secs < 90:
        return f"{secs} s ago"
    if secs < 5400:
        return f"{secs // 60} min ago"
    if secs < 172800:
        return f"{secs // 3600} h ago"
    return f"{secs // 86400} d ago"


def memory_status_text(now: Optional[datetime] = None) -> str:
    """One line: ``hindsight-server active · last retain 3 min ago · 0 LLM
    errors / 24h``. Every component degrades to "unknown" on its own, so a
    host without systemd still renders a sensible row instead of a stack
    trace or a false "not active"."""
    active = _service_active(_MEMORY_UNIT)
    if active is None:
        head = f"{_MEMORY_UNIT} unknown"
    elif active:
        head = f"{_MEMORY_UNIT} active"
    else:
        head = f"{_MEMORY_UNIT} NOT active"

    lines = _journal(_MEMORY_UNIT, _MEMORY_JOURNAL_WINDOW)
    if lines is None:
        return f"{head} · last retain unknown · LLM errors unknown"

    retains = [ln for ln in lines if _MEMORY_RETAIN_MARKER in ln]
    if not retains:
        retain = "no retain in 24h"
    else:
        stamp = _iso_stamp(retains[-1])
        retain = f"last retain {_ago(stamp, now)}" if stamp else f"{len(retains)} retains / 24h"

    errors = sum(1 for ln in lines if _MEMORY_ERROR_RE.search(ln))
    return f"{head} · {retain} · {errors} LLM errors / 24h"


# ── runtime profile: the injected side effects ──────────────────────────

# Ops lives with the ops scripts (LOCAL_MODE.md §1 rule 2.4): Parley does not
# own process control. Overridable so tests can point at a stub — they must
# never restart the owner's memory server.
_DEFAULT_MEMORY_SCRIPT = "~/code/hermes-agent-private/scripts/apply-memory-profile.sh"


def _memory_profile_script() -> Path:
    return Path(
        os.environ.get("PARLEY_MEMORY_PROFILE_SCRIPT") or _DEFAULT_MEMORY_SCRIPT
    ).expanduser()


def _memory_script_timeout() -> float:
    try:
        return max(10.0, float(os.environ.get("PARLEY_MEMORY_PROFILE_TIMEOUT", "180")))
    except ValueError:
        return 180.0


def _write_hermes_config(cfg: Dict[str, Any]) -> None:
    """Persist config.yaml through hermes' own writer.

    save_config -> utils._atomic_write -> atomic_replace, which resolves a
    symlink before os.replace. That is load-bearing here: ~/.hermes/config.yaml
    is a symlink into the hermes-agent-private repo, and any writer that
    renames over the LINK turns it into a plain file and silently orphans the
    repo copy."""
    from hermes_cli.config import save_config
    save_config(cfg)


def _write_hermes_env(updates: Any) -> None:
    """Persist the HINDSIGHT_API_LLM_* keys. ``None`` removes the key.

    Same symlink story as the config (~/.hermes/.env -> the repo's .env);
    hermes' save_env_value/remove_env_value go through _write_env_lines ->
    atomic_replace, so writing through the link is safe. Done here as well as
    in the ops script so a missing/failed script still leaves .env coherent
    with what the config now says."""
    from hermes_cli.config import remove_env_value, save_env_value
    for key, value in updates.items():
        if value is None:
            remove_env_value(key)
        else:
            save_env_value(key, value)


def _restart_memory_server(spec: "rp.MemorySpec") -> None:
    """Hand hindsight's restart to the repo script and wait for it."""
    script = _memory_profile_script()
    if not script.exists():
        raise SettingsValidationError(
            f"memory profile script not found at {script}; set "
            f"PARLEY_MEMORY_PROFILE_SCRIPT or install it from hermes-agent-private"
        )
    argv = [str(script)] + spec.as_args()
    started = time.time()
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=_memory_script_timeout(),
        )
    except subprocess.TimeoutExpired:
        raise SettingsValidationError(
            f"memory profile script did not finish within {_memory_script_timeout():.0f}s"
        )
    except OSError as e:
        raise SettingsValidationError(f"could not run {script}: {e}")
    logger.info(
        "[parley] memory profile script rc=%s in %.1fs", proc.returncode, time.time() - started,
    )
    if proc.returncode != 0:
        tail = ((proc.stderr or "") + (proc.stdout or "")).strip().splitlines()
        raise SettingsValidationError(
            "memory profile switch failed: " + (tail[-1] if tail else f"exit {proc.returncode}")
        )


def _preflight_runtime_profile(target: str, profile: Dict[str, Any]) -> None:
    """Preflight through the SAME probe the schema describes with.

    rp.preflight_profile defaults to its own probe; routing it back through
    ``_probe_local_server`` means the enum option that says "ready" and the
    check that lets the switch through can never be answering from two
    different code paths (and gives tests one seam instead of two)."""
    rp.preflight_profile(
        target, profile, probe=lambda *_a, **_k: _probe_local_server(profile),
    )


def apply_runtime_profile_setting(value: Any) -> Dict[str, Any]:
    """POST /v1/settings/runtime_profile — switch every model call at once.

    All the ordering and blast-radius rules live in parley_runtime_profiles;
    this is the wiring that gives them real side effects and translates the
    module's ProfileError into the extension's 400."""
    if not isinstance(value, str) or not value.strip():
        raise SettingsValidationError("runtime_profile value must be a non-empty string")
    try:
        plan = rp.apply_runtime_profile(
            value.strip(),
            preflight=_preflight_runtime_profile,
            write_config=_write_hermes_config,
            write_env=_write_hermes_env,
            restart_memory=_restart_memory_server,
            load=lambda: (read_hermes_config(), read_hermes_env()),
        )
    except rp.ProfileError as e:
        raise SettingsValidationError(str(e))
    except SettingsValidationError:
        raise
    except Exception as e:
        logger.exception("[parley] runtime profile apply failed")
        raise SettingsValidationError(f"failed to apply runtime profile: {e}")
    logger.info("[parley] runtime profile now %s (was %s)", plan.target, plan.leaving)
    return _updated_def("runtime_profile", {
        "id": "runtime_profile", "label": "Runtime profile",
        "category": "Agent", "type": "enum", "value": plan.target, "options": [],
    })


def apply_memory_toggle(sid: str, value: Any) -> Dict[str, Any]:
    """The two writable Memory settings — plain hermes ``memory.*`` booleans.

    Not a runtime-profile concern: turning memory off is orthogonal to where
    its LLM calls go, and conflating them would make "off-grid" silently
    disable recall."""
    path = _MEMORY_TOGGLES.get(sid)
    if path is None:
        raise SettingsNotFoundError(f"unknown setting: {sid}")
    if not isinstance(value, bool):
        raise SettingsValidationError(f"{sid} value must be true or false")
    cfg = read_hermes_config()
    rp.set_path(cfg, path, value)
    try:
        _write_hermes_config(cfg)
    except Exception as e:
        logger.exception("[parley] memory toggle persist failed")
        raise SettingsValidationError(f"failed to write hermes config: {e}")
    return _updated_def(sid, {
        "id": sid, "label": sid, "category": "Memory", "type": "toggle", "value": value,
    })


async def handle_schema(adapter, request: "web.Request") -> "web.Response":
    """GET /v1/settings/schema — list the agent's user-facing knobs."""
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    try:
        schema = await asyncio.get_running_loop().run_in_executor(
            None, build_settings_schema,
        )
    except Exception as e:
        logger.exception("[parley] settings schema build failed")
        return web.json_response(
            {"error": {"type": "server_error", "message": str(e)}},
            status=500,
        )
    return web.json_response({"object": "list", "data": schema})


async def handle_update(adapter, request: "web.Request") -> "web.Response":
    """POST /v1/settings/{id} — apply one setting."""
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    sid = request.match_info.get("id", "")
    try:
        body = await request.json()
    except (ValueError, json.JSONDecodeError):
        return web.json_response(
            {"error": {"type": "invalid_request_error",
                       "message": "body is not valid JSON"}},
            status=400,
        )
    value = body.get("value")
    try:
        updated = await asyncio.get_running_loop().run_in_executor(
            None, apply_setting, sid, value,
        )
    except SettingsValidationError as e:
        return web.json_response(
            {"error": {"type": "invalid_request_error", "message": str(e)}},
            status=400,
        )
    except SettingsNotFoundError as e:
        return web.json_response(
            {"error": {"type": "invalid_request_error", "message": str(e)}},
            status=404,
        )
    except Exception as e:
        logger.exception("[parley] settings apply failed: %s", sid)
        return web.json_response(
            {"error": {"type": "server_error", "message": str(e)}},
            status=500,
        )
    return web.json_response(updated)


async def handle_auxiliary_models(adapter, request: "web.Request") -> "web.Response":
    """GET /v1/parley/auxiliary-models — surface the auxiliary models
    hermes is configured to route to. Today: just ``vision``. The PWA's
    attachment-button gate uses this to enable the + button when the
    primary model is text-only but an auxiliary vision model is
    configured (hermes auto-enriches media_urls via the auxiliary
    vision pipeline; see hermes-agent gateway/run.py:_enrich_message_with_vision)."""
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    cfg = read_hermes_config()
    aux = cfg.get("auxiliary") if isinstance(cfg.get("auxiliary"), dict) else {}
    vision_cfg = aux.get("vision") if isinstance(aux.get("vision"), dict) else {}
    vision_model = vision_cfg.get("model") if isinstance(vision_cfg.get("model"), str) else None
    return web.json_response({"vision": vision_model or None})


async def handle_model_capabilities(adapter, request: "web.Request") -> "web.Response":
    """GET /v1/parley/model-capabilities?provider=X&model=Y — return
    ground-truth capability metadata from the models.dev registry that
    hermes already uses for its native-vs-text image routing decision."""
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    provider = (request.query.get("provider") or "").strip()
    model = (request.query.get("model") or "").strip()
    if not model:
        return web.json_response(
            {"error": "model query param required"}, status=400,
        )
    # PWA-side picker values are composite ids. Decode the
    # ``<slug>:<model>`` shape when no explicit provider is set.
    if not provider and ":" in model and "/" not in model.split(":", 1)[0]:
        slug, _, mid = model.partition(":")
        provider = slug.strip()
        model = mid.strip()
    try:
        from agent.models_dev import (
            get_model_capabilities,
            get_model_info,
            PROVIDER_TO_MODELS_DEV,
        )
        if provider:
            caps = get_model_capabilities(provider, model)
            resolved_provider = provider if caps is not None else None
        else:
            caps = None
            resolved_provider = None
            for p in PROVIDER_TO_MODELS_DEV.keys():
                candidate = get_model_capabilities(p, model)
                if candidate is not None:
                    caps = candidate
                    resolved_provider = p
                    break
    except Exception as e:
        logger.exception("[parley] model-capabilities lookup failed")
        return web.json_response(
            {"error": {"type": "server_error", "message": str(e)}},
            status=500,
        )
    if caps is None:
        return web.json_response(
            {"provider": provider or None, "model": model, "known": False},
            status=200,
        )
    # PDF intake is a separate modality from vision: a model can accept
    # images yet reject native PDF (and vice-versa). `ModelCapabilities`
    # doesn't carry it, but `ModelInfo.supports_pdf()` reads the same
    # models.dev `modalities.input` list — fetch it here so the client can
    # gate PDF attachments without a core-capability change.
    try:
        info = get_model_info(resolved_provider, model) if resolved_provider else None
        accepts_pdf = bool(info and info.supports_pdf())
    except Exception:
        accepts_pdf = False
    return web.json_response({
        "provider": resolved_provider,
        "model": model,
        "known": True,
        "supports_vision": caps.supports_vision,
        "supports_tools": caps.supports_tools,
        "supports_reasoning": caps.supports_reasoning,
        "accepts_pdf": accepts_pdf,
        "context_window": caps.context_window,
        "max_output_tokens": caps.max_output_tokens,
        "model_family": caps.model_family,
    })
