"""Unit tests for the PARLEY_* env accessor (parley_env.py).

Historical note: this module used to pin the SIDEKICK_* legacy fallback
and the bridge_legacy_env() startup copy (2026-08-20 pairing-lockout
regression). Both met their documented removal condition in the 2026-08
identity purge — every deployment surface (~/.hermes/.env, systemd
units, the gateway drop-in) now exports PARLEY_* — and were deleted.
What remains pins presence-based reads.
"""

from backends.hermes.plugin.parley_env import env_get, env_is_set


def test_set_returns_value():
    assert env_get("PARLEY_ITEMS_V3", environ={"PARLEY_ITEMS_V3": "1"}) == "1"


def test_unset_returns_default():
    assert env_get("PARLEY_NOPE", environ={}) is None
    assert env_get("PARLEY_NOPE", "dflt", environ={}) == "dflt"


def test_presence_based_empty_string_is_a_value():
    assert env_get("PARLEY_PERF_TRACE", environ={"PARLEY_PERF_TRACE": ""}) == ""


def test_no_implicit_fallback_between_names():
    assert env_get("PARLEY_ITEMS_V3", environ={"SIDEKICK_ITEMS_V3": "1"}) is None


def test_env_is_set_presence():
    assert env_is_set("PARLEY_TEST_GUARD", environ={"PARLEY_TEST_GUARD": ""})
    assert not env_is_set("PARLEY_TEST_GUARD", environ={})
