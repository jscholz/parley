"""/v1/jobs/* — the scheduled-jobs extension over hermes' cron store.

Runs against a throwaway cron store (cron.jobs.use_cron_store) so nothing
touches ~/.hermes. hermes lookups that need a live gateway/config (model
catalog, parley.db titles, delivery targets, pin resolution) are stubbed.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from .. import parley_route_jobs as jobs_route


@pytest.fixture()
def store(tmp_path, monkeypatch):
    from cron import jobs as cron_jobs
    monkeypatch.setattr(jobs_route, "_model_catalog_options", lambda: [
        {"value": "gpt-6-astra", "label": "GPT-6 Astra", "group": "OpenAI Codex"},
        {"value": "gpt-5.6-sol", "label": "GPT-5.6 Sol", "group": "OpenAI Codex"},
    ])
    monkeypatch.setattr(jobs_route, "_parley_chat_titles", lambda limit=300: [("abc-123", "Pitch deck"), ("def-456", "")])
    monkeypatch.setattr(jobs_route, "_hermes_delivery_targets", lambda: [
        {"id": "telegram", "name": "Telegram", "home_target_set": True}])
    # Mutable so apply_bulk_model_update's writes are observable AND so
    # _default_model reflects them, the same way cron.model/_default_model
    # actually relate in production (hermes.config.yaml round-trip).
    cron_default = {"model": "", "provider": ""}
    monkeypatch.setattr(jobs_route, "_default_model", lambda: (
        cron_default["model"] or "gpt-6-astra", cron_default["provider"] or "openai-codex"))
    monkeypatch.setattr(jobs_route, "_resolve_pin", lambda v: (v.split(":", 1)[-1], "openai-codex"))
    monkeypatch.setattr(jobs_route, "_write_cron_default",
                        lambda model, provider: cron_default.update(model=model, provider=provider))
    with cron_jobs.use_cron_store(tmp_path):
        a = cron_jobs.create_job(prompt="Daily brief", schedule="0 7 * * *", name="Brief", deliver="origin",
                                 origin={"platform": "parley", "chat_id": "abc-123", "chat_name": "parley:abc-123"})
        b = cron_jobs.create_job(prompt="Sync workbook", schedule="30 6 * * *", name="Workbook",
                                 deliver="sidekick:zzz-999")
        yield {"a": a["id"], "b": b["id"], "jobs": cron_jobs, "cron_default": cron_default}


def test_payload_lists_jobs_with_option_catalogs(store):
    p = jobs_route.build_jobs_payload()
    assert p["object"] == "list"
    by_id = {j["id"]: j for j in p["data"]}
    a = by_id[store["a"]]
    assert a["name"] == "Brief" and a["schedule"] == "0 7 * * *" and a["enabled"] is True
    assert a["state"] == "scheduled" and a["deliver"] == "origin" and a["model"] == ""
    assert a["origin"] == {"platform": "parley", "chat_id": "abc-123", "label": "parley:abc-123"}
    deliver_values = [o["value"] for o in p["options"]["deliver"]]
    assert deliver_values[:2] == ["origin", "local"]
    assert "parley:abc-123" in deliver_values and "telegram" in deliver_values
    # a job's current-but-unlisted target is kept so the picker can show it
    cur = [o for o in p["options"]["deliver"] if o["value"] == "sidekick:zzz-999"]
    assert cur and cur[0]["group"] == "Current"
    # untitled chat gets a synthetic label
    assert any(o["value"] == "parley:def-456" and o["label"].startswith("Parley chat") for o in p["options"]["deliver"])
    models = p["options"]["model"]
    assert models[0] == {"value": "", "label": "Follow default (gpt-6-astra via openai-codex)", "group": "Default"}
    assert [m["value"] for m in models[1:]] == ["gpt-6-astra", "gpt-5.6-sol"]
    assert p["default_model"] == "gpt-6-astra via openai-codex"


def test_pause_and_resume(store):
    v = jobs_route.apply_job_update(store["a"], {"enabled": False})
    assert v["enabled"] is False and v["state"] == "paused"
    v = jobs_route.apply_job_update(store["a"], {"enabled": True})
    assert v["enabled"] is True and v["state"] == "scheduled"


def test_redirect_delivery(store):
    v = jobs_route.apply_job_update(store["b"], {"deliver": "parley:abc-123"})
    assert v["deliver"] == "parley:abc-123"
    assert store["jobs"].get_job(store["b"])["deliver"] == "parley:abc-123"


def test_pin_and_unpin_model(store):
    v = jobs_route.apply_job_update(store["a"], {"model": "gpt-5.6-sol"})
    assert v["model"] == "gpt-5.6-sol" and v["provider"] == "openai-codex"
    v = jobs_route.apply_job_update(store["a"], {"model": ""})
    assert v["model"] == "" and v["provider"] == ""
    assert not store["jobs"].get_job(store["a"]).get("model")


def test_bulk_model_update_pins_all_and_writes_the_cron_default(store):
    jobs_route.apply_job_update(store["a"], {"model": "gpt-5.6-sol"})
    payload = jobs_route.apply_bulk_model_update("gpt-5.6-sol")
    assert all(j["model"] == "" and j["provider"] == "" for j in payload["data"])
    assert not store["jobs"].get_job(store["a"]).get("model")
    assert store["cron_default"] == {"model": "gpt-5.6-sol", "provider": "openai-codex"}
    assert payload["default_model"] == "gpt-5.6-sol via openai-codex"
    assert payload["object"] == "list" and set(payload["options"]) == {"deliver", "model"}


def test_bulk_model_update_empty_follows_agent_default(store):
    jobs_route.apply_job_update(store["a"], {"model": "gpt-5.6-sol"})
    jobs_route.apply_bulk_model_update("gpt-5.6-sol")
    payload = jobs_route.apply_bulk_model_update("")
    assert store["cron_default"] == {"model": "", "provider": ""}
    assert payload["default_model"] == "gpt-6-astra via openai-codex"
    assert all(j["model"] == "" for j in payload["data"])


def test_bulk_model_update_unknown_value_rejected_before_any_write(store, monkeypatch):
    jobs_route.apply_job_update(store["a"], {"model": "gpt-5.6-sol"})

    def _boom(v):
        raise jobs_route.JobsValidationError(f"value not in options[]: {v!r}")
    monkeypatch.setattr(jobs_route, "_resolve_pin", _boom)
    with pytest.raises(jobs_route.JobsValidationError, match="not in options"):
        jobs_route.apply_bulk_model_update("bogus/model")
    # never a partial write: neither the job's pin nor the cron default moved
    assert store["jobs"].get_job(store["a"])["model"] == "gpt-5.6-sol"
    assert store["cron_default"] == {"model": "", "provider": ""}


def test_bulk_model_update_rejects_non_string(store):
    with pytest.raises(jobs_route.JobsValidationError, match="must be a string"):
        jobs_route.apply_bulk_model_update(5)
    assert store["cron_default"] == {"model": "", "provider": ""}


def test_bulk_model_update_aborts_config_write_when_a_pin_clear_fails(store, monkeypatch):
    """Order under test: pins clear FIRST, cron.model/provider LAST. A
    per-job clear failure must abort BEFORE the config write, so no job
    ends up on the new model while another is silently still pinned."""
    jobs_route.apply_job_update(store["a"], {"model": "gpt-5.6-sol"})
    jobs_route.apply_job_update(store["b"], {"model": "gpt-5.6-sol"})
    from cron import jobs as cron_jobs
    real_update_job = cron_jobs.update_job

    def _flaky(job_id, updates):
        if job_id == store["b"]:
            raise ValueError("job is terminal")
        return real_update_job(job_id, updates)
    monkeypatch.setattr(cron_jobs, "update_job", _flaky)
    with pytest.raises(jobs_route.JobsValidationError, match=store["b"]):
        jobs_route.apply_bulk_model_update("")
    # the config write never ran
    assert store["cron_default"] == {"model": "", "provider": ""}


def test_run_now_queues_next_tick(store):
    before = store["jobs"].get_job(store["a"])["next_run_at"]
    v = jobs_route.run_job(store["a"])
    assert v["state"] == "scheduled" and v["enabled"] is True
    assert v["next_run_at"] != before


@pytest.mark.parametrize("body,msg", [
    ({}, "non-empty"),
    ({"name": "x"}, "unsupported field"),
    ({"deliver": ""}, "must not be empty"),
    ({"deliver": "parley:bad chat id"}, "not understood"),
    ({"enabled": "yes"}, "true or false"),
    ({"model": 5}, "must be a string"),
])
def test_rejects_bad_input(store, body, msg):
    with pytest.raises(jobs_route.JobsValidationError, match=msg):
        jobs_route.apply_job_update(store["a"], body)


def test_unknown_job_is_none(store):
    assert jobs_route.apply_job_update("nope", {"enabled": False}) is None
    assert jobs_route.run_job("nope") is None


def test_runs_maps_execution_rows(store, monkeypatch):
    import cron.executions as ex
    monkeypatch.setattr(ex, "list_executions", lambda **kw: [
        {"id": "e1", "job_id": store["a"], "status": "failed", "source": "scheduler", "claimed_at": "t0",
         "started_at": "t1", "finished_at": "t2", "error": "x" * 500}])
    rows = jobs_route.job_runs(store["a"], 5)
    assert rows[0]["status"] == "failed" and len(rows[0]["error"]) == 240


# ── handler layer ─────────────────────────────────────────────────────

class _Adapter:
    def __init__(self, ok=True): self.ok = ok
    def _check_http_auth(self, request): return self.ok


class _Request:
    def __init__(self, job_id=None, body=None, query=None):
        self.match_info = {"job_id": job_id} if job_id else {}
        self._body = body; self.query = query or {}
    async def json(self):
        if isinstance(self._body, Exception): raise self._body
        return self._body


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _body(resp):
    return json.loads(resp.text)


def test_handlers_status_codes(store):
    assert _run(jobs_route.handle_jobs_list(_Adapter(ok=False), _Request())).status == 401
    r = _run(jobs_route.handle_jobs_list(_Adapter(), _Request()))
    assert r.status == 200 and len(_body(r)["data"]) == 2
    r = _run(jobs_route.handle_job_update(_Adapter(), _Request(store["a"], {"enabled": False})))
    assert r.status == 200 and _body(r)["state"] == "paused"
    r = _run(jobs_route.handle_job_update(_Adapter(), _Request(store["a"], {"deliver": "!!"})))
    assert r.status == 400 and _body(r)["error"]["type"] == "invalid_request_error"
    r = _run(jobs_route.handle_job_update(_Adapter(), _Request("missing", {"enabled": True})))
    assert r.status == 404
    r = _run(jobs_route.handle_job_update(_Adapter(), _Request("../etc", {"enabled": True})))
    assert r.status == 400
    r = _run(jobs_route.handle_job_run(_Adapter(), _Request(store["b"])))
    assert r.status == 200 and _body(r)["enabled"] is True
    r = _run(jobs_route.handle_job_runs(_Adapter(), _Request(store["b"], query={"limit": "3"})))
    assert r.status == 200 and _body(r)["object"] == "list"


def test_handle_jobs_bulk_model_status_codes(store):
    assert _run(jobs_route.handle_jobs_bulk_model(_Adapter(ok=False), _Request(body={"model": ""}))).status == 401
    r = _run(jobs_route.handle_jobs_bulk_model(_Adapter(), _Request(body={"model": "gpt-5.6-sol"})))
    assert r.status == 200
    body = _body(r)
    assert body["object"] == "list" and all(j["model"] == "" for j in body["data"])
    r = _run(jobs_route.handle_jobs_bulk_model(_Adapter(), _Request(body={})))
    assert r.status == 400 and _body(r)["error"]["type"] == "invalid_request_error"
    r = _run(jobs_route.handle_jobs_bulk_model(_Adapter(), _Request(body={"model": 5})))
    assert r.status == 400


def test_delete_removes_job(store):
    assert jobs_route.delete_job(store["b"]) is True
    assert store["jobs"].get_job(store["b"]) is None
    assert jobs_route.delete_job(store["b"]) is False
    r = _run(jobs_route.handle_job_delete(_Adapter(), _Request(store["a"])))
    assert r.status == 200 and _body(r)["deleted"] is True
    assert _run(jobs_route.handle_job_delete(_Adapter(), _Request(store["a"]))).status == 404
    assert _run(jobs_route.handle_job_delete(_Adapter(ok=False), _Request(store["a"]))).status == 401
