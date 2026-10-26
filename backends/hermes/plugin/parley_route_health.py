"""Health extension — ``/v1/health/*`` (the Parley "Health" settings section).

Generic contract (docs/ABSTRACT_AGENT_PROTOCOL.md "Optional health extension"):
the agent lists named health checks with their latest report and lets the
UI re-run one on demand. Parley knows nothing about what the checks are.

hermes' implementation reads the daily digest state that a deployment's
OWN health-check scripts write (an ops-repo concern, outside this
contract — the reference deployment keeps its at ``scripts/lib/health.sh``
in a private repo) and re-runs those scripts with ``--no-alert`` (report +
heartbeat, no Telegram/push):

  PARLEY_HEALTH_STATE_DIR  dir holding <name>.last-run ("<epoch> <WORST>") and <name>.report.txt
                           (default ~/.hermes/logs/health)
  PARLEY_HEALTH_RUNNERS    "<name>=<command>;<name>=<command>" — how to re-run each check;
                           the command gets "--no-alert" appended. Checks without a runner
                           are read-only.
  PARLEY_HEALTH_RUN_TIMEOUT  seconds (default 300)

Routes:
  GET  /v1/health              -> {"object":"list","data":[CheckDef…]}   (system checks + integrations)
  POST /v1/health/{id}/run     -> CheckDef (after the run; `int-*` ids probe an integration)
  GET  /v1/health/catalog, POST /v1/health/catalog/{provider}/add,
  POST /v1/health/{id}/actions/{action}, GET /v1/health/flows/{id}, POST …/cancel,
  GET  /v1/health/oauth/callback/{server}   -> integrations connect/add flows (parley_integration_flows)
CheckDef: {id, name, worst ("OK"|"WARN"|"FAIL"|"CRASHED"|"UNKNOWN"), last_run_at (iso|null),
           report (str), can_run (bool), counts: {fail, warn, ok}}
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import re
import shlex
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_ID_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
_REPORT_MAX_CHARS = 20_000


class HealthValidationError(ValueError):
    """Rejected client input — HTTP 400."""


def _state_dir() -> Path:
    return Path(os.environ.get("PARLEY_HEALTH_STATE_DIR")
                or Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes") / "logs" / "health").expanduser()


def _runners() -> Dict[str, str]:
    raw = os.environ.get("PARLEY_HEALTH_RUNNERS", "")
    out: Dict[str, str] = {}
    for part in raw.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, cmd = part.split("=", 1)
        name, cmd = name.strip(), cmd.strip()
        if _ID_RE.match(name) and cmd:
            out[name] = cmd
    return out


def _run_timeout() -> int:
    try:
        return max(10, int(os.environ.get("PARLEY_HEALTH_RUN_TIMEOUT", "300")))
    except ValueError:
        return 300


def _counts(report: str) -> Dict[str, int]:
    c = {"fail": 0, "warn": 0, "ok": 0}
    for line in report.splitlines():
        if line.startswith("FAIL "):
            c["fail"] += 1
        elif line.startswith("WARN "):
            c["warn"] += 1
        elif line.startswith("OK "):
            c["ok"] += 1
    return c


def _check_view(name: str) -> Dict[str, Any]:
    d = _state_dir()
    worst, last_run_at = "UNKNOWN", None
    lr = d / f"{name}.last-run"
    if lr.exists():
        try:
            epoch, _, w = lr.read_text().strip().partition(" ")
            last_run_at = datetime.fromtimestamp(float(epoch), timezone.utc).isoformat()
            worst = (w or "UNKNOWN").strip().upper()
        except Exception:
            pass
    rp = d / f"{name}.report.txt"
    report = ""
    if rp.exists():
        try:
            report = rp.read_text(errors="replace")[:_REPORT_MAX_CHARS]
        except Exception:
            report = ""
    return {
        "id": name,
        "name": f"{name} health",
        "worst": worst,
        "last_run_at": last_run_at,
        "report": report,
        "can_run": name in _runners(),
        "counts": _counts(report),
    }


def list_checks() -> List[Dict[str, Any]]:
    names = set(_runners())
    d = _state_dir()
    if d.is_dir():
        for f in d.glob("*.last-run"):
            if _ID_RE.match(f.stem):
                names.add(f.stem)
    return [_check_view(n) for n in sorted(names)]


def list_all() -> List[Dict[str, Any]]:
    """System checks + integrations (parley_integrations) — ONE status
    surface for Settings › Integrations. An integrations failure never
    hides the system checks."""
    out = list_checks()
    try:
        from . import parley_integrations as _integ
    except ImportError:  # pragma: no cover — flat-module import path
        import parley_integrations as _integ  # type: ignore
    try:
        out.extend(_integ.list_items())
    except Exception:
        logger.exception("[parley] integrations enumeration failed")
    return out


def run_check(name: str) -> Optional[Dict[str, Any]]:
    """Re-run one check synchronously (blocking; call from an executor). None = unknown check."""
    if not _ID_RE.match(name or ""):
        raise HealthValidationError("invalid check id")
    if name.startswith("int-"):
        try:
            from . import parley_integrations as _integ
        except ImportError:  # pragma: no cover
            import parley_integrations as _integ  # type: ignore
        try:
            return _integ.run_item(name)
        except ValueError as e:
            raise HealthValidationError(str(e))
    runners = _runners()
    if name not in runners:
        if name in {c["id"] for c in list_checks()}:
            raise HealthValidationError(f"check '{name}' is read-only here (no runner configured)")
        return None
    argv = shlex.split(runners[name]) + ["--no-alert"]
    started = time.time()
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=_run_timeout(),
                              env={**os.environ, "H_NO_ALERT": "1"})
        logger.info("[parley] health run %s rc=%s in %.1fs", name, proc.returncode, time.time() - started)
    except subprocess.TimeoutExpired:
        raise HealthValidationError(f"check '{name}' did not finish within {_run_timeout()}s")
    except FileNotFoundError as e:
        raise HealthValidationError(f"runner for '{name}' not found: {e.filename}")
    view = _check_view(name)
    if not view["report"] and proc.stdout:
        view["report"] = proc.stdout[-_REPORT_MAX_CHARS:]
    view["exit_code"] = proc.returncode
    return view


# ── aiohttp handlers ─────────────────────────────────────────────────────

def _err(web, status: int, err_type: str, message: str):
    return web.json_response({"error": {"type": err_type, "message": message}}, status=status)


def _unauthorized(ctx, request) -> bool:
    check = getattr(ctx, "check_http_auth", None) or getattr(ctx, "_check_http_auth", None)
    return bool(check) and not check(request)


async def _in_executor(fn, *args):
    ctx = contextvars.copy_context()
    return await asyncio.get_running_loop().run_in_executor(None, ctx.run, fn, *args)


async def handle_health_list(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    try:
        data = await _in_executor(list_all)
    except Exception as e:
        logger.exception("[parley] health list failed")
        return _err(web, 500, "server_error", str(e))
    return web.json_response({"object": "list", "data": data})


async def handle_health_run(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    name = request.match_info.get("check_id", "")
    try:
        view = await _in_executor(run_check, name)
    except HealthValidationError as e:
        return _err(web, 400, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] health run failed")
        return _err(web, 500, "server_error", str(e))
    if view is None:
        return _err(web, 404, "not_found", "no such check")
    return web.json_response(view)


# ── integrations: catalog, actions, flows, OAuth callback ─────────────────

def _flows():
    try:
        from . import parley_integration_flows as m
    except ImportError:  # pragma: no cover
        import parley_integration_flows as m  # type: ignore
    return m


async def _json_body(request) -> Dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


async def handle_catalog(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    try:
        data = await _in_executor(_flows().catalog)
    except Exception as e:
        logger.exception("[parley] integrations catalog failed")
        return _err(web, 500, "server_error", str(e))
    return web.json_response({"object": "list", "data": data})


async def handle_catalog_add(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    body = await _json_body(request)
    env = body.get("env") if isinstance(body.get("env"), dict) else {}
    try:
        view = await _in_executor(_flows().start_add, request.match_info.get("provider", ""), env)
    except _flows().FlowError as e:
        return _err(web, e.status, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] integrations add failed")
        return _err(web, 500, "server_error", str(e))
    return web.json_response(view, status=202)


async def handle_item_action(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    item_id = request.match_info.get("check_id", "")
    action = request.match_info.get("action", "")
    if not _ID_RE.match(item_id) or not _ID_RE.match(action):
        return _err(web, 400, "invalid_request_error", "invalid id")
    body = await _json_body(request)
    try:
        view = await _flows().run_action(item_id, action, body)
    except _flows().FlowError as e:
        return _err(web, e.status, "invalid_request_error", str(e))
    except HealthValidationError as e:
        return _err(web, 400, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] integrations action failed")
        return _err(web, 500, "server_error", str(e))
    return web.json_response(view, status=202 if view.get("flow_id") else 200)


async def handle_custom_add(adapter, request):
    """POST /v1/health/custom — register a user-made integration from the pane."""
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    body = await _json_body(request)
    try:
        from . import parley_integrations as _integ
    except ImportError:  # pragma: no cover
        import parley_integrations as _integ  # type: ignore
    try:
        view = await _in_executor(_integ.write_custom, body)
    except ValueError as e:
        return _err(web, 400, "invalid_request_error", str(e))
    except Exception as e:
        logger.exception("[parley] custom integration write failed")
        return _err(web, 500, "server_error", str(e))
    return web.json_response(view, status=201)


async def handle_flow_status(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    flow = _flows().get_flow(request.match_info.get("flow_id", ""))
    if flow is None:
        return _err(web, 404, "not_found", "flow not found or expired")
    return web.json_response(flow.view())


async def handle_flow_cancel(adapter, request):
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    return web.json_response(_flows().cancel_flow(request.match_info.get("flow_id", "")))


async def handle_oauth_callback(adapter, request):
    """The provider's redirect, forwarded by the proxy. JSON back; the
    proxy renders the human page."""
    from aiohttp import web
    if _unauthorized(adapter, request):
        return web.Response(status=401, text="invalid token")
    q = request.query
    res = _flows().deliver_callback(request.match_info.get("server", ""), code=q.get("code"), state=q.get("state"),
                                    error=q.get("error"), iss=q.get("iss"))
    return web.json_response(res, status=200 if res.get("ok") else 400)


def register_health_routes(app, adapter) -> None:
    app.router.add_get("/v1/health", lambda r: handle_health_list(adapter, r))
    # Literal segments before the {check_id} routes so "catalog"/"flows"/"oauth" never match as ids.
    app.router.add_get("/v1/health/catalog", lambda r: handle_catalog(adapter, r))
    app.router.add_post("/v1/health/catalog/{provider}/add", lambda r: handle_catalog_add(adapter, r))
    app.router.add_post("/v1/health/custom", lambda r: handle_custom_add(adapter, r))
    app.router.add_get("/v1/health/flows/{flow_id}", lambda r: handle_flow_status(adapter, r))
    app.router.add_post("/v1/health/flows/{flow_id}/cancel", lambda r: handle_flow_cancel(adapter, r))
    app.router.add_get("/v1/health/oauth/callback/{server}", lambda r: handle_oauth_callback(adapter, r))
    app.router.add_post("/v1/health/{check_id}/run", lambda r: handle_health_run(adapter, r))
    app.router.add_post("/v1/health/{check_id}/actions/{action}", lambda r: handle_item_action(adapter, r))
