"""``GET /v1/capabilities`` — what this plugin implements, computed from the
routes it actually registered (2026-10-26 audit, phase 2).

The vocabulary is the route-family names of the proxy's
``proxy/parley/contract/routes.ts``; a node contract test checks that
every family named here exists there. Computing from the live router
(rather than a hand-kept list) means a route family that is not
registered — hermes refactor, import failure — is honestly absent, and
the proxy/PWA hide the surface instead of 502-ing.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Iterable, List, Set

logger = logging.getLogger(__name__)

# (path prefix, family) — most specific first; the first match wins.
FAMILY_PREFIXES = (
    ("/v1/capabilities", "capabilities"),
    ("/v1/responses", "responses"),
    ("/v1/events", "events"),
    ("/v1/conversations/search", "search"),
    ("/v1/conversations", "conversations"),
    ("/v1/gateway/", "gateway"),
    ("/v1/settings/", "settings"),
    ("/v1/commands", "commands"),
    ("/v1/jobs", "jobs"),
    ("/v1/health/catalog", "integrations"),
    ("/v1/health/flows", "integrations"),
    ("/v1/health/oauth", "integrations"),
    ("/v1/health/{check_id}/actions", "integrations"),
    ("/v1/health", "health"),
    ("/health", "liveness"),
    ("/v1/parley/auxiliary-models", "models"),
    ("/v1/parley/model-capabilities", "models"),
    ("/v1/parley/upload", "upload"),
    ("/v1/push/", "push"),
    ("/v1/unread", "unread"),
    ("/v1/pins", "pins"),
    ("/v1/activity", "activity"),
    ("/v1/questions/", "questions"),
    ("/v1/user-settings", "user-settings"),
    ("/v1/transcript/", "transcript-ops"),
)


def families_for_paths(paths: Iterable[str]) -> List[str]:
    out: Set[str] = set()
    for path in paths:
        for prefix, family in FAMILY_PREFIXES:
            if path.startswith(prefix):
                out.add(family)
                break
    return sorted(out)


def registered_paths(app: Any) -> List[str]:
    paths: List[str] = []
    try:
        for resource in app.router.resources():
            canonical = getattr(resource, "canonical", None)
            if isinstance(canonical, str):
                paths.append(canonical)
    except Exception:
        logger.debug("[parley] capabilities: router introspection failed", exc_info=True)
    return paths


def _hermes_version() -> str:
    try:
        from hermes_cli import __version__  # type: ignore
        return str(__version__)
    except Exception:
        return ""


def _plugin_version() -> str:
    try:
        for line in (Path(__file__).resolve().parent / "plugin.yaml").read_text().splitlines():
            if line.startswith("version:"):
                return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return ""


def capabilities(app: Any) -> Dict[str, Any]:
    return {
        "object": "capabilities",
        "extensions": families_for_paths(registered_paths(app)),
        "turn_lifecycle": True,
        "timestamp_units": "s",
        "agent": {"name": "hermes", "version": _hermes_version(), "plugin_version": _plugin_version()},
    }


async def handle_capabilities(ctx, request, app):
    from aiohttp import web
    check = getattr(ctx, "check_http_auth", None) or getattr(ctx, "_check_http_auth", None)
    if check and not check(request):
        return web.Response(status=401, text="invalid token")
    return web.json_response(capabilities(app))


def register_capabilities_route(app, ctx) -> None:
    app.router.add_get("/v1/capabilities", lambda r: handle_capabilities(ctx, r, app))
