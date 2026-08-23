"""display_doc tool — push a document into the Parley PWA's Docs panel.

The agent calls ``display_doc(path=...)``; the handler reads the file
server-side and ships ``{type: "doc_show", title, content, format, path}``
through the adapter's envelope channel. The PWA renders it in the right
drawer's Docs tab (markdown via miniMarkdown, HTML in a sandboxed iframe,
anything else as plain text) and auto-opens the drawer.

Separation contract: this module lives entirely in the parley plugin.
It registers against hermes' public ``tools.registry`` API when available
and degrades to a silent no-op when it isn't (older hermes, import
failure) — the plugin must never fail to load because of it. The PWA in
turn shows an empty Docs panel when the tool never fires. Neither side
hard-depends on the other:

  * backend without the tool  → Docs tab renders its empty state;
  * frontend without the tab  → the ``doc_show`` envelope is an unknown
    SSE event name and is dropped by the proxy/EventSource layers.

Toolset: ``parley`` — the BARE platform name, NOT ``hermes-parley``.
This distinction is load-bearing. Hermes resolves a plugin platform's
default toolset ``hermes-<platform>`` via an auto-generation branch in
``toolsets.resolve_toolset`` that returns ``_HERMES_CORE_TOOLS`` (file,
terminal, web, ...) PLUS any registry tools whose ``toolset == <platform>``
— but ONLY while no registered toolset literally named
``hermes-<platform>`` exists. Registering this tool under
``hermes-parley`` (as v1 did, 2026-07-04..07-07) created exactly such a
toolset, shadowing the auto-gen branch and silently stripping every core
tool from parley sessions — the agent was left with only display_doc +
MCP tools (field regression: filesystem access lost in the deck-writing
workflow). Registering under the bare platform name keeps the auto-gen
composite intact: core tools + display_doc. ``check_fn`` additionally
gates on the session platform so other surfaces never list it.
"""

import json
import logging
import os
import time
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
        "Display a document in the Parley app's Docs side panel — use "
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
                    "no parley chat in session context — display_doc only "
                    "works inside a Parley conversation"
                )
            })

        adapter = get_adapter()
        if adapter is None:
            return json.dumps({"error": "parley adapter is not running"})

        fmt = _FORMAT_BY_SUFFIX.get(path.suffix.lower(), "text")
        title = (args.get("title") or "").strip() or path.name
        # Shelf identity (v2 PWA "doc shelf"): the client dedups by a djb2
        # hash of the path — mirror it here so the tool result's doc_id
        # matches what the panel shows. Re-pushing the same path REPLACES
        # that shelf entry (refresh), it never duplicates.
        doc_id = _doc_id_for(str(path), title)
        try:
            # Sync tool handlers run on worker threads (run_in_executor in
            # run_agent.py); _schedule_envelope is the thread-safe path
            # back onto the adapter's event loop.
            adapter._schedule_envelope({
                "type": "doc_show",
                "chat_id": chat_id,
                "title": title,
                "content": content,
                "format": fmt,
                "path": str(path),
                "doc_id": doc_id,
                # Server clock, epoch ms: when the agent displayed this.
                # THE timestamp the PWA shows ("26s ago") — one server
                # value keeps it constant across devices, and the SSE
                # ring replays this envelope verbatim so boot/reconnect
                # can't reset it to 0s (field bug 2026-07-08).
                "displayed_at": int(time.time() * 1000),
            })
        except Exception as e:
            return json.dumps({"error": f"could not deliver doc to the app: {e}"})
        open_docs = _remember_open_doc(chat_id, doc_id, title)
        return json.dumps({
            "success": True,
            "displayed": str(path),
            "format": fmt,
            "bytes": size,
            "doc_id": doc_id,
            # Titles currently on the user's doc shelf for this chat
            # (this process's view — the user may have closed some in the
            # panel). Lets the agent talk about the shelf ("that's the
            # second doc in your panel") without a list tool.
            "open_docs": open_docs,
            "note": (
                "The document is now open in the user's Docs panel. "
                "Re-calling display_doc with the same path refreshes that "
                "panel entry in place (no duplicate)."
            ),
        })

    return display_doc_tool


def _doc_id_for(path: str, title: str) -> str:
    """djb2 hash, hex — MUST mirror docStore.docIdFor in the PWA."""
    key = path.strip() or f"title:{title.strip().lower()}"
    h = 5381
    for ch in key:
        h = ((h << 5) + h + ord(ch)) & 0xFFFFFFFF
    return format(h, "x")


# Per-chat memory of docs this process pushed — newest first, deduped by
# doc_id, soft-capped to the PWA shelf size. In-memory only (best-effort
# awareness for the agent; the panel is the source of truth and the user
# can close entries there without us knowing).
_OPEN_DOCS: Dict[str, list] = {}
_OPEN_DOCS_CAP = 7


def _remember_open_doc(chat_id: str, doc_id: str, title: str) -> list:
    entries = _OPEN_DOCS.setdefault(chat_id, [])
    entries[:] = [(i, t) for (i, t) in entries if i != doc_id]
    entries.insert(0, (doc_id, title))
    del entries[_OPEN_DOCS_CAP:]
    return [t for (_i, t) in entries]


def _check_display_doc() -> bool:
    """Offer the tool only inside parley sessions. (The registry's
    check_fn TTL cache can bleed availability across sessions for ~15s —
    same accepted trade-off as react_to_message's platform gate; a
    mis-listed call still fails gracefully on the chat-id guard.)"""
    try:
        from gateway.session_context import get_session_env
        return get_session_env("HERMES_SESSION_PLATFORM", "") == "parley"
    except Exception:
        return os.getenv("HERMES_SESSION_PLATFORM", "") == "parley"


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
            "[parley] tools.registry unavailable — display_doc not registered"
        )
        return False
    try:
        registry.register(
            name="display_doc",
            # Bare platform name — NEVER "hermes-parley". See module
            # docstring: a registered toolset named hermes-parley shadows
            # the auto-generated core-tools composite and strips file/
            # terminal/web from every parley session.
            toolset="parley",
            schema=DISPLAY_DOC_SCHEMA,
            handler=_make_display_doc_handler(get_adapter),
            check_fn=_check_display_doc,
            emoji="📄",
        )
        logger.info("[parley] display_doc tool registered (toolset=parley)")
        return True
    except Exception:
        logger.exception("[parley] display_doc registration failed")
        return False
