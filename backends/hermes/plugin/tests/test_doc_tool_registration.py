"""display_doc must reach the session's toolset on every supported hermes:
register through ctx.register_tool (scoped, owner-tracked) when the
PluginContext offers it, else the registry directly (2026-10-11)."""
from __future__ import annotations
import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_user_id_queries import _load_plugin  # noqa: E402


@pytest.fixture(scope="module")
def doc_tool():
    import importlib
    plugin = _load_plugin()
    return importlib.import_module(f"{plugin.__name__}.parley_doc_tool")


def test_prefers_ctx_register_tool(doc_tool):
    calls = []
    class Ctx:
        def register_tool(self, **kw):
            calls.append(kw); return object()
    assert doc_tool.register_display_doc_tool(lambda: None, ctx=Ctx()) is True
    assert calls and calls[0]["name"] == "display_doc" and calls[0]["toolset"] == "parley"
    assert callable(calls[0]["handler"]) and callable(calls[0]["check_fn"])
    assert doc_tool.REGISTERED == {"display_doc": True, "via": "ctx.register_tool"}


def test_refused_registration_is_reported_not_hidden(doc_tool):
    class Ctx:
        def register_tool(self, **kw):
            return None   # hermes: "tried to shadow global tool without override"
    assert doc_tool.register_display_doc_tool(lambda: None, ctx=Ctx()) is False
    assert doc_tool.REGISTERED["display_doc"] is False


def test_ctx_without_register_tool_falls_back(doc_tool, monkeypatch):
    import types, sys as _sys
    reg_calls = []
    fake = types.ModuleType("tools.registry")
    class R:
        def register(self, **kw): reg_calls.append(kw)
    fake.registry = R()
    monkeypatch.setitem(_sys.modules, "tools.registry", fake)
    assert doc_tool.register_display_doc_tool(lambda: None, ctx=object()) is True
    assert reg_calls and reg_calls[0]["toolset"] == "parley"
    assert doc_tool.REGISTERED["via"] == "tools.registry"
