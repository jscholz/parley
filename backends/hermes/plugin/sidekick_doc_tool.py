"""display_doc tool — push a document into the Sidekick PWA's Docs panel.

The agent calls ``display_doc(path=...)``; the handler reads the file
server-side and ships ``{type: "doc_show", title, content, format, path}``
through the adapter's envelope channel. The PWA renders it in the right
drawer's Docs tab (markdown via miniMarkdown, HTML in a sandboxed iframe,
anything else as plain text) and auto-opens the drawer.

Separation contract: this module lives entirely in the sidekick plugin.
It registers against hermes' public ``tools.registry`` API when available
and degrades to a silent no-op when it isn't (older hermes, import
failure) — the plugin must never fail to load because of it. The PWA in
turn shows an empty Docs panel when the tool never fires. Neither side
hard-depends on the other:

  * backend without the tool  → Docs tab renders its empty state;
  * frontend without the tab  → the ``doc_show`` envelope is an unknown
    SSE event name and is dropped by the proxy/EventSource layers.

Toolset: ``sidekick`` — the BARE platform name, NOT ``hermes-sidekick``.
This distinction is load-bearing. Hermes resolves a plugin platform's
default toolset ``hermes-<platform>`` via an auto-generation branch in
``toolsets.resolve_toolset`` that returns ``_HERMES_CORE_TOOLS`` (file,
terminal, web, ...) PLUS any registry tools whose ``toolset == <platform>``
— but ONLY while no registered toolset literally named
``hermes-<platform>`` exists. Registering this tool under
``hermes-sidekick`` (as v1 did, 2026-07-04..07-07) created exactly such a
toolset, shadowing the auto-gen branch and silently stripping every core
tool from sidekick sessions — the agent was left with only display_doc +
MCP tools (field regression: filesystem access lost in the deck-writing
workflow). Registering under the bare platform name keeps the auto-gen
composite intact: core tools + display_doc. ``check_fn`` additionally
gates on the session platform so other surfaces never list it.
"""

import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict

logger = logging.getLogger(__name__)

# Content rides one SSE envelope through the events ring; cap so a stray
# "display this 40MB log" can't bloat the ring / the PWA's localStorage
# mirror. The error message tells the agent how to recover.
MAX_DOC_BYTES = 1_000_000

_FORMAT_BY_SUFFIX = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".html": "html",
    ".htm": "html",
}

DISPLAY_DOC_SCHEMA = {
    "name": "display_doc",
    "description": (
        "Display a document in the Sidekick app's Docs side panel — use "
        "when the user asks to see/read a file you wrote (deck content, "
        "notes, a report) without opening an editor. Renders markdown "
        "(.md), sandboxed HTML (.html), or plain text; the panel opens "
        "automatically on the user's screen, including mobile. Prefer "
        "this over pasting a whole document into the chat reply."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path of the file to display (absolute or ~-relative).",
            },
            "title": {
                "type": "string",
                "description": "Optional panel title; defaults to the file name.",
            },
        },
        "required": ["path"],
    },
}


def _make_display_doc_handler(get_adapter: Callable[[], Any]):
    """Bind the handler to a live-adapter getter (evaluated per call, so
    adapter restarts don't strand a stale reference)."""

    def display_doc_tool(args: Dict[str, Any], **kw: Any) -> str:
        raw = (args.get("path") or "").strip()
        if not raw:
            return json.dumps({"error": "path is required"})
        path = Path(raw).expanduser()
        if not path.is_file():
            return json.dumps({"error": f"not a file: {path}"})
        try:
            size = path.stat().st_size
            if size > MAX_DOC_BYTES:
                return json.dumps({
                    "error": (
                        f"file is {size} bytes; display_doc caps at "
                        f"{MAX_DOC_BYTES}. Write a trimmed copy and display that."
                    )
                })
            content = path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            return json.dumps({"error": f"could not read {path}: {e}"})

        # session_context is the concurrency-safe reader; fall back to
        # plain env for hermes trees without it (its own resolution
        # order ends at os.environ anyway).
        try:
            from gateway.session_context import get_session_env
            chat_id = get_session_env("HERMES_SESSION_CHAT_ID", "") or None
        except Exception:
            chat_id = os.getenv("HERMES_SESSION_CHAT_ID") or None
        if not chat_id:
            return json.dumps({
                "error": (
                    "no sidekick chat in session context — display_doc only "
                    "works inside a Sidekick conversation"
                )
            })

        adapter = get_adapter()
        if adapter is None:
            return json.dumps({"error": "sidekick adapter is not running"})

        fmt = _FORMAT_BY_SUFFIX.get(path.suffix.lower(), "text")
        try:
            # Sync tool handlers run on worker threads (run_in_executor in
            # run_agent.py); _schedule_envelope is the thread-safe path
            # back onto the adapter's event loop.
            adapter._schedule_envelope({
                "type": "doc_show",
                "chat_id": chat_id,
                "title": (args.get("title") or "").strip() or path.name,
                "content": content,
                "format": fmt,
                "path": str(path),
            })
        except Exception as e:
            return json.dumps({"error": f"could not deliver doc to the app: {e}"})
        return json.dumps({
            "success": True,
            "displayed": str(path),
            "format": fmt,
            "bytes": size,
            "note": "The document is now open in the user's Docs panel.",
        })

    return display_doc_tool


def _check_display_doc() -> bool:
    """Offer the tool only inside sidekick sessions. (The registry's
    check_fn TTL cache can bleed availability across sessions for ~15s —
    same accepted trade-off as react_to_message's platform gate; a
    mis-listed call still fails gracefully on the chat-id guard.)"""
    try:
        from gateway.session_context import get_session_env
        return get_session_env("HERMES_SESSION_PLATFORM", "") == "sidekick"
    except Exception:
        return os.getenv("HERMES_SESSION_PLATFORM", "") == "sidekick"


def register_display_doc_tool(get_adapter: Callable[[], Any]) -> bool:
    """Register display_doc against hermes' tool registry, if present.

    Returns True when registered; never raises — a hermes tree without
    ``tools.registry`` (or with an incompatible register signature) just
    leaves the Docs panel agent-less.
    """
    try:
        from tools.registry import registry
    except Exception:
        logger.info(
            "[sidekick] tools.registry unavailable — display_doc not registered"
        )
        return False
    try:
        registry.register(
            name="display_doc",
            # Bare platform name — NEVER "hermes-sidekick". See module
            # docstring: a registered toolset named hermes-sidekick shadows
            # the auto-generated core-tools composite and strips file/
            # terminal/web from every sidekick session.
            toolset="sidekick",
            schema=DISPLAY_DOC_SCHEMA,
            handler=_make_display_doc_handler(get_adapter),
            check_fn=_check_display_doc,
            emoji="📄",
        )
        logger.info("[sidekick] display_doc tool registered (toolset=sidekick)")
        return True
    except Exception:
        logger.exception("[sidekick] display_doc registration failed")
        return False
