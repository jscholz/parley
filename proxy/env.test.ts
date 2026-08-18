// Unit tests for the PARLEY_*/SIDEKICK_* env compat shim (proxy/env.mjs).
//
// The live deployment's systemd drop-ins still export SIDEKICK_ITEMS_V3,
// SIDEKICK_CONFIG, SIDEKICK_TEST_GUARD, etc. — if the fallback regresses,
// live transcript serving silently reverts. These tests pin the contract:
// new name wins, old name honored, presence-based (not truthiness).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnv, legacyEnvName, envIsSet, setDefaultEnv } from './env.mjs';

test('readEnv: new name set → new value', () => {
  const env = { PARLEY_ITEMS_V3: '1' };
  assert.equal(readEnv('PARLEY_ITEMS_V3', env), '1');
});

test('readEnv: only legacy name set → legacy value honored', () => {
  const env = { SIDEKICK_ITEMS_V3: '1' };
  assert.equal(readEnv('PARLEY_ITEMS_V3', env), '1');
});

test('readEnv: both set → new name wins', () => {
  const env = { PARLEY_CONFIG: '/new.yaml', SIDEKICK_CONFIG: '/old.yaml' };
  assert.equal(readEnv('PARLEY_CONFIG', env), '/new.yaml');
});

test('readEnv: neither set → undefined', () => {
  assert.equal(readEnv('PARLEY_NOPE', {}), undefined);
});

test('readEnv: presence-based — empty-string new value shadows legacy', () => {
  // PARLEY_AGENT_CMD='' means "skip the stub agent"; it must not fall
  // through to a legacy value.
  const env = { PARLEY_AGENT_CMD: '', SIDEKICK_AGENT_CMD: 'node old.mjs' };
  assert.equal(readEnv('PARLEY_AGENT_CMD', env), '');
});

test('readEnv: empty-string legacy value is still returned (presence-based)', () => {
  const env = { SIDEKICK_AGENT_CMD: '' };
  assert.equal(readEnv('PARLEY_AGENT_CMD', env), '');
});

test('readEnv: non-PARLEY names have no legacy fallback', () => {
  const env = { SIDEKICK_PORT: '9999' };
  assert.equal(readEnv('PORT', env), undefined);
  assert.equal(readEnv('PORT', { PORT: '3001' }), '3001');
});

test('legacyEnvName maps PARLEY_→SIDEKICK_ and nothing else', () => {
  assert.equal(legacyEnvName('PARLEY_PLATFORM_TOKEN'), 'SIDEKICK_PLATFORM_TOKEN');
  assert.equal(legacyEnvName('PORT'), null);
  assert.equal(legacyEnvName('DEEPGRAM_API_KEY'), null);
});

test('envIsSet: true for either spelling', () => {
  assert.equal(envIsSet('PARLEY_HOME', { PARLEY_HOME: '/a' }), true);
  assert.equal(envIsSet('PARLEY_HOME', { SIDEKICK_HOME: '/b' }), true);
  assert.equal(envIsSet('PARLEY_HOME', {}), false);
});

test('setDefaultEnv: does not shadow a legacy value', () => {
  const env: Record<string, string> = { SIDEKICK_ENV_FILE: '/legacy/.env' };
  const got = setDefaultEnv(env, 'PARLEY_ENV_FILE', '/new/.env');
  assert.equal(got, '/legacy/.env');
  assert.equal(env.PARLEY_ENV_FILE, undefined);
});

test('setDefaultEnv: writes the new name when neither is set', () => {
  const env: Record<string, string> = {};
  const got = setDefaultEnv(env, 'PARLEY_ENV_FILE', '/new/.env');
  assert.equal(got, '/new/.env');
  assert.equal(env.PARLEY_ENV_FILE, '/new/.env');
});
