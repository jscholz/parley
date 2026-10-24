"""Plain-text uploads (2026-10-24): inlined as a fenced block in the turn,
persisted durably, never handed to the media pipeline; and the
cross-device user_message broadcast names every file."""
from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from test_user_id_queries import _load_plugin  # noqa: E402

from .. import parley_text_ingest as ti
from .. import parley_user_uploads as uu


def test_classification_by_mime_then_extension():
    assert ti.is_text_attachment("text/plain", "notes.txt")
    assert ti.is_text_attachment("", "notes.md"), "browsers often send no MIME for .md"
    assert ti.is_text_attachment("video/mp2t", "recorder.ts"), "TypeScript mislabeled as MPEG-TS"
    assert ti.is_text_attachment("application/json", "data.json")
    assert ti.is_text_attachment("application/octet-stream", "Dockerfile")
    assert not ti.is_text_attachment("application/pdf", "x.pdf")
    assert not ti.is_text_attachment("image/png", "x.png")
    assert not ti.is_text_attachment("application/zip", "x.zip")
    assert not ti.is_text_attachment("", "archive.bin")
    assert ti.normalized_mime("", "notes.md") == "text/markdown"
    assert ti.normalized_mime("video/mp2t", "a.ts") == "text/plain"
    assert ti.normalized_mime("text/x-python", "a.py") == "text/x-python"


def test_text_block_is_fenced_safely_and_budgeted():
    md = "# Title\n\n```js\nconsole.log(1)\n```\nmore\n"
    block = ti.text_block("notes.md", md, len(md.encode()), "/x/0-notes.md")
    assert block.startswith("[File attached: notes.md — 6 lines, ")
    assert "Saved at: /x/0-notes.md]" in block
    assert block.endswith("[end of file: notes.md]")
    # Our fence must be longer than the content's own ``` run.
    assert "\n````md\n" in block and block.count("````") == 2
    big = "x" * 1000
    small = ti.text_block("big.log", big, 1000, None, max_chars=100)
    assert "[File note: big.log is 1000 B — only the first 100 characters are inlined" in small
    assert small.count("x") == 100


def test_materialize_inlines_text_and_sends_no_media(tmp_path, monkeypatch):
    plugin = _load_plugin()
    monkeypatch.setenv("PARLEY_HOME", str(tmp_path / "home"))
    Adapter = plugin.ParleyAdapter
    out: list = []
    body = "hello\nworld\n".encode()
    paths, mimes, _ = Adapter._materialize_attachments(
        Adapter,
        [{"type": "file", "mimeType": "", "fileName": "notes.md",
          "content": "data:application/octet-stream;base64," + base64.b64encode(body).decode()}],
        text_out=out,
    )
    assert paths == [] and mimes == [], "text is not media"
    assert len(out) == 1 and out[0].startswith("[File attached: notes.md — 2 lines")
    assert "hello\nworld" in out[0] and out[0].endswith("[end of file: notes.md]")


def test_attachment_meta_matches_durable_urls():
    meta = uu.attachment_meta([
        {"type": "image", "mimeType": "application/pdf", "fileName": "Statement.pdf",
         "content": "data:application/pdf;base64," + base64.b64encode(b"%PDF-1.4 tiny").decode()},
        "garbage",
        {"type": "file", "mimeType": "text/markdown", "fileName": "notes.md", "uploadId": "up_1", "size": 777},
    ], "umsg_abc")
    assert [m["idx"] for m in meta] == [0, 1]
    assert meta[0]["url"] == "/api/parley/uploads/umsg_abc/0" and meta[0]["size"] == len(b"%PDF-1.4 tiny")
    assert meta[1] == {"idx": 1, "fileName": "notes.md", "mimeType": "text/markdown", "size": 777,
                       "url": "/api/parley/uploads/umsg_abc/1"}
    assert uu.attachment_meta(None, "umsg_abc") == [] and uu.attachment_meta([{}], "") == []
