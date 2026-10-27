"""HEIC/TIFF uploads get a JPEG thumbnail beside the durable copy (2026-10-27)."""
from __future__ import annotations

import io
import os

import pytest

from .. import parley_user_uploads as up


def _heic_bytes() -> bytes:
    pillow_heif = pytest.importorskip("pillow_heif")
    from PIL import Image
    pillow_heif.register_heif_opener()
    im = Image.new("RGB", (640, 480), (200, 80, 40))
    buf = io.BytesIO()
    im.save(buf, format="HEIF", quality=70)
    return buf.getvalue()


def test_needs_thumbnail_by_mime_or_extension():
    assert up.needs_thumbnail("image/heic", "x.heic")
    assert up.needs_thumbnail("application/octet-stream", "IMG_1.HEIC")
    assert up.needs_thumbnail("image/tiff", "scan.tif")
    assert not up.needs_thumbnail("image/jpeg", "a.jpg")
    assert not up.needs_thumbnail("application/pdf", "a.pdf")


def test_heic_upload_writes_jpeg_thumbnail_and_rows_expose_it(tmp_path, monkeypatch):
    monkeypatch.setenv("PARLEY_HOME", str(tmp_path))
    monkeypatch.setattr(up, "uploads_root", lambda: tmp_path / "uploads")
    data = _heic_bytes()
    row = up.persist_user_attachment(None, "umsg_1793000000000_abcdefgh", 0, file_name="IMG_1619.HEIC", mime="image/heic", payload=data)
    assert row is not None
    dest = tmp_path / "uploads" / "umsg_1793000000000_abcdefgh" / "0-IMG_1619.HEIC"
    thumb = tmp_path / "uploads" / "umsg_1793000000000_abcdefgh" / "0-thumb.jpg"
    assert dest.exists() and thumb.exists() and thumb.stat().st_size > 0
    from PIL import Image
    with Image.open(thumb) as im:
        assert im.format == "JPEG" and im.size == (640, 480)
    # attachments_for reads the thumb from disk next to the indexed path
    class _DB:
        def fetchall(self, sql, args):
            return [("umsg_1793000000000_abcdefgh", 0, "IMG_1619.HEIC", "image/heic", len(data), str(dest))]
    rows = up.attachments_for(_DB(), ["umsg_1793000000000_abcdefgh"])["umsg_1793000000000_abcdefgh"]
    assert rows[0]["thumbUrl"] == "/api/parley/uploads/umsg_1793000000000_abcdefgh/0/thumb"
    # a JPEG upload gets no thumbnail and no thumbUrl
    row2 = up.persist_user_attachment(None, "umsg_1793000000000_abcdefgh", 1, file_name="a.jpg", mime="image/jpeg", payload=b"\xff\xd8\xff\xd9")
    assert row2 is not None and not (tmp_path / "uploads" / "umsg_1793000000000_abcdefgh" / "1-thumb.jpg").exists()


def test_attachment_meta_announces_the_thumb_url_for_heic():
    meta = up.attachment_meta([{"fileName": "IMG_1.HEIC", "mimeType": "image/heic", "content": "data:image/heic;base64,AAAA"},
                               {"fileName": "a.png", "mimeType": "image/png", "content": "data:image/png;base64,AAAA"}], "umsg_1793000000000_abcdefgh")
    assert meta[0]["thumbUrl"] == "/api/parley/uploads/umsg_1793000000000_abcdefgh/0/thumb"
    assert "thumbUrl" not in meta[1]


def test_undecodable_file_gets_no_thumbnail_and_no_error(tmp_path, monkeypatch):
    monkeypatch.setattr(up, "uploads_root", lambda: tmp_path / "uploads")
    row = up.persist_user_attachment(None, "umsg_1793000000000_abcdefgh", 2, file_name="junk.heic", mime="image/heic", payload=b"not an image")
    assert row is not None
    assert not (tmp_path / "uploads" / "umsg_1793000000000_abcdefgh" / "2-thumb.jpg").exists()
