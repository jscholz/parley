"""/v1/capabilities — computed from the registered routes."""
from __future__ import annotations

import asyncio
import json
import types

from .. import parley_capabilities as caps


class _Resource:
    def __init__(self, canonical): self.canonical = canonical


class _Router:
    def __init__(self, paths): self._paths = paths
    def resources(self): return [_Resource(p) for p in self._paths]


class _App:
    def __init__(self, paths): self.router = _Router(paths)


def test_families_from_paths_most_specific_first():
    fams = caps.families_for_paths([
        "/health", "/v1/health", "/v1/health/{check_id}/run", "/v1/health/catalog", "/v1/health/flows/{flow_id}",
        "/v1/health/{check_id}/actions/{action}", "/v1/conversations", "/v1/conversations/search", "/v1/gateway/conversations",
        "/v1/push/subscribe", "/v1/user-settings", "/v1/transcript/repair", "/v1/capabilities", "/unknown/thing",
    ])
    assert fams == sorted({"liveness", "health", "integrations", "conversations", "search", "gateway", "push", "user-settings", "transcript-ops", "capabilities"})
    assert caps.families_for_paths(["/v1/health/{check_id}/run"]) == ["health"]          # not integrations
    assert caps.families_for_paths(["/v1/health/{check_id}/actions/{action}"]) == ["integrations"]


def test_capabilities_payload_shape():
    app = _App(["/v1/responses", "/v1/events", "/v1/conversations", "/v1/pins", "/v1/capabilities"])
    c = caps.capabilities(app)
    assert c["object"] == "capabilities" and c["turn_lifecycle"] is True and c["timestamp_units"] == "s"
    assert c["extensions"] == ["capabilities", "conversations", "events", "pins", "responses"]
    assert c["agent"]["name"] == "hermes" and c["agent"]["plugin_version"]


def test_handler_requires_auth_and_serves_json():
    app = _App(["/v1/responses", "/v1/capabilities"])
    ctx_ok = types.SimpleNamespace(_check_http_auth=lambda r: True)
    ctx_no = types.SimpleNamespace(_check_http_auth=lambda r: False)
    loop = asyncio.new_event_loop()
    assert loop.run_until_complete(caps.handle_capabilities(ctx_no, object(), app)).status == 401
    r = loop.run_until_complete(caps.handle_capabilities(ctx_ok, object(), app))
    assert r.status == 200 and json.loads(r.text)["extensions"] == ["capabilities", "responses"]
