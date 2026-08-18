"""Unit tests for the PARLEY_*/SIDEKICK_* env compat shim (parley_env.py).

The owner's live hermes-gateway systemd drop-in still exports the legacy
SIDEKICK_* spellings (SIDEKICK_ITEMS_V3, SIDEKICK_CHAT_MIGRATION,
SIDEKICK_TURN_LINKER, SIDEKICK_RECONCILE_RETIRED, SIDEKICK_TEST_GUARD…).
If the fallback regresses, live transcript serving silently reverts —
pin the contract here: new name wins, old honored, presence-based.
"""

from backends.hermes.plugin.parley_env import env_get, env_is_set, legacy_env_name


def test_new_name_set_returns_new_value():
    assert env_get("PARLEY_ITEMS_V3", environ={"PARLEY_ITEMS_V3": "1"}) == "1"


def test_legacy_name_only_is_honored():
    assert env_get("PARLEY_ITEMS_V3", environ={"SIDEKICK_ITEMS_V3": "1"}) == "1"


def test_both_set_new_name_wins():
    env = {"PARLEY_CONFIG": "/new.yaml", "SIDEKICK_CONFIG": "/old.yaml"}
    assert env_get("PARLEY_CONFIG", environ=env) == "/new.yaml"


def test_neither_set_returns_default():
    assert env_get("PARLEY_NOPE", environ={}) is None
    assert env_get("PARLEY_NOPE", "dflt", environ={}) == "dflt"


def test_presence_based_empty_new_shadows_legacy():
    env = {"PARLEY_PERF_TRACE": "", "SIDEKICK_PERF_TRACE": "1"}
    assert env_get("PARLEY_PERF_TRACE", environ=env) == ""


def test_non_parley_names_have_no_fallback():
    assert env_get("HERMES_STATE_DIR", environ={"SIDEKICK_STATE_DIR": "/x"}) is None
    assert env_get("HERMES_STATE_DIR", environ={"HERMES_STATE_DIR": "/y"}) == "/y"


def test_legacy_env_name_mapping():
    assert legacy_env_name("PARLEY_TEST_GUARD") == "SIDEKICK_TEST_GUARD"
    assert legacy_env_name("HERMES_STATE_DIR") is None


def test_env_is_set_for_either_spelling():
    assert env_is_set("PARLEY_TEST_GUARD", environ={"SIDEKICK_TEST_GUARD": "1"})
    assert env_is_set("PARLEY_TEST_GUARD", environ={"PARLEY_TEST_GUARD": ""})
    assert not env_is_set("PARLEY_TEST_GUARD", environ={})
