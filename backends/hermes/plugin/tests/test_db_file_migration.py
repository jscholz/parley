"""Unit tests for parley.db open semantics.

Historical note: this module used to cover the one-time sidekick.db →
parley.db file-rename migration; that shim met its documented removal
condition in the 2026-08 identity purge (no deployment carries the old
filename) and was deleted along with its tests. What remains pins the
plain open path.
"""

from __future__ import annotations

from pathlib import Path

from backends.hermes.plugin.parley_db import ParleyDB, open_parley_db


def test_open_parley_db_creates_new_name(tmp_path):
    db = open_parley_db(state_dir=str(tmp_path))
    try:
        assert Path(db.path).name == "parley.db"
    finally:
        db.close()
    assert (tmp_path / "parley.db").exists()


def test_direct_parleydb_open_is_unaffected(tmp_path):
    db = ParleyDB(tmp_path / "anything.db")
    db.close()
    assert (tmp_path / "anything.db").exists()
