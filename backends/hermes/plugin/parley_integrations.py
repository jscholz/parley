"""Integrations — the agent's connected services as status items.

Parley's Settings › Integrations pane renders ONE status surface: the
system health checks (``parley_route_health``) and, beside them, every
integration this agent has — MCP servers, chat platforms, model providers,
plugins that hold credentials, and user-made "custom" integrations. Each
is an ordinary health item with an extra ``integration`` block
(docs/ABSTRACT_AGENT_PROTOCOL.md "Optional health extension"), so Parley
knows nothing about what an MCP server is; it renders what it is told.

Phase 1 (2026-10-26, docs/INTEGRATIONS_PANE_PLAN.md): read-only
enumeration + on-demand probe ("Test"). Connect / add flows are phase 2.

Everything hermes-specific is imported lazily inside the enumerators and
wrapped so that a hermes refactor degrades to an item with
``worst: UNKNOWN`` and an honest report line, never a 500.

Item id: ``int-<kind>-<name>`` (health-id charset, ≤ 32 chars).

Custom registry — ``$HERMES_HOME/integrations/<name>.yaml``::

    name: linkedin-harness           # [a-z0-9_-]{1,20}; defaults to the file stem
    label: LinkedIn (Playwright harness)
    description: Logged-in LinkedIn profile driven by my Playwright scripts.
    docs: ~/code/li-harness/README.md     # optional; shown as a link
    status:                               # optional → UNKNOWN until configured
      command: ~/code/li-harness/bin/status   # exit 0 OK, 1 WARN, 2+ FAIL; stdout = report
      timeout_s: 60
    setup:                                # optional
      kind: instructions                  # phase 1 renders `markdown`; command/api-key are phase 3
      markdown: |
        Log in once in the harness profile: `bin/login`, then run `bin/status`.

Probe results are cached in memory and in ``<health state dir>/integrations.json``
so "last tested" survives a gateway restart; nothing probes on page open.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

ID_PREFIX = "int-"
_NAME_RE = re.compile(r"^[a-z0-9_-]{1,20}$")
_ENV_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
_REPORT_MAX = 20_000
DEFAULT_PROBE_TIMEOUT_S = 45

# Env var that configures each gateway platform (display hint only; the
# live signal is gateway_state.json's `platforms`).
_PLATFORM_ENV = {
    "telegram": "TELEGRAM_BOT_TOKEN", "discord": "DISCORD_BOT_TOKEN", "slack": "SLACK_BOT_TOKEN",
    "whatsapp": "WHATSAPP_ENABLED", "whatsapp_cloud": "WHATSAPP_CLOUD_ACCESS_TOKEN", "signal": "SIGNAL_HTTP_URL",
}
# Not integrations: hermes' own HTTP surfaces and the sidekick alias.
_PLATFORM_SKIP = {"api_server", "sidekick", "cli", "webhook", "acp"}


def hermes_home() -> Path:
    try:
        from hermes_cli.config import get_hermes_home  # type: ignore
        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _env(key: str) -> str:
    try:
        from hermes_cli.config import get_env_value  # type: ignore
        v = get_env_value(key)
        if v:
            return str(v)
    except Exception:
        pass
    return os.environ.get(key, "") or ""


def item_id(kind: str, name: str) -> str:
    raw = f"{ID_PREFIX}{kind}-{name}".lower()
    raw = re.sub(r"[^a-z0-9_-]", "-", raw)
    return raw[:32].rstrip("-")


def _counts(worst: str) -> Dict[str, int]:
    w = (worst or "").upper()
    return {"fail": 1 if w in ("FAIL", "CRASHED") else 0, "warn": 1 if w == "WARN" else 0, "ok": 1 if w == "OK" else 0}


def _item(kind: str, name: str, label: str, *, connected: Optional[bool], worst: str, report: str,
          can_run: bool, account: str = "", docs_url: str = "", setup_markdown: str = "",
          description: str = "", provider: str = "") -> Dict[str, Any]:
    integ: Dict[str, Any] = {"kind": kind, "provider": provider or name, "connected": connected}
    if account:
        integ["account"] = account
    if docs_url:
        integ["docs_url"] = docs_url
    if setup_markdown:
        integ["setup_markdown"] = setup_markdown
    if description:
        integ["description"] = description
    return {
        "id": item_id(kind, name), "name": label, "worst": worst, "last_run_at": None,
        "report": report[:_REPORT_MAX], "can_run": can_run, "counts": _counts(worst), "integration": integ,
    }


# ── probe cache (memory + file) ──────────────────────────────────────────

class ProbeCache:
    def __init__(self, path: Optional[Path] = None):
        self._path = path
        self._mem: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if self._path and self._path.exists():
            try:
                data = json.loads(self._path.read_text())
                if isinstance(data, dict):
                    self._mem.update({k: v for k, v in data.items() if isinstance(v, dict)})
            except Exception:
                logger.debug("[parley] integrations cache unreadable: %s", self._path)

    def get(self, item: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            self._load()
            return dict(self._mem[item]) if item in self._mem else None

    def put(self, item: str, worst: str, report: str) -> Dict[str, Any]:
        rec = {"worst": worst, "report": report[:_REPORT_MAX], "last_run_at": _now_iso()}
        with self._lock:
            self._load()
            self._mem[item] = rec
            if self._path:
                try:
                    self._path.parent.mkdir(parents=True, exist_ok=True)
                    tmp = self._path.with_suffix(".tmp")
                    tmp.write_text(json.dumps(self._mem, indent=1))
                    os.replace(tmp, self._path)
                except Exception:
                    logger.debug("[parley] integrations cache not persisted", exc_info=True)
        return dict(rec)


def _state_dir() -> Path:
    return Path(os.environ.get("PARLEY_HEALTH_STATE_DIR") or hermes_home() / "logs" / "health").expanduser()


_cache: Optional[ProbeCache] = None


def cache() -> ProbeCache:
    global _cache
    if _cache is None or _cache._path != _state_dir() / "integrations.json":
        _cache = ProbeCache(_state_dir() / "integrations.json")
    return _cache


def _apply_cache(item: Dict[str, Any]) -> Dict[str, Any]:
    rec = cache().get(item["id"])
    if rec:
        item["worst"] = rec.get("worst") or item["worst"]
        item["report"] = (rec.get("report") or item["report"])[:_REPORT_MAX]
        item["last_run_at"] = rec.get("last_run_at")
        item["counts"] = _counts(item["worst"])
    return item


# ── enumerators ──────────────────────────────────────────────────────────

def _load_config() -> Dict[str, Any]:
    try:
        from hermes_cli.config import load_config_readonly  # type: ignore
        return load_config_readonly() or {}
    except Exception:
        try:
            from hermes_cli.config import load_config  # type: ignore
            return load_config() or {}
        except Exception:
            return {}


def _mcp_tokens_present(name: str) -> bool:
    try:
        from tools.mcp_oauth import HermesTokenStorage  # type: ignore
        return bool(HermesTokenStorage(name).has_cached_tokens())
    except Exception:
        return (hermes_home() / "mcp-tokens" / f"{name}.json").exists()


def _env_refs(cfg: Dict[str, Any]) -> List[str]:
    found: List[str] = []
    def walk(v: Any) -> None:
        if isinstance(v, str):
            found.extend(_ENV_REF_RE.findall(v))
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    for key in ("env", "headers", "url", "args"):
        walk(cfg.get(key))
    return sorted(set(found))


def enumerate_mcp(config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    config = config if config is not None else _load_config()
    servers = config.get("mcp_servers")
    if not isinstance(servers, dict):
        return []
    out: List[Dict[str, Any]] = []
    for name, cfg in sorted(servers.items()):
        if not isinstance(cfg, dict):
            continue
        enabled = cfg.get("enabled", True) is not False
        transport = "http" if cfg.get("url") else ("stdio" if cfg.get("command") else "unknown")
        auth = cfg.get("auth") or ("header" if isinstance(cfg.get("headers"), dict)
                                   and any(str(k).lower() == "authorization" for k in cfg["headers"]) else "")
        lines = [f"{transport} · {cfg.get('url') or cfg.get('command') or '?'}"]
        connected: Optional[bool]
        worst = "UNKNOWN"
        if not enabled:
            connected, worst = False, "UNKNOWN"
            lines.append("disabled in config")
        elif auth == "oauth":
            connected = _mcp_tokens_present(name)
            lines.append("OAuth token on file" if connected else "no OAuth token — run `hermes mcp login " + name + "`")
            worst = "UNKNOWN" if connected else "WARN"
        else:
            missing = [v for v in _env_refs(cfg) if not _env(v)]
            connected = not missing
            if missing:
                worst = "WARN"
                lines.append("missing: " + ", ".join(missing))
            else:
                refs = _env_refs(cfg)
                lines.append("credentials present (" + ", ".join(refs) + ")" if refs else "no credentials needed")
        lines.append("not tested yet — press Test to connect and list tools")
        out.append(_item("mcp", str(name), str(name), connected=connected, worst=worst,
                         report="\n".join(lines), can_run=enabled, provider=str(name)))
    return out


def _gateway_platform_states() -> Dict[str, Dict[str, Any]]:
    """``gateway_state.json`` → {platform: {state, error_message, needs_attention,
    updated_at}} for entries written by the RUNNING gateway (same pid);
    stale entries from an earlier process are dropped."""
    try:
        data = json.loads((hermes_home() / "gateway_state.json").read_text())
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    plats = data.get("platforms")
    pid = data.get("pid")
    out: Dict[str, Dict[str, Any]] = {}
    if isinstance(plats, dict):
        for name, st in plats.items():
            if not isinstance(st, dict):
                continue
            if pid is not None and st.get("writer_pid") not in (None, pid):
                continue
            out[str(name)] = st
    elif isinstance(plats, list):  # older shape: just names
        for name in plats:
            out[str(name)] = {"state": "connected"}
    return out


def enumerate_platforms(config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    config = config if config is not None else _load_config()
    configured = config.get("platforms") if isinstance(config.get("platforms"), dict) else {}
    live = _gateway_platform_states()
    names = sorted((set(configured) | set(live)) - _PLATFORM_SKIP)
    out: List[Dict[str, Any]] = []
    for name in names:
        env_key = _PLATFORM_ENV.get(name, "")
        has_env = bool(_env(env_key)) if env_key else None
        st = live.get(name) or {}
        state = str(st.get("state") or "")
        is_live = state == "connected"
        if is_live:
            lines = ["connected to the running gateway"]
            worst = "WARN" if st.get("needs_attention") else "OK"
        elif st:
            lines = [f"gateway reports: {state or 'unknown'}"]
            worst = "FAIL" if state in ("error", "failed", "disconnected") else "WARN"
        else:
            lines = ["not connected in the running gateway"]
            worst = "WARN" if (has_env or name in configured) else "UNKNOWN"
        if st.get("error_message"):
            lines.append(f"error: {st['error_message']}")
        if env_key:
            lines.append(f"{env_key} {'set' if has_env else 'NOT set'}")
        out.append(_item("platform", name, name.replace("_", " ").title(), connected=is_live, worst=worst,
                         report="\n".join(lines), can_run=False, provider=name))
    return out


def enumerate_model_providers(config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Providers with a credential (per hermes' own auth status), plus the
    active one even when it has none (that is a FAIL worth seeing)."""
    config = config if config is not None else _load_config()
    active = ""
    try:
        from hermes_cli.auth import get_active_provider  # type: ignore
        active = str(get_active_provider() or "")
    except Exception:
        model = config.get("model")
        active = str(model.get("provider") or "") if isinstance(model, dict) else ""
    try:
        from hermes_cli.provider_catalog import provider_catalog  # type: ignore
        from hermes_cli.auth import get_auth_status  # type: ignore
        descriptors = list(provider_catalog())
    except Exception as e:
        logger.debug("[parley] provider catalog unavailable: %s", e)
        return []
    out: List[Dict[str, Any]] = []
    for d in descriptors:
        slug = str(getattr(d, "slug", "") or "")
        if not slug:
            continue
        # The AWS SDK status walks the whole credential chain (~4 s on a box
        # with no AWS profile); only pay for it when bedrock is the active
        # provider.
        if str(getattr(d, "auth_type", "") or "") == "aws_sdk" and slug != active:
            continue
        try:
            st = get_auth_status(slug) or {}
        except Exception as e:
            st = {"error": str(e)}
        ok = bool(st.get("logged_in") or st.get("configured"))
        if not ok and slug != active:
            continue
        lines = []
        if slug == active:
            lines.append("active provider")
        src = st.get("key_source") or ("oauth" if st.get("logged_in") and not st.get("key_source") else "")
        if src:
            lines.append(f"credential: {src}")
        if st.get("base_url"):
            lines.append(f"base url: {st['base_url']}")
        if st.get("error"):
            lines.append(f"status error: {st['error']}")
        if st.get("needs_refresh"):
            lines.append("token expired — needs refresh")
        worst = "OK" if ok and not st.get("needs_refresh") else ("WARN" if st.get("needs_refresh") else "FAIL")
        label = str(getattr(d, "label", "") or slug)
        out.append(_item("model-provider", slug, label, connected=ok, worst=worst,
                         report="\n".join(lines) or "configured", can_run=False, provider=slug,
                         account=str(st.get("account") or st.get("email") or ""),
                         docs_url=str(getattr(d, "signup_url", "") or "")))
    return out


def _auth_store_providers() -> Dict[str, Any]:
    try:
        data = json.loads((hermes_home() / "auth.json").read_text())
        p = data.get("providers") if isinstance(data, dict) else None
        return p if isinstance(p, dict) else {}
    except Exception:
        return {}


def enumerate_plugins() -> List[Dict[str, Any]]:
    """Installed hermes plugins that hold credentials: a `requires_env` in
    their manifest or an entry in auth.json. Platform-kind plugins are
    already covered by the gateway's platform list."""
    pdir = hermes_home() / "plugins"
    if not pdir.is_dir():
        return []
    try:
        import yaml  # type: ignore
    except Exception:
        return []
    auth_providers = _auth_store_providers()
    out: List[Dict[str, Any]] = []
    for mf in sorted(pdir.glob("*/plugin.yaml")):
        try:
            man = yaml.safe_load(mf.read_text()) or {}
        except Exception:
            continue
        if not isinstance(man, dict):
            continue
        name = str(man.get("name") or mf.parent.name)
        if str(man.get("kind") or "") == "platform":
            continue
        req = [str(e.get("name")) for e in (man.get("requires_env") or []) if isinstance(e, dict) and e.get("name")]
        has_auth = name in auth_providers
        if not req and not has_auth:
            continue
        missing = [k for k in req if not _env(k)]
        lines = []
        if has_auth:
            entry = auth_providers.get(name) or {}
            exp = entry.get("expires_at") if isinstance(entry, dict) else None
            lines.append("signed in (auth store)" + (f" · expires {exp}" if exp else ""))
        if req:
            lines.append(("missing: " + ", ".join(missing)) if missing else ("env set: " + ", ".join(req)))
        connected = has_auth or (bool(req) and not missing)
        worst = "OK" if connected else "WARN"
        out.append(_item("plugin", name, str(man.get("label") or name), connected=connected, worst=worst,
                         report="\n".join(lines), can_run=False, provider=name,
                         description=str(man.get("description") or "").strip().split("\n")[0][:160]))
    return out


def registry_dir() -> Path:
    return hermes_home() / "integrations"


def _expand(p: str) -> str:
    return os.path.expanduser(os.path.expandvars(p or ""))


def load_custom(path: Path) -> Optional[Dict[str, Any]]:
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(path.read_text()) or {}
    except Exception as e:
        logger.warning("[parley] custom integration %s unreadable: %s", path.name, e)
        return None
    if not isinstance(data, dict):
        return None
    name = str(data.get("name") or path.stem).strip().lower()
    if not _NAME_RE.match(name):
        logger.warning("[parley] custom integration %s: bad name %r (want [a-z0-9_-]{1,20})", path.name, name)
        return None
    data["name"] = name
    data["_path"] = str(path)
    return data


def enumerate_custom() -> List[Dict[str, Any]]:
    d = registry_dir()
    if not d.is_dir():
        return []
    out: List[Dict[str, Any]] = []
    for f in sorted(list(d.glob("*.yaml")) + list(d.glob("*.yml"))):
        spec = load_custom(f)
        if not spec:
            continue
        status = spec.get("status") if isinstance(spec.get("status"), dict) else {}
        setup = spec.get("setup") if isinstance(spec.get("setup"), dict) else {}
        has_cmd = bool(status.get("command"))
        lines = []
        if spec.get("description"):
            lines.append(str(spec["description"]).strip())
        lines.append("status check: " + (str(status["command"]) if has_cmd else "none configured (add status.command)"))
        if has_cmd:
            lines.append("not tested yet — press Test")
        docs = str(spec.get("docs") or "")
        out.append(_item("custom", spec["name"], str(spec.get("label") or spec["name"]),
                         connected=None, worst="UNKNOWN", report="\n".join(lines), can_run=has_cmd,
                         provider=spec["name"], docs_url=docs if docs.startswith(("http://", "https://")) else "",
                         setup_markdown=str(setup.get("markdown") or "") if str(setup.get("kind") or "instructions") == "instructions" else "",
                         description=str(spec.get("description") or "")[:160]))
    return out


ENUMERATORS: List[Callable[[], List[Dict[str, Any]]]] = [
    enumerate_mcp, enumerate_platforms, enumerate_model_providers, enumerate_plugins, enumerate_custom,
]


LIST_TTL_S = 20
_list_cache: Dict[str, Any] = {"at": 0.0, "items": None}


def invalidate_list_cache() -> None:
    _list_cache["at"] = 0.0
    _list_cache["items"] = None


def list_items() -> List[Dict[str, Any]]:
    """Every integration as a health item, cached probe results applied.
    Enumeration is memoised for LIST_TTL_S (Settings loads the list on
    open AND close); one broken enumerator never hides the others."""
    now = time.time()
    cached = _list_cache.get("items")
    if cached is not None and now - float(_list_cache.get("at") or 0) < LIST_TTL_S:
        return [_apply_cache(dict(it)) for it in cached]
    items = _enumerate_all()
    _list_cache["at"], _list_cache["items"] = now, [dict(it) for it in items]
    return items


def _enumerate_all() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: set = set()
    for fn in ENUMERATORS:
        try:
            items = fn()
        except Exception as e:
            logger.exception("[parley] integrations: %s failed", fn.__name__)
            items = [_item("other", fn.__name__.replace("enumerate_", ""), fn.__name__.replace("enumerate_", "").replace("_", " "),
                           connected=None, worst="UNKNOWN", report=f"enumeration failed: {e}", can_run=False)]
        for it in items:
            if it["id"] in seen:
                continue
            seen.add(it["id"])
            out.append(_apply_cache(it))
    return out


# ── probes ("Test") ──────────────────────────────────────────────────────

def _probe_timeout() -> int:
    try:
        return max(5, int(os.environ.get("PARLEY_INTEGRATION_PROBE_TIMEOUT", str(DEFAULT_PROBE_TIMEOUT_S))))
    except ValueError:
        return DEFAULT_PROBE_TIMEOUT_S


def probe_mcp(name: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Connect, list tools, disconnect — hermes' own `hermes mcp test` probe."""
    t0 = time.time()
    try:
        from hermes_cli.mcp_config import _probe_single_server  # type: ignore
        details: Dict[str, Any] = {}
        tools = _probe_single_server(name, dict(cfg), connect_timeout=float(_probe_timeout()), details=details)
        ms = int((time.time() - t0) * 1000)
        names = [t[0] for t in tools][:40]
        report = f"connected · {len(tools)} tool(s) · {ms} ms\n" + "\n".join(f"OK   {n}" for n in names)
        if len(tools) > 40:
            report += f"\n… and {len(tools) - 40} more"
        return {"worst": "OK", "report": report}
    except Exception as e:
        ms = int((time.time() - t0) * 1000)
        msg = str(e) or e.__class__.__name__
        return {"worst": "FAIL", "report": f"FAIL connect — {msg} ({ms} ms)"}


def probe_custom(spec: Dict[str, Any]) -> Dict[str, Any]:
    status = spec.get("status") if isinstance(spec.get("status"), dict) else {}
    cmd = str(status.get("command") or "")
    if not cmd:
        return {"worst": "UNKNOWN", "report": "no status.command configured"}
    try:
        timeout = max(5, int(status.get("timeout_s") or 60))
    except (TypeError, ValueError):
        timeout = 60
    argv = [_expand(a) for a in shlex.split(cmd)]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                              cwd=os.path.dirname(spec.get("_path") or "") or None, env={**os.environ, "H_NO_ALERT": "1"})
    except subprocess.TimeoutExpired:
        return {"worst": "FAIL", "report": f"FAIL status check did not finish within {timeout}s"}
    except FileNotFoundError as e:
        return {"worst": "FAIL", "report": f"FAIL status command not found: {e.filename}"}
    except Exception as e:
        return {"worst": "FAIL", "report": f"FAIL status command error: {e}"}
    worst = "OK" if proc.returncode == 0 else ("WARN" if proc.returncode == 1 else "FAIL")
    out = (proc.stdout or "").strip() or (proc.stderr or "").strip()
    return {"worst": worst, "report": (out or f"exit {proc.returncode}")[-_REPORT_MAX:]}


def run_item(item: str) -> Optional[Dict[str, Any]]:
    """Probe one integration synchronously (call from an executor).
    None = not an integration id we know. Raises ValueError for items
    that cannot be tested here."""
    if not item.startswith(ID_PREFIX):
        return None
    items = {it["id"]: it for it in list_items()}
    cur = items.get(item)
    if cur is None:
        return None
    kind = cur["integration"]["kind"]
    name = cur["integration"]["provider"]
    if kind == "mcp":
        servers = _load_config().get("mcp_servers") or {}
        cfg = servers.get(name) if isinstance(servers, dict) else None
        if not isinstance(cfg, dict):
            raise ValueError(f"MCP server '{name}' is no longer configured")
        res = probe_mcp(name, cfg)
    elif kind == "custom":
        spec = None
        for f in sorted(list(registry_dir().glob("*.yaml")) + list(registry_dir().glob("*.yml"))):
            s = load_custom(f)
            if s and s["name"] == name:
                spec = s
                break
        if spec is None:
            raise ValueError(f"custom integration '{name}' is no longer in the registry")
        res = probe_custom(spec)
    else:
        raise ValueError(f"'{cur['name']}' has no test here (its status is read from configuration)")
    rec = cache().put(item, res["worst"], res["report"])
    invalidate_list_cache()
    cur["worst"], cur["report"], cur["last_run_at"] = rec["worst"], rec["report"], rec["last_run_at"]
    cur["counts"] = _counts(cur["worst"])
    return cur
