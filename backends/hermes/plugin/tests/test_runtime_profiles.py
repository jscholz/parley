"""Runtime profiles — the pure planner (docs/LOCAL_MODE.md §1).

Everything here runs against dicts. No hermes, no network, no systemd, no
disk: plan_apply is pure by construction and apply_runtime_profile takes its
four side effects as arguments, which is the whole point — the setting under
test reroutes EVERY model call the live agent makes, so "what exactly would
this write?" has to be answerable without writing it.

Pinned here:
  - `cloud` is seeded FROM LIVE VALUES, never from the doc's example
  - snapshot of the leaving profile happens BEFORE the target is written
  - the active-profile marker is recorded LAST
  - a failed `local` preflight writes nothing at all
  - the env keys for both directions, including base_url removal
  - the blast radius stays inside the five allowed config roots
"""
from __future__ import annotations

import pytest

from .. import parley_runtime_profiles as rp


LIVE_CFG = {
    "model": {"default": "gpt-5.6-sol", "provider": "openai-codex",
              "base_url": "https://chatgpt.com/backend-api/codex"},
    "auxiliary": {
        "vision": {"provider": "openai-codex", "model": "gpt-5.5",
                   "base_url": "https://chatgpt.com/backend-api/codex",
                   "api_key": "", "timeout": 120, "download_timeout": 30},
        "web_extract": {"provider": "openai-codex", "model": "gpt-5.5"},
    },
    "fallback_providers": [
        {"provider": "custom:local-fallback", "model": "qwen3.6-35b-a3b",
         "base_url": "http://127.0.0.1:8000/v1", "api_mode": "chat_completions"},
    ],
    "compression": {"enabled": True, "threshold": 0.7, "protect_last_n": 20},
    "memory": {"memory_enabled": True, "user_profile_enabled": True},
    "parley": {"preferred_models": ["anthropic/*"]},
}
LIVE_ENV = {
    "HINDSIGHT_API_LLM_PROVIDER": "openai-codex",
    "HINDSIGHT_API_LLM_MODEL": "gpt-5.4-mini",
    "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "openai",
}


# ── seeding ─────────────────────────────────────────────────────────────

def test_cloud_profile_is_seeded_from_live_values_not_from_the_doc():
    profiles = rp.seed_default_profiles(LIVE_CFG, LIVE_ENV)
    cloud = profiles["cloud"]
    assert cloud["model"] == LIVE_CFG["model"]
    # only the auxiliary entries a profile names — vision, not web_extract
    assert set(cloud["auxiliary"]) == {"vision"}
    assert cloud["auxiliary"]["vision"] == LIVE_CFG["auxiliary"]["vision"]
    assert cloud["fallback_providers"] == LIVE_CFG["fallback_providers"]
    assert cloud["memory"] == {"llm_provider": "openai-codex",
                               "llm_model": "gpt-5.4-mini", "llm_base_url": ""}
    assert cloud["compression"] == {"threshold": 0.7}


def test_cloud_seed_carries_no_compression_when_the_box_sets_none():
    cfg = {k: v for k, v in LIVE_CFG.items() if k != "compression"}
    assert "compression" not in rp.seed_default_profiles(cfg, LIVE_ENV)["cloud"]


def test_local_profile_seed_matches_the_design():
    local = rp.seed_default_profiles(LIVE_CFG, LIVE_ENV)["local"]
    assert local["model"] == {"default": "qwen3.6-35b-a3b",
                              "provider": "custom:local-fallback",
                              "base_url": "http://127.0.0.1:8000/v1"}
    assert local["auxiliary"]["vision"]["provider"] == "custom:local-fallback"
    assert local["fallback_providers"] == []          # off-grid: nothing to fall back to
    assert local["compression"] == {"threshold": 0.6}
    # NOT hindsight's `llamacpp`, which would spawn a second GGUF server
    assert local["memory"]["llm_provider"] == "lmstudio"
    assert local["memory"]["llm_base_url"] == "http://127.0.0.1:8000/v1"


def test_scalar_model_config_is_normalised_into_a_dict():
    cloud = rp.seed_default_profiles({"model": "google/gemma-4"}, {})["cloud"]
    assert cloud["model"] == {"default": "google/gemma-4"}


def test_existing_profiles_block_wins_over_the_seed():
    cfg = dict(LIVE_CFG, parley={"runtime_profiles": {"cloud": {"model": {"default": "kept"}}}})
    profiles = rp.read_profiles(cfg, LIVE_ENV)
    assert list(profiles) == ["cloud"] and profiles["cloud"]["model"]["default"] == "kept"


def test_active_profile_defaults_to_cloud():
    assert rp.read_active_profile({}) == "cloud"
    assert rp.read_active_profile({"parley": {"runtime_profile": "local"}}) == "local"
    assert rp.read_active_profile({"parley": {"runtime_profile": "../etc"}}) == "cloud"


# ── the plan ────────────────────────────────────────────────────────────

def test_plan_to_local_writes_exactly_the_target_routing():
    plan = rp.plan_apply(LIVE_CFG, LIVE_ENV, "local")
    assert (plan.leaving, plan.target) == ("cloud", "local")
    assert plan.config_updates == {
        "model": {"default": "qwen3.6-35b-a3b", "provider": "custom:local-fallback",
                  "base_url": "http://127.0.0.1:8000/v1"},
        "auxiliary.vision.provider": "custom:local-fallback",
        "auxiliary.vision.model": "qwen3.6-35b-a3b",
        "auxiliary.vision.base_url": "http://127.0.0.1:8000/v1",
        "fallback_providers": [],
        "compression.threshold": 0.6,
    }
    assert plan.env_updates == {
        "HINDSIGHT_API_LLM_PROVIDER": "lmstudio",
        "HINDSIGHT_API_LLM_MODEL": "qwen3.6-35b-a3b",
        "HINDSIGHT_API_LLM_BASE_URL": "http://127.0.0.1:8000/v1",
    }
    assert plan.restart_memory is True
    assert plan.marker_updates == {"parley.runtime_profile": "local"}


def test_plan_leaf_writes_preserve_sibling_auxiliary_keys():
    """The vision entry carries timeout/api_key hermes maintains; a profile
    switch names three keys and must not blow the rest away."""
    plan = rp.plan_apply(LIVE_CFG, LIVE_ENV, "local")
    after = rp.apply_config_updates(LIVE_CFG, plan.config_updates)
    assert after["auxiliary"]["vision"]["timeout"] == 120
    assert after["auxiliary"]["vision"]["provider"] == "custom:local-fallback"
    assert after["auxiliary"]["web_extract"] == LIVE_CFG["auxiliary"]["web_extract"]
    # compression siblings too
    assert after["compression"] == {"enabled": True, "threshold": 0.6, "protect_last_n": 20}


def _in_local_mode():
    """The realistic post-switch state: profiles seeded from the cloud box,
    marker on local, config + env already rerouted."""
    profiles = rp.seed_default_profiles(LIVE_CFG, LIVE_ENV)
    cfg = rp.apply_config_updates(LIVE_CFG, {"parley.runtime_profiles": profiles})
    plan = rp.plan_apply(cfg, LIVE_ENV, "local")
    cfg = rp.apply_config_updates(cfg, plan.snapshot_updates)
    cfg = rp.apply_config_updates(cfg, plan.config_updates)
    cfg = rp.apply_config_updates(cfg, plan.marker_updates)
    env = dict(LIVE_ENV)
    for k, v in plan.env_updates.items():
        env.pop(k, None) if v is None else env.update({k: v})
    return cfg, env


def test_plan_back_to_cloud_removes_the_memory_base_url():
    """`None` means REMOVE the key: the cloud profile has no base_url at all,
    and leaving the local endpoint behind would silently keep memory local."""
    cfg, env = _in_local_mode()
    plan = rp.plan_apply(cfg, env, "cloud")
    assert plan.leaving == "local"
    assert plan.env_updates == {
        "HINDSIGHT_API_LLM_PROVIDER": "openai-codex",
        "HINDSIGHT_API_LLM_MODEL": "gpt-5.4-mini",
        "HINDSIGHT_API_LLM_BASE_URL": None,
    }
    assert plan.restart_memory is True


def test_round_trip_restores_the_cloud_routing_exactly():
    """The whole point of the snapshot: local -> cloud puts every key back."""
    cfg, env = _in_local_mode()
    plan = rp.plan_apply(cfg, env, "cloud")
    back = rp.apply_config_updates(cfg, plan.config_updates)
    assert back["model"] == LIVE_CFG["model"]
    assert back["auxiliary"] == LIVE_CFG["auxiliary"]
    assert back["fallback_providers"] == LIVE_CFG["fallback_providers"]
    assert back["compression"] == LIVE_CFG["compression"]


def test_plan_refuses_to_seed_when_the_active_profile_is_not_cloud():
    """No profiles block + active=local can only come from a hand-edit;
    seeding would photograph the LOCAL routing into `cloud` and lose the
    cloud configuration for good. Refuse rather than corrupt."""
    cfg = rp.apply_config_updates(LIVE_CFG, {"parley.runtime_profile": "local"})
    with pytest.raises(rp.ProfileError, match="cannot be seeded"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")
    # reading is still tolerant, so the settings panel renders
    assert set(rp.read_profiles(cfg, LIVE_ENV)) == {"cloud", "local"}


def test_plan_skips_the_memory_restart_when_nothing_would_change():
    """A pointless hindsight bounce drops in-flight retains and shows up in
    the health digest as an unexplained restart."""
    plan = rp.plan_apply(LIVE_CFG, LIVE_ENV, "cloud")
    assert plan.env_updates == {
        "HINDSIGHT_API_LLM_PROVIDER": "openai-codex",
        "HINDSIGHT_API_LLM_MODEL": "gpt-5.4-mini",
        "HINDSIGHT_API_LLM_BASE_URL": None,
    }
    assert plan.restart_memory is False


def test_plan_snapshots_the_leaving_profiles_live_model():
    """The user picked gpt-6-something after the profile was seeded; leaving
    cloud must capture THAT, not the profile's stale default."""
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": rp.seed_default_profiles(LIVE_CFG, LIVE_ENV),
        "model": {"default": "gpt-6-astra", "provider": "openai-codex"},
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "local")
    snap = plan.snapshot_updates["parley.runtime_profiles"]
    assert snap["cloud"]["model"] == {"default": "gpt-6-astra", "provider": "openai-codex"}
    assert snap["local"]["model"]["default"] == "qwen3.6-35b-a3b"   # untouched


def test_plan_seeds_the_whole_block_on_first_run():
    plan = rp.plan_apply(LIVE_CFG, LIVE_ENV, "local")
    assert set(plan.snapshot_updates["parley.runtime_profiles"]) == {"cloud", "local"}


def test_plan_touches_nothing_outside_the_allowed_roots():
    for target in ("cloud", "local"):
        plan = rp.plan_apply(LIVE_CFG, LIVE_ENV, target)
        roots = {p.split(".", 1)[0] for p in plan.touched_config_paths()}
        assert roots <= {"model", "auxiliary", "fallback_providers", "compression", "parley"}
        assert set(plan.touched_env_keys()) <= set(rp.MEMORY_ENV_KEYS)


def test_plan_rejects_a_profile_that_would_write_elsewhere():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"model": {"default": "x"}, "agent": {"max_turns": 3}}},
    })
    # An unknown profile key is simply ignored ...
    assert "agent.max_turns" not in rp.plan_apply(cfg, LIVE_ENV, "cloud").config_updates
    # ... but a compression/auxiliary key that escaped the namespace is not.
    cfg2 = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"compression": {"threshold": 0.5}}},
    })
    assert rp.plan_apply(cfg2, LIVE_ENV, "cloud").config_updates == {"compression.threshold": 0.5}


@pytest.mark.parametrize("bad", ["", "  ", "../etc", "Cloud", "a" * 40])
def test_plan_rejects_bad_profile_names(bad):
    with pytest.raises(rp.ProfileError):
        rp.plan_apply(LIVE_CFG, LIVE_ENV, bad)


def test_plan_rejects_an_unknown_profile():
    with pytest.raises(rp.ProfileError, match="unknown runtime profile"):
        rp.plan_apply(LIVE_CFG, LIVE_ENV, "gpu-farm")


def test_plan_is_pure():
    before = str(LIVE_CFG)
    rp.plan_apply(LIVE_CFG, LIVE_ENV, "local")
    assert str(LIVE_CFG) == before


# ── the probe / preflight ───────────────────────────────────────────────

def _fake_http(health=200, models=("qwen3.6-35b-a3b",), models_status=200, boom=None):
    import json as _json

    def _get(url, timeout):
        if boom is not None:
            raise boom
        if url.endswith("/health"):
            return health, b""
        return models_status, _json.dumps({"data": [{"id": m} for m in models]}).encode()
    return _get


def test_probe_reports_ready_when_health_and_models_agree():
    r = rp.probe_model_server("http://127.0.0.1:8000/v1", "qwen3.6-35b-a3b",
                              http_get=_fake_http())
    assert r.ok and r.models == ("qwen3.6-35b-a3b",)


@pytest.mark.parametrize("kwargs,needle", [
    ({"health": 503}, "/health returned HTTP 503"),
    ({"models": ("something-else",)}, "does not serve"),
    ({"models_status": 500}, "/v1/models returned HTTP 500"),
    ({"boom": ConnectionRefusedError()}, "not answering"),
])
def test_probe_names_what_is_down(kwargs, needle):
    r = rp.probe_model_server("http://127.0.0.1:8000/v1", "qwen3.6-35b-a3b",
                              http_get=_fake_http(**kwargs))
    assert not r.ok and needle in r.detail


def test_preflight_is_a_noop_for_cloud():
    def _explode(*a, **k):
        raise AssertionError("cloud must not probe anything")
    rp.preflight_profile("cloud", {}, probe=_explode)


def test_preflight_rejects_a_dead_local_server():
    profile = rp.seed_default_profiles(LIVE_CFG, LIVE_ENV)["local"]
    down = rp.ServerProbe(False, "http://127.0.0.1:8000 is not answering")
    with pytest.raises(rp.ProfileError, match="not answering"):
        rp.preflight_profile("local", profile, probe=lambda *a, **k: down)


# ── apply: ordering and abort behaviour ─────────────────────────────────

class _Recorder:
    """Records every injected side effect in call order."""

    def __init__(self, cfg=None, env=None, preflight_error=None):
        self.cfg = dict(cfg if cfg is not None else LIVE_CFG)
        self.env = dict(env if env is not None else LIVE_ENV)
        self.preflight_error = preflight_error
        self.calls = []

    def load(self):
        return dict(self.cfg), dict(self.env)

    def preflight(self, target, profile):
        self.calls.append(("preflight", target))
        if self.preflight_error:
            raise self.preflight_error

    def write_config(self, cfg):
        # snapshot what each write would land, so ordering is inspectable
        self.calls.append(("write_config", {
            "profiles": "parley.runtime_profiles" if (cfg.get("parley") or {}).get("runtime_profiles") else None,
            "model": (cfg.get("model") or {}).get("default"),
            "marker": (cfg.get("parley") or {}).get("runtime_profile"),
        }))

    def write_env(self, updates):
        self.calls.append(("write_env", dict(updates)))

    def restart_memory(self, spec):
        self.calls.append(("restart_memory", spec.as_args()))

    def apply(self, target):
        return rp.apply_runtime_profile(
            target, preflight=self.preflight, write_config=self.write_config,
            write_env=self.write_env, restart_memory=self.restart_memory,
            load=self.load,
        )


def test_apply_order_is_preflight_snapshot_config_env_restart_marker():
    r = _Recorder()
    plan = r.apply("local")
    assert [c[0] for c in r.calls] == [
        "preflight", "write_config", "write_config",
        "write_env", "restart_memory", "write_config",
    ]
    snapshot_write, target_write, marker_write = (
        r.calls[1][1], r.calls[2][1], r.calls[5][1],
    )
    # 1. snapshot lands with the profiles block but the OLD model still live
    assert snapshot_write["profiles"] == "parley.runtime_profiles"
    assert snapshot_write["model"] == "gpt-5.6-sol"
    assert snapshot_write["marker"] is None
    # 2. target routing lands, marker still not written
    assert target_write["model"] == "qwen3.6-35b-a3b" and target_write["marker"] is None
    # 3. the marker is LAST — a crash before it reports the profile actually live
    assert marker_write["marker"] == "local"
    assert r.calls[4][1] == ["lmstudio", "qwen3.6-35b-a3b", "http://127.0.0.1:8000/v1"]
    assert plan.target == "local"


def test_apply_aborts_before_any_write_when_preflight_fails():
    r = _Recorder(preflight_error=rp.ProfileError("local model server is not answering"))
    with pytest.raises(rp.ProfileError, match="not answering"):
        r.apply("local")
    assert [c[0] for c in r.calls] == ["preflight"]


def test_apply_skips_the_restart_when_the_memory_env_is_already_right():
    r = _Recorder()
    r.apply("cloud")
    assert [c[0] for c in r.calls] == [
        "preflight", "write_config", "write_config", "write_env", "write_config",
    ]


def test_apply_rejects_an_unknown_profile_without_touching_anything():
    r = _Recorder()
    with pytest.raises(rp.ProfileError):
        r.apply("nope")
    assert r.calls == []
