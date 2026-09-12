"""parley_job_runs — run views, console lines, immediate fire, watcher.

Runs against a throwaway cron store + a throwaway executions ledger, so
nothing touches ~/.hermes. The scheduler provider is a fake that records
its calls: the point of the fire test is the CONTRACT (claim first,
detach the run, 409 on a held claim), not hermes' agent loop.
"""
from __future__ import annotations

import asyncio
import sqlite3
import threading
import time
from datetime import datetime, timezone, timedelta

import pytest

from .. import parley_job_runs as runs
from .. import parley_route_jobs as jobs_route


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


# ── pure views ───────────────────────────────────────────────────────

def test_run_view_maps_ledger_statuses_and_duration():
    t0 = 1_700_000_000.0
    ex = {"id": "e1", "job_id": "j1", "status": "running", "claimed_at": _iso(t0 - 1), "started_at": _iso(t0),
          "finished_at": None, "error": None}
    v = runs.run_view(ex, job={"id": "j1", "model": "gpt-5.4-mini"}, now=t0 + 14)
    assert v["status"] == "running" and v["duration_ms"] == 14_000 and v["model"] == "gpt-5.4-mini"
    assert v["source"] == "scheduled" and v["delivery"] == {"status": "pending", "error": None}
    ex2 = {**ex, "status": "completed", "finished_at": _iso(t0 + 69)}
    v2 = runs.run_view(ex2, job={"id": "j1", "model_snapshot": {"model": "snap"}},
                       delivery={"status": "delivered", "error": None})
    assert v2["status"] == "succeeded" and v2["duration_ms"] == 69_000 and v2["model"] == "snap"
    assert v2["delivery"]["status"] == "delivered"
    v3 = runs.run_view({**ex, "status": "failed", "finished_at": _iso(t0 + 3), "error": "x" * 400}, default_model="dflt")
    assert v3["status"] == "failed" and len(v3["error"]) == 240 and v3["model"] == "dflt"
    assert v3["delivery"]["status"] == "none"   # terminal + no delivery row


def test_manual_runs_are_labelled_with_their_note():
    runs.remember_manual("e-manual", "focus on Slack only")
    v = runs.run_view({"id": "e-manual", "job_id": "j", "status": "claimed", "claimed_at": _iso(1.0)})
    assert v["source"] == "manual" and v["note"] == "focus on Slack only" and v["status"] == "queued"


def test_finished_notice_uses_the_cron_wrapper_shape():
    body = runs.run_finished_notice({"name": "Daily recap"}, {"job_id": "j1", "status": "failed",
                                                              "duration_ms": 69_000, "error": "boom", "delivery": {"status": "none"}})
    assert body.startswith("Cronjob Response: Daily recap\n(job_id: j1)\n")
    assert "❌ Manual run failed in 69s: boom" in body
    ok = runs.run_finished_notice({"name": "R"}, {"job_id": "j", "status": "succeeded", "duration_ms": 1000,
                                                  "delivery": {"status": "failed", "error": "no adapter"}})
    assert "✅" in ok and "Delivery failed: no adapter" in ok


# ── console over a fake state.db ─────────────────────────────────────

_STATE_SCHEMA = """
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, user_id TEXT, parent_session_id TEXT, started_at REAL, title TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
    tool_name TEXT, tool_call_id TEXT, tool_calls TEXT, timestamp REAL);
"""


@pytest.fixture
def state_db(tmp_path):
    db = tmp_path / "state.db"
    conn = sqlite3.connect(db)
    conn.executescript(_STATE_SCHEMA)
    t0 = 1_700_000_000.0
    conn.execute("INSERT INTO sessions VALUES ('cron_j1_20231114_221320','cron',NULL,NULL,?,NULL)", (t0 + 0.5,))
    conn.execute("INSERT INTO sessions VALUES ('cron_j1_20231110_000000','cron',NULL,NULL,?,NULL)", (t0 - 90_000,))
    conn.execute("INSERT INTO sessions VALUES ('cron_j2_20231114_221320','cron',NULL,NULL,?,NULL)", (t0 + 0.6,))
    rows = [
        ("cron_j1_20231114_221320", "user", "[SYSTEM: cron] Sweep the inbox", None, None, t0 + 1),
        ("cron_j1_20231114_221320", "assistant", "", None,
         '[{"function": {"name": "read_file", "arguments": "{\\"path\\": \\"notes.md\\"}"}}]', t0 + 2),
        ("cron_j1_20231114_221320", "tool", '{"content": "1|# Notes"}', "read_file", None, t0 + 3),
        ("cron_j1_20231114_221320", "tool", '{"error": "ENOENT: missing.md"}', "read_file", None, t0 + 4),
        ("cron_j1_20231114_221320", "assistant", "All clear.   Nothing urgent.", None, None, t0 + 5),
    ]
    conn.executemany("INSERT INTO messages (session_id, role, content, tool_name, tool_call_id, tool_calls, timestamp) "
                     "VALUES (?,?,?,?,NULL,?,?)", rows)
    conn.commit(); conn.close()
    return db, t0


def test_find_console_session_matches_by_start_window(state_db):
    db, t0 = state_db
    ex = {"claimed_at": _iso(t0), "started_at": _iso(t0 + 0.2), "finished_at": _iso(t0 + 60)}
    assert runs.find_console_session(db, "j1", ex) == "cron_j1_20231114_221320"
    # A different job's session at the same instant is not ours.
    assert runs.find_console_session(db, "j3", ex) is None
    # Still-running execution (no finished_at) matches too.
    assert runs.find_console_session(db, "j1", {"claimed_at": _iso(t0)}) == "cron_j1_20231114_221320"


def test_console_lines_classify_rows_and_paginate(state_db):
    db, _ = state_db
    page = runs.console_lines(db, "cron_j1_20231114_221320")
    kinds = [l["kind"] for l in page["lines"]]
    assert kinds == ["prompt", "tool_call", "tool_result", "error", "assistant"]
    assert page["lines"][1]["text"].startswith("read_file {")
    assert "ENOENT" in page["lines"][3]["text"]
    assert page["lines"][4]["text"] == "All clear. Nothing urgent."   # whitespace collapsed
    assert page["next_after"] == 5
    # Cursor: only rows after the last seen id come back.
    more = runs.console_lines(db, "cron_j1_20231114_221320", after_id=page["next_after"])
    assert more["lines"] == [] and more["next_after"] == 5
    partial = runs.console_lines(db, "cron_j1_20231114_221320", after_id=3)
    assert [l["kind"] for l in partial["lines"]] == ["error", "assistant"]


# ── immediate fire through a fake provider ───────────────────────────

class _FakeProvider:
    name = "fake"

    def __init__(self, *, claim_result="ok"):
        self.claim_result = claim_result
        self.claims = []
        self.fired = threading.Event()
        self.fired_with = None

    def claim_fire(self, job_id, *, force=False):
        self.claims.append((job_id, force))
        if self.claim_result is None:
            return None
        return {"id": job_id, "execution_id": f"exec-{job_id}", "forced": force}

    def fire_claimed(self, claimed, *, adapters=None, loop=None, cancel_event=None):
        self.fired_with = (claimed, adapters, loop)
        self.fired.set()
        return True


@pytest.fixture
def cron_store(tmp_path, monkeypatch):
    from cron import jobs as cron_jobs
    with cron_jobs.use_cron_store(tmp_path):
        j = cron_jobs.create_job(prompt="Sweep", schedule="0 7 * * *", name="Sweep", deliver="origin",
                                 origin={"platform": "parley", "chat_id": "chat-1", "chat_name": "parley:chat-1"})
        yield {"id": j["id"], "jobs": cron_jobs}


def _install_provider(monkeypatch, provider):
    import cron.scheduler_provider as sp
    monkeypatch.setattr(sp, "resolve_cron_scheduler", lambda: provider)
    monkeypatch.setattr(sp, "provider_supports_force_fire", lambda p: True)
    monkeypatch.setattr(runs, "_gateway_adapters", lambda: {"parley": object()})


def test_fire_now_claims_then_detaches_and_stamps_the_note(cron_store, monkeypatch):
    prov = _FakeProvider()
    _install_provider(monkeypatch, prov)
    done = threading.Event()
    job, exec_id = runs.fire_now(cron_store["id"], "focus on Slack", loop="LOOP", on_done=done.set)
    assert exec_id == f"exec-{cron_store['id']}"
    assert prov.claims == [(cron_store["id"], False)]
    assert prov.fired.wait(2.0) and done.wait(2.0)
    claimed, adapters, loop = prov.fired_with
    assert claimed["execution_id"] == exec_id and adapters is not None and loop == "LOOP"
    # The note is hermes' single-fire manual_run_prompt on the job record.
    assert cron_store["jobs"].get_job(cron_store["id"])["manual_run_prompt"] == "focus on Slack"
    assert runs.manual_info(exec_id) == {"note": "focus on Slack"}


def test_fire_now_conflict_when_claim_is_held(cron_store, monkeypatch):
    _install_provider(monkeypatch, _FakeProvider(claim_result=None))
    with pytest.raises(runs.JobRunConflict):
        runs.fire_now(cron_store["id"], None, loop=None)


def test_fire_now_forces_a_paused_job(cron_store, monkeypatch):
    prov = _FakeProvider()
    _install_provider(monkeypatch, prov)
    cron_store["jobs"].update_job(cron_store["id"], {"enabled": False, "state": "paused"})
    runs.fire_now(cron_store["id"], None, loop=None)
    assert prov.claims == [(cron_store["id"], True)]


def test_fire_now_unknown_job(cron_store, monkeypatch):
    _install_provider(monkeypatch, _FakeProvider())
    with pytest.raises(LookupError):
        runs.fire_now("nope", None, loop=None)


# ── route layer: run_job returns the job view with last_run ──────────

def test_run_job_returns_view_with_last_run(cron_store, monkeypatch):
    prov = _FakeProvider()
    _install_provider(monkeypatch, prov)
    import cron.executions as ex
    monkeypatch.setattr(ex, "get_execution", lambda eid: {
        "id": eid, "job_id": cron_store["id"], "status": "claimed", "claimed_at": _iso(1.0), "started_at": None,
        "finished_at": None, "error": None})
    monkeypatch.setattr(jobs_route, "_default_model", lambda: ("gpt-5.4-mini", "openai-codex"))
    view = jobs_route.run_job(cron_store["id"], "note here", loop=None)
    assert view["id"] == cron_store["id"]
    assert view["last_run"]["status"] == "queued" and view["last_run"]["source"] == "manual"
    assert view["last_run"]["note"] == "note here"
    # create_job snapshots the configured model; the view prefers that
    # snapshot over the fleet default, so it is whatever hermes pinned.
    assert view["last_run"]["model"]


def test_payload_carries_last_run_per_job(cron_store, monkeypatch):
    import cron.executions as ex
    monkeypatch.setattr(ex, "latest_executions", lambda ids: {cron_store["id"]: {
        "id": "e9", "job_id": cron_store["id"], "status": "completed", "claimed_at": _iso(1.0),
        "started_at": _iso(1.0), "finished_at": _iso(70.0), "error": None}})
    monkeypatch.setattr(runs, "_delivery_for", lambda eid: {"status": "delivered", "error": None})
    monkeypatch.setattr(jobs_route, "_default_model", lambda: ("m", "p"))
    monkeypatch.setattr(jobs_route, "_model_catalog_options", lambda: [])
    monkeypatch.setattr(jobs_route, "_parley_chat_titles", lambda limit=300: [])
    monkeypatch.setattr(jobs_route, "_hermes_delivery_targets", lambda: [])
    p = jobs_route.build_jobs_payload()
    lr = p["data"][0]["last_run"]
    assert lr["status"] == "succeeded" and lr["duration_ms"] == 69_000 and lr["delivery"]["status"] == "delivered"


# ── watcher: emits on change, brisk while active ─────────────────────

def test_watcher_emits_only_on_change_and_flags_terminal(monkeypatch):
    import cron.executions as ex
    snapshots = [
        [{"id": "e1", "job_id": "j1", "status": "running", "claimed_at": _iso(1.0), "started_at": _iso(1.0)}],
        [{"id": "e1", "job_id": "j1", "status": "running", "claimed_at": _iso(1.0), "started_at": _iso(1.0)}],
        [{"id": "e1", "job_id": "j1", "status": "completed", "claimed_at": _iso(1.0), "started_at": _iso(1.0),
          "finished_at": _iso(5.0)}],
    ]
    monkeypatch.setattr(runs, "_delivery_for", lambda eid: None)
    emitted, terminal = [], []

    async def emit(env): emitted.append(env)
    async def on_term(run, job): terminal.append(run["id"])

    w = runs.RunWatcher(emit=emit, job_lookup=lambda: {"j1": {"id": "j1", "name": "Sweep"}},
                        default_model=lambda: "m", state_db_path=lambda: None, on_manual_terminal=on_term)
    runs.remember_manual("e1", None)
    # Drive the change detector directly (the loop is just sleep + this).
    changes0 = w._changed([(s, None) for s in snapshots[0]])
    assert changes0 == []                      # first pass primes, never emits
    assert w._changed([(s, None) for s in snapshots[1]]) == []   # no change → nothing
    ch = w._changed([(s, None) for s in snapshots[2]])
    assert len(ch) == 1 and ch[0][2] is True   # became terminal
    assert w._any_active([(s, None) for s in snapshots[0]]) is True
    assert w._any_active([(s, None) for s in snapshots[2]]) is False


def test_run_console_route_handles_missing_session(cron_store, monkeypatch, tmp_path):
    import cron.executions as ex
    monkeypatch.setattr(ex, "get_execution", lambda eid: {
        "id": eid, "job_id": cron_store["id"], "status": "running", "claimed_at": _iso(time.time()),
        "started_at": None, "finished_at": None, "error": None})
    db = tmp_path / "state.db"
    sqlite3.connect(db).executescript(_STATE_SCHEMA)
    page = jobs_route.job_run_console(cron_store["id"], "e-x", 0, db)
    assert page == {"lines": [], "next_after": 0, "session_id": None, "done": False}
    assert jobs_route.job_run_console("other-job", "e-x", 0, db) is None
