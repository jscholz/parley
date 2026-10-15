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


def _link(db, pid, chat, created_at):
    db.exec("INSERT INTO msg_links (id, chat_id, role, content, created_at, updated_at, status) VALUES (?, ?, 'user', 'x', ?, ?, 'final')",
            (pid, chat, created_at, created_at))


def test_second_stored_copy_borrows_the_sends_attachments(mods, tmp_path, monkeypatch):
    """Field 2026-10-15: the served user row was 'legacy:208279' (hermes
    stored the turn twice); the PDF was saved under the umsg send 14 s
    earlier. The chip must still appear after a reload."""
    uploads, pdb = mods
    monkeypatch.setenv("PARLEY_HOME", str(tmp_path / "home"))
    db = pdb.open_parley_db(str(tmp_path / "state"))
    chat = "e50f5646-26ed-496e-a55e-f250c6a96a67"
    umsg = "umsg_1792091098520_sicbeu0u"
    _link(db, umsg, chat, 1792091099.2)
    uploads.persist_user_attachment(db, umsg, 0, file_name="Tax Return.pdf", mime="application/pdf", payload=b"%PDF")
    items = [{"role": "user", "parley_id": "legacy:208279", "created_at": 1792091113, "content": "audit"}]
    uploads.attach_user_attachments(db, items, chat_id=f"parley:{chat}")
    assert items[0]["attachments"][0]["fileName"] == "Tax Return.pdf"


def test_nearby_join_is_scoped_by_chat_window_and_used_once(mods, tmp_path, monkeypatch):
    uploads, pdb = mods
    monkeypatch.setenv("PARLEY_HOME", str(tmp_path / "home"))
    db = pdb.open_parley_db(str(tmp_path / "state"))
    _link(db, "umsg_a", "chat-a", 1000.0)
    uploads.persist_user_attachment(db, "umsg_a", 0, file_name="a.pdf", mime="application/pdf", payload=b"%PDF")
    far = [{"role": "user", "parley_id": "legacy:1", "created_at": 1000 + 600, "content": "x"}]
    uploads.attach_user_attachments(db, far, chat_id="parley:chat-a")
    assert "attachments" not in far[0], "outside the window"
    other = [{"role": "user", "parley_id": "legacy:2", "created_at": 1005, "content": "x"}]
    uploads.attach_user_attachments(db, other, chat_id="parley:chat-b")
    assert "attachments" not in other[0], "other chat"
    # The send itself is served AND a second copy is near it → only the send keeps the chip.
    both = [{"role": "user", "parley_id": "umsg_a", "created_at": 1000, "content": "x"},
            {"role": "user", "parley_id": "legacy:3", "created_at": 1010, "content": "x"}]
    uploads.attach_user_attachments(db, both, chat_id="parley:chat-a")
    assert both[0].get("attachments") and "attachments" not in both[1]
