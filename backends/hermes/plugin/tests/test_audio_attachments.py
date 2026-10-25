"""Audio attachments (2026-10-25): a voice note is transcribed through the
proxy's batch STT and inlined as a fenced block; the file is kept; nothing
goes to media_urls; a failed transcription is an honest note."""
from __future__ import annotations

import base64
import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from test_user_id_queries import _load_plugin  # noqa: E402

from .. import parley_audio_ingest as ai


def test_classification_and_mime():
    assert ai.is_audio_attachment("audio/ogg", "note.ogg")
    assert ai.is_audio_attachment("application/ogg", "note.ogg")
    assert ai.is_audio_attachment("", "PTT-20261025-WA0001.opus")
    assert ai.is_audio_attachment("application/octet-stream", "memo.m4a")
    assert not ai.is_audio_attachment("video/mp4", "clip.mp4")
    assert not ai.is_audio_attachment("", "notes.md")
    assert ai.normalized_mime("", "x.opus") == "audio/ogg"
    assert ai.normalized_mime("application/ogg", "x.ogg") == "audio/ogg"
    assert ai.normalized_mime("audio/x-m4a", "x.m4a") == "audio/mp4"


class _Resp(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False


def test_transcribe_posts_bytes_and_reads_transcript(monkeypatch):
    seen = {}
    def fake_urlopen(req, timeout=0):
        seen["url"] = req.full_url; seen["ct"] = req.get_header("Content-type"); seen["len"] = len(req.data)
        return _Resp(json.dumps({"ok": True, "transcript": "  hello from whatsapp  "}).encode())
    monkeypatch.setattr(ai.urllib.request, "urlopen", fake_urlopen)
    out = ai.transcribe(b"OggS" * 10, "audio/ogg", origin="http://proxy.test")
    assert out == "hello from whatsapp"
    assert seen == {"url": "http://proxy.test/transcribe", "ct": "audio/ogg", "len": 40}


def test_transcribe_surfaces_the_proxys_soft_failure(monkeypatch):
    monkeypatch.setattr(ai.urllib.request, "urlopen",
                        lambda req, timeout=0: _Resp(json.dumps({"ok": False, "error": "bridge timeout"}).encode()))
    with pytest.raises(RuntimeError, match="bridge timeout"):
        ai.transcribe(b"x", "audio/ogg", origin="http://proxy.test")


def test_audio_block_shapes():
    ok = ai.audio_block("note.ogg", "we should move the demo", 12_345, "/x/0-note.ogg")
    assert ok.startswith("[Audio attached: note.ogg — 12.1 KB. Saved at: /x/0-note.ogg. Transcript follows.]")
    assert "\nwe should move the demo\n[end of audio: note.ogg]" in ok
    bad = ai.audio_block("note.ogg", None, 5, None, error="bridge timeout")
    assert "Transcription FAILED" in bad and "[Audio note: note.ogg could not be transcribed (bridge timeout).]" in bad
    assert bad.endswith("[end of audio: note.ogg]")
    silent = ai.audio_block("note.ogg", "", 5, None)
    assert "(no speech detected)" in silent


def test_materialize_inlines_transcript_and_sends_no_media(tmp_path, monkeypatch):
    plugin = _load_plugin()
    monkeypatch.setenv("PARLEY_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(ai, "transcribe", lambda payload, mime, **kw: "the flat deposit is due friday")
    Adapter = plugin.ParleyAdapter
    out: list = []
    paths, mimes, _ = Adapter._materialize_attachments(
        Adapter,
        [{"type": "audio", "mimeType": "", "fileName": "PTT-20261025-WA0001.ogg",
          "content": "data:application/octet-stream;base64," + base64.b64encode(b"OggS-fake").decode()}],
        text_out=out,
    )
    assert paths == [] and mimes == [], "audio is not media for hermes"
    assert len(out) == 1
    assert out[0].startswith("[Audio attached: PTT-20261025-WA0001.ogg — ")
    assert "the flat deposit is due friday" in out[0] and out[0].endswith("[end of audio: PTT-20261025-WA0001.ogg]")


def test_materialize_failed_transcription_is_an_honest_note(tmp_path, monkeypatch):
    plugin = _load_plugin()
    monkeypatch.setenv("PARLEY_HOME", str(tmp_path / "home"))
    def boom(payload, mime, **kw): raise RuntimeError("transcribe HTTP 503")
    monkeypatch.setattr(ai, "transcribe", boom)
    Adapter = plugin.ParleyAdapter
    out: list = []
    paths, _, _ = Adapter._materialize_attachments(
        Adapter,
        [{"type": "audio", "mimeType": "audio/ogg", "fileName": "note.ogg",
          "content": "data:audio/ogg;base64," + base64.b64encode(b"OggS").decode()}],
        text_out=out,
    )
    assert paths == [] and "[Audio note: note.ogg could not be transcribed (transcribe HTTP 503).]" in out[0]
