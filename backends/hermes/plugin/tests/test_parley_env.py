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


# ── bridge_legacy_env (2026-08-20 pairing-lockout regression) ──────────
#
# hermes' platform registry is handed env var NAMES and later does a raw
# os.getenv on them, so env_get's fallback never runs for those. The
# rename changed the declared name to PARLEY_PLATFORM_ALLOW_ALL_USERS
# while deployed .env files still said SIDEKICK_* — hermes read the new
# name, found nothing, default-denied, and locked the owner out of every
# chat behind pairing codes.

def test_bridge_legacy_env_copies_legacy_value_forward():
    from backends.hermes.plugin.parley_env import bridge_legacy_env
    env = {"SIDEKICK_PLATFORM_ALLOW_ALL_USERS": "true"}
    bridged = bridge_legacy_env("PARLEY_PLATFORM_ALLOW_ALL_USERS", environ=env)
    # A raw getenv-style lookup on the NEW name must now succeed.
    assert env["PARLEY_PLATFORM_ALLOW_ALL_USERS"] == "true"
    assert bridged == ["PARLEY_PLATFORM_ALLOW_ALL_USERS"]


def test_bridge_legacy_env_never_clobbers_an_explicit_new_name():
    from backends.hermes.plugin.parley_env import bridge_legacy_env
    env = {
        "PARLEY_PLATFORM_ALLOW_ALL_USERS": "false",
        "SIDEKICK_PLATFORM_ALLOW_ALL_USERS": "true",
    }
    assert bridge_legacy_env("PARLEY_PLATFORM_ALLOW_ALL_USERS", environ=env) == []
    assert env["PARLEY_PLATFORM_ALLOW_ALL_USERS"] == "false"


def test_bridge_legacy_env_noop_when_neither_spelling_is_set():
    from backends.hermes.plugin.parley_env import bridge_legacy_env
    env = {}
    assert bridge_legacy_env("PARLEY_PLATFORM_ALLOW_ALL_USERS", environ=env) == []
    assert env == {}
