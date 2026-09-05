/**
 * Native (APNs) subscribe routes — only the hermes plugin can send APNs, so
 * outside plugin-owned mode the proxy answers 503 with a clear reason instead
 * of silently storing a token nobody will ever send to.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { startRig } from './proxy-harness.ts';

test('native subscribe/unsubscribe → 503 native_push_requires_plugin when the proxy owns push', async () => {
  const prev = process.env.PARLEY_PUSH_OWNED_BY_PLUGIN;
  delete process.env.PARLEY_PUSH_OWNED_BY_PLUGIN;
  const rig = await startRig();
  try {
    for (const path of ['subscribe-native', 'unsubscribe-native']) {
      const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'ios', token: 'a'.repeat(64) }),
      });
      assert.equal(r.status, 503, path);
      assert.equal((await r.json()).error, 'native_push_requires_plugin');
    }
  } finally {
    await rig.stop();
    if (prev !== undefined) process.env.PARLEY_PUSH_OWNED_BY_PLUGIN = prev;
  }
});
