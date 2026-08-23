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
import { dataHome } from './dataHome.mjs';

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
