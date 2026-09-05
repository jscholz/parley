"""Scheduled-jobs extension — ``/v1/jobs/*`` (the Parley "Cron" settings section).

Generic contract, documented in docs/ABSTRACT_AGENT_PROTOCOL.md under
"Optional scheduled-jobs extension": the agent lists its scheduled jobs
plus the option catalogs the UI needs (delivery targets, models), and
Parley renders a Cron section and posts edits back. Parley itself knows
nothing about hermes; this module is hermes' implementation over the
``cron.jobs`` store, the same store `hermes cron …` and the hermes
dashboard mutate, so every surface sees one truth.

Why: 2026-09-05 — the model switch to Astra silently skipped four cron
jobs (drift guard), and three jobs had been delivering to a dead
platform name for two weeks. Jonathan never uses the CLI; the only way
he could have seen or fixed either was a settings surface in Parley.

Routes (aiohttp, same auth as the rest of the adapter):
  GET  /v1/jobs                    -> {"object":"list","data":[JobDef…],
                                       "options":{"deliver":[…],"model":[…]},
                                       "default_model": "<label>"}
  POST /v1/jobs/{id}               {"enabled"?:bool,"deliver"?:str,"model"?:str} -> JobDef
  POST /v1/jobs/{id}/run           -> JobDef  (queued for the next scheduler tick)
  GET  /v1/jobs/{id}/runs?limit=N  -> {"object":"list","data":[RunDef…]}

JobDef.model is "" when the job follows the agent default (no pin);
POSTing "" clears a pin. Option lists carry ``group`` like the settings
model picker so the UI can render <optgroup>s.
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# deliver grammar: routing tokens, or comma-separated `<platform>[:<chat>[:<thread>]]` parts.
_DELIVER_PART_RE = re.compile(r"^[a-z0-9_-]+(?::[A-Za-z0-9_.@:+-]{1,128})?$")
_ROUTING_TOKENS = {"origin", "local", "all"}
_UPDATABLE = {"enabled", "deliver", "model"}
_PROMPT_PREVIEW_CHARS = 600
_ERROR_PREVIEW_CHARS = 240


class JobsValidationError(ValueError):
    """Rejected client input — surfaces as HTTP 400 with the message."""


# ── hermes lookups (each monkeypatchable in tests) ─────────────────────────

def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()


def _parley_chat_titles(limit: int = 300) -> List[Tuple[str, str]]:
    """(chat_id, title) for Parley chats, newest first — the deliver-target choices."""
    db = _hermes_home() / "parley.db"
    if not db.exists():
        return []
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            rows = conn.execute(
                "SELECT chat_id, title FROM conversation_titles WHERE source='parley' "
                "ORDER BY updated_at DESC LIMIT ?", (int(limit),)).fetchall()
        finally:
            conn.close()
        return [(str(c), str(t or "")) for c, t in rows if c]
    except Exception:
        logger.debug("[parley] conversation_titles unavailable", exc_info=True)
        return []


def _hermes_delivery_targets() -> List[Dict[str, Any]]:
    """hermes' own view of deliverable platforms (home channel set), or [] when unavailable."""
    try:
        from cron.scheduler_delivery import cron_delivery_targets
        return [t for t in cron_delivery_targets() if t.get("home_target_set")]
    except Exception:
        logger.debug("[parley] cron_delivery_targets unavailable", exc_info=True)
        return []


def _default_model() -> Tuple[str, str]:
    """(model, provider) an unpinned job runs on: cron.model wins over model.default."""
    try:
        from hermes_cli.config import load_config
        cfg = load_config() or {}
    except Exception:
        return "", ""
    cron = cfg.get("cron") if isinstance(cfg.get("cron"), dict) else {}
    model_cfg = cfg.get("model")
    if isinstance(model_cfg, str):
        model_cfg = {"default": model_cfg}
    model_cfg = model_cfg if isinstance(model_cfg, dict) else {}
    model = str(cron.get("model") or model_cfg.get("default") or "").strip()
    provider = str(cron.get("model_provider") or model_cfg.get("provider") or "").strip()
    return model, provider


def _model_catalog_options() -> List[Dict[str, Any]]:
    """The same model catalog the Agent settings picker shows (value, label, group)."""
    try:
        from .parley_route_settings import build_settings_schema
    except ImportError:  # loaded as a top-level module (tests, ad-hoc)
        from parley_route_settings import build_settings_schema  # type: ignore
    for setting in build_settings_schema():
        if setting.get("id") == "model":
            return [dict(o) for o in (setting.get("options") or [])]
    return []


def _resolve_pin(model_value: str) -> Tuple[str, str]:
    """Resolve a picker value to (model, provider) exactly like the Agent model setting does."""
    raw = (model_value or "").strip()
    if ":" in raw and "/" not in raw.split(":", 1)[0]:
        slug, _, mid = raw.partition(":")
        explicit_provider, new_model = slug.strip(), mid.strip()
    else:
        explicit_provider, new_model = "openrouter", raw
    import yaml
    from hermes_cli.config import get_config_path
    cfg: Dict[str, Any] = {}
    cfg_path = get_config_path()
    if cfg_path.exists():
        with open(cfg_path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
    raw_model = cfg.get("model")
    model_cfg = raw_model if isinstance(raw_model, dict) else ({"default": raw_model} if isinstance(raw_model, str) else {})
    try:
        from hermes_cli.config import get_compatible_custom_providers
        custom_provs = get_compatible_custom_providers(cfg)
    except Exception:
        custom_provs = cfg.get("custom_providers")
    from hermes_cli.model_switch import switch_model
    result = switch_model(
        raw_input=new_model,
        current_provider=(model_cfg.get("provider") or "openrouter").strip(),
        current_model=(model_cfg.get("default") or "").strip(),
        current_base_url=(model_cfg.get("base_url") or "").strip(),
        current_api_key="",
        is_global=False,
        explicit_provider=explicit_provider,
        user_providers=cfg.get("providers"),
        custom_providers=custom_provs,
    )
    if not result.success:
        raise JobsValidationError(result.error_message or "model not recognised")
    return result.new_model, (result.target_provider or "")


# ── views ────────────────────────────────────────────────────────────────

def _truncate(text: Any, n: int) -> str:
    s = str(text or "")
    return s if len(s) <= n else s[: n - 1] + "…"


def _job_view(job: Dict[str, Any]) -> Dict[str, Any]:
    from cron.jobs import effective_job_state
    origin = job.get("origin") if isinstance(job.get("origin"), dict) else {}
    origin_view = None
    if origin.get("platform"):
        origin_view = {
            "platform": str(origin.get("platform")),
            "chat_id": str(origin.get("chat_id") or ""),
            "label": str(origin.get("chat_name") or origin.get("chat_id") or ""),
        }
    schedule = job.get("schedule")
    schedule_display = job.get("schedule_display") or (
        schedule.get("display") if isinstance(schedule, dict) else str(schedule or ""))
    return {
        "id": str(job.get("id")),
        "name": str(job.get("name") or job.get("id")),
        "schedule": str(schedule_display or ""),
        "enabled": bool(job.get("enabled", True)),
        "state": effective_job_state(job),
        "next_run_at": job.get("next_run_at"),
        "last_run_at": job.get("last_run_at"),
        "last_status": job.get("last_status"),
        "last_error": _truncate(job.get("last_error") or job.get("last_delivery_error"), _ERROR_PREVIEW_CHARS) or None,
        "prompt": _truncate(job.get("prompt"), _PROMPT_PREVIEW_CHARS),
        "deliver": str(job.get("deliver") or "local"),
        "model": str(job.get("model") or ""),
        "provider": str(job.get("provider") or ""),
        "skills": [str(s) for s in (job.get("skills") or []) if s],
        "origin": origin_view,
    }


def _deliver_options(current_values: Iterable[str]) -> List[Dict[str, Any]]:
    opts: List[Dict[str, Any]] = [
        {"value": "origin", "label": "Origin chat (where the job was created)", "group": "Routing"},
        {"value": "local", "label": "Save only — no delivery", "group": "Routing"},
    ]
    seen = {o["value"] for o in opts}
    for chat_id, title in _parley_chat_titles():
        v = f"parley:{chat_id}"
        if v in seen:
            continue
        seen.add(v)
        opts.append({"value": v, "label": title or f"Parley chat {chat_id[:8]}", "group": "Parley chats"})
    for t in _hermes_delivery_targets():
        v = str(t.get("id") or "")
        if not v or v in seen:
            continue
        seen.add(v)
        opts.append({"value": v, "label": f"{t.get('name') or v} (home channel)", "group": "Other platforms"})
    for cur in current_values:
        for part in str(cur or "").split(","):
            part = part.strip()
            if part and part not in seen:
                seen.add(part)
                label = part
                if part.startswith("parley:"):
                    label = f"Parley chat {part[7:15]}… (no longer listed)"
                opts.append({"value": part, "label": label, "group": "Current"})
    return opts


def _model_options(current_models: Iterable[str], default_label: str) -> List[Dict[str, Any]]:
    opts: List[Dict[str, Any]] = [{"value": "", "label": f"Follow default ({default_label or 'unset'})", "group": "Default"}]
    seen = {""}
    for o in _model_catalog_options():
        v = str(o.get("value") or "")
        if not v or v in seen:
            continue
        seen.add(v)
        opts.append({"value": v, "label": str(o.get("label") or v), "group": str(o.get("group") or "Models")})
    for cur in current_models:
        cur = str(cur or "").strip()
        if cur and cur not in seen:
            seen.add(cur)
            opts.append({"value": cur, "label": f"{cur} (pinned)", "group": "Current"})
    return opts


def build_jobs_payload() -> Dict[str, Any]:
    from cron.jobs import list_jobs
    jobs = list_jobs(include_disabled=True)
    views = [_job_view(j) for j in jobs]
    default_model, default_provider = _default_model()
    default_label = f"{default_model} via {default_provider}" if default_provider else default_model
    return {
        "object": "list",
        "data": views,
        "options": {
            "deliver": _deliver_options(v["deliver"] for v in views),
            "model": _model_options((v["model"] for v in views), default_label),
        },
        "default_model": default_label,
    }


# ── mutations ────────────────────────────────────────────────────────────

def _validate_deliver(value: Any) -> str:
    if not isinstance(value, str):
        raise JobsValidationError("deliver must be a string")
    parts = [p.strip() for p in value.split(",") if p.strip()]
    if not parts:
        raise JobsValidationError("deliver must not be empty")
    for p in parts:
        if p.lower() in _ROUTING_TOKENS:
            continue
        if not _DELIVER_PART_RE.match(p):
            raise JobsValidationError(f"deliver target not understood: {p!r}")
    return ",".join(parts)


def apply_job_update(job_id: str, body: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Apply an edit; returns the updated JobDef or None when the job does not exist."""
    from cron.jobs import get_job, pause_job, resume_job, update_job
    if not isinstance(body, dict) or not body:
        raise JobsValidationError("body must be a non-empty JSON object")
    unknown = set(body) - _UPDATABLE
    if unknown:
        raise JobsValidationError(f"unsupported field(s): {', '.join(sorted(unknown))}")
    job = get_job(job_id)
    if job is None:
        return None
    updates: Dict[str, Any] = {}
    if "deliver" in body:
        updates["deliver"] = _validate_deliver(body["deliver"])
    if "model" in body:
        if body["model"] is not None and not isinstance(body["model"], str):
            raise JobsValidationError("model must be a string")
        pin = (body["model"] or "").strip()
        if pin:
            model, provider = _resolve_pin(pin)
            updates["model"], updates["provider"] = model, (provider or None)
        else:
            updates["model"], updates["provider"] = None, None
    if updates:
        job = update_job(job_id, updates) or job
    if "enabled" in body:
        if not isinstance(body["enabled"], bool):
            raise JobsValidationError("enabled must be true or false")
        job = (resume_job(job_id) if body["enabled"] else pause_job(job_id, reason="paused from Parley")) or job
    return _job_view(get_job(job_id) or job)


def run_job(job_id: str) -> Optional[Dict[str, Any]]:
    """Queue the job for the next scheduler tick (delivers through the gateway, unlike a CLI run)."""
    from cron.jobs import trigger_job
    try:
        job = trigger_job(job_id)
    except ValueError as e:
        raise JobsValidationError(str(e))
    return _job_view(job) if job else None


def job_runs(job_id: str, limit: int = 20) -> List[Dict[str, Any]]:
    from cron.executions import list_executions
    rows = list_executions(job_id=job_id, limit=max(1, min(int(limit), 100)))
    return [{
        "id": r.get("id"), "status": r.get("status"), "source": r.get("source"),
        "claimed_at": r.get("claimed_at"), "started_at": r.get("started_at"),
        "finished_at": r.get("finished_at"), "error": _truncate(r.get("error"), _ERROR_PREVIEW_CHARS) or None,
    } for r in rows]


# ── aiohttp handlers ─────────────────────────────────────────────────────

def _err(web, status: int, err_type: str, message: str):
    return web.json_response({"error": {"type": err_type, "message": message}}, status=status)


def _job_id_from(request) -> str:
    job_id = request.match_info.get("job_id", "")
    if not _JOB_ID_RE.match(job_id):
        raise JobsValidationError("invalid job id")
    return job_id


async def _in_executor(fn, *args):
    # Copy the caller's context into the worker thread: the cron store can be
    # scoped per-context (cron.jobs.use_cron_store) and a bare executor thread
    # would silently fall back to the process-wide ~/.hermes/cron store.
    ctx = contextvars.copy_context()
    return await asyncio.get_running_loop().run_in_executor(None, ctx.run, fn, *args)


async def handle_jobs_list(adapter, request):
    from aiohttp import web
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    try:
        payload = await _in_executor(build_jobs_payload)
    except Exception as e:
        logger.exception("[parley] jobs list failed")
        return _err(web, 500, "server_error", str(e))
    return web.json_response(payload)


async def handle_job_update(adapter, request):
    from aiohttp import web
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    try:
        job_id = _job_id_from(request)
        body = await request.json()
        view = await _in_executor(apply_job_update, job_id, body)
    except JobsValidationError as e:
        return _err(web, 400, "invalid_request_error", str(e))
    except ValueError as e:  # cron store rejections (e.g. terminal job, bad schedule)
        return _err(web, 400, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] job update failed")
        return _err(web, 500, "server_error", str(e))
    if view is None:
        return _err(web, 404, "not_found", "no such job")
    return web.json_response(view)


async def handle_job_run(adapter, request):
    from aiohttp import web
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    try:
        job_id = _job_id_from(request)
        view = await _in_executor(run_job, job_id)
    except JobsValidationError as e:
        return _err(web, 400, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] job run failed")
        return _err(web, 500, "server_error", str(e))
    if view is None:
        return _err(web, 404, "not_found", "no such job")
    return web.json_response(view)


async def handle_job_runs(adapter, request):
    from aiohttp import web
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    try:
        job_id = _job_id_from(request)
        limit = int(request.query.get("limit", "20"))
        rows = await _in_executor(job_runs, job_id, limit)
    except (JobsValidationError, ValueError) as e:
        return _err(web, 400, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] job runs failed")
        return _err(web, 500, "server_error", str(e))
    return web.json_response({"object": "list", "data": rows})


def register_jobs_routes(app, adapter) -> None:
    app.router.add_get("/v1/jobs", lambda r: handle_jobs_list(adapter, r))
    app.router.add_post("/v1/jobs/{job_id}", lambda r: handle_job_update(adapter, r))
    app.router.add_post("/v1/jobs/{job_id}/run", lambda r: handle_job_run(adapter, r))
    app.router.add_get("/v1/jobs/{job_id}/runs", lambda r: handle_job_runs(adapter, r))
