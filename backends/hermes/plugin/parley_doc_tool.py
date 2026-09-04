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
import re
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict

logger = logging.getLogger(__name__)

# ── HTML image rewriting ──────────────────────────────────────────────
# The Docs panel renders HTML in `<iframe sandbox="…" srcdoc=…>`. A
# LOCAL image reference can never load there: relative paths have no
# usable base (the frame's document is `about:srcdoc`), and `file:` URLs
# are blocked outright. Measured 2026-09-04 in the real frame:
#
#   sandbox=""                  every subresource → NO request at all
#   sandbox="allow-same-origin" fully-qualified proxy URL → 200 ✓
#
# So a doc that references `assets/stills/tile-inspect-grade.jpg`
# renders as broken-image icons no matter how correct the file on disk
# is (field 2026-09-04, the ITAD mosaic mockup — all six tiles present,
# all six broken in the panel).
#
# Fix both halves: the client relaxes the sandbox to allow-same-origin
# (WITHOUT allow-scripts — the combination to avoid is both together;
# with scripts still blocked there is no script to abuse the origin),
# and here we resolve each local <img src> against the document's own
# directory and swap in a media-registry URL the proxy can serve.
#
# Covers `<img src>` plus CSS `url(...)`. One regex over the whole
# document catches url() in both <style> blocks and inline style=""
# attributes, so background images work too.
#
# Not covered, and deliberately: <source srcset> (multi-candidate
# syntax), <link href> stylesheets, and @import. Those would each need
# their own grammar and none appear in the deck workflow's output.
_IMG_SRC_RE = re.compile(r'(<img\b[^>]*?\bsrc\s*=\s*)(["\'])(.*?)\2', re.I | re.S)

# url( 'x' ) / url( "x" ) / url( x ). Group 1 keeps `url(` plus any
# leading space, 2 is the quote (empty when bare), 3 is the reference.
# The bare form stops at the closing paren, which is why a raw path
# containing ')' is not supported — quote it.
_CSS_URL_RE = re.compile(
    r'(url\(\s*)(["\']?)([^"\')]+)\2\s*\)', re.I,
)

# Already-absolute schemes we must never touch. `data:` in particular is
# the one thing that has always worked; rewriting it would be a
# regression.
_ABSOLUTE_SRC = ("http://", "https://", "data:", "//")


def _proxy_origin() -> str:
    """Origin of the parley proxy that owns the media registry."""
    return (os.environ.get("PARLEY_PROXY_ORIGIN")
            or "http://127.0.0.1:3001").rstrip("/")


def _register_media_sync(path: Path):
    """Register a local file with the proxy; return its URL or None.

    Blocking on purpose — display_doc's handler is sync and already runs
    on a worker thread. Any failure returns None and leaves the original
    reference untouched, so a doc degrades to today's broken image
    rather than failing to display at all.
    """
    try:
        body = json.dumps({"path": str(path)}).encode()
        req = urllib.request.Request(
            f"{_proxy_origin()}/api/parley/media/register",
            data=body, headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode())
        return payload.get("url") or None
    except Exception as exc:
        logger.warning("[parley-doc] media register failed for %s: %s", path, exc)
        return None


def _resolve_ref(raw: str, doc_path: Path, cache: Dict[str, Any]):
    """Local reference → media-registry URL, or None to leave it alone.

    ``cache`` memoizes per document so a still used in six tiles costs
    one registration, and a miss is remembered as a miss (``None``)
    rather than retried per occurrence.
    """
    ref = (raw or "").strip()
    if not ref or ref.lower().startswith(_ABSOLUTE_SRC):
        return None
    if ref in cache:
        return cache[ref]
    target = Path(ref[7:] if ref.lower().startswith("file://") else ref)
    if not target.is_absolute():
        target = doc_path.parent / target
    try:
        target = target.resolve()
    except Exception:
        cache[ref] = None
        return None
    if not target.is_file():
        logger.warning("[parley-doc] asset not found: %s (from %r)", target, ref)
        cache[ref] = None
        return None
    url = _register_media_sync(target)
    cache[ref] = url or None
    return cache[ref]


def _rewrite_local_assets(html: str, doc_path: Path) -> tuple:
    """Point every local asset reference at the media registry.

    Covers ``<img src>`` and CSS ``url(...)`` — the latter in both
    ``<style>`` blocks and inline ``style=""`` attributes, since one
    regex over the whole document catches both. Returns
    ``(html, rewritten, skipped)``; anything unresolvable or
    unregisterable is left exactly as it was.
    """
    rewritten = 0
    skipped = 0
    cache: Dict[str, Any] = {}

    def _count(url) -> None:
        nonlocal rewritten, skipped
        if url:
            rewritten += 1
        else:
            skipped += 1

    def _sub_img(m):
        head, quote, src = m.group(1), m.group(2), m.group(3)
        if not (src or "").strip() or (src or "").strip().lower().startswith(_ABSOLUTE_SRC):
            return m.group(0)
        url = _resolve_ref(src, doc_path, cache)
        _count(url)
        return f"{head}{quote}{url}{quote}" if url else m.group(0)

    def _sub_url(m):
        quote, ref = m.group(2), m.group(3)
        if not (ref or "").strip() or (ref or "").strip().lower().startswith(_ABSOLUTE_SRC):
            return m.group(0)
        url = _resolve_ref(ref, doc_path, cache)
        _count(url)
        # PRESERVE the original quoting, including "none". Emitting a
        # double quote for a bare `url(x)` inside an inline
        # style="…" attribute terminates the attribute early and the
        # rule silently dies — caught by rendering, not by review, on
        # 2026-09-04. A registry URL is bare-safe (hex id + extension),
        # so the source's own choice is always the safe one.
        return f"{m.group(1)}{quote}{url}{quote})" if url else m.group(0)

    out = _IMG_SRC_RE.sub(_sub_img, html)
    out = _CSS_URL_RE.sub(_sub_url, out)
    return out, rewritten, skipped


# Back-compat alias: the earlier name shipped one commit ago.
_rewrite_local_images = _rewrite_local_assets

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
        if fmt == "html":
            low = content.lower()
            if "<img" in low or "url(" in low:
                content, _rw, _sk = _rewrite_local_assets(content, path)
                if _rw or _sk:
                    logger.info(
                        "[parley-doc] rewrote %d local asset ref(s) to media "
                        "URLs (%d left as-is) in %s", _rw, _sk, path,
                    )
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
