/**
 * The envelope contract, pinned (2026-10-26 audit §1.2).
 *
 *   plugin-emitted  ⊆  upstream types  (parley_envelopes.py vs contract)
 *   contract        ==  proxy fan-out   (stream.ts FANOUT_TYPES is derived)
 *   contract        ==  PWA subscribed  (src/envelopeTypes.ts)
 *
 * plus a behavioural check that the two envelopes the hand-kept list
 * dropped for months (`job_run`, `activity_changed`) now reach a tab.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ENVELOPE_TYPES, UPSTREAM_ENVELOPE_TYPES, PROXY_ENVELOPE_TYPES, TRANSLATOR_ENVELOPE_TYPES, isEnvelopeType } from '../contract/envelopes.ts';
import { SUBSCRIBED_ENVELOPE_TYPES } from '../../../src/envelopeTypes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function pluginEnvelopeTypes(): string[] {
  const src = readFileSync(join(ROOT, 'backends/hermes/plugin/parley_envelopes.py'), 'utf8');
  const m = /ENVELOPE_TYPES\s*=\s*\(([\s\S]*?)\n\)/.exec(src);
  assert.ok(m, 'parley_envelopes.py must declare ENVELOPE_TYPES = (...)');
  const types = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  assert.ok(types.length > 5, `plugin tuple looks empty: ${types}`);
  return types;
}

test('contract: no duplicates, upstream and proxy lists are disjoint', () => {
  assert.equal(new Set(ENVELOPE_TYPES).size, ENVELOPE_TYPES.length);
  for (const t of PROXY_ENVELOPE_TYPES) assert.ok(!(UPSTREAM_ENVELOPE_TYPES as readonly string[]).includes(t), t);
  assert.ok(isEnvelopeType('job_run') && !isEnvelopeType('heartbeat'));
});

test('contract: every type the hermes plugin emits is an upstream type (plugin ⊆ contract)', () => {
  const plugin = pluginEnvelopeTypes();
  const upstream = new Set<string>(UPSTREAM_ENVELOPE_TYPES);
  const unknown = plugin.filter((t) => !upstream.has(t));
  assert.deepEqual(unknown, [], `plugin emits types the proxy would drop: ${unknown}`);
  // And the reverse, so the TS list cannot carry dead upstream types.
  const pluginSet = new Set<string>([...plugin, ...TRANSLATOR_ENVELOPE_TYPES]);
  const dead = UPSTREAM_ENVELOPE_TYPES.filter((t) => !pluginSet.has(t));
  assert.deepEqual(dead, [], `upstream types no backend declares: ${dead}`);
});

test('contract: the PWA subscribes to exactly what the proxy fans out', () => {
  const pwa = [...SUBSCRIBED_ENVELOPE_TYPES].sort();
  const proxy = [...ENVELOPE_TYPES].sort();
  assert.deepEqual(pwa, proxy);
});

test('contract: stream.ts fan-out is the contract set, and job_run / activity_changed reach a tab', async () => {
  process.env.PARLEY_PUSH_OWNED_BY_PLUGIN = 'true';
  const stream = await import('../stream.ts');
  assert.deepEqual([...stream.FANOUT_TYPES].sort(), [...ENVELOPE_TYPES].sort());

  const server = http.createServer((req, res) => stream.handleParleyStream(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const ac = new AbortController();
  const resp = await fetch(`http://127.0.0.1:${port}/api/parley/stream?live_only=1`, { signal: ac.signal });
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  await new Promise((r) => setTimeout(r, 30));

  stream.pushEnvelope({ type: 'job_run', chat_id: 'cron', job_id: 'j1', job_name: 'Nightly', run: { id: 'r1', status: 'running' } });
  stream.pushEnvelope({ type: 'activity_changed', chat_id: '*', cause: 'clear' });
  stream.pushEnvelope({ type: 'heartbeat_not_a_contract_type', chat_id: 'x' } as any);

  let buf = '';
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && !(buf.includes('event: job_run') && buf.includes('event: activity_changed'))) {
    const next = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 60))]);
    if (next && next.value) buf += dec.decode(next.value, { stream: true });
  }
  ac.abort();
  await new Promise<void>((r) => server.close(() => r()));
  assert.ok(buf.includes('event: job_run'), `job_run must be fanned out:\n${buf}`);
  assert.ok(buf.includes('event: activity_changed'), `activity_changed must be fanned out:\n${buf}`);
  assert.ok(!buf.includes('heartbeat_not_a_contract_type'), 'non-contract types are still dropped');
});
