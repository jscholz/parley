// Unit tests for data-home resolution (proxy/dataHome.mjs).
//
// Contract (Parley rename): PARLEY_HOME/SIDEKICK_HOME env wins, then an
// existing ~/.parley, then an existing ~/.sidekick (live installs keep
// being read in place — never moved), then ~/.parley for fresh installs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataHome } from './dataHome.mjs';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'parley-datahome-'));
}

test('env override wins (new name)', () => {
  const home = tmpHome();
  assert.equal(dataHome({ PARLEY_HOME: '/explicit/new' }, home), '/explicit/new');
});

test('env override wins (legacy SIDEKICK_HOME honored)', () => {
  const home = tmpHome();
  assert.equal(dataHome({ SIDEKICK_HOME: '/explicit/old' }, home), '/explicit/old');
});

test('existing ~/.parley preferred', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.parley'));
  fs.mkdirSync(path.join(home, '.sidekick'));
  assert.equal(dataHome({}, home), path.join(home, '.parley'));
});

test('falls back to existing ~/.sidekick when ~/.parley missing', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.sidekick'));
  assert.equal(dataHome({}, home), path.join(home, '.sidekick'));
});

test('fresh install (neither dir) gets ~/.parley', () => {
  const home = tmpHome();
  assert.equal(dataHome({}, home), path.join(home, '.parley'));
});
