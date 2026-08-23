// Unit tests for the PARLEY_* env accessor (proxy/env.mjs).
//
// Presence-based semantics are load-bearing: PARLEY_AGENT_CMD='' means
// "skip the stub agent" and must not read as unset. (The SIDEKICK_*
// legacy fallback was removed by the 2026-08 identity purge once every
// deployment surface exported PARLEY_*.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnv, envIsSet, setDefaultEnv } from './env.mjs';

test('readEnv: set → value', () => {
  const env = { PARLEY_ITEMS_V3: '1' };
  assert.equal(readEnv('PARLEY_ITEMS_V3', env), '1');
});

test('readEnv: unset → undefined', () => {
  assert.equal(readEnv('PARLEY_NOPE', {}), undefined);
});

test('readEnv: presence-based — empty string is a value, not unset', () => {
  const env = { PARLEY_AGENT_CMD: '' };
  assert.equal(readEnv('PARLEY_AGENT_CMD', env), '');
});

test('readEnv: no implicit fallback between names', () => {
  const env = { SIDEKICK_ITEMS_V3: '1' };
  assert.equal(readEnv('PARLEY_ITEMS_V3', env), undefined);
});

test('envIsSet: presence, including empty string', () => {
  assert.equal(envIsSet('PARLEY_HOME', { PARLEY_HOME: '/a' }), true);
  assert.equal(envIsSet('PARLEY_HOME', { PARLEY_HOME: '' }), true);
  assert.equal(envIsSet('PARLEY_HOME', {}), false);
});

test('setDefaultEnv: writes only when unset', () => {
  const env: Record<string, string> = {};
  assert.equal(setDefaultEnv(env, 'PARLEY_ENV_FILE', '/new/.env'), '/new/.env');
  assert.equal(env.PARLEY_ENV_FILE, '/new/.env');
  assert.equal(setDefaultEnv(env, 'PARLEY_ENV_FILE', '/other/.env'), '/new/.env');
});
