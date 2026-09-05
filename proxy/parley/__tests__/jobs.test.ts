/**
 * Scheduled-jobs proxy routes — pin the contract in
 * docs/ABSTRACT_AGENT_PROTOCOL.md "Optional scheduled-jobs extension":
 * GET forwards the agent's payload verbatim, POST forwards the body and
 * returns the updated job, run + runs forward, 404 (no scheduler) and
 * agent validation errors propagate with their envelope.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { startRig } from './proxy-harness.ts';

const JOB = {
  id: 'c06b4603e054', name: 'Press Radar', schedule: '45 3 * * *', enabled: true, state: 'scheduled',
  next_run_at: '2026-09-06T03:45:00+01:00', last_run_at: null, last_status: 'ok', last_error: null,
  prompt: 'Collect press', deliver: 'origin', model: '', provider: '', skills: [],
  origin: { platform: 'parley', chat_id: 'abc', label: 'parley:abc' },
};

test('jobs — list forwards payload with option catalogs', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setJobs([structuredClone(JOB)]);
    const r = await fetch(`${rig.proxyUrl}/api/parley/jobs`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data[0].id, 'c06b4603e054');
    assert.ok(Array.isArray(body.options.deliver) && Array.isArray(body.options.model));
  } finally { await rig.stop(); }
});

test('jobs — update forwards body and returns the updated job', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setJobs([structuredClone(JOB)]);
    const r = await fetch(`${rig.proxyUrl}/api/parley/jobs/c06b4603e054`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(r.status, 200);
    const job = await r.json();
    assert.equal(job.enabled, false);
    assert.equal(job.state, 'paused');
    assert.deepEqual(rig.fakeAgent.lastJobPost, { id: 'c06b4603e054', action: 'update', body: { enabled: false } });
  } finally { await rig.stop(); }
});

test('jobs — run forwards and agent validation errors propagate', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setJobs([structuredClone(JOB)]);
    const run = await fetch(`${rig.proxyUrl}/api/parley/jobs/c06b4603e054/run`, { method: 'POST' });
    assert.equal(run.status, 200);
    assert.equal(rig.fakeAgent.lastJobPost?.action, 'run');
    const bad = await fetch(`${rig.proxyUrl}/api/parley/jobs/c06b4603e054`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliver: 'bad!target' }),
    });
    assert.equal(bad.status, 400);
    const err = await bad.json();
    assert.equal(err.error.type, 'invalid_request_error');
    const runs = await fetch(`${rig.proxyUrl}/api/parley/jobs/c06b4603e054/runs?limit=5`);
    assert.equal(runs.status, 200);
    assert.equal((await runs.json()).data[0].status, 'completed');
  } finally { await rig.stop(); }
});

test('jobs — 404 when the agent has no scheduler; bad ids rejected at the proxy', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setJobs(null);
    assert.equal((await fetch(`${rig.proxyUrl}/api/parley/jobs`)).status, 404);
    const r = await fetch(`${rig.proxyUrl}/api/parley/jobs/${encodeURIComponent('../x')}`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 400);
    assert.equal(rig.fakeAgent.lastJobPost, null);
  } finally { await rig.stop(); }
});
