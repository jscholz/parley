"""Shared pytest plumbing for the audio-bridge suite.

Async runner: the suite's coroutine tests (test_parley_stream.py,
test_stt_transcript.py) were written against the ``pytest.mark.asyncio``
convention, but pytest-asyncio was never added to requirements.txt or
the runner venv — so every async test in the suite failed at collection
("async def functions are not natively supported") from the day it
landed (c2c5044, which introduced test_parley_stream.py without a
conftest or plugin dep). Rather than grow a plugin dependency for tests
this simple, run each coroutine test on a fresh event loop here. All
tests drive pure in-process objects (no sockets, no aiohttp), so a
plain ``asyncio.run`` per test is exactly equivalent.
"""

import asyncio
import inspect

import pytest


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "asyncio: run this coroutine test on a fresh asyncio event loop",
    )


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem):
    """Execute ``async def`` test functions via asyncio.run.

    Sync tests fall through to pytest's default caller (return None).
    """
    fn = pyfuncitem.obj
    if inspect.iscoroutinefunction(fn):
        kwargs = {
            name: pyfuncitem.funcargs[name]
            for name in pyfuncitem._fixtureinfo.argnames
        }
        asyncio.run(fn(**kwargs))
        return True
    return None
