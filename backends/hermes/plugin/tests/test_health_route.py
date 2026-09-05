"""/v1/health/* — health extension over the daily digest state files + runners."""
from __future__ import annotations

import asyncio
import json
import os
import stat
import time

import pytest

from .. import parley_route_health as hr

REPORT = "🔴 hermes health — box — now — 1 FAIL · 1 WARN · 2 OK\nFAIL a — broken\nWARN b — meh\nOK   c — fine\nOK   d — fine\n"


@pytest.fixture()
def state(tmp_path, monkeypatch):
    d = tmp_path / "health"; d.mkdir()
    (d / "hermes.last-run").write_text(f"{int(time.time()) - 3600} FAIL\n")
    (d / "hermes.report.txt").write_text(REPORT)
    (d / "parley.last-run").write_text(f"{int(time.time()) - 60} OK\n")
    (d / "parley.report.txt").write_text("✅ parley health — box — now — 0 FAIL · 0 WARN · 1 OK\nOK   x — y\n")
    runner = tmp_path / "run-hermes.sh"
    runner.write_text("#!/usr/bin/env bash\n"
                      f"echo \"$@\" > {tmp_path}/args.txt\n"
                      f"echo \"$(date +%s) OK\" > {d}/hermes.last-run\n"
                      f"printf '✅ hermes health — box — later — 0 FAIL · 0 WARN · 1 OK\\nOK   a — fixed\\n' > {d}/hermes.report.txt\n"
                      "exit 0\n")
    runner.chmod(runner.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PARLEY_HEALTH_STATE_DIR", str(d))
    monkeypatch.setenv("PARLEY_HEALTH_RUNNERS", f"hermes={runner};bogus name=ignored")
    return {"dir": d, "tmp": tmp_path}


def test_list_reads_state_and_counts(state):
    checks = {c["id"]: c for c in hr.list_checks()}
    assert set(checks) == {"hermes", "parley"}
    h = checks["hermes"]
    assert h["worst"] == "FAIL" and h["can_run"] is True and h["counts"] == {"fail": 1, "warn": 1, "ok": 2}
    assert h["last_run_at"].endswith("+00:00") and "FAIL a — broken" in h["report"]
    assert checks["parley"]["can_run"] is False and checks["parley"]["worst"] == "OK"


def test_run_invokes_runner_with_no_alert_and_returns_fresh_view(state):
    v = hr.run_check("hermes")
    assert (state["tmp"] / "args.txt").read_text().strip() == "--no-alert"
    assert v["worst"] == "OK" and v["counts"]["fail"] == 0 and v["exit_code"] == 0
    assert "fixed" in v["report"]


def test_run_rejects_readonly_unknown_and_bad_ids(state):
    with pytest.raises(hr.HealthValidationError, match="read-only"):
        hr.run_check("parley")
    assert hr.run_check("nothing") is None
    with pytest.raises(hr.HealthValidationError, match="invalid"):
        hr.run_check("../x")


class _Adapter:
    def __init__(self, ok=True): self.ok = ok
    def _check_http_auth(self, r): return self.ok


class _Request:
    def __init__(self, check_id=None): self.match_info = {"check_id": check_id} if check_id else {}


def _run(c): return asyncio.new_event_loop().run_until_complete(c)


def test_handlers(state):
    assert _run(hr.handle_health_list(_Adapter(ok=False), _Request())).status == 401
    r = _run(hr.handle_health_list(_Adapter(), _Request()))
    assert r.status == 200 and len(json.loads(r.text)["data"]) == 2
    r = _run(hr.handle_health_run(_Adapter(), _Request("hermes")))
    assert r.status == 200 and json.loads(r.text)["worst"] == "OK"
    assert _run(hr.handle_health_run(_Adapter(), _Request("parley"))).status == 400
    assert _run(hr.handle_health_run(_Adapter(), _Request("nothing"))).status == 404
