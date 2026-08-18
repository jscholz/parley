"""Unit tests for the sidekick.db → parley.db file-rename migration.

This code runs against the owner's live DB at next deploy — it must be
boring: atomic same-dir rename, WAL/SHM sidecars carried along,
idempotent, and it must NEVER re-adopt a stale legacy file once
parley.db exists (keyterms-incident lesson: an old-name store must not
become fresh truth again).
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from backends.hermes.plugin.sidekick_db import (
    SidekickDB,
    migrate_legacy_db_file,
    open_sidekick_db,
)


def _make_legacy_db(path: Path, marker: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE IF NOT EXISTS probe (v TEXT)")
    conn.execute("INSERT INTO probe (v) VALUES (?)", (marker,))
    conn.commit()
    conn.close()


def _probe(path: Path) -> list:
    conn = sqlite3.connect(str(path))
    try:
        return [r[0] for r in conn.execute("SELECT v FROM probe").fetchall()]
    finally:
        conn.close()


def test_renames_legacy_file_before_open(tmp_path):
    legacy = tmp_path / "sidekick.db"
    new = tmp_path / "parley.db"
    _make_legacy_db(legacy, "live-data")

    assert migrate_legacy_db_file(new, legacy) is True
    assert new.exists()
    assert not legacy.exists()
    assert _probe(new) == ["live-data"]


def test_sidecar_wal_shm_files_move_along(tmp_path):
    legacy = tmp_path / "sidekick.db"
    new = tmp_path / "parley.db"
    _make_legacy_db(legacy, "x")
    (tmp_path / "sidekick.db-wal").write_bytes(b"wal-bytes")
    (tmp_path / "sidekick.db-shm").write_bytes(b"shm-bytes")

    migrate_legacy_db_file(new, legacy)
    assert (tmp_path / "parley.db-wal").read_bytes() == b"wal-bytes"
    assert (tmp_path / "parley.db-shm").read_bytes() == b"shm-bytes"
    assert not (tmp_path / "sidekick.db-wal").exists()
    assert not (tmp_path / "sidekick.db-shm").exists()


def test_idempotent_second_run_is_noop(tmp_path):
    legacy = tmp_path / "sidekick.db"
    new = tmp_path / "parley.db"
    _make_legacy_db(legacy, "once")
    assert migrate_legacy_db_file(new, legacy) is True
    assert migrate_legacy_db_file(new, legacy) is False
    assert _probe(new) == ["once"]


def test_never_readopts_legacy_once_new_exists(tmp_path):
    """A stale sidekick.db appearing AFTER parley.db is live must be
    left alone — the new file stays untouched."""
    legacy = tmp_path / "sidekick.db"
    new = tmp_path / "parley.db"
    _make_legacy_db(new, "new-truth")
    _make_legacy_db(legacy, "stale-old")

    assert migrate_legacy_db_file(new, legacy) is False
    assert _probe(new) == ["new-truth"]
    assert legacy.exists()  # untouched, for manual inspection/removal


def test_fresh_install_no_legacy_file(tmp_path):
    new = tmp_path / "parley.db"
    assert migrate_legacy_db_file(new, tmp_path / "sidekick.db") is False
    assert not new.exists()


def test_open_sidekick_db_migrates_then_opens(tmp_path):
    _make_legacy_db(tmp_path / "sidekick.db", "carried")
    db = open_sidekick_db(state_dir=str(tmp_path))
    try:
        assert Path(db.path).name == "parley.db"
        assert not (tmp_path / "sidekick.db").exists()
        assert db.fetchone("SELECT v FROM probe")[0] == "carried"
    finally:
        db.close()


def test_open_sidekick_db_fresh_creates_new_name(tmp_path):
    db = open_sidekick_db(state_dir=str(tmp_path))
    try:
        assert Path(db.path).name == "parley.db"
    finally:
        db.close()
    assert (tmp_path / "parley.db").exists()


def test_direct_sidekickdb_open_is_unaffected(tmp_path):
    db = SidekickDB(tmp_path / "anything.db")
    db.close()
    assert (tmp_path / "anything.db").exists()
