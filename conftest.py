"""Shared test stubs for running the Parley Hermes plugin tests standalone.

The real plugin imports Hermes gateway modules at package import time. In the
Parley repo test environment those modules are not installed, so install the
small surface the plugin needs before test modules import backends.hermes.plugin.
Individual older tests still carry local copies of this setup; keeping this
central version makes collection order deterministic.
"""

from __future__ import annotations

import os
import sys
import types


def pytest_configure(config):  # noqa: ARG001 - pytest hook signature
    os.environ.setdefault("VAPID_PUBLIC_KEY", "test-public-key")
    os.environ.setdefault("VAPID_PRIVATE_KEY", "test-private-key")
    # Live-DB tripwire (push-prefs corruption incident, 2026-07-25):
    # with this set, the plugin DB layer refuses to open any DB under the
    # real state dirs (~/.hermes, ~/.parley,
    # ~/.openclaw-sk-integ). Every test must use tmp paths; a fixture that
    # accidentally resolves to the live store fails at open instead of
    # writing production state. Legacy PARLEY_TEST_GUARD spelling is
    # honored too (parley_env shim).
    os.environ["PARLEY_TEST_GUARD"] = "1"
    if "gateway" not in sys.modules:
        sys.modules["gateway"] = types.ModuleType("gateway")

    if "gateway.config" not in sys.modules:
        cfg = types.ModuleType("gateway.config")

        class Platform:
            PARLEY = "parley"

        class PlatformConfig:
            pass

        cfg.Platform = Platform
        cfg.PlatformConfig = PlatformConfig
        sys.modules["gateway.config"] = cfg

    if "gateway.platforms" not in sys.modules:
        sys.modules["gateway.platforms"] = types.ModuleType("gateway.platforms")

    if "gateway.platforms.base" not in sys.modules:
        base = types.ModuleType("gateway.platforms.base")

        class BasePlatformAdapter:
            pass

        class MessageEvent:
            pass

        class MessageType:
            TEXT = "text"
            PHOTO = "photo"
            VIDEO = "video"
            AUDIO = "audio"
            DOCUMENT = "document"

        class SendResult:
            def __init__(self, success=True, message_id="", **kwargs):
                self.success = success
                self.message_id = message_id
                for key, value in kwargs.items():
                    setattr(self, key, value)

        base.BasePlatformAdapter = BasePlatformAdapter
        base.MessageEvent = MessageEvent
        base.MessageType = MessageType
        base.SendResult = SendResult
        sys.modules["gateway.platforms.base"] = base

    if "py_vapid" not in sys.modules:
        py_vapid = types.ModuleType("py_vapid")

        class Vapid:
            def generate_keys(self):
                return None

            def save_private_key(self):
                return b""

            def save_public_key(self):
                return b""

        py_vapid.Vapid = Vapid
        sys.modules["py_vapid"] = py_vapid

    if "pywebpush" not in sys.modules:
        pywebpush = types.ModuleType("pywebpush")

        class WebPushException(Exception):
            def __init__(self, *args, response=None, **kwargs):
                super().__init__(*args)
                self.response = response

        def webpush(*args, **kwargs):
            return None

        pywebpush.webpush = webpush
        pywebpush.WebPushException = WebPushException
        sys.modules["pywebpush"] = pywebpush

    if "aiohttp" not in sys.modules:
        aiohttp = types.ModuleType("aiohttp")
        web = types.ModuleType("aiohttp.web")

        class Response:
            def __init__(self, *, text="", status=200, content_type=None):
                self.text = text
                self.status = status
                self.content_type = content_type

        class Request:
            pass

        def json_response(data, status=200):
            import json
            return Response(text=json.dumps(data), status=status, content_type="application/json")

        web.Response = Response
        web.Request = Request
        web.json_response = json_response
        aiohttp.web = web
        sys.modules["aiohttp"] = aiohttp
        sys.modules["aiohttp.web"] = web


import pytest


@pytest.fixture(autouse=True)
def _flush_plugin_caches():
    """Autouse fixture: drop process-wide TTL caches between every
    test. Without this, the compute_unread + _summaries_by_user_id
    caches added 2026-06-23 leak across tests in the same pytest run
    — e.g. test A inserts state.db rows, test B inserts conflicting
    state.db rows but reads back A's cached summary instead of running
    a fresh query. Both caches expose explicit invalidation hooks
    designed for exactly this kind of cross-test isolation.

    Some tests (notably test_user_id_queries.py) load the plugin via
    ``importlib.import_module("plugin")`` rather than the
    ``backends.hermes.plugin`` package path. That gives Python two
    distinct module objects for the same source file, each with its
    own module-level cache dict. We flush BOTH on every test so the
    isolation is bulletproof regardless of which loader path the
    test exercises.
    """
    import sys as _sys
    candidate_paths = (
        "backends.hermes.plugin.parley_unread",
        "plugin.parley_unread",
    )
    for path in candidate_paths:
        mod = _sys.modules.get(path)
        if mod is not None and hasattr(mod, "invalidate_unread_cache"):
            try:
                mod.invalidate_unread_cache()
            except Exception:
                pass
    candidate_paths = (
        "backends.hermes.plugin.parley_route_conversations",
        "plugin.parley_route_conversations",
    )
    for path in candidate_paths:
        mod = _sys.modules.get(path)
        if mod is not None and hasattr(mod, "invalidate_summaries_cache"):
            try:
                mod.invalidate_summaries_cache()
            except Exception:
                pass
    yield
