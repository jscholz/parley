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
  - the blast radius stays inside the allowed config roots (and, within the
    widened `tools`/`skills` roots, inside their one allowed sub-path each)
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
                               "llm_model": "gpt-5.4-mini", "llm_base_url": "",
                               "recall_max_tokens": 4096, "recall_budget": "mid"}
    assert cloud["compression"] == {"threshold": 0.7}
    # the local diet's widened roots, restored to "hermes defaults" in cloud
    assert cloud["tools"] == {"tool_search": {}}
    assert cloud["skills"] == {"platform_disabled": {"parley": []}}
    # explicit empty cron pin: "follow this profile's model.default" — a
    # switch INTO cloud always resets any bulk "model for all jobs" pin.
    assert cloud["cron"] == {"model": "", "model_provider": ""}


def test_cloud_seed_carries_no_compression_when_the_box_sets_none():
    cfg = {k: v for k, v in LIVE_CFG.items() if k != "compression"}
    assert "compression" not in rp.seed_default_profiles(cfg, LIVE_ENV)["cloud"]


def test_local_profile_seed_matches_the_design():
    local = rp.seed_default_profiles(LIVE_CFG, LIVE_ENV)["local"]
    assert local["model"] == {"default": "qwen3.6-35b-a3b",
                              "provider": "custom:local-fallback",
                              "base_url": "http://127.0.0.1:8000/v1",
                              "max_tokens": 8192}
    assert local["auxiliary"]["vision"]["provider"] == "custom:local-fallback"
    assert local["fallback_providers"] == []          # off-grid: nothing to fall back to
    assert local["compression"] == {"threshold": 0.6}
    # NOT hindsight's `llamacpp`, which would spawn a second GGUF server
    assert local["memory"]["llm_provider"] == "lmstudio"
    assert local["memory"]["llm_base_url"] == "http://127.0.0.1:8000/v1"
    assert local["memory"]["recall_max_tokens"] == 1500
    assert local["memory"]["recall_budget"] == "low"
    # the local diet: fewer tool schemas, some skill categories hidden
    assert local["tools"]["tool_search"]["enabled"] == "on"
    assert local["tools"]["tool_search"]["listing_max_tokens"] == 1200
    assert "computer_use" in local["tools"]["tool_search"]["defer"]
    assert "delegate_task" in local["tools"]["tool_search"]["defer"]
    parley_hidden = local["skills"]["platform_disabled"]["parley"]
    assert "claude-design" in parley_hidden
    # the software-development category itself is NOT named as a hidden
    # group — that call is the owner's to make, not this diet's.
    assert "software-development" not in parley_hidden
    # same reset guarantee as cloud's: a cloud-pinned bulk model must not
    # survive a flip to local (no API key off-grid).
    assert local["cron"] == {"model": "", "model_provider": ""}


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
                  "base_url": "http://127.0.0.1:8000/v1", "max_tokens": 8192},
        "auxiliary.vision.provider": "custom:local-fallback",
        "auxiliary.vision.model": "qwen3.6-35b-a3b",
        "auxiliary.vision.base_url": "http://127.0.0.1:8000/v1",
        "fallback_providers": [],
        "compression.threshold": 0.6,
        "tools.tool_search": rp.LOCAL_TOOL_SEARCH,
        "skills.platform_disabled.parley": rp.LOCAL_SKILLS_HIDDEN_PARLEY,
        "cron.model": "", "cron.model_provider": "",
    }
    assert plan.env_updates == {
        "HINDSIGHT_API_LLM_PROVIDER": "lmstudio",
        "HINDSIGHT_API_LLM_MODEL": "qwen3.6-35b-a3b",
        "HINDSIGHT_API_LLM_BASE_URL": "http://127.0.0.1:8000/v1",
    }
    assert plan.restart_memory is True
    assert plan.memory.recall_max_tokens == 1500 and plan.memory.recall_budget == "low"
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
        assert roots <= {"model", "auxiliary", "fallback_providers", "compression",
                          "parley", "tools", "skills", "cron"}
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


# ── B: model block is a wholesale replace, both directions ──────────────

def test_model_switch_replaces_the_whole_block_not_merge():
    """A leftover cloud-only key (here `context_length`, hermes' override for
    a model whose /v1/models answer is wrong) must NOT survive a switch to a
    profile that never names it — a merge would leave it pinned under the
    local provider."""
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "model": dict(LIVE_CFG["model"], context_length=999999),
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "local")
    after = rp.apply_config_updates(cfg, plan.config_updates)
    assert "context_length" not in after["model"]
    assert after["model"] == plan.config_updates["model"]


def test_model_switch_back_restores_the_leaving_profiles_exact_model():
    """The other direction: leaving a profile whose live model carries a key
    the profile literal never had snapshots the WHOLE block, so switching
    back puts it back unabridged — not just the keys the profile names."""
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": rp.seed_default_profiles(LIVE_CFG, LIVE_ENV),
        "model": dict(LIVE_CFG["model"], context_length=999999),
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "local")
    cfg = rp.apply_config_updates(cfg, plan.snapshot_updates)
    cfg = rp.apply_config_updates(cfg, plan.config_updates)
    cfg = rp.apply_config_updates(cfg, plan.marker_updates)
    back_plan = rp.plan_apply(cfg, LIVE_ENV, "cloud")
    restored = rp.apply_config_updates(cfg, back_plan.config_updates)
    assert restored["model"] == dict(LIVE_CFG["model"], context_length=999999)


# ── A: the widened `tools` / `skills` roots stay narrow ──────────────────

def test_profile_tools_block_may_only_set_tool_search():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"tools": {"tool_search": {}, "mcp_servers": ["x"]}}},
    })
    with pytest.raises(rp.ProfileError, match="tool_search"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


def test_profile_tools_tool_search_must_be_a_mapping():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"tools": {"tool_search": ["nope"]}}},
    })
    with pytest.raises(rp.ProfileError, match="mapping"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


def test_profile_tools_must_itself_be_a_mapping():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"tools": "nonsense"}},
    })
    with pytest.raises(rp.ProfileError, match="tools must be a mapping"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


def test_profile_skills_block_may_only_set_platform_disabled():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {
            "cloud": {"skills": {"platform_disabled": {"parley": []}, "disabled": ["x"]}},
        },
    })
    with pytest.raises(rp.ProfileError, match="platform_disabled"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


def test_profile_skills_platform_disabled_values_must_be_lists_of_strings():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"skills": {"platform_disabled": {"parley": "not-a-list"}}}},
    })
    with pytest.raises(rp.ProfileError, match="list of skill names"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


def test_profile_skills_platform_disabled_rejects_a_blank_platform_key():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"skills": {"platform_disabled": {"": ["x"]}}}},
    })
    with pytest.raises(rp.ProfileError, match="invalid"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


def test_tool_search_empty_mapping_is_an_explicit_restore_to_hermes_defaults():
    """`{}` is a real write (restores hermes defaults), not "nothing to do" —
    it must appear in config_updates so a switch back to cloud actually
    undoes whatever the local diet configured."""
    plan = rp.plan_apply(LIVE_CFG, LIVE_ENV, "cloud")
    assert plan.config_updates["tools.tool_search"] == {}


def test_tools_tool_search_write_leaves_sibling_tools_keys_untouched():
    cfg = dict(LIVE_CFG, tools={"some_other_flag": True})
    plan = rp.plan_apply(cfg, LIVE_ENV, "local")
    after = rp.apply_config_updates(cfg, plan.config_updates)
    assert after["tools"]["some_other_flag"] is True
    assert after["tools"]["tool_search"] == rp.LOCAL_TOOL_SEARCH


def test_platform_disabled_replaces_only_the_named_platform():
    cfg = dict(LIVE_CFG, skills={
        "disabled": ["global-skill"],
        "platform_disabled": {"parley": ["old-parley-skill"], "whatsapp": ["keep-me"]},
    })
    cfg = rp.apply_config_updates(cfg, {
        "parley.runtime_profiles": {"cloud": {"skills": {"platform_disabled": {"parley": ["new-one"]}}}},
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "cloud")
    after = rp.apply_config_updates(cfg, plan.config_updates)
    assert after["skills"]["platform_disabled"]["parley"] == ["new-one"]
    assert after["skills"]["platform_disabled"]["whatsapp"] == ["keep-me"]   # sibling platform survives
    assert after["skills"]["disabled"] == ["global-skill"]                   # global list survives


# ── A2: the widened `cron` root stays narrow (model/model_provider only) ─

def test_profile_cron_writes_model_and_model_provider():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"cron": {"model": "gpt-5.6-sol", "model_provider": "openai-codex"}}},
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "cloud")
    assert plan.config_updates == {"cron.model": "gpt-5.6-sol", "cron.model_provider": "openai-codex"}


def test_profile_cron_may_only_set_model_and_model_provider():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"cron": {"model": "", "provider": "chronos"}}},
    })
    with pytest.raises(rp.ProfileError, match="model_provider"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


def test_profile_cron_rejects_non_string_values():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"cron": {"model": 5}}},
    })
    with pytest.raises(rp.ProfileError, match="must be a string"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


def test_profile_cron_must_itself_be_a_mapping():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"cron": "nonsense"}},
    })
    with pytest.raises(rp.ProfileError, match="cron must be a mapping"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


def test_cron_leaf_write_preserves_sibling_cron_keys():
    """A profile switch must not blow away the SCHEDULER provider, the
    drift guard, or any other owner/hermes cron.* setting — only the two
    keys the bulk-model endpoint owns."""
    cfg = dict(LIVE_CFG, cron={
        "model_drift_guard": True, "preflight": True, "provider": "chronos",
        "model": "old-pin", "model_provider": "old-provider",
    })
    cfg = rp.apply_config_updates(cfg, {
        "parley.runtime_profiles": {"cloud": {"cron": {"model": "", "model_provider": ""}}},
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "cloud")
    after = rp.apply_config_updates(cfg, plan.config_updates)
    assert after["cron"]["model"] == "" and after["cron"]["model_provider"] == ""
    assert after["cron"]["model_drift_guard"] is True
    assert after["cron"]["preflight"] is True
    assert after["cron"]["provider"] == "chronos"


def test_profile_switch_resets_a_bulk_model_pin():
    """The scenario the doc's semantic promises: the owner sets "model for
    all jobs" (writing cron.model directly, exactly like
    apply_bulk_model_update does), then switches profiles — the seeded
    empty cron pin on EITHER profile must win, not the stale bulk value."""
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": rp.seed_default_profiles(LIVE_CFG, LIVE_ENV),
        "cron": {"model": "gpt-5.6-sol", "model_provider": "openai-codex"},
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "local")
    after = rp.apply_config_updates(cfg, plan.config_updates)
    assert after["cron"]["model"] == "" and after["cron"]["model_provider"] == ""


# ── C: hindsight recall knobs (memory.recall_max_tokens / recall_budget) ─

def test_recall_neither_given_leaves_memoryspec_recall_fields_none():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"memory": {"llm_provider": "x", "llm_model": "y"}}},
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "cloud")
    assert plan.memory.recall_max_tokens is None and plan.memory.recall_budget is None


def test_recall_both_given_pass_through_unchanged():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"memory": {
            "llm_provider": "x", "llm_model": "y",
            "recall_max_tokens": 2000, "recall_budget": "high",
        }}},
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "cloud")
    assert plan.memory.recall_max_tokens == 2000
    assert plan.memory.recall_budget == "high"


def test_recall_only_tokens_given_fills_budget_with_hermes_default(caplog):
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"memory": {
            "llm_provider": "x", "llm_model": "y", "recall_max_tokens": 2000,
        }}},
    })
    with caplog.at_level("INFO"):
        plan = rp.plan_apply(cfg, LIVE_ENV, "cloud")
    assert plan.memory.recall_max_tokens == 2000
    assert plan.memory.recall_budget == rp.DEFAULT_RECALL_BUDGET == "mid"
    assert any("recall_budget" in r.message for r in caplog.records)


def test_recall_only_budget_given_fills_tokens_with_hermes_default(caplog):
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"memory": {
            "llm_provider": "x", "llm_model": "y", "recall_budget": "high",
        }}},
    })
    with caplog.at_level("INFO"):
        plan = rp.plan_apply(cfg, LIVE_ENV, "cloud")
    assert plan.memory.recall_max_tokens == rp.DEFAULT_RECALL_MAX_TOKENS == 4096
    assert plan.memory.recall_budget == "high"
    assert any("recall_max_tokens" in r.message for r in caplog.records)


@pytest.mark.parametrize("bad_tokens", [100, 20000, "not-a-number"])
def test_recall_max_tokens_out_of_range_or_unparseable_is_rejected(bad_tokens):
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"memory": {"recall_max_tokens": bad_tokens}}},
    })
    with pytest.raises(rp.ProfileError, match="recall_max_tokens"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


def test_recall_budget_rejects_an_unknown_value():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"memory": {"recall_budget": "urgent"}}},
    })
    with pytest.raises(rp.ProfileError, match="recall_budget"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


# ── D: hindsight auto_recall/auto_retain/retain_every_n_turns ────────────
# (parley_hindsight_config.py's other three keys — independent optionals,
# no "fill the other half" pairing like recall_max_tokens/recall_budget.)

def test_auto_recall_and_auto_retain_are_independent_optionals():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"memory": {"auto_retain": False}}},
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "cloud")
    assert plan.memory.auto_retain is False
    assert plan.memory.auto_recall is None       # not named by this profile
    assert plan.memory.recall_max_tokens is None  # unrelated pair, untouched


def test_retain_every_n_turns_passes_through_and_validates_range():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"memory": {"retain_every_n_turns": 10}}},
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "cloud")
    assert plan.memory.retain_every_n_turns == 10


@pytest.mark.parametrize("bad", [0, 51, "five"])
def test_retain_every_n_turns_out_of_range_or_unparseable_is_rejected(bad):
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"memory": {"retain_every_n_turns": bad}}},
    })
    with pytest.raises(rp.ProfileError, match="retain_every_n_turns"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


@pytest.mark.parametrize("key,bad", [("auto_recall", "yes"), ("auto_retain", 1)])
def test_auto_recall_and_auto_retain_reject_non_booleans(key, bad):
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {"cloud": {"memory": {key: bad}}},
    })
    with pytest.raises(rp.ProfileError, match="true or false"):
        rp.plan_apply(cfg, LIVE_ENV, "cloud")


def test_a_profile_naming_only_retain_every_n_turns_still_triggers_the_hindsight_write():
    """None of the recall pair, but a MemorySpec must still be built and
    apply_memory_recall must still fire — has_hindsight_file_updates()
    is what the runtime-profile apply loop actually gates on."""
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {
            "cloud": {"memory": {"retain_every_n_turns": 3}},
            "local": {"model": {"default": "qwen3.6-35b-a3b", "provider": "custom:local-fallback"}},
        },
    })
    plan = rp.plan_apply(cfg, LIVE_ENV, "cloud")
    assert plan.memory is not None
    assert plan.memory.has_hindsight_file_updates()
    assert plan.memory.hindsight_file_updates() == {"retain_every_n_turns": 3}

    r = _Recorder(cfg=cfg)
    r.apply("cloud")
    assert [c[1] for c in r.calls if c[0] == "apply_memory_recall"] == [{"retain_every_n_turns": 3}]


def test_apply_skips_the_recall_script_when_the_profile_names_no_recall():
    cfg = rp.apply_config_updates(LIVE_CFG, {
        "parley.runtime_profiles": {
            "cloud": {"memory": {"llm_provider": "openai-codex", "llm_model": "gpt-5.4-mini"}},
            "local": {"model": {"default": "qwen3.6-35b-a3b", "provider": "custom:local-fallback"},
                      "memory": {"llm_provider": "lmstudio", "llm_model": "qwen3.6-35b-a3b"}},
        },
    })
    r = _Recorder(cfg=cfg)
    r.apply("local")
    assert "apply_memory_recall" not in [c[0] for c in r.calls]


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

    def apply_memory_recall(self, spec):
        # hindsight_file_updates() rather than recall_args() — it's the
        # complete, self-describing set of keys THIS spec actually names
        # (the recall pair plus the three independent booleans/int).
        self.calls.append(("apply_memory_recall", spec.hindsight_file_updates()))

    def apply(self, target):
        return rp.apply_runtime_profile(
            target, preflight=self.preflight, write_config=self.write_config,
            write_env=self.write_env, restart_memory=self.restart_memory,
            apply_memory_recall=self.apply_memory_recall,
            load=self.load,
        )


def test_apply_order_is_preflight_snapshot_config_env_restart_marker():
    r = _Recorder()
    plan = r.apply("local")
    assert [c[0] for c in r.calls] == [
        "preflight", "write_config", "write_config",
        "write_env", "restart_memory", "apply_memory_recall", "write_config",
    ]
    snapshot_write, target_write, marker_write = (
        r.calls[1][1], r.calls[2][1], r.calls[6][1],
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
    # 4. the hindsight-file write runs after the LLM-routing restart, still before the marker
    assert r.calls[5][1] == {"recall_max_tokens": 1500, "recall_budget": "low"}
    assert plan.target == "local"


def test_apply_aborts_before_any_write_when_preflight_fails():
    r = _Recorder(preflight_error=rp.ProfileError("local model server is not answering"))
    with pytest.raises(rp.ProfileError, match="not answering"):
        r.apply("local")
    assert [c[0] for c in r.calls] == ["preflight"]


def test_apply_skips_the_restart_when_the_memory_env_is_already_right():
    """The LLM-routing restart is skipped (the env already says openai-codex),
    but the recall script still runs — recall is a different file with no
    restart to guard, so it fires whenever the profile names it."""
    r = _Recorder()
    r.apply("cloud")
    assert [c[0] for c in r.calls] == [
        "preflight", "write_config", "write_config",
        "write_env", "apply_memory_recall", "write_config",
    ]
    assert [c[1] for c in r.calls if c[0] == "apply_memory_recall"] == [
        {"recall_max_tokens": 4096, "recall_budget": "mid"},
    ]


def test_apply_rejects_an_unknown_profile_without_touching_anything():
    r = _Recorder()
    with pytest.raises(rp.ProfileError):
        r.apply("nope")
    assert r.calls == []
