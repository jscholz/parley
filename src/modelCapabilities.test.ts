// Negative-cache semantics of fetchModelCaps — the loop-breaker for the
// 2026-07-07 white-screen bug (zero-backoff retry hammer against a
// failing /model-capabilities on trial installs). A failure must be
// CACHED (known:false) so the attach-gate's fetch→re-run chain
// terminates, and must expire so recovery still lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let fetchCalls = 0;
let fetchMode: 'fail' | 'ok' = 'fail';
(globalThis as any).fetch = async () => {
  fetchCalls++;
  if (fetchMode === 'fail') return { ok: false, status: 502, json: async () => ({}) };
  return {
    ok: true, status: 200,
    json: async () => ({ known: true, supports_vision: true }),
  };
};
(globalThis as any).window = { addEventListener: () => {}, dispatchEvent: () => true };
(globalThis as any).document = { addEventListener: () => {} };

const caps = await import('./modelCapabilities.ts');

test('failure is cached — repeat calls do NOT refetch (no retry loop)', async () => {
  fetchMode = 'fail'; fetchCalls = 0;
  const first = await caps.fetchModelCaps('echo');
  assert.equal(first?.known, false, 'failure returns a known:false verdict');
  for (let i = 0; i < 50; i++) await caps.fetchModelCaps('echo');
  assert.equal(fetchCalls, 1, '50 follow-up calls must hit the cache, not the network');
  assert.equal(caps.capsKnownFor('echo'), true, 'negative entry counts as an answer');
});

test('success for another model caches normally', async () => {
  fetchMode = 'ok'; fetchCalls = 0;
  const got = await caps.fetchModelCaps('gpt-9');
  assert.equal(got?.known, true);
  assert.equal(got?.supports_vision, true);
  await caps.fetchModelCaps('gpt-9');
  assert.equal(fetchCalls, 1);
});
