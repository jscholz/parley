"""Settings schema + POST route for local mode and the Memory section.

docs/LOCAL_MODE.md §1 (runtime_profile) and §3 (Settings › Memory), over the
generic settings extension in docs/ABSTRACT_AGENT_PROTOCOL.md.

Every hermes read (config.yaml, .env), the local-server probe, systemctl,
journalctl and the memory-profile script are injected or monkeypatched. The
suite must never touch the owner's live agent — this is the setting that
decides where every one of his model calls goes.
"""
from __future__ import annotations

import asyncio
import json
import subprocess

import pytest

from .. import parley_route_settings as st
from .. import parley_runtime_profiles as rp


CFG = {
    "model": {"default": "gpt-5.6-sol", "provider": "openai-codex",
              "base_url": "https://chatgpt.com/backend-api/codex"},
    "auxiliary": {"vision": {"provider": "openai-codex", "model": "gpt-5.5", "timeout": 120}},
    "fallback_providers": [{"provider": "custom:local-fallback", "model": "qwen3.6-35b-a3b"}],
    "compression": {"enabled": True, "threshold": 0.7},
    "memory": {"memory_enabled": True, "user_profile_enabled": False},
    "parley": {"preferred_models": ["anthropic/*"]},
}
ENV = {
    "HINDSIGHT_API_LLM_PROVIDER": "openai-codex",
    "HINDSIGHT_API_LLM_MODEL": "gpt-5.4-mini",
    "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "openai",
    "HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL": "text-embedding-3-small",
}
READY = rp.ServerProbe(True, "http://127.0.0.1:8000 ready", ("qwen3.6-35b-a3b",))
DOWN = rp.ServerProbe(False, "http://127.0.0.1:8000 is not answering")


@pytest.fixture()
def sandbox(monkeypatch, tmp_path):
    """A settings module whose every hermes/OS touchpoint is fake.

    The hindsight config file is a REAL temp file (via
    ``PARLEY_HINDSIGHT_CONFIG``) rather than another monkeypatched map —
    parley_hindsight_config.py's own read/validate/write is covered in
    isolation by test_parley_hindsight_config.py; here we only need it to
    not touch a real install, which the env override already guarantees.
    """
    hs_path = tmp_path / "hindsight-config.json"
    monkeypatch.setenv("PARLEY_HINDSIGHT_CONFIG", str(hs_path))
    state = {"cfg": json.loads(json.dumps(CFG)), "env": dict(ENV),
             "probe": READY, "saved": [], "env_writes": [], "script": [],
             "hindsight_path": hs_path}
    monkeypatch.setattr(st, "read_hermes_config", lambda: json.loads(json.dumps(state["cfg"])))
    monkeypatch.setattr(st, "read_hermes_env", lambda: dict(state["env"]))
    monkeypatch.setattr(st, "_probe_local_server", lambda profile: state["probe"])
    monkeypatch.setattr(st, "_cloud_model_catalog", lambda *a, **k: [
        {"value": "openai-codex:gpt-5.6-sol", "label": "gpt-5.6-sol", "group": "OpenAI Codex"},
        {"value": "anthropic/claude-opus-4.6", "label": "claude opus", "group": "OpenRouter"},
    ])
    monkeypatch.setattr(st, "memory_status_text", lambda: "hindsight-server active · last retain 3 min ago · 0 LLM errors / 24h")

    def _save(cfg):
        state["saved"].append(json.loads(json.dumps(cfg)))
        state["cfg"] = json.loads(json.dumps(cfg))
    monkeypatch.setattr(st, "_write_hermes_config", _save)

    def _env(updates):
        state["env_writes"].append(dict(updates))
        for k, v in updates.items():
            state["env"].pop(k, None) if v is None else state["env"].update({k: v})
    monkeypatch.setattr(st, "_write_hermes_env", _env)
    monkeypatch.setattr(st, "_restart_memory_server", lambda spec: state["script"].append(spec.as_args()))
    return state


def _hindsight_disk(state):
    return json.loads(state["hindsight_path"].read_text(encoding="utf-8"))


def _by_id(schema):
    return {s["id"]: s for s in schema}


# ── schema ──────────────────────────────────────────────────────────────

def test_runtime_profile_setting_is_declared(sandbox):
    d = _by_id(st.build_settings_schema())["runtime_profile"]
    assert d["type"] == "enum" and d["category"] == "Agent" and d["group"] == "Runtime"
    assert d["value"] == "cloud"
    assert [o["value"] for o in d["options"]] == ["cloud", "local"]
    assert "evicted" in d["description"]      # the cached-agent caveat


def test_local_option_description_follows_the_live_probe(sandbox):
    opts = {o["value"]: o for o in _by_id(st.build_settings_schema())["runtime_profile"]["options"]}
    assert opts["local"]["description"].endswith("— ready")
    assert "custom:local-fallback" in opts["local"]["description"]
    assert opts["cloud"]["description"] == "openai-codex · gpt-5.6-sol — needs the internet"
    sandbox["probe"] = DOWN
    opts = {o["value"]: o for o in _by_id(st.build_settings_schema())["runtime_profile"]["options"]}
    assert opts["local"]["description"].endswith("— server not responding")


def test_memory_section_fields_and_readonly_flags(sandbox):
    schema = _by_id(st.build_settings_schema())
    memory = [s for s in st.build_settings_schema() if s.get("category") == "Memory"]
    assert [s["id"] for s in memory] == [
        "memory_enabled", "memory_user_profile",
        "memory_recall", "memory_recall_max_tokens", "memory_recall_budget",
        "memory_retain", "memory_retain_every_n_turns",
        "memory_llm", "memory_embeddings", "memory_status", "memory_hindsight_state",
    ]
    # groups
    assert schema["memory_enabled"]["group"] == "Built-in files"
    assert schema["memory_user_profile"]["group"] == "Built-in files"
    for sid in ("memory_recall", "memory_recall_max_tokens", "memory_recall_budget",
                "memory_retain", "memory_retain_every_n_turns",
                "memory_llm", "memory_embeddings", "memory_status", "memory_hindsight_state"):
        assert schema[sid]["group"] == "Hindsight"
    # relabeled built-in-file toggles, honest about being separate from hindsight
    assert schema["memory_enabled"]["label"] == "Notes file (MEMORY.md)"
    assert schema["memory_user_profile"]["label"] == "User profile file (USER.md)"
    assert "Hindsight" in schema["memory_enabled"]["description"]
    assert schema["memory_enabled"]["type"] == "toggle" and schema["memory_enabled"]["value"] is True
    assert schema["memory_user_profile"]["value"] is False
    # hindsight defaults (no file written yet in this sandbox)
    assert schema["memory_recall"]["type"] == "toggle" and schema["memory_recall"]["value"] is True
    assert schema["memory_recall_max_tokens"]["type"] == "slider"
    assert schema["memory_recall_max_tokens"]["value"] == 4096
    assert schema["memory_recall_max_tokens"]["min"] == 200 and schema["memory_recall_max_tokens"]["max"] == 16000
    assert schema["memory_recall_budget"]["type"] == "enum" and schema["memory_recall_budget"]["value"] == "mid"
    assert {o["value"] for o in schema["memory_recall_budget"]["options"]} == {"low", "mid", "high"}
    assert schema["memory_retain"]["value"] is True
    assert "EXPENSIVE" in schema["memory_retain"]["description"]
    assert schema["memory_retain_every_n_turns"]["value"] == 1
    assert schema["memory_retain_every_n_turns"]["min"] == 1 and schema["memory_retain_every_n_turns"]["max"] == 50
    # readonly text lines
    for sid in ("memory_llm", "memory_embeddings", "memory_status", "memory_hindsight_state"):
        assert schema[sid]["type"] == "text" and schema[sid]["readonly"] is True
    # writable ones must NOT be marked readonly
    assert "readonly" not in schema["memory_enabled"]
    assert "readonly" not in schema["memory_recall"]
    assert schema["memory_llm"]["value"] == "openai-codex · gpt-5.4-mini"
    assert schema["memory_embeddings"]["value"] == "openai · text-embedding-3-small"
    assert schema["memory_status"]["value"].startswith("hindsight-server active")
    assert schema["memory_hindsight_state"]["value"].startswith("hindsight config not found at ")


def test_memory_hindsight_state_reflects_the_file_once_one_exists(sandbox):
    sandbox["hindsight_path"].write_text(json.dumps({
        "auto_recall": True, "recall_max_tokens": 1500, "recall_budget": "low",
        "auto_retain": True, "retain_every_n_turns": 1,
    }), encoding="utf-8")
    schema = _by_id(st.build_settings_schema())
    assert schema["memory_hindsight_state"]["value"] == (
        "recall on · 1500 tok · low | retain on · every 1 turn"
    )
    assert schema["memory_recall_max_tokens"]["value"] == 1500
    assert schema["memory_recall_budget"]["value"] == "low"


def test_memory_llm_shows_the_local_endpoint_in_local_mode(sandbox):
    sandbox["env"]["HINDSIGHT_API_LLM_PROVIDER"] = "lmstudio"
    sandbox["env"]["HINDSIGHT_API_LLM_MODEL"] = "qwen3.6-35b-a3b"
    sandbox["env"]["HINDSIGHT_API_LLM_BASE_URL"] = "http://127.0.0.1:8000/v1"
    v = _by_id(st.build_settings_schema())["memory_llm"]["value"]
    assert v == "lmstudio · qwen3.6-35b-a3b @ http://127.0.0.1:8000/v1"


def test_model_picker_lists_the_local_server_in_local_mode(sandbox):
    """LOCAL_MODE.md §1 rule 3 — and the values stay BARE, because the local
    provider slug contains a colon and would not survive the picker's
    `<slug>:<model>` decoder."""
    rp.set_path(sandbox["cfg"], "parley.runtime_profile", "local")
    rp.set_path(sandbox["cfg"], "model", {"default": "qwen3.6-35b-a3b",
                                          "provider": "custom:local-fallback",
                                          "base_url": "http://127.0.0.1:8000/v1"})
    sandbox["probe"] = rp.ServerProbe(True, "ready", ("qwen3.6-35b-a3b", "another-local"))
    d = _by_id(st.build_settings_schema())["model"]
    assert [o["value"] for o in d["options"]] == ["another-local", "qwen3.6-35b-a3b"]
    assert d["value"] == "qwen3.6-35b-a3b"          # no phantom "Current" row
    assert all(o["group"] == "Local server" for o in d["options"])


def test_model_picker_falls_back_to_the_pinned_model_when_the_server_is_down(sandbox):
    rp.set_path(sandbox["cfg"], "parley.runtime_profile", "local")
    sandbox["probe"] = DOWN
    d = _by_id(st.build_settings_schema())["model"]
    assert [o["value"] for o in d["options"]] == ["gpt-5.6-sol", "qwen3.6-35b-a3b"]


# ── apply ───────────────────────────────────────────────────────────────

def test_apply_runtime_profile_switches_config_env_and_memory(sandbox):
    out = st.apply_setting("runtime_profile", "local")
    assert out["id"] == "runtime_profile" and out["value"] == "local"
    final = sandbox["cfg"]
    assert final["model"]["provider"] == "custom:local-fallback"
    assert final["model"]["max_tokens"] == 8192
    assert final["auxiliary"]["vision"]["provider"] == "custom:local-fallback"
    assert final["auxiliary"]["vision"]["timeout"] == 120        # sibling survives
    assert final["fallback_providers"] == []
    assert final["compression"] == {"enabled": True, "threshold": 0.6}
    assert final["tools"]["tool_search"]["listing_max_tokens"] == 1200
    assert final["skills"]["platform_disabled"]["parley"] == rp.LOCAL_SKILLS_HIDDEN_PARLEY
    assert final["parley"]["runtime_profile"] == "local"
    assert final["parley"]["preferred_models"] == ["anthropic/*"]  # untouched
    assert sandbox["env_writes"] == [{
        "HINDSIGHT_API_LLM_PROVIDER": "lmstudio",
        "HINDSIGHT_API_LLM_MODEL": "qwen3.6-35b-a3b",
        "HINDSIGHT_API_LLM_BASE_URL": "http://127.0.0.1:8000/v1",
    }]
    assert sandbox["script"] == [["lmstudio", "qwen3.6-35b-a3b", "http://127.0.0.1:8000/v1"]]
    # recall/retain landed in the hindsight config file, in-process — no script
    assert _hindsight_disk(sandbox) == {"recall_max_tokens": 1500, "recall_budget": "low"}
    # the marker is the LAST thing written
    assert (sandbox["saved"][0].get("parley") or {}).get("runtime_profile") is None
    assert sandbox["saved"][-1]["parley"]["runtime_profile"] == "local"


def test_apply_runtime_profile_rejects_a_dead_local_server(sandbox):
    sandbox["probe"] = DOWN
    with pytest.raises(st.SettingsValidationError, match="not answering"):
        st.apply_setting("runtime_profile", "local")
    assert sandbox["saved"] == [] and sandbox["env_writes"] == [] and sandbox["script"] == []
    assert sandbox["cfg"] == CFG
    assert not sandbox["hindsight_path"].exists()


@pytest.mark.parametrize("value,needle", [
    ("", "non-empty"), (3, "non-empty"), ("gpu-farm", "unknown runtime profile"),
])
def test_apply_runtime_profile_rejects_bad_values(sandbox, value, needle):
    with pytest.raises(st.SettingsValidationError, match=needle):
        st.apply_setting("runtime_profile", value)
    assert sandbox["saved"] == []


def test_memory_toggles_write_hermes_config(sandbox):
    out = st.apply_setting("memory_user_profile", True)
    assert out["id"] == "memory_user_profile" and out["value"] is True
    assert sandbox["cfg"]["memory"]["user_profile_enabled"] is True
    st.apply_setting("memory_enabled", False)
    assert sandbox["cfg"]["memory"]["memory_enabled"] is False


def test_memory_toggle_rejects_a_non_boolean(sandbox):
    with pytest.raises(st.SettingsValidationError, match="true or false"):
        st.apply_setting("memory_enabled", "yes")


@pytest.mark.parametrize("sid", [
    "memory_llm", "memory_embeddings", "memory_status", "memory_hindsight_state",
])
def test_readonly_settings_reject_writes(sandbox, sid):
    with pytest.raises(st.SettingsValidationError, match="read-only"):
        st.apply_setting(sid, "anything")


# ── Hindsight settings (parley_hindsight_config.py) ──────────────────────

def test_hindsight_toggles_write_the_config_file(sandbox):
    out = st.apply_setting("memory_recall", False)
    assert out["id"] == "memory_recall" and out["value"] is False
    assert _hindsight_disk(sandbox) == {"auto_recall": False}
    st.apply_setting("memory_retain", False)
    assert _hindsight_disk(sandbox) == {"auto_recall": False, "auto_retain": False}


def test_hindsight_numeric_and_enum_fields_round_trip(sandbox):
    st.apply_setting("memory_recall_max_tokens", 6000)
    st.apply_setting("memory_recall_budget", "high")
    st.apply_setting("memory_retain_every_n_turns", 5)
    assert _hindsight_disk(sandbox) == {
        "recall_max_tokens": 6000, "recall_budget": "high", "retain_every_n_turns": 5,
    }
    schema = _by_id(st.build_settings_schema())
    assert schema["memory_recall_max_tokens"]["value"] == 6000
    assert schema["memory_recall_budget"]["value"] == "high"
    assert schema["memory_retain_every_n_turns"]["value"] == 5


@pytest.mark.parametrize("sid,bad,needle", [
    ("memory_recall", "yes", "true or false"),
    ("memory_retain", 1, "true or false"),
    ("memory_recall_max_tokens", 100, "200..16000"),
    ("memory_recall_max_tokens", "lots", "must be an integer"),
    ("memory_recall_budget", "urgent", "must be one of"),
    ("memory_retain_every_n_turns", 0, "1..50"),
    ("memory_retain_every_n_turns", 51, "1..50"),
])
def test_hindsight_fields_reject_bad_values(sandbox, sid, bad, needle):
    with pytest.raises(st.SettingsValidationError, match=needle):
        st.apply_setting(sid, bad)
    assert not sandbox["hindsight_path"].exists()


def test_hindsight_setting_creates_the_file_cleanly_on_a_fresh_install(sandbox):
    assert not sandbox["hindsight_path"].exists()
    st.apply_setting("memory_recall_budget", "high")
    assert sandbox["hindsight_path"].exists()
    assert _hindsight_disk(sandbox) == {"recall_budget": "high"}


def test_hindsight_setting_preserves_unknown_keys(sandbox):
    sandbox["hindsight_path"].write_text(json.dumps({"mode": "local_external", "bank_id": "x"}), encoding="utf-8")
    st.apply_setting("memory_recall", False)
    assert _hindsight_disk(sandbox) == {"mode": "local_external", "bank_id": "x", "auto_recall": False}


def test_unknown_setting_still_404s(sandbox):
    with pytest.raises(st.SettingsNotFoundError):
        st.apply_setting("nope", 1)


def test_model_switch_mirrors_into_the_active_profile(sandbox, monkeypatch):
    """LOCAL_MODE.md §1 rule 3 — in `local` the picker writes the profile's
    provider, not a `<slug>:` decode, and the choice is mirrored so a switch
    away and back does not forget it."""
    rp.set_path(sandbox["cfg"], "parley.runtime_profile", "local")
    rp.set_path(sandbox["cfg"], "parley.runtime_profiles",
                rp.seed_default_profiles(CFG, ENV))
    sandbox["probe"] = rp.ServerProbe(True, "ready", ("qwen3.6-35b-a3b", "another-local"))
    out = st.apply_setting("model", "another-local")
    assert out["value"] == "another-local"
    assert sandbox["cfg"]["model"]["default"] == "another-local"
    assert sandbox["cfg"]["model"]["provider"] == "custom:local-fallback"
    assert sandbox["cfg"]["parley"]["runtime_profiles"]["local"]["model"]["default"] == "another-local"
    assert sandbox["cfg"]["parley"]["runtime_profiles"]["cloud"]["model"]["default"] == "gpt-5.6-sol"


# ── memory status ───────────────────────────────────────────────────────

def _proc(stdout="", rc=0):
    return subprocess.CompletedProcess(args=[], returncode=rc, stdout=stdout, stderr="")


def test_memory_status_reads_the_unit_and_the_journal(monkeypatch):
    import datetime as dt
    now = dt.datetime(2026, 9, 7, 12, 0, 0, tzinfo=dt.timezone.utc)
    journal = "\n".join([
        "2026-09-07T10:00:00+0000 box hindsight[1]: RETAIN_BATCH START: jonathan",
        "2026-09-07T10:01:00+0000 box hindsight[1]: extraction failed: boom",
        "2026-09-07T11:57:00+0000 box hindsight[1]: RETAIN_BATCH START: jonathan",
        "2026-09-07T11:58:00+0000 box hindsight[1]: RateLimitError from upstream",
    ])

    def _run(argv, timeout):
        return _proc("active\n") if argv[0] == "systemctl" else _proc(journal)
    monkeypatch.setattr(st, "_run", _run)
    assert st.memory_status_text(now) == (
        "hindsight-server active · last retain 3 min ago · 2 LLM errors / 24h"
    )


def test_memory_status_reports_a_dead_server(monkeypatch):
    monkeypatch.setattr(st, "_run", lambda argv, timeout:
                        _proc("inactive\n") if argv[0] == "systemctl" else _proc(""))
    assert st.memory_status_text().startswith("hindsight-server NOT active · no retain in 24h")


def test_memory_status_degrades_to_unknown_without_systemd(monkeypatch):
    """Tests and non-systemd hosts must render a row, not a stack trace —
    and "unknown" must not be mistaken for "not active"."""
    monkeypatch.setattr(st, "_run", lambda argv, timeout: None)
    assert st.memory_status_text() == (
        "hindsight-server unknown · last retain unknown · LLM errors unknown"
    )


def test_memory_status_survives_a_journalctl_error(monkeypatch):
    monkeypatch.setattr(st, "_run", lambda argv, timeout:
                        _proc("active\n") if argv[0] == "systemctl" else _proc("", rc=1))
    assert st.memory_status_text() == (
        "hindsight-server active · last retain unknown · LLM errors unknown"
    )


# ── the memory-profile script seam ──────────────────────────────────────

def test_restart_uses_the_configured_script_and_surfaces_failure(tmp_path, monkeypatch):
    script = tmp_path / "stub.sh"
    script.write_text("#!/usr/bin/env bash\necho \"$@\" > %s/args\nexit ${STUB_RC:-0}\n" % tmp_path)
    script.chmod(0o755)
    monkeypatch.setenv("PARLEY_MEMORY_PROFILE_SCRIPT", str(script))
    st._restart_memory_server(rp.MemorySpec("lmstudio", "qwen3.6-35b-a3b", "http://127.0.0.1:8000/v1"))
    assert (tmp_path / "args").read_text().strip() == "lmstudio qwen3.6-35b-a3b http://127.0.0.1:8000/v1"
    # cloud direction: no base_url argument at all
    st._restart_memory_server(rp.MemorySpec("openai-codex", "gpt-5.4-mini"))
    assert (tmp_path / "args").read_text().strip() == "openai-codex gpt-5.4-mini"
    monkeypatch.setenv("STUB_RC", "3")
    with pytest.raises(st.SettingsValidationError, match="memory profile switch failed"):
        st._restart_memory_server(rp.MemorySpec("openai-codex", "gpt-5.4-mini"))


def test_restart_reports_a_missing_script(tmp_path, monkeypatch):
    monkeypatch.setenv("PARLEY_MEMORY_PROFILE_SCRIPT", str(tmp_path / "nope.sh"))
    with pytest.raises(st.SettingsValidationError, match="not found"):
        st._restart_memory_server(rp.MemorySpec("openai-codex", "gpt-5.4-mini"))


def test_memory_profile_script_default_resolves_inside_this_repo(monkeypatch):
    """Portability: a third-party install must never need anyone's private
    ops repo for this default to resolve (docs/LOCAL_MODE.md §1 rule 2.4)."""
    monkeypatch.delenv("PARLEY_MEMORY_PROFILE_SCRIPT", raising=False)
    script = st._memory_profile_script()
    assert script.is_absolute()
    assert "hermes-agent-private" not in str(script)
    assert script.parts[-3:] == ("hermes", "scripts", "apply-memory-profile.sh")
    assert script.exists()
    import os as _os
    assert _os.access(script, _os.X_OK)


# ── the route ───────────────────────────────────────────────────────────

class _Adapter:
    def __init__(self, ok=True): self.ok = ok
    def _check_http_auth(self, request): return self.ok


class _Request:
    def __init__(self, sid=None, body=None):
        self.match_info = {"id": sid} if sid else {}
        self._body = body
    async def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def _run_coro(c):
    return asyncio.new_event_loop().run_until_complete(c)


def test_route_get_schema_includes_the_new_sections(sandbox):
    r = _run_coro(st.handle_schema(_Adapter(), _Request()))
    assert r.status == 200
    ids = [s["id"] for s in json.loads(r.text)["data"]]
    assert "runtime_profile" in ids and "memory_status" in ids


def test_route_post_runtime_profile(sandbox):
    r = _run_coro(st.handle_update(_Adapter(), _Request("runtime_profile", {"value": "local"})))
    assert r.status == 200 and json.loads(r.text)["value"] == "local"
    assert sandbox["cfg"]["parley"]["runtime_profile"] == "local"


def test_route_post_rejects_a_dead_local_server_with_400(sandbox):
    sandbox["probe"] = DOWN
    r = _run_coro(st.handle_update(_Adapter(), _Request("runtime_profile", {"value": "local"})))
    assert r.status == 400
    body = json.loads(r.text)
    assert body["error"]["type"] == "invalid_request_error"
    assert "not answering" in body["error"]["message"]
    assert sandbox["saved"] == []


def test_route_post_readonly_is_400_and_unknown_is_404(sandbox):
    assert _run_coro(st.handle_update(_Adapter(), _Request("memory_status", {"value": "x"}))).status == 400
    assert _run_coro(st.handle_update(_Adapter(), _Request("nope", {"value": "x"}))).status == 404
    assert _run_coro(st.handle_update(_Adapter(ok=False), _Request("memory_enabled", {"value": True}))).status == 401


def test_route_post_memory_toggle(sandbox):
    r = _run_coro(st.handle_update(_Adapter(), _Request("memory_user_profile", {"value": True})))
    assert r.status == 200 and json.loads(r.text)["value"] is True
