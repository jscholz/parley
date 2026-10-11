"""User-upload lane (2026-10-11): durable copies of what the user attached,
indexed in parley.db and joined onto user rows by the items read."""
from __future__ import annotations
import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_user_id_queries import _load_plugin  # noqa: E402


@pytest.fixture(scope="module")
def mods():
    import importlib
    plugin = _load_plugin()
    return (importlib.import_module(f"{plugin.__name__}.parley_user_uploads"),
            importlib.import_module(f"{plugin.__name__}.parley_db"))


def test_persist_index_and_join(mods, tmp_path, monkeypatch):
    uploads, pdb = mods
    monkeypatch.setenv("PARLEY_HOME", str(tmp_path / "home"))
    db = pdb.open_parley_db(str(tmp_path / "state"))
    umsg = "umsg_1791680364154_wi4w0qxu"
    r0 = uploads.persist_user_attachment(db, umsg, 0, file_name="wrist 1.png", mime="image/png", payload=b"PNG!")
    src = tmp_path / "staged.pdf"; src.write_bytes(b"%PDF-1.4")
    r1 = uploads.persist_user_attachment(db, umsg, 1, file_name="../../deck.pdf", mime="application/pdf", source_path=src)
    assert r0 and r1
    assert Path(r0["path"]).read_bytes() == b"PNG!"
    assert Path(r0["path"]).parent == tmp_path / "home" / "uploads" / umsg
    assert r1["file_name"] == "deck.pdf"                      # path components stripped
    assert Path(r1["path"]).name == "1-deck.pdf"
    items = [{"role": "user", "parley_id": umsg, "content": "x"}, {"role": "assistant", "parley_id": "msg_1", "content": "y"},
             {"role": "user", "parley_id": "umsg_other", "content": "z"}]
    uploads.attach_user_attachments(db, items)
    assert [a["url"] for a in items[0]["attachments"]] == [f"/api/parley/uploads/{umsg}/0", f"/api/parley/uploads/{umsg}/1"]
    assert items[0]["attachments"][0] == {"idx": 0, "fileName": "wrist 1.png", "mimeType": "image/png", "size": 4, "url": f"/api/parley/uploads/{umsg}/0"}
    assert "attachments" not in items[1] and "attachments" not in items[2]


def test_bad_ids_and_missing_db_are_harmless(mods, tmp_path, monkeypatch):
    uploads, _ = mods
    monkeypatch.setenv("PARLEY_HOME", str(tmp_path))
    assert uploads.persist_user_attachment(None, "", 0, file_name="a", mime="image/png", payload=b"x") is None
    assert uploads.persist_user_attachment(None, "bad id/with/slashes", 0, file_name="a", mime="image/png", payload=b"x") is None
    row = uploads.persist_user_attachment(None, "umsg_1_a", 0, file_name="a.png", mime="image/png", payload=b"x")
    assert row and Path(row["path"]).exists()                 # file kept even without an index db
    items = [{"role": "user", "parley_id": "umsg_1_a"}]
    uploads.attach_user_attachments(None, items)
    assert "attachments" not in items[0]
