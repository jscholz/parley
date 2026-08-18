// Unit tests for the sidekick.db → parley.db file-rename migration
// (backends/openclaw/src/db.js migrateLegacyDbFile).
//
// Run: node --test backends/openclaw/test/db-file-migration.test.mjs
//
// Mirrors backends/hermes/plugin/tests/test_db_file_migration.py:
// atomic same-dir rename, sidecars carried, idempotent, and a stale
// legacy file is never re-adopted once parley.db exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyDbFile, openDb, close } from '../src/db.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'parley-oc-dbmig-'));
}

test('renames legacy file (with sidecars) before open', () => {
  const dir = tmpDir();
  const legacy = path.join(dir, 'sidekick.db');
  const fresh = path.join(dir, 'parley.db');
  const db = openDb({ path: legacy });
  close(db);
  fs.writeFileSync(legacy + '-wal', 'wal-bytes');
  fs.writeFileSync(legacy + '-shm', 'shm-bytes');

  assert.equal(migrateLegacyDbFile(fresh, legacy), true);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(fresh + '-wal', 'utf8'), 'wal-bytes');
  assert.equal(fs.readFileSync(fresh + '-shm', 'utf8'), 'shm-bytes');

  const reopened = openDb({ path: fresh });
  close(reopened);
});

test('idempotent — second run is a no-op', () => {
  const dir = tmpDir();
  const legacy = path.join(dir, 'sidekick.db');
  const fresh = path.join(dir, 'parley.db');
  fs.writeFileSync(legacy, 'x');
  assert.equal(migrateLegacyDbFile(fresh, legacy), true);
  assert.equal(migrateLegacyDbFile(fresh, legacy), false);
});

test('never re-adopts a stale legacy file once parley.db exists', () => {
  const dir = tmpDir();
  const legacy = path.join(dir, 'sidekick.db');
  const fresh = path.join(dir, 'parley.db');
  fs.writeFileSync(fresh, 'new-truth');
  fs.writeFileSync(legacy, 'stale-old');
  assert.equal(migrateLegacyDbFile(fresh, legacy), false);
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'new-truth');
  assert.equal(fs.existsSync(legacy), true); // left for manual cleanup
});

test('fresh install — nothing to migrate', () => {
  const dir = tmpDir();
  assert.equal(
    migrateLegacyDbFile(path.join(dir, 'parley.db'), path.join(dir, 'sidekick.db')),
    false,
  );
  assert.equal(fs.existsSync(path.join(dir, 'parley.db')), false);
});
