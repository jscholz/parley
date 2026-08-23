"""Unit tests for the audio-bridge copy of the PARLEY_* env accessor.

Historical note: the SIDEKICK_* legacy fallback met its documented
removal condition in the 2026-08 identity purge (every deployment
surface exports PARLEY_*) and was deleted. Keep this copy in sync with
backends/hermes/plugin/parley_env.py and proxy/env.mjs.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from parley_env import env_get, env_is_set  # noqa: E402


def test_set_returns_value():
    assert env_get("PARLEY_AUDIO_PORT", environ={"PARLEY_AUDIO_PORT": "8643"}) == "8643"


def test_unset_returns_default():
    assert env_get("PARLEY_NOPE", environ={}) is None
    assert env_get("PARLEY_NOPE", "dflt", environ={}) == "dflt"


def test_no_implicit_fallback_between_names():
    assert env_get("PARLEY_AUDIO_PORT", environ={"SIDEKICK_AUDIO_PORT": "8643"}) is None


def test_env_is_set_presence():
    assert env_is_set("PARLEY_AUDIO_LOG_FILE", environ={"PARLEY_AUDIO_LOG_FILE": ""})
    assert not env_is_set("PARLEY_AUDIO_LOG_FILE", environ={})
