/**
 * The /v1 route catalogue (proxy/parley/contract/routes.ts) vs what the
 * hermes plugin actually registers (2026-10-26 audit §1.1): a family on
 * one side without the other fails here instead of 502-ing on a phone.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { UPSTREAM_ROUTES, catalogueRouteKeys, routeKey } from '../contract/routes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGIN = join(ROOT, 'backends/hermes/plugin');

function pluginRegisteredRoutes(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(PLUGIN).filter((n) => n.endsWith('.py'))) {
    const src = readFileSync(join(PLUGIN, f), 'utf8');
    for (const m of src.matchAll(/add_(get|post|delete|patch|put)\(\s*\n?\s*"(\/[^"]+)"/g)) {
      out.add(routeKey(m[1], m[2]));
    }
  }
  return out;
}

test('contract: every catalogued route is registered by the hermes plugin', () => {
  const registered = pluginRegisteredRoutes();
  assert.ok(registered.size > 20, `found only ${registered.size} plugin routes — regex drift?`);
  const missing = [...catalogueRouteKeys()].filter((k) => !registered.has(k));
  assert.deepEqual(missing, [], `catalogued but not registered: ${missing.join(', ')}`);
});

test('contract: every /v1 route the plugin registers is catalogued', () => {
  const catalogued = catalogueRouteKeys();
  const stray = [...pluginRegisteredRoutes()].filter((k) => !catalogued.has(k));
  assert.deepEqual(stray, [], `registered but not in contract/routes.ts: ${stray.join(', ')}`);
});

test('contract: required families name their degrade rule and a doc', () => {
  for (const f of UPSTREAM_ROUTES) {
    assert.ok(f.routes.length > 0 && f.degrade.length > 10 && f.doc.length > 3, f.family);
    for (const r of f.routes) assert.match(r, /^(GET|POST|DELETE|PATCH|PUT) \//, r);
  }
  assert.ok(UPSTREAM_ROUTES.some((f) => f.family === 'events' && f.support === 'required'), '/v1/events is required');
});
