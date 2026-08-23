// Unit tests for deployment-config path resolution (proxy/configPath.mjs).
//
// Contract: PARLEY_CONFIG env override wins when the file exists, then
// parley.config.yaml, then config.yaml, else null. (The legacy
// sidekick.config.yaml step was removed by the 2026-08 identity purge.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfigPath } from './configPath.mjs';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'parley-configpath-'));
}

test('prefers parley.config.yaml', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'parley.config.yaml'), 'a: 1\n');
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'a: 2\n');
  assert.equal(resolveConfigPath(dir, {}), path.join(dir, 'parley.config.yaml'));
});

test('falls back to config.yaml, else null', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'a: 3\n');
  assert.equal(resolveConfigPath(dir, {}), path.join(dir, 'config.yaml'));
  assert.equal(resolveConfigPath(tmpDir(), {}), null);
});

test('PARLEY_CONFIG env override wins when the file exists', () => {
  const dir = tmpDir();
  const explicit = path.join(dir, 'elsewhere.yaml');
  fs.writeFileSync(explicit, 'a: 4\n');
  fs.writeFileSync(path.join(dir, 'parley.config.yaml'), 'a: 1\n');
  assert.equal(resolveConfigPath(dir, { PARLEY_CONFIG: explicit }), explicit);
});

test('missing env-pointed file falls through to the dir candidates', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'parley.config.yaml'), 'a: 1\n');
  const got = resolveConfigPath(dir, { PARLEY_CONFIG: path.join(dir, 'nope.yaml') });
  assert.equal(got, path.join(dir, 'parley.config.yaml'));
});
