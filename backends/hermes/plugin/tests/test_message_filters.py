"""parley_message_filters — the one decision point for notice lines
(2026-11-19). Samples are the field's own lines."""
from __future__ import annotations

import asyncio
import importlib
import os
import sys

import pytest

from .. import parley_message_filters as mf
from .. import parley_state as state
from ..parley_db import ParleyDB

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_user_message_broadcast import _load_plugin, _make_adapter  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_rules():
    mf._reset_for_tests()
    mf.set_user_patterns([])
    yield
    mf._reset_for_tests()


RECALL = [
    "👁️ Hindsight — recalled 55 memories",
    "🧠 Provider — recalled 1 memory",
    "🧠 Built-in — recalled relevant memory",
    "👁️ Hindsight — recalled 3 memories  🧠 Files — recalled 2 memories",
]
REVIEW = [
    "💾 Self-improvement review: Skill 'notion' patched · Skill 'notion' patched (references/meeting-transcript-subdocs.md)",
    "💾 Skill 'r2-raise' patched.",
]
PULSE = [
    "⏳ Working — 3 min — iteration 4/60, terminal",
    "⏳ Still working… (3 min elapsed — iteration 4/60, tool)",
    "⏳ Another Hermes process is using this session; waiting for it to finish before starting your turn...",
    "⏳ Still waiting for the other Hermes process on this session (435s)...",
]
CONVERSATION = [
    "I recalled the meeting with LocalGlobe — here are the notes.",
    "Memory updated: nothing to do with 💾 budgets.",
    "⚡ Interrupting current task (14 min elapsed, iteration 0/60). I'll respond to your message shortly.",
    "⚠️ I seem to be stuck (no activity for 15 min).",
    "Here are 55 memories of the trip.",
    "",
]


def test_builtin_hide_rules_match_the_field_lines_only():
    for t in RECALL:
        assert mf.classify(t, "assistant") == "hide", t
        assert mf.match(t).id == "memory-recall", t
    for t in REVIEW:
        assert mf.classify(t, "assistant") == "hide", t
        assert mf.match(t).id == "self-improvement-review", t
    for t in PULSE:
        assert mf.classify(t, "assistant") == "pulse", t
    for t in CONVERSATION:
        assert mf.classify(t, "assistant") == "show", t
    # Role matters: a USER row that looks like a recall line is the user's own words.
    assert mf.classify(RECALL[0], "user") == "show"
    assert mf.is_hidden("[OUT-OF-BAND USER MESSAGE — …]\nhello", "user")
    assert not mf.is_hidden("[OUT-OF-BAND USER MESSAGE — …]\nhello", "assistant")


def test_non_conversational_metadata_hides_without_a_pattern():
    assert mf.classify("♻️ Gateway restarted successfully", "assistant", {"non_conversational": True}) == "hide"
    assert mf.classify("♻️ Gateway restarted successfully", "assistant", {}) == "show"


def test_user_patterns_hide_assistant_lines_and_are_validated():
    mf.set_user_patterns(["^📦 Pre-API compression", "nightly digest"])
    assert mf.classify("📦 Pre-API compression: 40k → 12k tokens", "assistant") == "hide"
    assert mf.classify("Your NIGHTLY DIGEST is ready", "assistant") == "hide", "case-insensitive, anywhere"
    assert mf.classify("Your NIGHTLY DIGEST is ready", "user") == "show", "user rules never touch the user's rows"
    assert mf.user_patterns() == ["^📦 Pre-API compression", "nightly digest"]
    with pytest.raises(mf.PatternError, match="not a valid regular expression"):
        mf.set_user_patterns(["("])
    with pytest.raises(mf.PatternError, match="matches every message"):
        mf.set_user_patterns([".*"])
    with pytest.raises(mf.PatternError, match="must be strings"):
        mf.set_user_patterns([3])
    # A failed set leaves the previous rules in place.
    assert mf.user_patterns() == ["^📦 Pre-API compression", "nightly digest"]


def test_send_drops_a_hidden_line_before_any_envelope():
    plugin = _load_plugin()
    adapter = _make_adapter(plugin)
    adapter._turn_buffer = None
    sent = []

    async def capture(env):
        sent.append(dict(env))
        return True
    adapter._safe_send_envelope = capture
    res = asyncio.run(adapter.send("c1", "👁️ Hindsight — recalled 55 memories", metadata={"_interim_send": True}))
    assert res.success and res.message_id
    assert sent == [], "a hidden line produces no envelope at all (no bubble, no push, no badge)"
    res = asyncio.run(adapter.send("c1", "💾 Self-improvement review: Skill 'notion' patched", metadata={"_interim_send": True}))
    assert sent == []
    # A real reply still flows.
    asyncio.run(adapter.send("c1", "Here is the summary.", metadata=None))
    assert [e["type"] for e in sent] == ["reply_delta", "reply_final"]


def test_read_paths_hide_filtered_assistant_rows(tmp_path):
    db = ParleyDB(tmp_path / "parley.db")
    try:
        chat = "c-filter"
        recall = {"id": 1, "role": "assistant", "content": "👁️ Hindsight — recalled 12 memories", "timestamp": 1.0,
                  "tool_name": None, "tool_call_id": None, "tool_calls": None}
        assert state.insert_legacy_twin(db, chat, recall) is False, "the importer refuses a filtered line"
        assert state.insert_legacy_twin(db, chat, dict(recall, id=2, content="A real answer", timestamp=2.0)) is True
        mf.set_user_patterns(["^📦"])
        # A line that landed before the rule existed is hidden on read.
        state.upsert_msg_link(db, id="msg_3", chat_id=chat, role="assistant", content="📦 Pre-API compression", status="final")
        state.upsert_msg_link(db, id="msg_4", chat_id=chat, role="assistant", content="Still here", status="final")
        page = state.list_messages_for_chat(db, chat, limit=200)
        assert [it["content"] for it in page["items"]] == ["A real answer", "Still here"]
    finally:
        db.close()
