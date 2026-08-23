"""Unit tests for native-image passthrough in ``_parallel_image_enrich``.

Field report (2026-06-17): a sent message containing images showed up in
the conversation as a long plaintext image extraction, even though
``agent.image_input_mode: native`` was configured and the active model
(GPT-5.5) takes images natively. Root cause: the parley plugin's
``_parallel_image_enrich`` ran UNCONDITIONALLY — it pre-analyzed each
image via ``vision_analyze`` into a ``[The user sent an image~ …]`` text
blob and stripped the image entries out of ``media_urls`` before the
gateway saw them, so the gateway's native-image path never fired and the
primary model received text-only.

The fix gates the enrich on the image-input mode (mirroring the gateway's
own ``_decide_image_input_mode``): in ``native`` mode the images are left
untouched in ``media_urls`` for the gateway to attach as native pixels; in
``text`` mode the parallel pre-analysis still runs (its reason for being:
avoid N×serial vision calls on a multi-page PDF).

The loader/stub scaffolding mirrors ``test_pdf_rasterize.py`` so the test
runs without a hermes-agent install on PYTHONPATH.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
import types
from pathlib import Path

import pytest


# ── plugin loader (mirrors test_pdf_rasterize.py) ─────────────────────

def _install_hermes_stubs() -> None:
    if "gateway" not in sys.modules:
        sys.modules["gateway"] = types.ModuleType("gateway")

    if "gateway.config" not in sys.modules:
        cfg = types.ModuleType("gateway.config")

        class _Platform:
            PARLEY = "parley"

        class _PlatformConfig:
            pass

        cfg.Platform = _Platform
        cfg.PlatformConfig = _PlatformConfig
        sys.modules["gateway.config"] = cfg

    if "gateway.platforms" not in sys.modules:
        sys.modules["gateway.platforms"] = types.ModuleType("gateway.platforms")

    if "gateway.platforms.base" not in sys.modules:
        base = types.ModuleType("gateway.platforms.base")

        class _BasePlatformAdapter:
            pass

        class _MessageEvent:
            pass

        class _MessageType:
            TEXT = "text"
            PHOTO = "photo"
            VIDEO = "video"
            AUDIO = "audio"
            DOCUMENT = "document"

        class _SendResult:
            pass

        base.BasePlatformAdapter = _BasePlatformAdapter
        base.MessageEvent = _MessageEvent
        base.MessageType = _MessageType
        base.SendResult = _SendResult
        sys.modules["gateway.platforms.base"] = base


def _load_plugin():
    _install_hermes_stubs()
    plugin_pkg = Path(__file__).resolve().parents[1]
    parent_dir = str(plugin_pkg.parent)
    if parent_dir not in sys.path:
        sys.path.insert(0, parent_dir)
    return importlib.import_module(plugin_pkg.name)


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


# ── runtime stubs for the image-routing decision + vision tool ────────
# ``_parallel_image_enrich`` (and the mode helper it calls) imports these
# hermes-internal modules lazily at call time, so we inject fakes into
# sys.modules right before invoking it.

def _stub_runtime(monkeypatch, *, mode: str, vision_analysis: str = "a tabby cat") -> None:
    # agent.image_routing.decide_image_input_mode → fixed mode
    image_routing = types.ModuleType("agent.image_routing")
    image_routing.decide_image_input_mode = lambda provider, model, cfg: mode

    # agent.auxiliary_client._read_main_provider / _read_main_model
    aux = types.ModuleType("agent.auxiliary_client")
    aux._read_main_provider = lambda: "openai-codex"
    aux._read_main_model = lambda: "gpt-5.5"

    agent_pkg = sys.modules.get("agent") or types.ModuleType("agent")

    # hermes_cli.config.load_config
    hermes_cli = sys.modules.get("hermes_cli") or types.ModuleType("hermes_cli")
    hermes_cfg = types.ModuleType("hermes_cli.config")
    hermes_cfg.load_config = lambda: {"agent": {"image_input_mode": mode}}

    # tools.vision_tools.vision_analyze_tool (async) — only the text path
    # should ever reach this; in native mode we assert it is NOT called.
    tools_pkg = sys.modules.get("tools") or types.ModuleType("tools")
    vision = types.ModuleType("tools.vision_tools")

    async def _fake_vision(image_url: str, user_prompt: str, *a, **kw) -> str:
        _fake_vision.calls.append(image_url)
        return json.dumps({"success": True, "analysis": vision_analysis})

    _fake_vision.calls = []  # type: ignore[attr-defined]
    vision.vision_analyze_tool = _fake_vision

    monkeypatch.setitem(sys.modules, "agent", agent_pkg)
    monkeypatch.setitem(sys.modules, "agent.image_routing", image_routing)
    monkeypatch.setitem(sys.modules, "agent.auxiliary_client", aux)
    monkeypatch.setitem(sys.modules, "hermes_cli", hermes_cli)
    monkeypatch.setitem(sys.modules, "hermes_cli.config", hermes_cfg)
    monkeypatch.setitem(sys.modules, "tools", tools_pkg)
    monkeypatch.setitem(sys.modules, "tools.vision_tools", vision)

    return _fake_vision


# ── the failing-first test: native mode must NOT strip/enrich ─────────

def test_native_mode_leaves_images_untouched(plugin, monkeypatch):
    """With image_input_mode == native, the images stay in media_urls and
    the text is NOT replaced with a pre-analysis blob — so the gateway's
    native-image path can attach the pixels to the primary model."""
    fake_vision = _stub_runtime(monkeypatch, mode="native")
    Adapter = plugin.ParleyAdapter

    text, urls, types_out, mtype = asyncio.run(
        Adapter._parallel_image_enrich(
            Adapter,  # acts as `self`; only static helpers are touched
            "look at this screenshot",
            ["/tmp/a.png", "/tmp/b.png"],
            ["image/png", "image/png"],
            plugin.MessageType.PHOTO,
        )
    )

    # Images survive for the gateway to attach natively.
    assert urls == ["/tmp/a.png", "/tmp/b.png"]
    assert types_out == ["image/png", "image/png"]
    assert mtype == plugin.MessageType.PHOTO
    # Text is the user's, untouched — no pre-analysis blob injected.
    assert text == "look at this screenshot"
    assert "[The user sent an image" not in text
    # The aux vision LLM must never be called in native mode.
    assert fake_vision.calls == []


# ── regression guard: text mode still pre-analyzes + strips ───────────

def test_text_mode_still_enriches_and_strips(plugin, monkeypatch):
    """With image_input_mode == text, the existing behavior is preserved:
    each image is pre-analyzed and stripped from media_urls (so the
    gateway's serial vision loop doesn't re-process a multi-page PDF)."""
    fake_vision = _stub_runtime(monkeypatch, mode="text", vision_analysis="a tabby cat")
    Adapter = plugin.ParleyAdapter

    text, urls, types_out, mtype = asyncio.run(
        Adapter._parallel_image_enrich(
            Adapter,
            "look at this screenshot",
            ["/tmp/a.png"],
            ["image/png"],
            plugin.MessageType.PHOTO,
        )
    )

    # Image stripped out so the gateway doesn't re-enrich it.
    assert urls == []
    assert types_out == []
    # Pre-analysis blob prepended to the user's text.
    assert "[The user sent an image" in text
    assert "a tabby cat" in text
    assert text.endswith("look at this screenshot")
    assert fake_vision.calls == ["/tmp/a.png"]
