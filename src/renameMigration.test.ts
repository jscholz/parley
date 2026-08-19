// Unit tests for the client-side persisted-state rename migration
// (src/renameMigration.ts). The IndexedDB copy path needs a browser and
// is covered by scripts/smoke/rename-idb-migration.mjs; here we pin the
// localStorage contract with an injected storage stub: copy only when
// the new key is absent, never overwrite an existing new key from the
// old one (keyterms-incident lesson), old keys left in place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateLocalStorageKeys, LS_COPY_KEYS } from './renameMigration.ts';

function stubStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    dump: () => Object.fromEntries(map),
  };
}

test('copies old → new when the new key is absent', () => {
  const s = stubStorage({
    'sidekick_server_url': 'https://host:3001',
    'sidekick.settings.v2': '{"a":1}',
  });
  const copied = migrateLocalStorageKeys(s);
  assert.equal(copied, 2);
  assert.equal(s.getItem('parley_server_url'), 'https://host:3001');
  assert.equal(s.getItem('parley.settings.v2'), '{"a":1}');
  // old keys stay in place (rollback safety)
  assert.equal(s.getItem('sidekick_server_url'), 'https://host:3001');
});

test('never overwrites an existing new key from the old one', () => {
  const s = stubStorage({
    'sidekick.settings.v2': '{"stale":true}',
    'parley.settings.v2': '{"fresh":true}',
  });
  const copied = migrateLocalStorageKeys(s);
  assert.equal(copied, 0);
  assert.equal(s.getItem('parley.settings.v2'), '{"fresh":true}');
});

test('idempotent — a second run copies nothing', () => {
  const s = stubStorage({ 'sidekick.sidebarWidth': '347' });
  assert.equal(migrateLocalStorageKeys(s), 1);
  // Mutate the old key after migration: the new key must not change.
  s.setItem('sidekick.sidebarWidth', '999');
  assert.equal(migrateLocalStorageKeys(s), 0);
  assert.equal(s.getItem('parley.sidebarWidth'), '347');
});

test('nothing to migrate — clean storage stays clean', () => {
  const s = stubStorage();
  assert.equal(migrateLocalStorageKeys(s), 0);
  assert.deepEqual(s.dump(), {});
});

test('key table is sane: every pair renames sidekick→parley 1:1', () => {
  for (const [oldKey, newKey] of LS_COPY_KEYS) {
    assert.match(oldKey, /sidekick/);
    assert.equal(newKey, oldKey.replace('sidekick', 'parley'));
  }
});
