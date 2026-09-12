"""Run-level view of hermes cron executions for the Parley jobs extension.

Backs the parts of ``/v1/jobs/*`` that answer "what happened when I pressed
Run now?" (his report 2026-09-12: manual runs on the cheaper cron model
gave zero feedback — the button only marked the job due for the next
60-second tick and the one notice vanished on re-render):

  POST /v1/jobs/{id}/run  {note?}        → fires NOW through the gateway's
                                           claim-and-fire path; returns the
                                           job view with ``last_run``
  GET  /v1/jobs/{id}/runs                → run views, newest first
  GET  /v1/jobs/{id}/runs/{run_id}       → one run view
  GET  /v1/jobs/{id}/runs/{run_id}/console?after=N
                                         → the run's live console lines
  stream envelope ``job_run``            → pushed on every state change

Everything hermes-specific stays here: the executions ledger (claimed /
running / completed / failed / unknown), the deliveries ledger, the
``cron_<job>_<stamp>`` session hermes persists while the run's agent
works (that session IS the console — tool calls, results and the final
text land in state.db as they happen, so Parley stores nothing of its
own), the scheduler provider's fire API, and the gateway runner whose
live adapters a fire needs in order to deliver. The proxy forwards the
contract verbatim; the PWA only renders ``RunView`` and console lines.

Run view (the contract)::

    {"id", "job_id", "status": queued|running|succeeded|failed|unknown,
     "source": manual|scheduled, "note", "model",
     "started_at", "finished_at", "duration_ms", "error",
     "delivery": {"status": none|pending|delivering|delivered|failed, "error"},
     "console": bool}
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import json
import logging
import sqlite3
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

# executions.status → contract status
_RUN_STATUS = {
    "claimed": "queued",
    "running": "running",
    "completed": "succeeded",
    "failed": "failed",
    "unknown": "unknown",
}
TERMINAL_RUN_STATUSES = frozenset({"succeeded", "failed", "unknown"})

# Console line budget per request and text budget per line.
CONSOLE_PAGE_LINES = 400
CONSOLE_LINE_CHARS = 600
# How far before ``claimed_at`` a cron session may have started and still
# be this run's (clock skew between the ledger and SessionDB is sub-second;
# the slack is generous on purpose).
_SESSION_MATCH_SLACK_S = 15.0

# Watcher cadence: brisk while something is in flight, lazy otherwise.
WATCH_ACTIVE_INTERVAL_S = 2.0
WATCH_IDLE_INTERVAL_S = 30.0


class JobRunConflict(Exception):
    """The job is already running (its fire claim is held) — HTTP 409."""


class JobRunUnavailable(Exception):
    """The scheduler cannot fire this job right now — HTTP 503."""


# ── time helpers ─────────────────────────────────────────────────────

def _parse_iso(value: Any) -> Optional[float]:
    """ISO-8601 (with or without zone; hermes writes zoned) → epoch seconds."""
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _duration_ms(started_at: Any, finished_at: Any, now: Optional[float] = None) -> Optional[int]:
    s = _parse_iso(started_at)
    if s is None:
        return None
    e = _parse_iso(finished_at)
    if e is None:
        e = now if now is not None else time.time()
    return max(0, int((e - s) * 1000))


# ── manual-run memory (in-process; a restart forgets, which is fine) ─

_manual_lock = threading.Lock()
_manual_runs: Dict[str, Dict[str, Any]] = {}  # execution_id → {"note": str|None}


def remember_manual(execution_id: str, note: Optional[str]) -> None:
    with _manual_lock:
        _manual_runs[str(execution_id)] = {"note": (note or None)}
        # Keep the map bounded: nobody needs more than a few hundred.
        if len(_manual_runs) > 500:
            for k in list(_manual_runs)[:-300]:
                _manual_runs.pop(k, None)


def manual_info(execution_id: Any) -> Optional[Dict[str, Any]]:
    with _manual_lock:
        return _manual_runs.get(str(execution_id))


# ── views ────────────────────────────────────────────────────────────

def _delivery_view(delivery: Optional[Dict[str, Any]], run_status: str) -> Dict[str, Any]:
    if delivery is None:
        # No delivery row: either nothing to deliver yet, or the job saves
        # locally / delivered before the queue existed. Say "none" once the
        # run is over, "pending" while it is still going.
        return {"status": "none" if run_status in TERMINAL_RUN_STATUSES else "pending", "error": None}
    status = str(delivery.get("status") or "unknown")
    if status not in ("pending", "delivering", "delivered", "failed"):
        status = "unknown"
    err = delivery.get("error")
    return {"status": status, "error": (str(err)[:240] if err else None)}


def run_view(execution: Dict[str, Any], *, job: Optional[Dict[str, Any]] = None,
             delivery: Optional[Dict[str, Any]] = None, default_model: str = "",
             console: Optional[bool] = None, now: Optional[float] = None) -> Dict[str, Any]:
    status = _RUN_STATUS.get(str(execution.get("status") or ""), "unknown")
    manual = manual_info(execution.get("id"))
    model = ""
    if job:
        snap = job.get("model_snapshot")
        if isinstance(snap, dict):
            model = str(snap.get("model") or "")
        elif isinstance(snap, str):
            model = snap
        model = model or str(job.get("model") or "")
    err = execution.get("error")
    return {
        "id": str(execution.get("id")),
        "job_id": str(execution.get("job_id") or (job or {}).get("id") or ""),
        "status": status,
        "source": "manual" if manual is not None else "scheduled",
        "note": (manual or {}).get("note"),
        "model": model or default_model or "",
        "started_at": execution.get("started_at") or execution.get("claimed_at"),
        "finished_at": execution.get("finished_at"),
        "duration_ms": _duration_ms(execution.get("started_at") or execution.get("claimed_at"),
                                    execution.get("finished_at"), now),
        "error": (str(err)[:240] if err else None),
        "delivery": _delivery_view(delivery, status),
        "console": bool(console) if console is not None else False,
    }


def _delivery_for(execution_id: str) -> Optional[Dict[str, Any]]:
    try:
        from cron.delivery_queue import get_status
        return get_status(execution_id)
    except Exception:
        return None


def list_runs(job_id: str, limit: int, *, job: Optional[Dict[str, Any]] = None,
              default_model: str = "", state_db_path: Any = None) -> List[Dict[str, Any]]:
    from cron.executions import list_executions
    rows = list_executions(job_id=job_id, limit=max(1, min(int(limit), 100)))
    out: List[Dict[str, Any]] = []
    for r in rows:
        console = find_console_session(state_db_path, job_id, r) is not None if state_db_path else False
        out.append(run_view(r, job=job, delivery=_delivery_for(str(r.get("id"))),
                            default_model=default_model, console=console))
    return out


def get_run(job_id: str, run_id: str, *, job: Optional[Dict[str, Any]] = None,
            default_model: str = "", state_db_path: Any = None) -> Optional[Dict[str, Any]]:
    from cron.executions import get_execution
    r = get_execution(run_id)
    if not r or str(r.get("job_id")) != str(job_id):
        return None
    console = find_console_session(state_db_path, job_id, r) is not None if state_db_path else False
    return run_view(r, job=job, delivery=_delivery_for(run_id), default_model=default_model, console=console)


def latest_runs(job_ids: Iterable[str], *, jobs_by_id: Dict[str, Dict[str, Any]],
                default_model: str = "") -> Dict[str, Dict[str, Any]]:
    """job_id → run view of its most recent execution (one indexed query)."""
    try:
        from cron.executions import latest_executions
        latest = latest_executions([str(j) for j in job_ids])
    except Exception:
        logger.debug("[parley] latest_executions unavailable", exc_info=True)
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for job_id, ex in latest.items():
        if not isinstance(ex, dict):
            continue
        out[str(job_id)] = run_view(ex, job=jobs_by_id.get(str(job_id)),
                                    delivery=_delivery_for(str(ex.get("id"))), default_model=default_model)
    return out


# ── console: the run's cron session in state.db ──────────────────────

def find_console_session(state_db_path: Any, job_id: str, execution: Dict[str, Any]) -> Optional[str]:
    """The ``cron_<job_id>_<stamp>`` session hermes opened for this run, or
    None. Matched by start time: the session starts a moment after the
    execution is claimed and before it finishes."""
    if not state_db_path:
        return None
    claimed = _parse_iso(execution.get("claimed_at")) or _parse_iso(execution.get("started_at"))
    if claimed is None:
        return None
    finished = _parse_iso(execution.get("finished_at"))
    lo = claimed - _SESSION_MATCH_SLACK_S
    hi = (finished + _SESSION_MATCH_SLACK_S) if finished is not None else time.time() + _SESSION_MATCH_SLACK_S
    try:
        uri = f"file:{state_db_path}?mode=ro"
        with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=2.0)) as conn:
            row = conn.execute(
                "SELECT id FROM sessions WHERE id LIKE ? AND started_at BETWEEN ? AND ? "
                "ORDER BY started_at ASC LIMIT 1",
                (f"cron_{job_id}_%", lo, hi),
            ).fetchone()
    except sqlite3.Error:
        return None
    return str(row[0]) if row else None


def _clip(text: str, n: int = CONSOLE_LINE_CHARS) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _tool_call_lines(tool_calls_json: Any) -> List[Tuple[str, str]]:
    try:
        calls = json.loads(tool_calls_json) if isinstance(tool_calls_json, str) else (tool_calls_json or [])
    except (TypeError, ValueError):
        return [("tool_call", _clip(str(tool_calls_json)))]
    out: List[Tuple[str, str]] = []
    for c in calls if isinstance(calls, list) else []:
        fn = (c or {}).get("function") if isinstance(c, dict) else None
        name = (fn or {}).get("name") or (c or {}).get("name") or "tool"
        args = (fn or {}).get("arguments") or ""
        out.append(("tool_call", _clip(f"{name} {args}")))
    return out


_ERROR_MARKERS = ('"error":', "Traceback", "Error:", "failed", "FAILED")


def _tool_result_kind(content: str) -> str:
    head = content[:400]
    if any(m in head for m in _ERROR_MARKERS):
        # A JSON envelope with a null/false error field is fine.
        if '"error": null' in head or '"error": false' in head or '"success": true' in head:
            return "tool_result"
        return "error"
    return "tool_result"


def console_lines(state_db_path: Any, session_id: str, *, after_id: int = 0,
                  limit: int = CONSOLE_PAGE_LINES) -> Dict[str, Any]:
    """Message rows of the run's session as console lines, newest last.

    ``after_id`` is the last message id the client has; only later rows are
    returned. Kinds: ``prompt`` (the job prompt, first row), ``assistant``
    (model text), ``tool_call``, ``tool_result``, ``error``.
    """
    lines: List[Dict[str, Any]] = []
    next_after = int(after_id or 0)
    try:
        uri = f"file:{state_db_path}?mode=ro"
        with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=2.0)) as conn:
            rows = conn.execute(
                "SELECT id, role, content, tool_name, tool_calls, timestamp FROM messages "
                "WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
                (session_id, int(after_id or 0), max(1, min(int(limit), 2000))),
            ).fetchall()
    except sqlite3.Error as exc:
        return {"lines": [], "next_after": next_after, "error": str(exc)}
    first_seen = int(after_id or 0) == 0
    for (mid, role, content, tool_name, tool_calls, ts) in rows:
        next_after = int(mid)
        text = content or ""
        if role == "user":
            kind = "prompt" if first_seen else "user"
            first_seen = False
            lines.append({"id": int(mid), "ts": float(ts or 0), "kind": kind, "text": _clip(text, 400)})
        elif role == "assistant":
            first_seen = False
            if text.strip():
                lines.append({"id": int(mid), "ts": float(ts or 0), "kind": "assistant", "text": _clip(text)})
            for kind, t in _tool_call_lines(tool_calls):
                lines.append({"id": int(mid), "ts": float(ts or 0), "kind": kind, "text": t})
        elif role == "tool":
            first_seen = False
            kind = _tool_result_kind(text)
            label = f"{tool_name or 'tool'} · {len(text)} chars"
            lines.append({"id": int(mid), "ts": float(ts or 0), "kind": kind,
                          "text": _clip(f"{label} · {text}")})
        else:
            first_seen = False
    return {"lines": lines, "next_after": next_after}


# ── fire now ─────────────────────────────────────────────────────────

def _gateway_adapters() -> Any:
    """Live platform adapters so the fire can DELIVER (a fire without them
    can run the agent but not send the result to Parley/Telegram/…)."""
    try:
        from gateway.run import _gateway_runner_ref
        runner = _gateway_runner_ref()
        return getattr(runner, "adapters", None) or None
    except Exception:
        return None


def fire_now(job_id: str, note: Optional[str], *, loop: Any, on_done: Optional[Callable[[], None]] = None,
             ) -> Tuple[Dict[str, Any], str]:
    """Claim and fire ``job_id`` immediately. Returns ``(job, execution_id)``.

    Mirrors the gateway's own fire webhook: the store claim is taken
    synchronously (so a duplicate press is a clean 409 rather than a second
    run), then the run itself is detached to a worker thread with the live
    adapters and the event loop, exactly like a scheduled fire. ``note`` is
    stamped as the job's single-fire ``manual_run_prompt`` — hermes appends
    it to the prompt for this run only and clears it when the run records.
    """
    from cron.jobs import resolve_job_ref, update_job
    from cron.scheduler_provider import provider_supports_force_fire, resolve_cron_scheduler

    job = resolve_job_ref(job_id)
    if not job:
        raise LookupError(job_id)
    if job.get("state") in ("completed", "error") and not job.get("enabled", True):
        raise ValueError(f"Cannot run: job '{job.get('name', job_id)}' is {job.get('state')} (terminal).")
    if note:
        update_job(job["id"], {"manual_run_prompt": note})
    provider = resolve_cron_scheduler()
    force = (not job.get("enabled", True)) or job.get("state") == "paused"
    if force and not provider_supports_force_fire(provider):
        raise JobRunUnavailable("this scheduler cannot force-fire a paused job")
    claimed = provider.claim_fire(job["id"], force=True) if force else provider.claim_fire(job["id"])
    if claimed is None:
        raise JobRunConflict("already running")
    execution_id = str(claimed.get("execution_id") or "")
    if execution_id:
        remember_manual(execution_id, note)
    adapters = _gateway_adapters()

    def _run() -> None:
        try:
            provider.fire_claimed(claimed, adapters=adapters, loop=loop)
        except Exception:
            logger.exception("[parley] manual cron fire failed job=%s", job_id)
        finally:
            if on_done:
                try:
                    on_done()
                except Exception:
                    logger.debug("[parley] fire on_done hook failed", exc_info=True)

    threading.Thread(target=_run, name=f"parley-cron-fire-{job_id}", daemon=True).start()
    return job, execution_id


# ── watcher: push job_run envelopes on state change ──────────────────

class RunWatcher:
    """Polls the ledgers and emits a ``job_run`` envelope whenever a run's
    status or delivery status changes. Brisk (2 s) while any run is in
    flight, lazy (30 s) otherwise, so an idle gateway pays one indexed
    query every half minute. ``emit`` is awaited on the adapter's loop.
    """

    def __init__(self, *, emit: Callable[[Dict[str, Any]], Any], job_lookup: Callable[[], Dict[str, Dict[str, Any]]],
                 default_model: Callable[[], str], state_db_path: Callable[[], Any],
                 on_manual_terminal: Optional[Callable[[Dict[str, Any], Dict[str, Any]], Any]] = None):
        self._emit = emit
        self._job_lookup = job_lookup
        self._default_model = default_model
        self._state_db_path = state_db_path
        self._on_manual_terminal = on_manual_terminal
        self._seen: Dict[str, Tuple[str, str]] = {}
        self._task: Optional[asyncio.Task] = None
        self._wake = asyncio.Event()
        self._primed = False

    def ensure_started(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._loop(), name="parley-cron-run-watcher")

    def poke(self) -> None:
        """Something just changed (a manual fire) — poll now."""
        try:
            self._wake.set()
        except Exception:
            pass

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

    def _snapshot(self) -> List[Tuple[Dict[str, Any], Optional[Dict[str, Any]]]]:
        from cron.executions import list_executions
        rows = list_executions(limit=30)
        return [(r, _delivery_for(str(r.get("id")))) for r in rows]

    def _changed(self, snapshot: List[Tuple[Dict[str, Any], Optional[Dict[str, Any]]]]) -> List[Tuple[Dict[str, Any], Optional[Dict[str, Any]], bool]]:
        out = []
        for ex, dl in snapshot:
            key = (str(ex.get("status") or ""), str((dl or {}).get("status") or ""))
            eid = str(ex.get("id"))
            prev = self._seen.get(eid)
            if prev != key:
                self._seen[eid] = key
                # On the very first pass we just learn the world; nothing is "new".
                if self._primed:
                    became_terminal = key[0] in ("completed", "failed", "unknown") and (prev is None or prev[0] not in ("completed", "failed", "unknown"))
                    out.append((ex, dl, became_terminal))
        if len(self._seen) > 500:
            for k in list(self._seen)[:-300]:
                self._seen.pop(k, None)
        self._primed = True
        return out

    def _any_active(self, snapshot: List[Tuple[Dict[str, Any], Optional[Dict[str, Any]]]]) -> bool:
        for ex, dl in snapshot:
            if str(ex.get("status")) in ("claimed", "running"):
                return True
            if dl and str(dl.get("status")) in ("pending", "delivering"):
                return True
        return False

    async def _loop(self) -> None:
        while True:
            try:
                snapshot = await asyncio.to_thread(self._snapshot)
                jobs = self._job_lookup()
                default_model = self._default_model()
                for ex, dl, became_terminal in self._changed(snapshot):
                    job = jobs.get(str(ex.get("job_id")))
                    view = run_view(ex, job=job, delivery=dl, default_model=default_model,
                                    console=find_console_session(self._state_db_path(), str(ex.get("job_id")), ex) is not None)
                    await self._emit({"type": "job_run", "job_id": view["job_id"], "run": view,
                                      "job_name": str((job or {}).get("name") or view["job_id"])})
                    if became_terminal and view["source"] == "manual" and self._on_manual_terminal:
                        try:
                            await self._on_manual_terminal(view, job or {})
                        except Exception:
                            logger.debug("[parley] manual-terminal hook failed", exc_info=True)
                interval = WATCH_ACTIVE_INTERVAL_S if self._any_active(snapshot) else WATCH_IDLE_INTERVAL_S
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.debug("[parley] run watcher iteration failed", exc_info=True)
                interval = WATCH_IDLE_INTERVAL_S
            self._wake.clear()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=interval)


def run_finished_notice(job: Dict[str, Any], run: Dict[str, Any]) -> str:
    """Body for the cron-kind notification sent when a MANUAL run reaches a
    terminal state and did not deliver anywhere Parley can see. Uses the
    same header shape hermes' own cron deliveries use, so the PWA's banner
    parser and the ⏰ notification row treat it as one of them."""
    name = str(job.get("name") or run.get("job_id") or "cron job")
    dur = run.get("duration_ms")
    took = f" in {int(dur // 1000)}s" if isinstance(dur, (int, float)) and dur is not None else ""
    if run.get("status") == "succeeded":
        body = f"✅ Manual run finished{took}."
        if run.get("delivery", {}).get("status") == "failed":
            body += f" Delivery failed: {run['delivery'].get('error') or 'unknown error'}"
    else:
        body = f"❌ Manual run {run.get('status')}{took}: {run.get('error') or 'no error recorded'}"
    return f"Cronjob Response: {name}\n(job_id: {run.get('job_id')})\n-------------\n\n{body}"
