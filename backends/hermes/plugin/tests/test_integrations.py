"""parley_integrations — enumeration + on-demand probe, with hermes stubbed."""
from __future__ import annotations

import json
import stat
import sys
import types

import pytest

from .. import parley_integrations as integ
from .. import parley_route_health as hr


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "hermes"; h.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setenv("PARLEY_HEALTH_STATE_DIR", str(tmp_path / "health"))
    monkeypatch.setenv("NOTION_API_KEY", "secret-123")
    monkeypatch.delenv("LINEAR_KEY", raising=False)
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "tok")
    monkeypatch.setenv("HASS_TOKEN", "hass")
    # hermes_cli stubs: config + auth + provider catalog
    cfg = {
        "mcp_servers": {
            "notion": {"command": "npx", "args": ["-y", "x"], "env": {"NOTION_TOKEN": "${NOTION_API_KEY}"}},
            "attio": {"url": "https://mcp.attio.com/mcp", "auth": "oauth"},
            "linear": {"url": "https://mcp.linear.app", "headers": {"Authorization": "Bearer ${LINEAR_KEY}"}},
            "old": {"command": "x", "enabled": False},
        },
        "platforms": {"slack": {"extra": {}}},
        "model": {"provider": "openrouter"},
    }
    hermes_cli = sys.modules.get("hermes_cli") or types.ModuleType("hermes_cli")
    m_cfg = types.ModuleType("hermes_cli.config")
    m_cfg.load_config_readonly = lambda: cfg
    m_cfg.load_config = lambda: cfg
    m_cfg.get_hermes_home = lambda: h
    import os
    m_cfg.get_env_value = lambda k: os.environ.get(k)
    m_auth = types.ModuleType("hermes_cli.auth")
    m_auth.get_active_provider = lambda: "openrouter"
    statuses = {"openrouter": {"configured": True, "logged_in": True, "key_source": "env:OPENROUTER_API_KEY"},
                "openai-codex": {"logged_in": True},
                "nous": {"logged_in": False}}
    m_cat = types.ModuleType("hermes_cli.provider_catalog")
    D = types.SimpleNamespace
    def _status(slug):
        if slug == "bedrock":
            raise AssertionError("aws_sdk status must not be consulted unless active")
        return statuses.get(slug, {"logged_in": False})
    m_auth.get_auth_status = _status
    m_cat.provider_catalog = lambda: [D(slug="openrouter", label="OpenRouter", signup_url="https://openrouter.ai", auth_type="api_key"),
                                      D(slug="openai-codex", label="OpenAI Codex", signup_url="", auth_type="oauth_external"),
                                      D(slug="nous", label="Nous", signup_url="", auth_type="oauth_device_code"),
                                      D(slug="bedrock", label="AWS Bedrock", signup_url="", auth_type="aws_sdk")]
    m_mcp = types.ModuleType("hermes_cli.mcp_config")
    calls = []
    def _probe(name, cfg, connect_timeout=None, details=None):
        calls.append((name, connect_timeout))
        if name == "notion":
            return [("search", "Search pages"), ("fetch", "Fetch a page")]
        raise RuntimeError("401 Unauthorized")
    m_mcp._probe_single_server = _probe
    for name, mod in (("hermes_cli", hermes_cli), ("hermes_cli.config", m_cfg), ("hermes_cli.auth", m_auth),
                      ("hermes_cli.provider_catalog", m_cat), ("hermes_cli.mcp_config", m_mcp)):
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.setitem(sys.modules, "tools", None)          # force the file fallback for OAuth tokens
    monkeypatch.setitem(sys.modules, "tools.mcp_oauth", None)
    # files: tokens, gateway state, plugins, auth store, custom registry
    (h / "mcp-tokens").mkdir(); (h / "mcp-tokens" / "attio.json").write_text("{}")
    (h / "gateway_state.json").write_text(json.dumps({"pid": 42, "platforms": {
        "telegram": {"state": "connected", "writer_pid": 42, "needs_attention": False},
        "api_server": {"state": "connected", "writer_pid": 42},
        "parley": {"state": "connected", "writer_pid": 42},
        "discord": {"state": "error", "error_message": "bad token", "writer_pid": 42},
        "whatsapp": {"state": "connected", "writer_pid": 7},     # stale: an earlier gateway process
    }}))
    (h / "auth.json").write_text(json.dumps({"providers": {"spotify": {"expires_at": 1_900_000_000}}}))
    for name, man in (("spotify", "name: spotify\nlabel: Spotify\nkind: standalone\n"),
                      ("homeassistant", "name: homeassistant\nlabel: Home Assistant\nkind: standalone\nrequires_env:\n  - name: HASS_TOKEN\n"),
                      ("hindsight", "name: hindsight\nrequires_env: []\n"),
                      ("parley", "name: parley\nkind: platform\nrequires_env:\n  - name: PARLEY_PLATFORM_TOKEN\n")):
        d = h / "plugins" / name; d.mkdir(parents=True); (d / "plugin.yaml").write_text(man)
    reg = h / "integrations"; reg.mkdir()
    script = tmp_path / "li-status"
    script.write_text("#!/usr/bin/env bash\necho 'logged in as jonathan · 3 scripts ok'\nexit ${LI_RC:-0}\n")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    (reg / "linkedin-harness.yaml").write_text(
        "label: LinkedIn (Playwright harness)\ndescription: Logged-in LinkedIn profile driven by my scripts.\n"
        f"status:\n  command: {script}\n  timeout_s: 20\nsetup:\n  kind: instructions\n  markdown: |\n    Run bin/login once.\n")
    (reg / "Bad Name.yaml").write_text("name: 'Not Valid!'\n")
    (reg / "nocheck.yaml").write_text("label: No check\n")
    integ._cache = None
    integ.invalidate_list_cache()
    return {"home": h, "calls": calls, "tmp": tmp_path}


def _by_id(items):
    return {i["id"]: i for i in items}


def test_enumerates_every_kind_with_honest_connected_flags(home):
    items = _by_id(integ.list_items())
    # MCP
    assert items["int-mcp-notion"]["integration"] == {"kind": "mcp", "provider": "notion", "connected": True}
    assert items["int-mcp-notion"]["worst"] == "UNKNOWN" and items["int-mcp-notion"]["can_run"] is True
    assert items["int-mcp-attio"]["integration"]["connected"] is True       # token file on disk
    lin = items["int-mcp-linear"]
    assert lin["integration"]["connected"] is False and lin["worst"] == "WARN" and "LINEAR_KEY" in lin["report"]
    assert items["int-mcp-old"]["can_run"] is False and "disabled" in items["int-mcp-old"]["report"]
    # platforms: live from gateway_state, configured-but-down is WARN, hermes' own surfaces skipped
    assert items["int-platform-telegram"]["worst"] == "OK" and items["int-platform-telegram"]["integration"]["connected"] is True
    assert items["int-platform-slack"]["worst"] == "WARN" and items["int-platform-slack"]["integration"]["connected"] is False
    assert "int-platform-api_server" not in items and "int-platform-parley" in items
    assert items["int-platform-discord"]["worst"] == "FAIL" and "bad token" in items["int-platform-discord"]["report"]
    assert "int-platform-whatsapp" not in items                            # stale writer dropped
    # model providers: credentialed ones + the active one only
    assert items["int-model-provider-openrouter"]["worst"] == "OK" and "active provider" in items["int-model-provider-openrouter"]["report"]
    assert items["int-model-provider-openai-codex"]["worst"] == "OK"
    assert "int-model-provider-nous" not in items
    # plugins: auth-store or requires_env; platform-kind and env-less ones skipped
    assert items["int-plugin-spotify"]["worst"] == "OK" and "signed in" in items["int-plugin-spotify"]["report"]
    assert items["int-plugin-homeassistant"]["worst"] == "OK"
    assert "int-plugin-hindsight" not in items and "int-plugin-parley" not in items
    # custom registry
    li = items["int-custom-linkedin-harness"]
    assert li["name"] == "LinkedIn (Playwright harness)" and li["can_run"] is True and li["worst"] == "UNKNOWN"
    assert li["integration"]["kind"] == "custom" and "Run bin/login" in li["integration"]["setup_markdown"]
    assert items["int-custom-nocheck"]["can_run"] is False
    assert not any(k.startswith("int-custom-not") for k in items)
    # every item carries the health-item shape
    for it in items.values():
        assert set(it) >= {"id", "name", "worst", "last_run_at", "report", "can_run", "counts", "integration"}
        assert len(it["id"]) <= 32 and hr._ID_RE.match(it["id"])


def test_probe_mcp_caches_and_persists(home):
    out = integ.run_item("int-mcp-notion")
    assert out["worst"] == "OK" and "2 tool(s)" in out["report"] and "OK   search" in out["report"]
    assert out["last_run_at"] and home["calls"][0][0] == "notion"
    # a fresh listing (new cache object, as after a gateway restart) still shows the result
    integ._cache = None
    integ.invalidate_list_cache()
    again = _by_id(integ.list_items())["int-mcp-notion"]
    assert again["worst"] == "OK" and again["last_run_at"] == out["last_run_at"]
    assert (home["tmp"] / "health" / "integrations.json").exists()
    bad = integ.run_item("int-mcp-attio")
    assert bad["worst"] == "FAIL" and "401" in bad["report"]


def test_probe_custom_maps_exit_codes(home, monkeypatch):
    ok = integ.run_item("int-custom-linkedin-harness")
    assert ok["worst"] == "OK" and "logged in as jonathan" in ok["report"]
    monkeypatch.setenv("LI_RC", "1")
    assert integ.run_item("int-custom-linkedin-harness")["worst"] == "WARN"
    monkeypatch.setenv("LI_RC", "2")
    assert integ.run_item("int-custom-linkedin-harness")["worst"] == "FAIL"
    with pytest.raises(ValueError, match="no test here"):
        integ.run_item("int-platform-telegram")
    assert integ.run_item("int-mcp-nothing") is None
    assert integ.run_item("hermes") is None


def test_health_routes_merge_integrations(home):
    ids = {c["id"] for c in hr.list_all()}
    assert "int-mcp-notion" in ids and "int-custom-linkedin-harness" in ids
    assert hr.run_check("int-custom-linkedin-harness")["worst"] == "OK"
    with pytest.raises(hr.HealthValidationError, match="no test here"):
        hr.run_check("int-platform-telegram")
    assert hr.run_check("int-mcp-nothing") is None


def test_one_broken_enumerator_does_not_hide_the_rest(home, monkeypatch):
    def boom():
        raise RuntimeError("hermes moved the function")
    monkeypatch.setattr(integ, "ENUMERATORS", [boom, integ.enumerate_custom])
    items = _by_id(integ.list_items())
    assert "int-custom-linkedin-harness" in items
    broken = items["int-other-boom"]
    assert broken["worst"] == "UNKNOWN" and "hermes moved the function" in broken["report"]
