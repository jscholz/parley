"""hindsight's OWN config file — ``parley_hindsight_config.py``.

Everything here uses ``PARLEY_HINDSIGHT_CONFIG`` (monkeypatched via
``tmp_path``) so the suite never touches a real ``~/.hermes/hindsight/
config.json``. Covers: validation + round trip for each of the five
fields, unknown-key preservation, symlink preservation, missing-file
behaviour, and the path-resolution default (``$HERMES_HOME/hindsight/
config.json``, overridable by the env var).
"""
from __future__ import annotations

import json

import pytest

from .. import parley_hindsight_config as hc


@pytest.fixture()
def cfg_path(tmp_path, monkeypatch):
    p = tmp_path / "config.json"
    monkeypatch.setenv("PARLEY_HINDSIGHT_CONFIG", str(p))
    return p


# ── path resolution ──────────────────────────────────────────────────────

def test_config_path_honours_the_env_override(cfg_path):
    assert hc.config_path() == cfg_path


def test_config_path_defaults_to_hermes_home_hindsight(monkeypatch):
    monkeypatch.delenv("PARLEY_HINDSIGHT_CONFIG", raising=False)
    monkeypatch.setattr(
        "hermes_cli.config.get_hermes_home",
        lambda: __import__("pathlib").Path("/fake/hermes/home"),
    )
    assert hc.config_path() == __import__("pathlib").Path("/fake/hermes/home/hindsight/config.json")


# ── missing-file behaviour ───────────────────────────────────────────────

def test_read_config_on_a_missing_file_is_empty_dict(cfg_path):
    assert not cfg_path.exists()
    assert hc.read_config(cfg_path) == {}


def test_status_text_reports_not_found_with_the_path(cfg_path):
    assert hc.status_text(cfg_path) == f"hindsight config not found at {cfg_path}"


def test_effective_values_fill_hermes_defaults_when_file_absent(cfg_path):
    v = hc.effective_values(hc.read_config(cfg_path))
    assert v == {
        hc.KEY_AUTO_RECALL: True,
        hc.KEY_RECALL_MAX_TOKENS: 4096,
        hc.KEY_RECALL_BUDGET: "mid",
        hc.KEY_AUTO_RETAIN: True,
        hc.KEY_RETAIN_EVERY_N_TURNS: 1,
    }


def test_read_config_on_a_corrupt_file_is_empty_dict_not_a_raise(cfg_path):
    cfg_path.write_text("{not json", encoding="utf-8")
    assert hc.read_config(cfg_path) == {}


# ── write creates the file cleanly on a fresh install ────────────────────

def test_write_config_creates_the_file_and_parent_dir_cleanly(tmp_path, monkeypatch):
    nested = tmp_path / "nested" / "hindsight" / "config.json"
    monkeypatch.setenv("PARLEY_HINDSIGHT_CONFIG", str(nested))
    assert not nested.exists()
    updated = hc.plan_update(hc.read_config(), hc.KEY_AUTO_RECALL, False)
    hc.write_config(updated)
    assert nested.exists()
    assert json.loads(nested.read_text()) == {"auto_recall": False}
    # 2-space indent, per the module contract.
    assert '"auto_recall": false' in nested.read_text()
    assert nested.read_text().count("\n") >= 2


# ── validation + round trip, one field at a time ─────────────────────────

@pytest.mark.parametrize("key,good,bad,bad_needle", [
    (hc.KEY_AUTO_RECALL, False, "yes", "true or false"),
    (hc.KEY_AUTO_RETAIN, False, 1, "true or false"),
    (hc.KEY_RECALL_MAX_TOKENS, 8000, "lots", "must be an integer"),
    (hc.KEY_RECALL_BUDGET, "high", "urgent", "must be one of"),
    (hc.KEY_RETAIN_EVERY_N_TURNS, 5, "five", "must be an integer"),
])
def test_plan_update_round_trips_a_good_value_and_rejects_a_bad_one(cfg_path, key, good, bad, bad_needle):
    updated = hc.plan_update({}, key, good)
    assert updated[key] == good
    with pytest.raises(hc.HindsightConfigError, match=bad_needle):
        hc.plan_update({}, key, bad)


@pytest.mark.parametrize("bad_tokens", [199, 16001])
def test_recall_max_tokens_out_of_range_is_rejected(bad_tokens):
    with pytest.raises(hc.HindsightConfigError, match="200..16000"):
        hc.plan_update({}, hc.KEY_RECALL_MAX_TOKENS, bad_tokens)


@pytest.mark.parametrize("bad_turns", [0, 51])
def test_retain_every_n_turns_out_of_range_is_rejected(bad_turns):
    with pytest.raises(hc.HindsightConfigError, match="1..50"):
        hc.plan_update({}, hc.KEY_RETAIN_EVERY_N_TURNS, bad_turns)


def test_plan_update_rejects_an_unknown_key():
    with pytest.raises(hc.HindsightConfigError, match="unknown hindsight config key"):
        hc.plan_update({}, "not_a_real_key", 1)


def test_plan_updates_is_all_or_nothing():
    """One bad value among several must not partially land."""
    with pytest.raises(hc.HindsightConfigError):
        hc.plan_updates({}, {hc.KEY_AUTO_RECALL: True, hc.KEY_RECALL_BUDGET: "urgent"})


# ── unknown-key preservation ─────────────────────────────────────────────

def test_plan_update_preserves_keys_it_does_not_own(cfg_path):
    cfg = {"mode": "local_external", "api_url": "http://127.0.0.1:8765", "bank_id": "x"}
    updated = hc.plan_update(cfg, hc.KEY_AUTO_RECALL, False)
    assert updated["mode"] == "local_external"
    assert updated["api_url"] == "http://127.0.0.1:8765"
    assert updated["bank_id"] == "x"
    assert updated[hc.KEY_AUTO_RECALL] is False


def test_write_config_preserves_unknown_keys_end_to_end(cfg_path):
    cfg_path.write_text(json.dumps({"mode": "local_external", "extra": 1}), encoding="utf-8")
    cfg = hc.read_config(cfg_path)
    updated = hc.plan_update(cfg, hc.KEY_RECALL_BUDGET, "high")
    hc.write_config(updated, cfg_path)
    on_disk = json.loads(cfg_path.read_text())
    assert on_disk == {"mode": "local_external", "extra": 1, "recall_budget": "high"}


# ── symlink preservation ──────────────────────────────────────────────────

def test_write_config_preserves_a_symlink(tmp_path):
    real = tmp_path / "real_config.json"
    real.write_text(json.dumps({"auto_retain": True}), encoding="utf-8")
    link = tmp_path / "link_config.json"
    link.symlink_to(real)

    cfg = hc.read_config(link)
    updated = hc.plan_update(cfg, hc.KEY_RETAIN_EVERY_N_TURNS, 10)
    hc.write_config(updated, link)

    assert link.is_symlink()
    assert link.resolve() == real
    on_disk = json.loads(real.read_text())
    assert on_disk == {"auto_retain": True, "retain_every_n_turns": 10}


# ── summary line ──────────────────────────────────────────────────────────

def test_summary_line_matches_the_documented_format():
    cfg = {"auto_recall": True, "recall_max_tokens": 1500, "recall_budget": "low",
           "auto_retain": True, "retain_every_n_turns": 1}
    assert hc.summary_line(cfg) == "recall on · 1500 tok · low | retain on · every 1 turn"


def test_summary_line_pluralises_turns():
    cfg = {"retain_every_n_turns": 3}
    assert "every 3 turns" in hc.summary_line(cfg)


def test_summary_line_reflects_off_states():
    cfg = {"auto_recall": False, "auto_retain": False}
    line = hc.summary_line(cfg)
    assert "recall off" in line and "retain off" in line
