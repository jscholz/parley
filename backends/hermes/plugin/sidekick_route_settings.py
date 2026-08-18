"""HTTP route handlers for the optional settings extension.

Extracted from ``__init__.py`` 2026-05-17. Covers four endpoints
plus their settings-apply logic (the largest single chunk in this
refactor — ~700 LOC):

  - GET  /v1/settings/schema             list user-facing knobs
  - POST /v1/settings/{id}               apply one setting
  - GET  /v1/sidekick/auxiliary-models   surface aux vision model
  - GET  /v1/sidekick/model-capabilities models.dev caps lookup

Plus the helpers:

  - read_hermes_config        snapshot ~/.hermes/config.yaml
  - read_preferred_models     resolve the model-picker glob filter
  - build_settings_schema     compose the SettingDef[] list
  - apply_setting             dispatch by setting id
  - apply_preferred_models    persist the glob list
  - apply_model_setting       persist model.default + provider

And the exception classes that route _apply_setting failures to
HTTP 400 / 404 in the handler.

Wiring contract: each handler takes ``(adapter, request)`` where
adapter is the calling ``SidekickAdapter`` instance. The helpers
also take ``adapter`` first when they need access to the live
state.db path / etc.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from .parley_env import env_get
from typing import Any, Dict, List, Set

# Guarded aiohttp import — see sidekick_route_conversations for why.
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
        logger.warning("[sidekick] settings: read hermes config failed: %s", e)
        return {}


def read_preferred_models(cfg: Dict[str, Any]) -> List[str]:
    """Resolve the preferred-models glob list. Source of truth:
    ``sidekick.preferred_models:`` in ~/.hermes/config.yaml (a yaml
    list of glob strings). Falls back to SIDEKICK_PREFERRED_MODELS
    env (comma-separated) for env-only deployments. Empty result
    = no filter (full catalog)."""
    sk = cfg.get("sidekick") if isinstance(cfg.get("sidekick"), dict) else {}
    raw = sk.get("preferred_models")
    if isinstance(raw, list):
        out = [str(g).strip() for g in raw if isinstance(g, str) and str(g).strip()]
        if out:
            return out
    env_raw = (env_get("PARLEY_PREFERRED_MODELS") or "").strip()
    if env_raw:
        return [g.strip() for g in env_raw.split(",") if g.strip()]
    return []


def build_settings_schema() -> List[Dict[str, Any]]:
    """Build the SettingDef[] list. Reads hermes config.yaml for
    the current model + the preferred-models glob filter (under
    ``sidekick.preferred_models:``). Picker options merge OpenRouter
    (filtered by user's preferred-globs) with EVERY other
    authenticated provider's curated model list (e.g. openai-codex
    OAuth, copilot, anthropic). Provider is encoded into the option
    value: OpenRouter entries stay bare (vendor/model), every other
    provider prefixes with ``<slug>:`` (e.g. ``openai-codex:gpt-5.5``).
    apply_model_setting parses the prefix back to route the switch
    to the right provider."""
    import fnmatch
    cfg = read_hermes_config()

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
        logger.warning("[sidekick] settings: openrouter catalog fetch failed: %s", e)

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
                "[sidekick] settings: live openrouter supplement failed: %s", e,
            )

    # Pull EVERY other authenticated provider's curated model list
    # (Codex OAuth, Copilot OAuth, Anthropic API key, etc.).
    sk_cfg = cfg.get("sidekick", {}) if isinstance(cfg.get("sidekick"), dict) else {}
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
            "[sidekick] settings: list_authenticated_providers failed: %s", e,
        )

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

    _GROUP_RANK = {"Current": 0, "OpenRouter": 1}
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
    raise SettingsNotFoundError(f"unknown setting: {sid}")


def apply_preferred_models_setting(value: Any) -> Dict[str, Any]:
    """Persist the preferred-models glob list to ~/.hermes/config.yaml
    under ``sidekick.preferred_models:``. The next /v1/settings/schema
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
        sk = cfg.get("sidekick")
        if not isinstance(sk, dict):
            sk = {}
            cfg["sidekick"] = sk
        sk["preferred_models"] = cleaned
        from hermes_cli.config import save_config
        save_config(cfg)
    except Exception as e:
        logger.exception("[sidekick] preferred_models persist failed")
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
    would break this — none today."""
    # Log caller context for model-switch attribution.
    try:
        import traceback as _tb
        frames = _tb.format_stack(limit=8)
        logger.info(
            "[sidekick] apply_model_setting called value=%r frames=%s",
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
        logger.exception("[sidekick] switch_model raised")
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
        save_config(cfg)
    except Exception as e:
        logger.warning("[sidekick] failed to persist model to config.yaml: %s", e)

    new_schema = build_settings_schema()
    return next((s for s in new_schema if s["id"] == "model"), schema[0])


async def handle_schema(adapter, request: "web.Request") -> "web.Response":
    """GET /v1/settings/schema — list the agent's user-facing knobs."""
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    try:
        schema = await asyncio.get_running_loop().run_in_executor(
            None, build_settings_schema,
        )
    except Exception as e:
        logger.exception("[sidekick] settings schema build failed")
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
        logger.exception("[sidekick] settings apply failed: %s", sid)
        return web.json_response(
            {"error": {"type": "server_error", "message": str(e)}},
            status=500,
        )
    return web.json_response(updated)


async def handle_auxiliary_models(adapter, request: "web.Request") -> "web.Response":
    """GET /v1/sidekick/auxiliary-models — surface the auxiliary models
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
    """GET /v1/sidekick/model-capabilities?provider=X&model=Y — return
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
        logger.exception("[sidekick] model-capabilities lookup failed")
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
