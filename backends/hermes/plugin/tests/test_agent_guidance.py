"""The plugin teaches the agent how to use Parley (2026-10-11): a bounded
system-prompt section registered on load, plus the shipped skills dir."""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_user_id_queries import _load_plugin  # noqa: E402


@pytest.fixture(scope="module")
def guidance():
    import importlib
    plugin = _load_plugin()
    return importlib.import_module(f"{plugin.__name__}.parley_agent_guidance")


def test_section_is_bounded_and_covers_every_lane(guidance, monkeypatch):
    monkeypatch.setenv("PARLEY_PROXY_ORIGIN", "http://127.0.0.1:4001")
    text = guidance.render_section({})
    assert len(text) <= guidance.SECTION_MAX_CHARS
    assert "PARLEY_PROXY_ORIGIN=http://127.0.0.1:4001" in text
    assert f"PARLEY_SKILLS_DIR={guidance.SKILLS_DIR}" in text
    for must in ("[voice]", "display_doc", "/api/parley/media/register",
                 "/api/parley/attachments/register", "canvas.mjs",
                 "meeting-transcript-ingest", "parley-pdf-rasterize"):
        assert must in text, must
    # the curl examples carry the install's origin, never the single-tenant default
    assert "127.0.0.1:3001" not in text


def test_proxy_origin_precedence(guidance, monkeypatch):
    for k in ("PARLEY_PROXY_ORIGIN", "SIDECLAW_URL", "PORT"):
        monkeypatch.delenv(k, raising=False)
    assert guidance.proxy_origin() == "http://127.0.0.1:3001"
    monkeypatch.setenv("PORT", "4001")
    assert guidance.proxy_origin() == "http://127.0.0.1:4001"
    monkeypatch.setenv("SIDECLAW_URL", "http://127.0.0.1:5001/")
    assert guidance.proxy_origin() == "http://127.0.0.1:5001"
    monkeypatch.setenv("PARLEY_PROXY_ORIGIN", "https://galatea.example:4001")
    assert guidance.proxy_origin() == "https://galatea.example:4001"


def test_register_uses_the_hermes_hook_and_tolerates_its_absence(guidance):
    calls = []

    class Ctx:
        def register_system_prompt_section(self, id, content, *, position, max_chars):
            calls.append((id, callable(content), position, max_chars))

    assert guidance.register_agent_guidance(Ctx()) is True
    assert calls == [("parley", True, "after_memory", guidance.SECTION_MAX_CHARS)]
    assert guidance.register_agent_guidance(object()) is False   # older hermes: silent no-op


def test_shipped_skills_are_well_formed_and_owner_agnostic(guidance):
    for name in guidance.SKILL_NAMES:
        md = guidance.SKILLS_DIR / name / "SKILL.md"
        assert md.exists(), md
        head = md.read_text().split("---")[1]
        assert re.search(rf"^name:\s*{re.escape(name)}\s*$", head, re.M), name
        assert re.search(r"^description:\s*\S", head, re.M), name
    for f in guidance.SKILLS_DIR.rglob("*"):
        if f.is_file() and f.suffix in (".md", ".mjs", ".py"):
            body = f.read_text(errors="ignore")
            assert not re.search(r"jscholz|/home/jonathan|Jonathan's|raise-ops|#raise", body), f
