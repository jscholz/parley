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

// Integrations flows (phase 2): thin pass-through with the client's origin
// stamped in, and the OAuth callback page the provider redirects to.
test('health — integration flows pass through with origin; callback renders a page', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setHealth([structuredClone(CHECK)]);
    const cat = await fetch(`${rig.proxyUrl}/api/parley/health/catalog`);
    assert.equal(cat.status, 200);
    assert.equal((await cat.json()).data[0].provider, 'linear');

    const act = await fetch(`${rig.proxyUrl}/api/parley/health/int-mcp-attio/actions/connect`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://galatea.example:3001' }, body: '{}',
    });
    assert.equal(act.status, 202);
    assert.equal((await act.json()).authorization_url, 'https://provider.example/authorize?state=good');
    assert.equal(rig.fakeAgent.lastHealthFlowBody?.route, 'action:int-mcp-attio/connect');
    assert.equal(rig.fakeAgent.lastHealthFlowBody?.body.origin, 'https://galatea.example:3001');

    // No Origin header (same-origin fetch from an installed PWA): Host decides.
    const add = await fetch(`${rig.proxyUrl}/api/parley/health/catalog/linear/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ env: { A: '1' } }),
    });
    assert.equal(add.status, 202);
    assert.equal(rig.fakeAgent.lastHealthFlowBody?.body.env.A, '1');
    assert.match(rig.fakeAgent.lastHealthFlowBody?.body.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

    const bad = await fetch(`${rig.proxyUrl}/api/parley/health/int-mcp-attio/actions/nope`, { method: 'POST' });
    assert.equal(bad.status, 400);                      // upstream status kept
    assert.equal((await fetch(`${rig.proxyUrl}/api/parley/health/flows/f-1`)).status, 200);
    assert.equal((await fetch(`${rig.proxyUrl}/api/parley/health/flows/gone`)).status, 404);
    assert.equal((await fetch(`${rig.proxyUrl}/api/parley/health/flows/f-1/cancel`, { method: 'POST' })).status, 200);

    const ok = await fetch(`${rig.proxyUrl}/api/parley/integrations/oauth/callback/attio?code=abc&state=good`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') || '', /text\/html/);
    const okHtml = await ok.text();
    assert.match(okHtml, /Signed in/);
    assert.match(okHtml, /parley:oauth-callback/);
    assert.deepEqual(rig.fakeAgent.lastOAuthCallback, { server: 'attio', query: { code: 'abc', state: 'good' } });
    const expired = await fetch(`${rig.proxyUrl}/api/parley/integrations/oauth/callback/attio?code=abc&state=stale`);
    assert.equal(expired.status, 400);
    assert.match(await expired.text(), /expired/);
    const evil = await fetch(`${rig.proxyUrl}/api/parley/integrations/oauth/callback/${encodeURIComponent('<x>')}?state=good`);
    assert.equal(evil.status, 400);
    assert.doesNotMatch(await evil.text(), /<x>/);
  } finally { await rig.stop(); }
});
