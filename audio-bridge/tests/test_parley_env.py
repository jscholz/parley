"""Unit tests for the audio-bridge copy of the PARLEY_*/SIDEKICK_* env
compat shim (audio-bridge/parley_env.py).

The live parley-audio (né sidekick-audio) systemd unit still exports
legacy SIDEKICK_AUDIO_* / SIDEKICK_PROXY_URL spellings; the fallback
keeps the bridge booting against those. Contract: new name wins, old
honored, presence-based.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from parley_env import env_get, env_is_set, legacy_env_name  # noqa: E402


def test_legacy_name_only_is_honored():
    env = {"SIDEKICK_AUDIO_PORT": "8643"}
    assert env_get("PARLEY_AUDIO_PORT", environ=env) == "8643"


def test_both_set_new_name_wins():
    env = {"PARLEY_PROXY_URL": "http://new:3001", "SIDEKICK_PROXY_URL": "http://old:3001"}
    assert env_get("PARLEY_PROXY_URL", environ=env) == "http://new:3001"


def test_neither_set_returns_default():
    assert env_get("PARLEY_AUDIO_HOST", "127.0.0.1", environ={}) == "127.0.0.1"


def test_legacy_env_name_and_is_set():
    assert legacy_env_name("PARLEY_AUDIO_LOG_FILE") == "SIDEKICK_AUDIO_LOG_FILE"
    assert legacy_env_name("DEEPGRAM_API_KEY") is None
    assert env_is_set("PARLEY_BACKEND", environ={"SIDEKICK_BACKEND": "hermes"})
    assert not env_is_set("PARLEY_BACKEND", environ={})
