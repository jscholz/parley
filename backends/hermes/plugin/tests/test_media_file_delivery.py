"""Unit tests for native file delivery (``send_image_file`` / ``send_document``).

Field report (2026-09-01): Jonathan asked for a diagram for slide 4 of the
raise deck. The agent produced three assets and referenced them with
``MEDIA:/abs/path`` — hermes' universal attachment convention, which works
on telegram/whatsapp/slack/matrix because those adapters implement native
file upload. Parley did not: it implemented only ``send``, ``send_typing``
and ``send_image`` (which takes a *URL*, not a path). All three assets fell
through to ``BasePlatformAdapter``'s fallback, which by design refuses to
echo host paths into chat, so the user got three "⚠️ Couldn't deliver"
notices and no diagram. The files were fine on disk; only delivery failed.

The fix implements both methods by registering the local file with the
parley proxy's media registry (``proxy/parley/media.ts``, whose contract
names "hermes plugin session" as a first-class caller) and reusing the
existing image envelope / plain reply text. No new envelope on the wire.

What these tests pin, in order of how much they cost when broken:

  1. A registrable image is DELIVERED — never the fallback notice. This is
     the regression that lost the deck assets.
  2. Every failure mode degrades to the base notice and NEVER raises:
     registry refusal (documents are refused on purpose — the media lane
     is not a general file server), proxy unreachable (a split-host
     deployment must behave as it did before), and a path the delivery
     guard rejects.
  3. The guard runs BEFORE any network call, so a bad path cannot leak
     into an outbound request.

The loader/stub scaffolding mirrors ``test_image_native_passthrough.py``
so the test runs without a hermes-agent install on PYTHONPATH.
"""

from __future__ import annotations

import asyncio
import importlib
import sys
import types
from pathlib import Path

import pytest


# ── plugin loader ────────────────────────────────────────────────────
# The root conftest already installs the gateway stubs (including the
# base adapter's media-delivery surface: the path guard plus the
# send_image_file / send_document fallbacks these tests assert we
# delegate to). Don't re-stub here — its guard is `not in sys.modules`,
# so a local copy would be silently ignored and drift.

def _load_plugin():
    plugin_pkg = Path(__file__).resolve().parents[1]
    parent_dir = str(plugin_pkg.parent)
    if parent_dir not in sys.path:
        sys.path.insert(0, parent_dir)
    return importlib.import_module(plugin_pkg.name)


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


# ── fake aiohttp ─────────────────────────────────────────────────────
# ``_register_media`` imports aiohttp lazily at call time (guarded, so a
# test env without the runtime install still loads), which lets us inject
# a fake into sys.modules per-test rather than hitting a real socket.

def _install_fake_aiohttp(monkeypatch, *, status=200, body=None, raises=None):
    posts = []

    class _Resp:
        def __init__(self):
            self.status = status

        async def json(self, content_type=None):
            return body

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    class _Session:
        def __init__(self, *a, **kw):
            pass

        def post(self, url, json=None):
            posts.append((url, json))
            if raises is not None:
                raise raises
            return _Resp()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    fake = types.ModuleType("aiohttp")
    fake.ClientSession = _Session
    fake.ClientTimeout = lambda **kw: None
    monkeypatch.setitem(sys.modules, "aiohttp", fake)
    return posts


def _adapter(plugin):
    """A ParleyAdapter with __init__ bypassed — these methods only need
    ``name`` plus whatever the test records."""
    a = object.__new__(plugin.ParleyAdapter)
    a.name = "Parley"
    a.fallbacks = []
    a.images = []
    a.sends = []

    async def _send_image(chat_id, image_url, caption=None, reply_to=None,
                          metadata=None):
        a.images.append((chat_id, image_url, caption))
        return sys.modules["gateway.platforms.base"].SendResult(success=True)

    async def _send(chat_id, content, reply_to=None, metadata=None):
        a.sends.append((chat_id, content))
        return sys.modules["gateway.platforms.base"].SendResult(success=True)

    a.send_image = _send_image
    a.send = _send
    return a


@pytest.fixture
def png(tmp_path):
    p = tmp_path / "loop.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    return str(p)


# ── 1. the regression: a registrable image is delivered ──────────────

def test_image_file_is_registered_and_delivered(plugin, monkeypatch, png):
    posts = _install_fake_aiohttp(
        monkeypatch, status=200,
        body={"id": "abc123", "url": "/api/parley/media/abc123.png",
              "mime": "image/png", "filename": "loop.png"},
    )
    a = _adapter(plugin)

    res = asyncio.run(a.send_image_file("chat1", png, caption="the loop"))

    assert res.success
    # Delivered through the existing image envelope, with the registry URL.
    assert a.images == [("chat1", "/api/parley/media/abc123.png", "the loop")]
    # And critically: the user did NOT get a "couldn't deliver" notice.
    assert a.fallbacks == []
    # Registered against the proxy, passing the resolved path.
    assert len(posts) == 1
    url, payload = posts[0]
    assert url.endswith("/api/parley/media/register")
    assert payload["path"].endswith("loop.png")


def test_document_that_is_media_rides_reply_text(plugin, monkeypatch, tmp_path):
    """An .mp4 routed as a document still gets through — as a markdown
    reference the client's card fallback parser classifies by extension."""
    mp4 = tmp_path / "clip.mp4"
    mp4.write_bytes(b"\x00" * 16)
    _install_fake_aiohttp(
        monkeypatch, status=200,
        body={"id": "d1", "url": "/api/parley/media/d1.mp4",
              "mime": "video/mp4", "filename": "clip.mp4"},
    )
    a = _adapter(plugin)

    res = asyncio.run(a.send_document("chat1", str(mp4), file_name="clip.mp4"))

    assert res.success
    assert a.sends == [("chat1", "![clip.mp4](/api/parley/media/d1.mp4)")]
    assert a.fallbacks == []


# ── 2. every failure degrades to the base notice, never raises ───────

def test_registry_refusal_falls_back(plugin, monkeypatch, tmp_path):
    """Documents (.svg/.pdf) are refused on purpose — the registry is a
    media lane, not a general file server, and SVG is scriptable."""
    svg = tmp_path / "loop.svg"
    svg.write_text("<svg/>")
    _install_fake_aiohttp(
        monkeypatch, status=415,
        body={"error": "unsupported extension (known: .mp4 .png …)"},
    )
    a = _adapter(plugin)

    res = asyncio.run(a.send_document("chat1", str(svg), file_name="loop.svg"))

    assert res.success                      # the notice was delivered
    assert a.fallbacks == [("document", str(svg))]
    assert a.sends == []                    # no bogus markdown reference


def test_proxy_unreachable_falls_back_without_raising(plugin, monkeypatch, png):
    """A split-host deployment whose proxy cannot be reached must behave
    exactly as it did before this change, not raise into the turn."""
    _install_fake_aiohttp(monkeypatch, raises=OSError("connection refused"))
    a = _adapter(plugin)

    res = asyncio.run(a.send_image_file("chat1", png))

    assert res.success
    assert a.fallbacks == [("image", png)]
    assert a.images == []


def test_malformed_registry_response_falls_back(plugin, monkeypatch, png):
    """HTTP 200 but no url — treat as refusal rather than KeyError."""
    _install_fake_aiohttp(monkeypatch, status=200, body={"id": "x"})
    a = _adapter(plugin)

    res = asyncio.run(a.send_image_file("chat1", png))

    assert res.success
    assert a.fallbacks == [("image", png)]
    assert a.images == []


# ── 3. the guard runs before any network call ────────────────────────

def test_rejected_path_never_reaches_the_network(plugin, monkeypatch, tmp_path):
    posts = _install_fake_aiohttp(monkeypatch, status=200, body={"url": "/nope"})
    a = _adapter(plugin)
    missing = str(tmp_path / "does-not-exist.png")

    res = asyncio.run(a.send_image_file("chat1", missing))

    assert res.success
    assert a.fallbacks == [("image", missing)]
    assert posts == []          # guard rejected it before the POST
    assert a.images == []


# ── proxy origin is configurable (the one new coupling) ──────────────

def test_proxy_origin_defaults_and_is_overridable(plugin, monkeypatch):
    a = _adapter(plugin)

    monkeypatch.delenv("PARLEY_PROXY_ORIGIN", raising=False)
    assert a._proxy_origin() == "http://127.0.0.1:3001"

    monkeypatch.setenv("PARLEY_PROXY_ORIGIN", "http://10.0.0.5:3001/")
    assert a._proxy_origin() == "http://10.0.0.5:3001"   # trailing / stripped
