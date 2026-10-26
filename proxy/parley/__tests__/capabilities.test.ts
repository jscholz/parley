/**
 * Capability discovery (audit phase 2): the proxy probes GET
 * /v1/capabilities once the upstream is ready, /config hands it to the
 * PWA, a legacy upstream (404) yields null, and an upstream without
 * `extension()` makes the delegate routes answer 404 — never 502.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startRig } from './proxy-harness.ts';
import { CAPABILITY_FAMILIES } from '../contract/capabilities.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('capabilities — probed at init and served on getCapabilities(); legacy 404 → null', async () => {
  const rig = await startRig();
  try {
    const parley = await import('../index.ts');
    const caps = await parley.refreshCapabilities(true);
    assert.ok(caps && caps.extensions.includes('pins') && caps.turn_lifecycle === true, JSON.stringify(caps));
    assert.deepEqual(parley.getCapabilities(), caps);
    for (const f of caps!.extensions) assert.ok(CAPABILITY_FAMILIES.includes(f), `unknown family ${f}`);
    rig.fakeAgent.capabilities = null;
    assert.equal(await parley.refreshCapabilities(true), null);
    assert.equal(parley.getCapabilities(), null);
  } finally { await rig.stop(); }
});

test('capabilities — the plugin names only families the contract knows', () => {
  const src = readFileSync(join(ROOT, 'backends/hermes/plugin/parley_capabilities.py'), 'utf8');
  const m = /FAMILY_PREFIXES\s*=\s*\(([\s\S]*?)\n\)/.exec(src);
  assert.ok(m, 'FAMILY_PREFIXES tuple');
  const families = [...m![1].matchAll(/,\s*"([a-z-]+)"\s*\)/g)].map((x) => x[1]);
  assert.ok(families.length > 10, `parsed ${families.length} families`);
  const unknown = families.filter((f) => !CAPABILITY_FAMILIES.includes(f));
  assert.deepEqual(unknown, [], `plugin families missing from contract/routes.ts: ${unknown}`);
});

test('delegate routes — an upstream without extension() answers 404, not 502', async () => {
  const rig = await startRig();
  try {
    const parley = await import('../index.ts');
    const delegate = await import('../notifications/delegate.ts');
    // Through the real upstream first (pins list → fake agent has no /v1/pins → upstream 404 kept).
    const r1 = await fetch(`${rig.proxyUrl}/api/parley/health`);
    assert.equal(r1.status, 200);
    // Now swap in an upstream with no extension(): every delegate route is "unsupported".
    const real = parley.getUpstream()!;
    const noExt: any = { ...real, extension: undefined };
    Object.setPrototypeOf(noExt, Object.getPrototypeOf(real));
    (parley as any).__setUpstreamForTest?.(noExt);
    if (!(parley as any).__setUpstreamForTest) return;
    const res: any = { status: 0, body: null, writeHead(s: number) { this.status = s; }, end(b: string) { this.body = b; } };
    await delegate.delegatePinsList({ url: '/api/parley/pins', headers: {} } as any, res);
    assert.equal(res.status, 404);
    assert.match(String(res.body), /unsupported/);
  } finally { await rig.stop(); }
});
