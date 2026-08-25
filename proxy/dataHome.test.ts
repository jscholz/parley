// Unit tests for data-home resolution (proxy/dataHome.mjs).
//
// Contract: PARLEY_HOME env wins, else ~/.parley. (The ~/.sidekick
// fallback was removed by the 2026-08 identity purge; the live dir was
// moved to ~/.parley in the same cutover.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataHome, isLiveDataHome } from './dataHome.mjs';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'parley-datahome-'));
}

test('env override wins', () => {
  const home = tmpHome();
  assert.equal(dataHome({ PARLEY_HOME: '/explicit/new' }, home), '/explicit/new');
});

test('defaults to ~/.parley whether or not it exists yet', () => {
  const home = tmpHome();
  assert.equal(dataHome({}, home), path.join(home, '.parley'));
  fs.mkdirSync(path.join(home, '.parley'));
  assert.equal(dataHome({}, home), path.join(home, '.parley'));
});

test('an old ~/.sidekick dir is ignored', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.sidekick'));
  assert.equal(dataHome({}, home), path.join(home, '.parley'));
});

// ── live-home tripwire (test-safety sentinel) ────────────────────────
//
// Surfaced on /health as `data_home` and read by scripts/run-smoke.mjs,
// which refuses to drive a server that reports "live" — the smoke suite
// POSTs to /api/parley/config/<key> and would overwrite real settings.

test('isLiveDataHome: the default home is live', () => {
  const home = tmpHome();
  assert.equal(isLiveDataHome({}, home), true);
});

test('isLiveDataHome: a sandbox PARLEY_HOME is not live', () => {
  const home = tmpHome();
  assert.equal(isLiveDataHome({ PARLEY_HOME: '/tmp/parley-smoke-home' }, home), false);
});

test('isLiveDataHome: PARLEY_HOME pointing back at the real dir is still live', () => {
  // The guard compares RESOLVED paths precisely so it cannot be defeated
  // by setting the env var to the live location — including via a
  // non-normalised path, which a naive string compare would miss.
  const home = tmpHome();
  assert.equal(isLiveDataHome({ PARLEY_HOME: path.join(home, '.parley') }, home), true);
  assert.equal(isLiveDataHome({ PARLEY_HOME: path.join(home, 'x', '..', '.parley') }, home), true);
});
