"""Connect / add flows for Settings › Integrations (phase 2, 2026-10-26).

Parley renders what it is told; everything that knows what an OAuth
flow or a catalog entry is lives here, on top of hermes' own machinery:

- **OAuth (browser)** for `auth: oauth` MCP servers — the same bridge the
  hermes dashboard uses (``tools.mcp_dashboard_oauth.DashboardOAuthFlow``):
  the SDK does discovery, DCR, PKCE and the token exchange; we only move
  the browser callback from a loopback listener to the Parley proxy
  (``<origin>/api/parley/integrations/oauth/callback/<server>`` → proxy →
  ``GET /v1/health/oauth/callback/<server>`` here). Each Parley client
  passes the origin it reached the proxy on, so every tenant and device
  gets a redirect URI the browser can actually follow.
- **Catalog** — hermes' curated MCP catalog (``hermes_cli.mcp_catalog``):
  list entries as addable integrations; ``add`` installs one (secrets to
  .env, config block to config.yaml) the way the dashboard's install
  endpoint does, in a worker thread, as an ``install`` flow.

A Flow is a small dict Parley polls::

    {"flow_id", "item_id", "kind": "oauth"|"install", "status":
     "starting"|"waiting"|"done"|"error"|"cancelled",
     "authorization_url"?, "error"?, "message"?, "created_at", "updated_at"}

Device-code OAuth (``hermes mcp login --flow device``) is CLI-bound in
hermes today (prints the code) and is NOT wired here — phase 3.
"""
from __future__ import annotations

import logging
import os
import re
import secrets
import threading
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from . import parley_integrations as integ

logger = logging.getLogger(__name__)

FLOW_TTL_S = 30 * 60
MAX_LIVE_FLOWS = 8
_ORIGIN_RE = re.compile(r"^https?://[A-Za-z0-9.\-_\[\]:]+$")
_PROVIDER_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class FlowError(ValueError):
    """Client-facing failure → HTTP 4xx (status attribute)."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _now() -> float:
    return time.time()


class Flow:
    def __init__(self, kind: str, item_id: str, server: str = ""):
        self.flow_id = secrets.token_urlsafe(18)
        self.kind = kind
        self.item_id = item_id
        self.server = server
        self.status = "starting"
        self.authorization_url: Optional[str] = None
        self.error: Optional[str] = None
        self.message: str = ""
        self.created_at = _now()
        self.updated_at = self.created_at
        self.dashboard: Any = None          # DashboardOAuthFlow for oauth flows
        self.worker_done = threading.Event()

    def view(self) -> Dict[str, Any]:
        if self.dashboard is not None:
            snap = self.dashboard.snapshot()
            self.authorization_url = snap.get("authorization_url")
            ds = snap.get("status")
            if getattr(self.dashboard, "cancelled", False):
                self.status = "cancelled"
            elif ds == "authorization_required":
                self.status = "waiting"
            elif ds == "approved":
                self.status = "done"
            elif ds == "error":
                self.status = "error"
            else:
                self.status = "starting"
            self.error = snap.get("error")
        out = {
            "flow_id": self.flow_id, "item_id": self.item_id, "kind": self.kind, "status": self.status,
            "created_at": self.created_at, "updated_at": self.updated_at,
        }
        if self.authorization_url:
            out["authorization_url"] = self.authorization_url
        if self.error:
            out["error"] = self.error
        if self.message:
            out["message"] = self.message
        return out

    def finish(self, status: str, *, error: str = "", message: str = "") -> None:
        self.status, self.error, self.message = status, (error or None), message
        self.updated_at = _now()
        self.worker_done.set()


_flows: Dict[str, Flow] = {}
_lock = threading.Lock()


def _gc() -> None:
    cutoff = _now() - FLOW_TTL_S
    with _lock:
        for fid in [f for f, fl in _flows.items() if fl.created_at < cutoff]:
            _flows.pop(fid, None)


def get_flow(flow_id: str) -> Optional[Flow]:
    _gc()
    return _flows.get(flow_id)


def _register(flow: Flow) -> None:
    with _lock:
        live = [f for f in _flows.values() if not f.worker_done.is_set()]
        if len(live) >= MAX_LIVE_FLOWS:
            raise FlowError("too many integration flows in progress", 429)
        if flow.server and any(f.server == flow.server and f.kind == flow.kind for f in live):
            raise FlowError(f"a {flow.kind} flow for '{flow.server}' is already in progress", 409)
        _flows[flow.flow_id] = flow


def cancel_flow(flow_id: str) -> Dict[str, Any]:
    flow = get_flow(flow_id)
    if flow is None:
        return {"ok": True, "status": "expired"}
    if flow.dashboard is not None:
        flow.dashboard.mark_error("Cancelled by user", cancelled=True)
    elif not flow.worker_done.is_set():
        flow.finish("cancelled", error="Cancelled by user")
    return {"ok": True, "status": flow.view()["status"]}


# ── redirect origin ──────────────────────────────────────────────────────

def public_origin(requested: Optional[str]) -> str:
    """The origin the user's browser can reach the proxy on. The client
    sends the one it is using; PARLEY_PUBLIC_ORIGIN / PARLEY_PROXY_ORIGIN
    are the fallbacks (loopback origins only work on the box itself)."""
    for cand in (requested, integ._env("PARLEY_PUBLIC_ORIGIN"), integ._env("PARLEY_PROXY_ORIGIN")):
        c = (cand or "").strip().rstrip("/")
        if c and _ORIGIN_RE.match(c) and urlparse(c).netloc:
            return c
    return "http://127.0.0.1:3001"


def redirect_uri(server: str, requested_origin: Optional[str]) -> str:
    from urllib.parse import quote
    return f"{public_origin(requested_origin)}/api/parley/integrations/oauth/callback/{quote(server, safe='')}"


# ── OAuth (browser) ──────────────────────────────────────────────────────

def _mcp_server_cfg(name: str) -> Dict[str, Any]:
    servers = integ._load_config().get("mcp_servers") or {}
    cfg = servers.get(name) if isinstance(servers, dict) else None
    if not isinstance(cfg, dict):
        raise FlowError(f"MCP server '{name}' is not configured", 404)
    return dict(cfg)


def _run_oauth_worker(flow: Flow, cfg: Dict[str, Any]) -> None:
    """Mirror of hermes' dashboard worker (hermes_cli.web_server_mcp
    _run_dashboard_mcp_oauth) without profile/home overrides: we run inside
    the gateway, in its home. Tokens are backed up and restored on failure."""
    dflow = flow.dashboard
    name = flow.server
    worst, report = "FAIL", ""
    try:
        from hermes_cli.mcp_config import _oauth_tokens_present, _probe_single_server, _save_mcp_server  # type: ignore
        from tools.mcp_dashboard_oauth import dashboard_oauth_flow  # type: ignore
        from tools.mcp_oauth import HermesTokenStorage, force_interactive_oauth, login_connect_timeout  # type: ignore
        from tools.mcp_oauth_manager import get_manager  # type: ignore
        with force_interactive_oauth(), dashboard_oauth_flow(dflow):
            manager = get_manager()
            storage = HermesTokenStorage(name)
            backup = storage.snapshot()
            previous = None
            try:
                previous = manager.remove(name)
                tools = _probe_single_server(name, cfg, connect_timeout=login_connect_timeout(cfg))
                if not _oauth_tokens_present(name):
                    raise RuntimeError("The server responded, but no OAuth token was obtained — "
                                       "this provider may require a manually-registered OAuth client.")
                _save_mcp_server(name, cfg)
                dflow.tools = [{"name": t, "description": d} for t, d in tools]
                dflow.mark_approved()
                worst = "OK"
                report = f"connected · {len(tools)} tool(s)\n" + "\n".join(f"OK   {t}" for t, _ in tools[:40])
                try:
                    from tools.mcp_tool_loop import reconnect_mcp_server  # type: ignore
                    reconnect_mcp_server(name)
                except Exception:
                    logger.info("[parley] integrations: live reconnect of '%s' skipped", name, exc_info=True)
            except Exception:
                storage.restore(backup, only_if_absent=True)
                manager.restore_entry(name, previous)
                raise
    except Exception as exc:
        msg = str(exc) or exc.__class__.__name__
        try:
            from tools.mcp_oauth import humanize_oauth_registration_error  # type: ignore
            msg = humanize_oauth_registration_error(name, exc, server_url=cfg.get("url")) or msg
        except Exception:
            pass
        report = f"FAIL connect — {msg}"
        if dflow is not None:
            dflow.mark_error(msg)
    finally:
        try:
            integ.cache().put(flow.item_id, worst, report)
            integ.invalidate_list_cache()
        except Exception:
            logger.debug("[parley] integrations: probe cache update failed", exc_info=True)
        if dflow is not None:
            dflow.mark_worker_done()
        flow.worker_done.set()
        flow.updated_at = _now()


async def start_oauth(item_id: str, requested_origin: Optional[str]) -> Dict[str, Any]:
    """Begin a browser OAuth flow for an `auth: oauth` MCP server item.
    Returns the flow view with `authorization_url` (or an error status)."""
    name = item_id[len(integ.ID_PREFIX) + len("mcp-"):] if item_id.startswith(integ.ID_PREFIX + "mcp-") else ""
    if not name:
        raise FlowError("only MCP server integrations can be connected here", 400)
    cfg = _mcp_server_cfg(name)
    if not cfg.get("url"):
        raise FlowError("stdio servers authenticate via env keys, not OAuth", 400)
    if cfg.get("headers") and cfg.get("auth") != "oauth":
        raise FlowError("this server uses header/API-key auth, not OAuth", 400)
    cfg["auth"] = "oauth"
    try:
        from tools.mcp_dashboard_oauth import DashboardOAuthFlow, exception_message  # type: ignore
    except Exception as e:
        raise FlowError(f"this hermes build has no dashboard OAuth bridge: {e}", 501)
    flow = Flow("oauth", item_id, server=name)
    flow.dashboard = DashboardOAuthFlow(
        flow_id=flow.flow_id, server_name=name, profile=None, hermes_home=str(integ.hermes_home()),
        redirect_uri=(cfg.get("oauth") or {}).get("redirect_uri") or redirect_uri(name, requested_origin),
        reconnect_live=True,
    )
    _register(flow)
    threading.Thread(target=_run_oauth_worker, args=(flow, cfg), daemon=True, name=f"parley-oauth-{name}").start()
    try:
        await flow.dashboard.wait_for_authorization_url(timeout=30)
    except Exception as exc:
        flow.dashboard.mark_error(exception_message(exc))
    return flow.view()


def deliver_callback(server: str, *, code: Optional[str], state: Optional[str], error: Optional[str],
                     iss: Optional[str] = None) -> Dict[str, Any]:
    """The provider redirected the browser (via the proxy). Match on server
    + state and hand it to the waiting flow. Never raises; the proxy
    renders the message."""
    _gc()
    with _lock:
        candidates = [f for f in _flows.values() if f.kind == "oauth" and f.server == server and f.dashboard is not None]
    flow = next((f for f in candidates
                 if f.dashboard.expected_state is not None and state is not None
                 and secrets.compare_digest(f.dashboard.expected_state, state)), None)
    if flow is None:
        return {"ok": False, "status": "expired", "message": "This sign-in has expired. Go back to Parley and try again."}
    try:
        flow.dashboard.deliver_callback(code=code, state=state, error=error, iss=iss)
    except ValueError as exc:
        already = "already received" in str(exc)
        return {"ok": False, "status": "rejected", "message": "This sign-in link was already used." if already else "This sign-in link is not valid."}
    if error:
        return {"ok": False, "status": "denied", "message": f"The provider refused the sign-in ({error}). Go back to Parley for details."}
    return {"ok": True, "status": "received", "message": "Signed in. You can close this tab and go back to Parley."}


# ── catalog ──────────────────────────────────────────────────────────────

def catalog() -> List[Dict[str, Any]]:
    try:
        from hermes_cli import mcp_catalog  # type: ignore
        entries = list(mcp_catalog.list_catalog())
        installed = mcp_catalog.installed_servers()
    except Exception as e:
        logger.debug("[parley] mcp catalog unavailable: %s", e)
        return []
    out: List[Dict[str, Any]] = []
    for e in entries:
        auth = getattr(e, "auth", None)
        atype = str(getattr(auth, "type", "none") or "none")
        fields = [{"id": x.name, "label": x.prompt or x.name, "secret": bool(x.secret), "required": bool(x.required)}
                  for x in (getattr(auth, "env", None) or [])]
        setup = "oauth" if atype == "oauth" else ("api-key" if (atype == "api_key" or fields) else "none")
        out.append({
            "provider": e.name, "name": e.name.replace("_", " ").replace("-", " ").title() if e.name.islower() else e.name,
            "kind": "mcp", "description": e.description, "setup": setup, "fields": fields,
            "needs_install": getattr(e, "install", None) is not None,
            "installed": e.name in installed, "docs_url": str(getattr(e, "source", "") or ""),
            "transport": str(getattr(getattr(e, "transport", None), "type", "") or ""),
        })
    return out


def _run_install_worker(flow: Flow, entry: Any, env: Dict[str, str]) -> None:
    try:
        from hermes_cli import mcp_catalog  # type: ignore
        mcp_catalog.install_entry(entry, enable=True, preloaded_env=env or None)
        flow.finish("done", message=f"'{entry.name}' installed. " + ("Press Connect to sign in." if str(getattr(entry.auth, 'type', '')) == "oauth" else "Press Test to check it."))
    except Exception as exc:
        logger.exception("[parley] catalog install failed: %s", entry.name)
        flow.finish("error", error=str(exc) or exc.__class__.__name__)
    finally:
        integ.invalidate_list_cache()


def start_add(provider: str, env: Dict[str, str]) -> Dict[str, Any]:
    if not _PROVIDER_RE.match(provider or ""):
        raise FlowError("invalid provider", 400)
    try:
        from hermes_cli import mcp_catalog  # type: ignore
        from hermes_cli.config import save_env_value, validate_env_var_name_for_write  # type: ignore
    except Exception as e:
        raise FlowError(f"this hermes build has no MCP catalog: {e}", 501)
    entry = mcp_catalog.get_entry(provider)
    if entry is None:
        raise FlowError(f"no catalog entry '{provider}'", 404)
    specs = list(getattr(entry.auth, "env", None) or [])
    declared = {s.name for s in specs}
    env = {str(k): str(v) for k, v in (env or {}).items() if v is not None}
    undeclared = sorted(set(env) - declared)
    if undeclared:
        raise FlowError(f"'{provider}' does not declare: {', '.join(undeclared)}", 400)
    missing = [s.name for s in specs if s.required and not env.get(s.name)]
    if missing:
        raise FlowError(f"missing: {', '.join(missing)}", 400)
    try:
        for k in env:
            validate_env_var_name_for_write(k)
    except ValueError as exc:
        raise FlowError(str(exc), 400)
    # Secrets to .env first (install_entry keeps ${VAR} refs in config.yaml).
    for s in specs:
        if s.secret and env.get(s.name):
            save_env_value(s.name, env[s.name])
    flow = Flow("install", integ.item_id("mcp", entry.name), server=entry.name)
    flow.status = "waiting"
    _register(flow)
    threading.Thread(target=_run_install_worker, args=(flow, entry, env), daemon=True, name=f"parley-install-{entry.name}").start()
    return flow.view()


# ── per-item actions (what the pane renders as buttons) ──────────────────

def actions_for(item: Dict[str, Any]) -> List[Dict[str, Any]]:
    integ_meta = item.get("integration") or {}
    kind = integ_meta.get("kind")
    if kind == "mcp":
        cfg = {}
        try:
            cfg = _mcp_server_cfg(str(integ_meta.get("provider") or ""))
        except FlowError:
            pass
        if cfg.get("url") and (cfg.get("auth") == "oauth" or (not cfg.get("headers") and cfg.get("auth") in (None, "", "oauth"))):
            connected = integ_meta.get("connected") is True
            return [{"id": "connect", "label": "Reconnect" if connected else "Connect", "flow": "oauth"}]
    if kind == "custom":
        return [{"id": "remove", "label": "Remove", "flow": "confirm", "danger": True,
                 "message": "Remove this integration from the registry? Its YAML file is deleted; nothing else changes."}]
    return []


async def run_action(item_id: str, action: str, body: Dict[str, Any]) -> Dict[str, Any]:
    items = {it["id"]: it for it in integ.list_items()}
    item = items.get(item_id)
    if item is None:
        raise FlowError("no such integration", 404)
    allowed = {a["id"]: a for a in actions_for(item)}
    if action == "test":
        # Same as POST …/run; offered here so clients can drive every action through one route.
        view = integ.run_item(item_id)
        if view is None:
            raise FlowError("nothing to test", 400)
        return {"flow_id": None, "kind": "run", "status": "done", "item": view}
    if action not in allowed:
        raise FlowError(f"'{action}' is not available for this integration", 400)
    if allowed[action]["flow"] == "oauth":
        return await start_oauth(item_id, body.get("origin") if isinstance(body, dict) else None)
    if allowed[action]["flow"] == "confirm" and action == "remove" and item["integration"].get("kind") == "custom":
        ok = integ.remove_custom(str(item["integration"].get("provider") or ""))
        if not ok:
            raise FlowError("not in the registry any more", 404)
        return {"flow_id": None, "kind": "confirm", "status": "done", "message": f"'{item['name']}' removed."}
    raise FlowError("unsupported flow", 400)
