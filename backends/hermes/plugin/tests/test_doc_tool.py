"""display_doc tool — reads a file server-side and ships a doc_show
envelope to the PWA's Docs panel (parley_doc_tool.py).

The handler is a plain sync tool callable; these tests exercise it with a
fake adapter capturing envelopes. Registration against hermes'
tools.registry is deliberately NOT exercised here — it's guarded
best-effort wiring whose failure mode is "tool absent", covered by the
separation contract in the module docstring.
"""

from __future__ import annotations

import json

import pytest

from .. import parley_doc_tool as doc_tool


class FakeAdapter:
    def __init__(self):
        self.envelopes = []

    def _schedule_envelope(self, env):
        self.envelopes.append(env)


@pytest.fixture
def adapter():
    return FakeAdapter()


@pytest.fixture
def handler(adapter):
    return doc_tool._make_display_doc_handler(lambda: adapter)


def test_display_doc_reads_file_and_emits_envelope(tmp_path, monkeypatch, adapter, handler):
    f = tmp_path / "deck-notes.md"
    f.write_text("# Raise\n\nSeed **now**.\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_SESSION_CHAT_ID", "chat-123")

    out = json.loads(handler({"path": str(f)}))

    assert out.get("success") is True
    assert len(adapter.envelopes) == 1
    env = adapter.envelopes[0]
    assert env["type"] == "doc_show"
    assert env["chat_id"] == "chat-123"
    assert env["format"] == "markdown"
    assert env["title"] == "deck-notes.md"
    assert "Seed **now**" in env["content"]
    assert env["path"] == str(f)


def test_display_doc_envelope_carries_server_display_time(tmp_path, monkeypatch, adapter, handler):
    """displayed_at (server epoch ms) is THE clock the PWA shows — one
    server value keeps the '26s ago' meta constant across devices, and
    the SSE ring replays the envelope verbatim so a boot/reconnect
    replay can't reset it to 0s (field bug 2026-07-08)."""
    import time as _time

    f = tmp_path / "report.md"
    f.write_text("# R\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_SESSION_CHAT_ID", "chat-123")

    before = int(_time.time() * 1000)
    json.loads(handler({"path": str(f)}))
    after = int(_time.time() * 1000)

    env = adapter.envelopes[0]
    assert isinstance(env["displayed_at"], int)
    assert before <= env["displayed_at"] <= after


def test_display_doc_format_detection(tmp_path, monkeypatch, adapter, handler):
    monkeypatch.setenv("HERMES_SESSION_CHAT_ID", "chat-123")
    cases = {
        "page.html": "html",
        "notes.txt": "text",
        "script.py": "text",
    }
    for name, expected in cases.items():
        f = tmp_path / name
        f.write_text("content", encoding="utf-8")
        out = json.loads(handler({"path": str(f), "title": "T"}))
        assert out.get("success") is True, out
        assert adapter.envelopes[-1]["format"] == expected, name
        assert adapter.envelopes[-1]["title"] == "T"


def test_display_doc_caps_size_without_emitting(tmp_path, monkeypatch, adapter, handler):
    f = tmp_path / "huge.md"
    f.write_text("x" * 4096, encoding="utf-8")
    monkeypatch.setenv("HERMES_SESSION_CHAT_ID", "chat-123")
    monkeypatch.setattr(doc_tool, "MAX_DOC_BYTES", 1024)

    out = json.loads(handler({"path": str(f)}))

    assert "error" in out
    assert "1024" in out["error"], "error must tell the agent the cap so it can recover"
    assert adapter.envelopes == []


def test_display_doc_requires_parley_chat_context(tmp_path, monkeypatch, adapter, handler):
    f = tmp_path / "doc.md"
    f.write_text("hi", encoding="utf-8")
    monkeypatch.delenv("HERMES_SESSION_CHAT_ID", raising=False)

    out = json.loads(handler({"path": str(f)}))

    assert "error" in out
    assert adapter.envelopes == []


def test_display_doc_missing_file_errors_cleanly(monkeypatch, adapter, handler):
    monkeypatch.setenv("HERMES_SESSION_CHAT_ID", "chat-123")
    out = json.loads(handler({"path": "/nonexistent/nope.md"}))
    assert "error" in out
    assert adapter.envelopes == []


def test_display_doc_registers_under_bare_platform_toolset(monkeypatch):
    """Regression: toolset MUST be the bare platform name "parley".

    Registering under "hermes-parley" (v1, 2026-07-04) created a real
    registry toolset with that name, which SHADOWS hermes' auto-generated
    ``hermes-<platform>`` composite (``_HERMES_CORE_TOOLS`` + platform
    tools) in ``toolsets.resolve_toolset`` — silently stripping file/
    terminal/web/every core tool from ALL parley sessions. Field
    regression 2026-07-07: agent lost filesystem access mid-workflow.
    """
    import sys
    import types

    calls = {}

    class FakeRegistry:
        def register(self, **kwargs):
            calls.update(kwargs)

    fake_mod = types.ModuleType("tools.registry")
    fake_mod.registry = FakeRegistry()
    fake_pkg = types.ModuleType("tools")
    fake_pkg.registry = fake_mod
    monkeypatch.setitem(sys.modules, "tools", fake_pkg)
    monkeypatch.setitem(sys.modules, "tools.registry", fake_mod)

    assert doc_tool.register_display_doc_tool(lambda: None) is True
    assert calls["name"] == "display_doc"
    assert calls["toolset"] == "parley", (
        "toolset must be the bare platform name; a literal 'hermes-parley' "
        "registry toolset shadows the core-tools composite and strips "
        "filesystem/terminal tools from every parley session"
    )


def test_doc_id_mirrors_pwa_djb2():
    """doc_id keys the PWA shelf — the Python hash MUST match
    docStore.docIdFor (djb2, hex). Pinned vector cross-checked against
    the TS implementation."""
    assert doc_tool._doc_id_for("/home/user/deck.md", "Deck") == "a4988a70"
    # Title fallback normalizes case.
    assert doc_tool._doc_id_for("", "Same Title") == doc_tool._doc_id_for("", "same title")


def test_display_doc_result_carries_doc_id_and_open_docs(tmp_path, monkeypatch, adapter, handler):
    monkeypatch.setenv("HERMES_SESSION_CHAT_ID", "chat-shelf")
    doc_tool._OPEN_DOCS.clear()

    a = tmp_path / "a.md"; a.write_text("# A", encoding="utf-8")
    b = tmp_path / "b.md"; b.write_text("# B", encoding="utf-8")

    out_a = json.loads(handler({"path": str(a), "title": "Doc A"}))
    assert out_a["doc_id"] == doc_tool._doc_id_for(str(a), "Doc A")
    assert out_a["open_docs"] == ["Doc A"]

    out_b = json.loads(handler({"path": str(b), "title": "Doc B"}))
    assert out_b["open_docs"] == ["Doc B", "Doc A"], "newest first"

    # Re-push of A refreshes, never duplicates — mirrors the shelf rule.
    out_a2 = json.loads(handler({"path": str(a), "title": "Doc A"}))
    assert out_a2["open_docs"] == ["Doc A", "Doc B"]
    assert adapter.envelopes[-1]["doc_id"] == out_a2["doc_id"]
