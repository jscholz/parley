"""Unit tests for ``_decode_multimodal_content``.

Field report (2026-09-04, chat [pitch deck]): Jonathan uploaded two PDF
decks in one turn. Parley rasterizes a PDF to one PNG per page, so the
two decks became 71 images, and hermes-core stored that turn as a
NUL-sentinel-prefixed JSON content-parts array with every page inlined
as base64 — a single 12.8 MB user message row. hermes then re-persisted
that whole row on EVERY agent iteration of the long turn: six copies,
76.8 MB, in eight minutes and still growing while the turn ran.

Parley's read paths served the blob verbatim, so the PWA tried to render
12.8 MB of JSON into one chat bubble and locked the browser. Killing and
reopening the app recovered it only until the transcript reloaded the
same rows.

Two properties of the bug made it hard to see, and both are pinned here:

  * The sentinel is a NUL byte, and sqlite's ``length()`` stops at the
    first NUL. Every one of those 12.8 MB rows reports length 0, so a
    SQL-side size audit reads them as *empty messages*. Only python
    ``len()`` sees the truth.
  * The decode must be lossy in exactly one direction: keep all the
    text, drop the image payloads. The user's actual question was 6430
    characters buried inside 12.8 MB of base64.

Anything unparseable degrades to the raw string minus the sentinel
rather than vanishing — a transcript row we do not understand should
still render, not disappear.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest


def _load():
    plugin_pkg = Path(__file__).resolve().parents[1]
    parent_dir = str(plugin_pkg.parent)
    if parent_dir not in sys.path:
        sys.path.insert(0, parent_dir)
    return importlib.import_module(f"{plugin_pkg.name}.parley_state")


@pytest.fixture(scope="module")
def state():
    return _load()


def _blob(parts):
    return "\x00json:" + json.dumps(parts)


# ── the regression ───────────────────────────────────────────────────

def test_pdf_upload_blob_reduces_to_its_text(state):
    """The shape that locked the browser: one text part, N image parts."""
    parts = [{"type": "text", "text": "Okay. I'm trying to finish this slide deck."}]
    parts += [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + "A" * 4000}}
        for _ in range(71)
    ]
    raw = _blob(parts)
    assert len(raw) > 280_000          # the real one was 12.8 MB

    out = state._decode_multimodal_content(raw)

    assert out.startswith("Okay. I'm trying to finish this slide deck.")
    assert "[71 images]" in out
    assert "base64" not in out          # no payload survives
    assert "AAAA" not in out
    assert len(out) < 200               # 4 orders of magnitude smaller


def test_sqlite_length_hides_the_blob_but_python_does_not(state):
    """Why this went unnoticed: the NUL sentinel defeats SQL size audits.

    Not a test of our code so much as a guard on the investigation
    technique — if someone later 'optimizes' the sentinel away, the
    audit story changes with it.
    """
    raw = _blob([{"type": "text", "text": "hi"}])
    assert raw[0] == "\x00"
    assert len(raw) > 20
    # sqlite semantics: length() counts up to the first NUL → 0 here.
    assert raw.split("\x00")[0] == ""


def test_single_image_marker_is_singular(state):
    out = state._decode_multimodal_content(
        _blob([{"type": "text", "text": "look"}, {"type": "image_url", "image_url": {}}])
    )
    assert "[1 image]" in out and "[1 images]" not in out


def test_multiple_text_parts_are_joined_in_order(state):
    out = state._decode_multimodal_content(
        _blob([
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"},
        ])
    )
    assert out == "first\nsecond"


def test_image_only_turn_renders_the_marker_alone(state):
    out = state._decode_multimodal_content(
        _blob([{"type": "image_url", "image_url": {}} for _ in range(3)])
    )
    assert out == "[3 images]"


# ── pass-through and graceful degradation ────────────────────────────

def test_plain_strings_are_untouched(state):
    for s in ("hello", "", "[CONTEXT COMPACTION — ...]", "json:not-prefixed"):
        assert state._decode_multimodal_content(s) == s


def test_none_becomes_empty_string(state):
    assert state._decode_multimodal_content(None) == ""


def test_unparseable_payload_degrades_to_raw_not_empty(state):
    """A shape we do not understand must still render."""
    out = state._decode_multimodal_content("\x00json:{not valid json")
    assert out == "{not valid json"


def test_non_list_payload_degrades_to_raw(state):
    out = state._decode_multimodal_content('\x00json:{"type":"text"}')
    assert out == '{"type":"text"}'


def test_unknown_part_shapes_are_counted_not_dropped_silently(state):
    """A part that is neither text nor a known media shape still gets
    represented, so the bubble never implies the turn was empty."""
    out = state._decode_multimodal_content(
        _blob([{"type": "input_audio", "audio": {"data": "zzz"}}])
    )
    assert out == "[1 image]"


def test_compaction_seed_check_must_run_on_raw_content(state):
    """Ordering guard for _build_v3_items: decoding first would strip the
    sentinel and could expose a seed prefix that the raw check owns."""
    seed = "[PRIOR CONTEXT — for reference only; not a new message]\nbody"
    assert state._is_compaction_seed(seed)
    assert not state._is_compaction_seed(_blob([{"type": "text", "text": seed}]))
