/**
 * Health proxy routes — docs/ABSTRACT_AGENT_PROTOCOL.md "Optional health extension".
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { startRig } from './proxy-harness.ts';

const CHECK = { id: 'hermes', name: 'hermes health', worst: 'FAIL', last_run_at: '2026-09-05T07:11:34+00:00',
  report: '🔴 hermes health\nFAIL a — b\n', can_run: true, counts: { fail: 1, warn: 0, ok: 0 } };
const RO = { ...CHECK, id: 'parley', name: 'parley health', can_run: false };

test('health — list forwards, run re-runs, read-only rejected, 404 propagates', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setHealth([structuredClone(CHECK), structuredClone(RO)]);
    const list = await fetch(`${rig.proxyUrl}/api/parley/health`);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).data.length, 2);
    const run = await fetch(`${rig.proxyUrl}/api/parley/health/hermes/run`, { method: 'POST' });
    assert.equal(run.status, 200);
    assert.equal((await run.json()).worst, 'OK');
    assert.equal(rig.fakeAgent.lastHealthRun, 'hermes');
    assert.equal((await fetch(`${rig.proxyUrl}/api/parley/health/parley/run`, { method: 'POST' })).status, 400);
    assert.equal((await fetch(`${rig.proxyUrl}/api/parley/health/${encodeURIComponent('../x')}/run`, { method: 'POST' })).status, 400);
    rig.fakeAgent.setHealth(null);
    assert.equal((await fetch(`${rig.proxyUrl}/api/parley/health`)).status, 404);
  } finally { await rig.stop(); }
});
