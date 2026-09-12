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
platform name for two weeks. The owner never uses the CLI; the only way
they could have seen or fixed either was a settings surface in Parley.

Routes (aiohttp, same auth as the rest of the adapter):
  GET  /v1/jobs                    -> {"object":"list","data":[JobDef…],
                                       "options":{"deliver":[…],"model":[…]},
                                       "default_model": "<label>"}
  POST /v1/jobs/{id}               {"enabled"?:bool,"deliver"?:str,"model"?:str} -> JobDef
  POST /v1/jobs/model              {"model":str}    -> the GET /v1/jobs payload (see below)
  POST /v1/jobs/{id}/run           -> JobDef  (queued for the next scheduler tick)
  DELETE /v1/jobs/{id}             -> {"deleted": true}  (permanent; the UI confirms first)
  GET  /v1/jobs/{id}/runs?limit=N  -> {"object":"list","data":[RunDef…]}

JobDef.model is "" when the job follows the agent default (no pin);
POSTing "" clears a pin. Option lists carry ``group`` like the settings
model picker so the UI can render <optgroup>s.

``POST /v1/jobs/model`` — "model for all jobs" (2026-09-08): the owner kept
wanting to repoint every cron job in one action instead of clicking through
each job's picker, which is also exactly the shape of the 2026-09-05 drift
bug in this module's docstring above (a model switch that quietly missed
four jobs). The value is resolved through the SAME catalog/pin-resolution
path as a per-job pin (``_model_catalog_options`` / ``_resolve_pin``) so the
two surfaces can never disagree about what a picker value means. "" means
"follow the agent default" and clears ``cron.model``/``cron.model_provider``
in hermes config, same as clearing any other picker to its default.

Write order is deliberate (see ``apply_bulk_model_update``'s docstring):
every job's per-job pin is cleared FIRST, and only once every clear has
succeeded does ``cron.model``/``cron.model_provider`` get written. A
failure partway through clearing aborts BEFORE the config write, so the
worst case is "every job still follows whatever default was already live"
(uniform, unchanged) — never a mix of jobs already on the new model and
jobs silently still pinned to the old one, which is the class of bug this
endpoint exists to prevent at a bulk scale.
"""
from __future__ import annotations

import asyncio
import functools
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


def _write_cron_default(model: str, provider: str) -> None:
    """Persist cron.model / cron.model_provider, ONE dotted key at a time
    through hermes' own comment-preserving round-trip writer
    (``utils.atomic_roundtrip_yaml_update`` → ``_atomic_write`` →
    ``atomic_replace``, which is symlink-preserving — ``~/.hermes/config.yaml``
    is commonly a symlink into an ops repo).

    NOT a read-modify-write of the whole document via ``save_config``: that
    round-trips the file through a plain loader and drops every comment in
    it, so a knob the owner flips often would quietly strip the annotations
    from a hand-maintained config. Narrow single-key updates leave the rest
    of the file byte-identical.

    A module-level seam (rather than inlined in apply_bulk_model_update) so
    tests can monkeypatch it without touching disk, same pattern as
    ``_resolve_pin``/``_default_model`` above.
    """
    from hermes_cli.config import get_config_path
    from utils import atomic_roundtrip_yaml_update
    cfg_path = get_config_path()
    atomic_roundtrip_yaml_update(cfg_path, "cron.model", model)
    atomic_roundtrip_yaml_update(cfg_path, "cron.model_provider", provider)


# ── views ────────────────────────────────────────────────────────────────


def _truncate(text: Any, n: int) -> str:
    s = str(text or "")
    return s if len(s) <= n else s[: n - 1] + "…"


def _job_view(job: Dict[str, Any], last_run: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
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
        # Most recent execution as a run view (parley_job_runs), or None.
        # Lets the card show "Running · 0:14" / "Done in 1m09s" without a
        # second request per job.
        "last_run": last_run,
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
    default_model, default_provider = _default_model()
    from . import parley_job_runs
    by_id = {str(j.get("id")): j for j in jobs}
    latest = parley_job_runs.latest_runs(by_id.keys(), jobs_by_id=by_id, default_model=default_model)
    views = [_job_view(j, latest.get(str(j.get("id")))) for j in jobs]
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


def run_job(job_id: str, note: Optional[str] = None, *, loop: Any = None,
            on_done: Optional[Any] = None) -> Optional[Dict[str, Any]]:
    """Fire the job NOW through the gateway's claim-and-fire path and return
    the job view with ``last_run`` = the execution just started.

    Replaces the old "mark due for the next 60 s tick" (his report
    2026-09-12: the button appeared to do nothing). A duplicate press while
    the run holds the fire claim raises ``JobRunConflict`` (409). ``note``
    rides along as hermes' single-fire ``manual_run_prompt``.
    """
    from cron.executions import get_execution
    from . import parley_job_runs
    try:
        job, execution_id = parley_job_runs.fire_now(job_id, note, loop=loop, on_done=on_done)
    except LookupError:
        return None
    except ValueError as e:
        raise JobsValidationError(str(e))
    default_model, _ = _default_model()
    last_run = None
    if execution_id:
        ex = get_execution(execution_id)
        if ex:
            last_run = parley_job_runs.run_view(ex, job=job, default_model=default_model)
    return _job_view(job, last_run)


def job_run_view(job_id: str, run_id: str, state_db_path: Any = None) -> Optional[Dict[str, Any]]:
    from cron.jobs import get_job
    from . import parley_job_runs
    default_model, _ = _default_model()
    return parley_job_runs.get_run(job_id, run_id, job=get_job(job_id), default_model=default_model,
                                   state_db_path=state_db_path)


def job_run_console(job_id: str, run_id: str, after: int, state_db_path: Any) -> Optional[Dict[str, Any]]:
    """Console lines for one run, or None when the run is unknown. A run
    whose session hasn't appeared yet returns an empty page (not 404) so
    the client keeps polling."""
    from cron.executions import get_execution
    from . import parley_job_runs
    ex = get_execution(run_id)
    if not ex or str(ex.get("job_id")) != str(job_id):
        return None
    session_id = parley_job_runs.find_console_session(state_db_path, job_id, ex)
    status = parley_job_runs.run_view(ex)["status"]
    if not session_id:
        return {"lines": [], "next_after": int(after or 0), "session_id": None,
                "done": status in parley_job_runs.TERMINAL_RUN_STATUSES}
    page = parley_job_runs.console_lines(state_db_path, session_id, after_id=int(after or 0))
    page["session_id"] = session_id
    page["done"] = status in parley_job_runs.TERMINAL_RUN_STATUSES
    return page


def delete_job(job_id: str) -> bool:
    """Remove the job permanently (hermes keeps its run history / output dir)."""
    from cron.jobs import remove_job
    return bool(remove_job(job_id))


def job_runs(job_id: str, limit: int = 20, state_db_path: Any = None) -> List[Dict[str, Any]]:
    from cron.jobs import get_job
    from . import parley_job_runs
    default_model, _ = _default_model()
    return parley_job_runs.list_runs(job_id, limit, job=get_job(job_id), default_model=default_model,
                                     state_db_path=state_db_path)


# ── aiohttp handlers ─────────────────────────────────────────────────────

def _err(web, status: int, err_type: str, message: str):
    return web.json_response({"error": {"type": err_type, "message": message}}, status=status)


def _unauthorized(ctx, request) -> bool:
    """The plugin's HTTP app authenticates at the middleware layer; ``register_routes``
    receives a lightweight context, not the adapter. Honour an explicit checker when the
    caller provides one (tests, direct adapter use), otherwise defer to the middleware."""
    check = getattr(ctx, "check_http_auth", None) or getattr(ctx, "_check_http_auth", None)
    return bool(check) and not check(request)


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


def apply_bulk_model_update(value: Any) -> Dict[str, Any]:
    """POST /v1/jobs/model — "model for all jobs": one action that repoints
    EVERY cron job at the same model, instead of clicking through each
    job's picker (the owner's ask; see this module's docstring for the
    2026-09-05 drift bug that motivates it at bulk scale too).

    Resolves *value* through the exact same catalog/pin-resolution path a
    per-job pin uses (``_resolve_pin``, itself built on
    ``_model_catalog_options`` — the Agent settings model picker's own
    catalog), so an unknown value is rejected with a 400 (JobsValidationError)
    BEFORE anything is written — never a partial write.

    "" means "follow the agent default": every job's pin is cleared AND
    ``cron.model``/``cron.model_provider`` are cleared, so unpinned jobs
    fall through to ``model.default`` (parley_route_jobs._default_model's
    existing fallthrough — unchanged by this function).

    Write order is deliberate: every job's per-job pin is cleared FIRST;
    ``cron.model``/``cron.model_provider`` is written LAST, and only if
    every clear succeeded. Rationale (the failure modes this endpoint has
    to be explainable under):

      * A per-job clear can genuinely fail (``cron.jobs.update_job`` raises
        ``ValueError`` for e.g. a job in a state that rejects updates) even
        though *value* itself resolved fine. If that happens partway
        through the job list, we abort BEFORE touching cron.model/provider
        and raise, listing which job(s) failed. Every job's *effective*
        model is therefore whatever cron.model already said before this
        call — uniform, unchanged, exactly as if the call had not been
        made. The alternative order (write config first, clear pins after)
        would leave already-cleared jobs on the NEW model while a job that
        failed to clear stays on its OLD pin — precisely the "some jobs
        silently left behind" bug this endpoint exists to prevent, just
        introduced by the fix itself.
      * If every clear succeeds but the config write itself fails (e.g. a
        filesystem error in save_config), every job is now unpinned but
        cron.model/provider still says the OLD default — again uniform
        (every job follows the same, unchanged default), not a mix, and
        the caller can simply retry the call to finish the job.

    Either way the response (a fresh ``build_jobs_payload()``) always
    reflects what is ACTUALLY in the store, so the UI never has to trust a
    claim the write didn't back up.
    """
    if value is not None and not isinstance(value, str):
        raise JobsValidationError("model must be a string")
    raw = (value or "").strip()
    if raw:
        model, provider = _resolve_pin(raw)
    else:
        model, provider = "", ""

    from cron.jobs import list_jobs, update_job
    jobs = list_jobs(include_disabled=True)
    failed: List[Tuple[str, str]] = []
    for job in jobs:
        if not (job.get("model") or job.get("provider")):
            continue  # already unpinned — nothing to clear
        job_id = str(job.get("id"))
        try:
            update_job(job_id, {"model": None, "provider": None})
        except Exception as e:
            failed.append((job_id, str(e)))
    if failed:
        detail = "; ".join(f"{jid}: {err}" for jid, err in failed)
        raise JobsValidationError(
            f"could not clear the per-job pin for {len(failed)} job(s) ({detail}); "
            f"no config change was made — fix and retry"
        )

    try:
        _write_cron_default(model, provider)
    except Exception as e:
        logger.exception("[parley] cron default model persist failed")
        raise JobsValidationError(f"failed to write hermes config: {e}")

    return build_jobs_payload()


async def handle_jobs_list(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    try:
        ensure_run_watcher(adapter)
        payload = await _in_executor(build_jobs_payload)
    except Exception as e:
        logger.exception("[parley] jobs list failed")
        return _err(web, 500, "server_error", str(e))
    return web.json_response(payload)


async def handle_jobs_bulk_model(adapter, request):
    """POST /v1/jobs/model {"model": str} -> the GET /v1/jobs payload.

    Registered BEFORE ``/v1/jobs/{job_id}`` (see register_jobs_routes) so
    the literal path ``model`` is never swallowed by the job-id matcher."""
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    try:
        body = await request.json()
        if not isinstance(body, dict) or "model" not in body:
            raise JobsValidationError("body must include a 'model' field")
        payload = await _in_executor(apply_bulk_model_update, body["model"])
    except JobsValidationError as e:
        return _err(web, 400, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] bulk model update failed")
        return _err(web, 500, "server_error", str(e))
    return web.json_response(payload)


async def handle_job_update(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
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


def _state_db_path(adapter) -> Any:
    return getattr(adapter, "_state_db_path", None)


def _job_chat_id(job: Dict[str, Any]) -> Optional[str]:
    """The Parley chat a job reports to (bare chat id, same form the
    session_changed envelope uses), or None when it delivers elsewhere."""
    target = str(job.get("deliver") or "").split(",")[0].strip()
    if target.startswith("parley:"):
        return target.split(":", 2)[1] or None
    origin = job.get("origin") if isinstance(job.get("origin"), dict) else {}
    if target in ("origin", "") and origin.get("platform") == "parley" and origin.get("chat_id"):
        return str(origin["chat_id"])
    return None


_watcher = None


def ensure_run_watcher(adapter):
    """Start (once) the ledger watcher that pushes ``job_run`` envelopes and
    the manual-run completion notice. Lazy: created on the first jobs
    request, so it needs no hook in the adapter's start()."""
    global _watcher
    from . import parley_job_runs
    if _watcher is not None:
        _watcher.ensure_started()
        return _watcher

    def _jobs() -> Dict[str, Dict[str, Any]]:
        try:
            from cron.jobs import list_jobs
            return {str(j.get("id")): j for j in list_jobs(include_disabled=True)}
        except Exception:
            return {}

    async def _emit(env: Dict[str, Any]) -> None:
        job = _jobs().get(str(env.get("job_id")))
        # Every stream envelope must carry a chat_id (the proxy drops the
        # rest). Route to the job's Parley chat when it has one, else to a
        # sentinel the PWA's job_run handler ignores for routing purposes.
        env["chat_id"] = (_job_chat_id(job) if job else None) or "cron"
        await adapter._safe_send_envelope(env)

    async def _manual_terminal(run: Dict[str, Any], job: Dict[str, Any]) -> None:
        # A run that delivered its output to a Parley chat already produced
        # the ⏰ notification the user will see; only speak up when there is
        # nothing else to see — a failure, a failed delivery, or a job that
        # reports somewhere Parley cannot show.
        chat_id = _job_chat_id(job)
        delivered_here = chat_id and run.get("status") == "succeeded" \
            and run.get("delivery", {}).get("status") in ("delivered", "delivering", "pending")
        if delivered_here:
            return
        target = chat_id or _job_chat_id({"deliver": "origin", "origin": job.get("origin")})
        if not target:
            return
        body = parley_job_runs.run_finished_notice(job, run)
        await adapter._safe_send_envelope({
            "type": "notification", "chat_id": target, "kind": "cron", "content": body, "text": body,
        })

    _watcher = parley_job_runs.RunWatcher(
        emit=_emit, job_lookup=_jobs, default_model=lambda: _default_model()[0],
        state_db_path=lambda: _state_db_path(adapter), on_manual_terminal=_manual_terminal,
    )
    _watcher.ensure_started()
    return _watcher


async def handle_job_run(adapter, request):
    """POST /v1/jobs/{id}/run {"note"?: str} → job view with ``last_run``.
    409 when the job is already running, 503 when the scheduler can't fire."""
    from aiohttp import web
    from . import parley_job_runs
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    note = None
    try:
        body = await request.json()
        if isinstance(body, dict) and body.get("note") is not None:
            note = str(body.get("note")).strip()[:2000] or None
    except Exception:
        body = {}
    try:
        job_id = _job_id_from(request)
        watcher = ensure_run_watcher(adapter)
        loop = asyncio.get_running_loop()
        view = await _in_executor(functools.partial(run_job, job_id, note, loop=loop,
                                                    on_done=lambda: loop.call_soon_threadsafe(watcher.poke)))
        watcher.poke()
    except parley_job_runs.JobRunConflict:
        return _err(web, 409, "conflict", "already running")
    except parley_job_runs.JobRunUnavailable as e:
        return _err(web, 503, "unavailable", str(e))
    except JobsValidationError as e:
        return _err(web, 400, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] job run failed")
        return _err(web, 500, "server_error", str(e))
    if view is None:
        return _err(web, 404, "not_found", "no such job")
    return web.json_response(view)


async def handle_job_run_get(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    try:
        job_id = _job_id_from(request)
        run_id = str(request.match_info.get("run_id") or "")
        view = await _in_executor(job_run_view, job_id, run_id, _state_db_path(adapter))
    except Exception as e:
        logger.exception("[parley] job run get failed")
        return _err(web, 500, "server_error", str(e))
    if view is None:
        return _err(web, 404, "not_found", "no such run")
    return web.json_response(view)


async def handle_job_run_console(adapter, request):
    """GET /v1/jobs/{id}/runs/{run_id}/console?after=N → console lines
    after message id N. Reads hermes' own session for the run — nothing
    is stored on the Parley side."""
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    try:
        job_id = _job_id_from(request)
        run_id = str(request.match_info.get("run_id") or "")
        after = int(request.query.get("after", "0") or 0)
        page = await _in_executor(job_run_console, job_id, run_id, after, _state_db_path(adapter))
    except ValueError as e:
        return _err(web, 400, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] job run console failed")
        return _err(web, 500, "server_error", str(e))
    if page is None:
        return _err(web, 404, "not_found", "no such run")
    return web.json_response(page)


async def handle_job_delete(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    try:
        job_id = _job_id_from(request)
        ok = await _in_executor(delete_job, job_id)
    except JobsValidationError as e:
        return _err(web, 400, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] job delete failed")
        return _err(web, 500, "server_error", str(e))
    if not ok:
        return _err(web, 404, "not_found", "no such job")
    return web.json_response({"deleted": True, "id": job_id})


async def handle_job_runs(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    try:
        job_id = _job_id_from(request)
        limit = int(request.query.get("limit", "20"))
        rows = await _in_executor(job_runs, job_id, limit, _state_db_path(adapter))
    except (JobsValidationError, ValueError) as e:
        return _err(web, 400, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] job runs failed")
        return _err(web, 500, "server_error", str(e))
    return web.json_response({"object": "list", "data": rows})


def register_jobs_routes(app, adapter) -> None:
    app.router.add_get("/v1/jobs", lambda r: handle_jobs_list(adapter, r))
    # Registered BEFORE the dynamic {job_id} route below: aiohttp's
    # UrlDispatcher matches resources in registration order, and job_id's
    # alphabet ([A-Za-z0-9_-]{1,64}) matches the literal string "model" too.
    app.router.add_post("/v1/jobs/model", lambda r: handle_jobs_bulk_model(adapter, r))
    app.router.add_post("/v1/jobs/{job_id}", lambda r: handle_job_update(adapter, r))
    app.router.add_post("/v1/jobs/{job_id}/run", lambda r: handle_job_run(adapter, r))
    app.router.add_get("/v1/jobs/{job_id}/runs", lambda r: handle_job_runs(adapter, r))
    app.router.add_get("/v1/jobs/{job_id}/runs/{run_id}", lambda r: handle_job_run_get(adapter, r))
    app.router.add_get("/v1/jobs/{job_id}/runs/{run_id}/console", lambda r: handle_job_run_console(adapter, r))
    app.router.add_delete("/v1/jobs/{job_id}", lambda r: handle_job_delete(adapter, r))
