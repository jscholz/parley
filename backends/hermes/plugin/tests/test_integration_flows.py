"""parley_integration_flows — OAuth (browser) via hermes' dashboard bridge, catalog add, actions."""
from __future__ import annotations

import asyncio
import sys
import types

import pytest

from .. import parley_integration_flows as flows
from .. import parley_integrations as integ
from .. import parley_route_health as hr
from .test_integrations import home  # noqa: F401  (fixture: stubbed hermes + tmp home)


@pytest.fixture()
def oauth_env(home, monkeypatch):
    """Stub the hermes OAuth plumbing around the REAL DashboardOAuthFlow:
    the probe publishes an authorization URL, then waits for the callback."""
    import importlib
    real_dashboard = importlib.import_module("tools.mcp_dashboard_oauth") if "tools" in sys.modules and sys.modules["tools"] else None
    # The home fixture nulls `tools`; put back the real dashboard module (stdlib-only) and stub the rest.
    tools_pkg = types.ModuleType("tools"); tools_pkg.__path__ = []  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "tools", tools_pkg)
    for name in ("tools.mcp_dashboard_oauth",):
        monkeypatch.delitem(sys.modules, name, raising=False)
    from hermes_cli import mcp_config as _mc  # the stub from `home`
    state = {"probe_calls": [], "saved": None, "removed": [], "restored": []}

    def _probe(name, cfg, connect_timeout=None, details=None):
        from tools.mcp_dashboard_oauth import get_dashboard_oauth_flow
        d = get_dashboard_oauth_flow()
        state["probe_calls"].append((name, cfg.get("auth"), d.redirect_uri))
        asyncio.run(d.publish_authorization_url("https://provider.example/authorize?client_id=x&state=STATE123"))
        code, st, iss = asyncio.run(d.wait_for_callback(timeout=5))
        if code == "bad":
            raise RuntimeError("token exchange failed: invalid_grant")
        return [("search", "Search"), ("fetch", "Fetch")]
    _mc._probe_single_server = _probe
    _mc._oauth_tokens_present = lambda name: True
    _mc._save_mcp_server = lambda name, cfg: state.__setitem__("saved", (name, cfg)) or True
    m_oauth = types.ModuleType("tools.mcp_oauth")
    class _Storage:
        def __init__(self, name, **kw): self.name = name
        def snapshot(self): return {"tok": b"old"}
        def restore(self, snap, only_if_absent=False): state["restored"].append(self.name)
    import contextlib
    m_oauth.HermesTokenStorage = _Storage
    m_oauth.force_interactive_oauth = lambda: contextlib.nullcontext()
    m_oauth.login_connect_timeout = lambda cfg: 5.0
    m_oauth.humanize_oauth_registration_error = lambda name, exc, server_url=None: None
    m_mgr = types.ModuleType("tools.mcp_oauth_manager")
    class _Mgr:
        def remove(self, name, **kw): state["removed"].append(name); return "prev"
        def restore_entry(self, name, entry, **kw): state["restored"].append(("entry", name, entry))
    m_mgr.get_manager = lambda: _Mgr()
    m_loop = types.ModuleType("tools.mcp_tool_loop")
    m_loop.reconnect_mcp_server = lambda name: state.__setitem__("reconnected", name) or True
    for name, mod in (("tools.mcp_oauth", m_oauth), ("tools.mcp_oauth_manager", m_mgr), ("tools.mcp_tool_loop", m_loop)):
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.setenv("PARLEY_PROXY_ORIGIN", "http://127.0.0.1:3001")
    flows._flows.clear()
    return state


def _run(c):
    return asyncio.new_event_loop().run_until_complete(c)


def test_actions_only_on_oauth_capable_mcp_items(home):
    items = {it["id"]: it for it in integ.list_items()}
    attio = items["int-mcp-attio"]["integration"]
    assert attio["actions"] == [{"id": "connect", "label": "Reconnect", "flow": "oauth"}]
    assert "actions" not in items["int-mcp-notion"]["integration"]          # stdio: env keys, not OAuth
    assert "actions" not in items["int-mcp-linear"]["integration"]          # header auth
    assert "actions" not in items["int-platform-telegram"]["integration"]
    assert "actions" not in items["int-custom-linkedin-harness"]["integration"]


def test_public_origin_prefers_the_client_origin_and_validates(home, monkeypatch):
    monkeypatch.setenv("PARLEY_PROXY_ORIGIN", "http://127.0.0.1:3001")
    assert flows.public_origin("https://galatea.taile0c895.ts.net:3001/") == "https://galatea.taile0c895.ts.net:3001"
    assert flows.public_origin("javascript:alert(1)") == "http://127.0.0.1:3001"
    assert flows.public_origin("https://x.example/path") == "http://127.0.0.1:3001"
    monkeypatch.setenv("PARLEY_PUBLIC_ORIGIN", "https://pub.example")
    assert flows.public_origin(None) == "https://pub.example"
    assert flows.redirect_uri("att io", "https://h.example") == "https://h.example/api/parley/integrations/oauth/callback/att%20io"


def test_oauth_flow_end_to_end(oauth_env):
    view = _run(flows.start_oauth("int-mcp-attio", "https://galatea.example:3001"))
    assert view["status"] == "waiting" and view["authorization_url"].startswith("https://provider.example/authorize")
    assert oauth_env["probe_calls"][0] == ("attio", "oauth", "https://galatea.example:3001/api/parley/integrations/oauth/callback/attio")
    fid = view["flow_id"]
    # Wrong state → rejected, flow still waiting.
    r = flows.deliver_callback("attio", code="abc", state="WRONG", error=None)
    assert r["ok"] is False and r["status"] == "expired"
    r = flows.deliver_callback("attio", code="abc", state="STATE123", error=None)
    assert r["ok"] is True
    flows.get_flow(fid).worker_done.wait(5)
    final = flows.get_flow(fid).view()
    assert final["status"] == "done", final
    assert oauth_env["saved"][0] == "attio" and oauth_env["saved"][1]["auth"] == "oauth"
    assert oauth_env.get("reconnected") == "attio"
    # The item now carries the probe result.
    integ.invalidate_list_cache()
    it = {i["id"]: i for i in integ.list_items()}["int-mcp-attio"]
    assert it["worst"] == "OK" and "2 tool(s)" in it["report"] and it["last_run_at"]
    # A second callback for the same flow is rejected as already used.
    r = flows.deliver_callback("attio", code="abc", state="STATE123", error=None)
    assert r["ok"] is False


def test_oauth_flow_failure_restores_tokens(oauth_env):
    view = _run(flows.start_oauth("int-mcp-attio", None))
    fid = view["flow_id"]
    flows.deliver_callback("attio", code="bad", state="STATE123", error=None)
    flows.get_flow(fid).worker_done.wait(5)
    final = flows.get_flow(fid).view()
    assert final["status"] == "error" and "invalid_grant" in final["error"]
    assert oauth_env["restored"] and oauth_env["saved"] is None
    integ.invalidate_list_cache()
    assert {i["id"]: i for i in integ.list_items()}["int-mcp-attio"]["worst"] == "FAIL"


def test_oauth_flow_cancel_and_duplicate_guard(oauth_env):
    view = _run(flows.start_oauth("int-mcp-attio", None))
    with pytest.raises(flows.FlowError) as ei:
        _run(flows.start_oauth("int-mcp-attio", None))
    assert ei.value.status == 409
    r = flows.cancel_flow(view["flow_id"])
    assert r["status"] in ("cancelled", "error")
    flows.get_flow(view["flow_id"]).worker_done.wait(5)
    assert flows.get_flow(view["flow_id"]).view()["status"] == "cancelled"
    assert flows.cancel_flow("nope") == {"ok": True, "status": "expired"}


def test_start_oauth_rejects_non_oauth_items(oauth_env):
    with pytest.raises(flows.FlowError, match="env keys"):
        _run(flows.start_oauth("int-mcp-notion", None))
    with pytest.raises(flows.FlowError, match="API-key"):
        _run(flows.start_oauth("int-mcp-linear", None))
    with pytest.raises(flows.FlowError, match="only MCP"):
        _run(flows.start_oauth("int-platform-telegram", None))


@pytest.fixture()
def catalog_env(home, monkeypatch):
    D = types.SimpleNamespace
    class Spec:
        def __init__(self, name, prompt, secret=True, required=True):
            self.name, self.prompt, self.secret, self.required = name, prompt, secret, required
    entries = [
        D(name="linear", description="Issues and projects", source="https://linear.app", auth=D(type="oauth", env=[]), transport=D(type="http"), install=None),
        D(name="asana", description="Tasks", source="", auth=D(type="oauth", env=[Spec("ASANA_CLIENT_ID", "Asana client id", secret=False), Spec("ASANA_CLIENT_SECRET", "Asana client secret")]), transport=D(type="http"), install=None),
        D(name="context7", description="Docs", source="", auth=D(type="none", env=[]), transport=D(type="http"), install=None),
    ]
    m_cat = types.ModuleType("hermes_cli.mcp_catalog")
    m_cat.list_catalog = lambda: entries
    m_cat.installed_servers = lambda: {"attio": {}, "notion": {}}
    m_cat.get_entry = lambda name: next((e for e in entries if e.name == name), None)
    state = {"installed": [], "env": {}}
    def _install(entry, enable=True, preloaded_env=None):
        if entry.name == "context7":
            raise RuntimeError("config rejected")
        state["installed"].append((entry.name, enable, dict(preloaded_env or {})))
    m_cat.install_entry = _install
    monkeypatch.setitem(sys.modules, "hermes_cli.mcp_catalog", m_cat)
    cfg = sys.modules["hermes_cli.config"]
    cfg.save_env_value = lambda k, v: state["env"].__setitem__(k, v)
    cfg.validate_env_var_name_for_write = lambda k: None
    flows._flows.clear()
    return state


def test_catalog_lists_addable_entries(catalog_env):
    cat = {c["provider"]: c for c in flows.catalog()}
    assert cat["linear"]["setup"] == "oauth" and cat["linear"]["installed"] is False and cat["linear"]["docs_url"] == "https://linear.app"
    assert cat["asana"]["setup"] == "oauth" and [f["id"] for f in cat["asana"]["fields"]] == ["ASANA_CLIENT_ID", "ASANA_CLIENT_SECRET"]
    assert cat["asana"]["fields"][0]["secret"] is False and cat["asana"]["fields"][1]["secret"] is True
    assert cat["context7"]["setup"] == "none"


def test_add_validates_fields_and_installs_in_background(catalog_env):
    with pytest.raises(flows.FlowError, match="missing: ASANA_CLIENT_ID, ASANA_CLIENT_SECRET"):
        flows.start_add("asana", {})
    with pytest.raises(flows.FlowError, match="does not declare"):
        flows.start_add("linear", {"EVIL": "x"})
    with pytest.raises(flows.FlowError) as ei:
        flows.start_add("nope", {})
    assert ei.value.status == 404
    view = flows.start_add("asana", {"ASANA_CLIENT_ID": "id1", "ASANA_CLIENT_SECRET": "sec"})
    assert view["kind"] == "install" and view["item_id"] == "int-mcp-asana"
    flows.get_flow(view["flow_id"]).worker_done.wait(5)
    final = flows.get_flow(view["flow_id"]).view()
    assert final["status"] == "done" and "Connect" in final["message"]
    assert catalog_env["env"] == {"ASANA_CLIENT_SECRET": "sec"}                 # only secrets go to .env
    assert catalog_env["installed"] == [("asana", True, {"ASANA_CLIENT_ID": "id1", "ASANA_CLIENT_SECRET": "sec"})]
    bad = flows.start_add("context7", {})
    flows.get_flow(bad["flow_id"]).worker_done.wait(5)
    assert flows.get_flow(bad["flow_id"]).view()["status"] == "error"


class _Adapter:
    def _check_http_auth(self, r): return True


class _Req:
    def __init__(self, match=None, query=None, body=None):
        self.match_info = match or {}; self.query = query or {}; self._body = body
    async def json(self):
        if self._body is None: raise ValueError("no body")
        return self._body


def test_routes(oauth_env, catalog_env):
    import json
    r = _run(hr.handle_catalog(_Adapter(), _Req()))
    assert r.status == 200 and {c["provider"] for c in json.loads(r.text)["data"]} == {"linear", "asana", "context7"}
    r = _run(hr.handle_item_action(_Adapter(), _Req({"check_id": "int-mcp-attio", "action": "connect"}, body={"origin": "https://h.example"})))
    assert r.status == 202
    view = json.loads(r.text)
    assert view["status"] == "waiting" and "authorization_url" in view
    r = _run(hr.handle_flow_status(_Adapter(), _Req({"flow_id": view["flow_id"]})))
    assert r.status == 200 and json.loads(r.text)["status"] == "waiting"
    r = _run(hr.handle_oauth_callback(_Adapter(), _Req({"server": "attio"}, query={"code": "abc", "state": "STATE123"})))
    assert r.status == 200 and json.loads(r.text)["ok"] is True
    flows.get_flow(view["flow_id"]).worker_done.wait(5)
    r = _run(hr.handle_flow_status(_Adapter(), _Req({"flow_id": view["flow_id"]})))
    assert json.loads(r.text)["status"] == "done"
    r = _run(hr.handle_item_action(_Adapter(), _Req({"check_id": "int-mcp-notion", "action": "connect"}, body={})))
    assert r.status == 400
    r = _run(hr.handle_item_action(_Adapter(), _Req({"check_id": "int-custom-linkedin-harness", "action": "test"}, body={})))
    assert r.status == 200 and json.loads(r.text)["item"]["worst"] == "OK"
    r = _run(hr.handle_catalog_add(_Adapter(), _Req({"provider": "linear"}, body={"env": {}})))
    assert r.status == 202 and json.loads(r.text)["kind"] == "install"
    r = _run(hr.handle_flow_cancel(_Adapter(), _Req({"flow_id": "zzz"})))
    assert json.loads(r.text)["status"] == "expired"
    r = _run(hr.handle_flow_status(_Adapter(), _Req({"flow_id": "zzz"})))
    assert r.status == 404
