"""Perf-investigation instrumentation for the sidekick plugin.

All helpers in this module are gated behind ``SIDEKICK_PERF_TRACE`` so
the production cost is zero by default; flip the env to ``1`` to engage
the watchers. Logs go to the standard plugin logger so they show up in
journalctl --user-unit hermes-gateway under the `sidekick.perf_trace`
namespace.

Created 2026-06-23 to chase the "gateway gets slower the longer it
runs" smell that survived 30f5664's reconcile-off-read-path fix. The
instrumentation answers three questions:

1. **Is the asyncio event loop starved?** ``loop_lag_watcher`` samples
   ``loop.time()`` drift every 100ms and logs WARN when actual-vs-
   scheduled exceeds 50ms. Cheap when healthy; loud only when the loop
   can't dispatch on its scheduled cadence.

2. **Where does the request time go on the gateway side?** The
   ``perf_arrival_middleware`` stamps ``request['t_arrived']`` so the
   route handler can log the gap between TCP-accept and handler-entry.
   That gap is the asyncio dispatch latency the items-trace `+0ms enter`
   can't see (its t0 is set INSIDE the handler).

3. **Is ``reconcile_from_state_db`` cheap on no-drift chats?** The
   ``trace_reconcile_run`` context manager logs per-call wall time, sql
   op counts, and time spent waiting for the sidekick.db lock vs holding
   it. A no-op reconcile should be ms-scale; a heavy one is the smoking
   gun.

Off-switch: unset ``SIDEKICK_PERF_TRACE`` or set it to anything truthy-
negative. The module functions still exist but become near-no-ops.
"""

from __future__ import annotations

import asyncio
import functools
import os
from .parley_env import env_get
import sys
import time
from contextlib import contextmanager
from typing import Any, Awaitable, Callable, Optional

try:
    from aiohttp import web  # type: ignore[assignment]
except ImportError:  # pragma: no cover
    web = None  # type: ignore[assignment]


# Sidekick's existing items-trace writes to stderr via plain `print` so
# the lines land in journalctl regardless of the gateway's stdlib
# logging level config. Match that pattern here for consistency and to
# avoid INFO logs being dropped by the gateway's default WARN-and-up
# log handler.
def _log(level: str, msg: str) -> None:
    print(f"[perf-trace {level}] {msg}", flush=True, file=sys.stderr)


class _LoggerShim:
    """Adapts the stdlib-logger surface we use elsewhere (info/warning/
    error) onto the stderr print sink. Lets the rest of the code feel
    natural without committing to a logger config we don't own."""
    def info(self, fmt: str, *args: Any) -> None: _log("INFO", fmt % args if args else fmt)
    def warning(self, fmt: str, *args: Any) -> None: _log("WARN", fmt % args if args else fmt)
    def error(self, fmt: str, *args: Any) -> None: _log("ERROR", fmt % args if args else fmt)


logger = _LoggerShim()


def _is_enabled() -> bool:
    """Module-level toggle. Read each call rather than cache so toggling
    via systemctl set-environment + reload works without a code change.
    Cost of the env read is negligible compared to anything we'd log."""
    return env_get("PARLEY_PERF_TRACE", "").lower() in ("1", "true", "yes")


# ── 1. Event-loop lag watcher ────────────────────────────────────────

async def loop_lag_watcher(
    *,
    interval_s: float = 0.1,
    warn_threshold_ms: float = 50.0,
    err_threshold_ms: float = 250.0,
) -> None:
    """Sample event-loop responsiveness. The task wakes itself every
    ``interval_s``; if the wakeup actually happens >warn_threshold_ms
    after scheduled, the loop was busy doing something else.

    Low cost when the loop is healthy (one sleep + one comparison per
    interval, ~10/s). Logs only when the lag exceeds threshold so a
    healthy loop is silent.

    Cancellation: standard asyncio cancellation. The caller is expected
    to stash the Task and cancel it on shutdown.

    Also enables asyncio's built-in ``slow_callback_duration`` so the
    loop logs a WARN when ANY single callback runs synchronously for
    longer than the warn threshold. That's a much more precise signal
    than the lag watcher — it names the exact coroutine that hogged
    the loop, instead of "the loop was busy" with no attribution.
    """
    if not _is_enabled():
        return
    logger.info("[perf-trace] loop_lag_watcher armed: interval=%.0fms warn>%.0fms err>%.0fms",
                interval_s * 1000, warn_threshold_ms, err_threshold_ms)
    loop = asyncio.get_running_loop()
    # asyncio's own "this callback ran sync for too long" trigger. When
    # set, the loop logs a WARN with the callback repr + duration any
    # time a single ready-queue callback exceeds this. Catches blocking
    # I/O or CPU-bound work on the loop thread that the lag watcher
    # can only see indirectly.
    loop.slow_callback_duration = warn_threshold_ms / 1000.0
    last_warn_at = 0.0
    while True:
        t_scheduled = loop.time()
        await asyncio.sleep(interval_s)
        t_actual = loop.time()
        lag_ms = (t_actual - t_scheduled - interval_s) * 1000.0
        if lag_ms < warn_threshold_ms:
            continue
        # Rate-limit warns so a sustained stall doesn't drown the log.
        # One line per second is enough to characterize the pattern.
        now = loop.time()
        if now - last_warn_at < 1.0:
            continue
        last_warn_at = now
        if lag_ms >= err_threshold_ms:
            logger.error("[perf-trace] LOOP LAG %.0fms (>=%.0fms)", lag_ms, err_threshold_ms)
            # When the lag is severe, dump a snapshot of running tasks so
            # we can attribute the stall. asyncio.all_tasks() is cheap;
            # the loop is by definition unstuck at this point (the
            # watcher just woke). Limit to first N tasks so a runaway
            # leak doesn't drown the log.
            try:
                tasks = list(asyncio.all_tasks(loop=loop))
                tasks_by_state = {"pending": 0, "running": 0}
                interesting: list = []
                for t in tasks:
                    # asyncio.Task has _state ('PENDING', 'FINISHED', 'CANCELLED')
                    # and current_task() gives the running one. _state PENDING
                    # covers both pending-on-IO and running.
                    name = t.get_name() or "anon"
                    coro = t.get_coro()
                    coro_name = getattr(coro, "__qualname__", str(coro))[:80]
                    if t.done():
                        continue
                    interesting.append(f"{name}:{coro_name}")
                interesting.sort()
                logger.error("[perf-trace] LOOP LAG tasks total=%d: %s",
                             len(interesting), " | ".join(interesting[:20]))
            except Exception as e:
                logger.error("[perf-trace] LOOP LAG task-snapshot failed: %s", e)
        else:
            logger.warning("[perf-trace] loop lag %.0fms (>=%.0fms)", lag_ms, warn_threshold_ms)


# ── 2. aiohttp arrival-stamp middleware ──────────────────────────────

# aiohttp's ``web.middleware`` decorator only exists in the runtime
# install. Unit tests stub aiohttp out (``web = None``); guard the
# decoration so importing this module under pytest doesn't blow up at
# module-load time.
if web is not None and hasattr(web, "middleware"):
    _middleware_decorator = web.middleware
else:
    def _middleware_decorator(fn):  # pragma: no cover — test-only fallback
        return fn


@_middleware_decorator
async def perf_arrival_middleware(request, handler):
    """Stamp ``request['t_perf_arrived']`` with the monotonic clock at
    handler-entry. The handler can subtract its own ``time.monotonic()``
    at the top of its body to measure the dispatch-queue gap — but in
    practice for our debugging the gap is observable directly by
    diffing this timestamp against the request's arrival in the access
    log / journalctl.
    """
    request["t_perf_arrived"] = time.monotonic()
    return await handler(request)


# ── 3. Reconcile timing wrapper ──────────────────────────────────────

# Module-level counters so a one-off reconcile run can be characterized
# without threading objects through. Reset on each context-enter.
_reconcile_ctx: dict = {}


@contextmanager
def trace_reconcile_run(chat_id: str, source: str):
    """Wrap a reconcile_from_state_db invocation. Logs total wall time,
    number of sidekick.db SELECT/UPDATE/INSERT/DELETE calls observed,
    and (best-effort) the wall time spent inside those calls.

    Use as:
        with trace_reconcile_run(chat_id, source) as t:
            ... reconcile body ...
            t.add_op('SELECT', dt_ms)
            ...

    When SIDEKICK_PERF_TRACE is off, this is a no-op context that yields
    a dummy recorder.
    """
    class _Recorder:
        __slots__ = ("op_counts", "op_total_ms", "started_at")
        def __init__(self) -> None:
            self.op_counts: dict = {}
            self.op_total_ms: float = 0.0
            self.started_at: float = time.monotonic()
        def add_op(self, kind: str, dt_ms: float) -> None:
            self.op_counts[kind] = self.op_counts.get(kind, 0) + 1
            self.op_total_ms += dt_ms

    if not _is_enabled():
        # Yield a no-op recorder. Callers still call .add_op but nothing
        # is logged at exit.
        class _Noop:
            def add_op(self, *_a, **_kw) -> None: pass
        yield _Noop()
        return

    rec = _Recorder()
    try:
        yield rec
    finally:
        wall_ms = (time.monotonic() - rec.started_at) * 1000.0
        ops_str = " ".join(f"{k}={v}" for k, v in sorted(rec.op_counts.items()))
        logger.info(
            "[perf-trace] reconcile chat=%s source=%s wall=%.1fms ops_in_sql=%.1fms "
            "(%s)",
            chat_id[:24], source, wall_ms, rec.op_total_ms, ops_str or "no-ops",
        )


# ── 4. sidekick.db growth snapshot ───────────────────────────────────

def log_db_stats(sidekick_db, label: str = "snapshot") -> None:
    """One-shot snapshot of sidekick.db size + key table row counts.
    Cheap (one COUNT per table, ms-scale) but still gated so it doesn't
    fire on every gateway start when nobody's investigating.
    """
    if not _is_enabled():
        return
    try:
        # sidekick.db path lives on the SidekickDB instance as ._path.
        # Fall back gracefully if the attribute name differs.
        db_path = getattr(sidekick_db, "_path", None) or getattr(sidekick_db, "path", None)
        size_bytes = None
        if db_path is not None:
            try:
                size_bytes = os.path.getsize(str(db_path))
            except OSError:
                pass
        counts: dict = {}
        for table in ("msg_links", "activity_items", "pins", "push_subscriptions",
                      "push_mutes", "user_settings"):
            try:
                row = sidekick_db.fetchone(f"SELECT COUNT(*) AS n FROM {table}")
                counts[table] = int(row["n"]) if row else None
            except Exception:
                pass  # Table may not exist on older installs.
        size_mb = f"{size_bytes / 1_048_576:.1f}MB" if size_bytes is not None else "?"
        counts_str = " ".join(f"{k}={v}" for k, v in counts.items())
        logger.info("[perf-trace] db-stats %s size=%s %s", label, size_mb, counts_str)
    except Exception as e:  # pragma: no cover
        logger.warning("[perf-trace] db-stats failed: %s", e)


async def db_stats_periodic_loop(
    sidekick_db,
    *,
    interval_s: float = 3600.0,
) -> None:
    """Periodic background snapshot of sidekick.db. Hourly by default
    so the size/row-count growth over a long uptime is visible in the
    journal without manual prodding.
    """
    if not _is_enabled():
        return
    while True:
        log_db_stats(sidekick_db, label=f"hourly t+{int(time.time())}")
        await asyncio.sleep(interval_s)


# ── 5. Bounded concurrency for sidekick worker threads ──────────────
#
# Sidekick's hot-path /items + drawer-list routes all use
# ``asyncio.to_thread`` to push SQL+Python work to the default executor
# (size ~16 on a 12-core box). A PWA drawer-prefetch burst can spawn
# 30+ concurrent to_thread submissions; with each holding the GIL for
# stretches of Python list-comp / dict-build / set-membership work,
# the asyncio loop thread starves (caught 2026-06-23 — loop lag 8s
# during traffic, 0ms at idle, no single slow callback). Capping
# sidekick concurrency to a small number of in-flight workers gives
# the loop thread fair GIL share back.
#
# Implemented as an asyncio.Semaphore (not a separate executor) so
# the existing to_thread call sites stay simple — just wrap them in
# ``run_in_sidekick_worker``. The default executor is still used; we
# just bound how many sidekick tasks compete for it at any moment.
#
# Tunable via env (SIDEKICK_WORKER_CONCURRENCY); default 3 is enough
# for the steady-state PWA load + a couple of background tasks
# without giving back enough GIL share to actually move the needle.

_SIDEKICK_WORKER_CONCURRENCY = int(
    env_get("PARLEY_WORKER_CONCURRENCY", "3") or 3
)
_sidekick_sem: Optional[asyncio.Semaphore] = None


def _get_sidekick_sem() -> asyncio.Semaphore:
    """Lazily create the semaphore. Avoids touching asyncio primitives
    at import time so unit tests don't bind to the wrong loop."""
    global _sidekick_sem
    if _sidekick_sem is None:
        _sidekick_sem = asyncio.Semaphore(_SIDEKICK_WORKER_CONCURRENCY)
    return _sidekick_sem


async def run_in_sidekick_worker(func: Callable, *args, **kwargs):
    """Drop-in replacement for ``asyncio.to_thread`` that bounds the
    number of concurrent sidekick worker calls. Excess calls await
    the semaphore (cheap async wait — no thread is held). Once the
    semaphore is acquired, the func runs in the default executor
    just like ``asyncio.to_thread`` would have."""
    if kwargs:
        func = functools.partial(func, **kwargs)
    async with _get_sidekick_sem():
        return await asyncio.to_thread(func, *args)
