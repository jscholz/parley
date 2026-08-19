// Unit tests for the upstream /v1 route-prefix resolver
// (proxy/parley/upstreamRoutePrefix.ts) — the new-proxy/pre-rename-
// plugin compat shim from the Sidekick → Parley rename.
//
// Contract under test:
//   - non-404 probe answer (200/401/503/…) → '/v1/parley', memoized
//     for the process lifetime (routes can't regress).
//   - 404 → '/v1/sidekick', NOT final (re-probes after the TTL so a
//     plugin upgrade is adopted).
//   - probe failure (upstream down) → '/v1/parley', NOT final.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  upstreamV1Prefix,
  resetUpstreamV1PrefixForTests,
} from '../upstreamRoutePrefix.ts';

const realFetch = globalThis.fetch;
let fetchCalls = 0;

function stubFetch(responder: () => Promise<Response>) {
  globalThis.fetch = ((..._args: unknown[]) => {
    fetchCalls++;
    return responder();
  }) as typeof fetch;
}

beforeEach(() => {
  fetchCalls = 0;
  resetUpstreamV1PrefixForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('non-404 answer resolves to /v1/parley and memoizes for good', async () => {
  stubFetch(async () => new Response('{}', { status: 200 }));
  assert.equal(await upstreamV1Prefix(), '/v1/parley');
  assert.equal(await upstreamV1Prefix(), '/v1/parley');
  assert.equal(fetchCalls, 1, 'final verdict must not re-probe');
});

test('401 (route exists, auth wrong) still counts as /v1/parley', async () => {
  stubFetch(async () => new Response('unauthorized', { status: 401 }));
  assert.equal(await upstreamV1Prefix(), '/v1/parley');
  assert.equal(fetchCalls, 1);
});

test('404 resolves to the legacy /v1/sidekick prefix', async () => {
  stubFetch(async () => new Response('not found', { status: 404 }));
  assert.equal(await upstreamV1Prefix(), '/v1/sidekick');
  // Within the TTL the memo answers without a new probe.
  assert.equal(await upstreamV1Prefix(), '/v1/sidekick');
  assert.equal(fetchCalls, 1, 'legacy verdict memoized within the TTL');
});

test('probe failure keeps the primary spelling without finalizing', async () => {
  stubFetch(async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(await upstreamV1Prefix(), '/v1/parley');
  assert.equal(fetchCalls, 1);
  // A later probe (post-reset stands in for TTL expiry) can still
  // discover a pre-rename upstream — the error verdict wasn't final.
  resetUpstreamV1PrefixForTests();
  stubFetch(async () => new Response('not found', { status: 404 }));
  assert.equal(await upstreamV1Prefix(), '/v1/sidekick');
});

test('concurrent callers share one in-flight probe', async () => {
  let release: (r: Response) => void;
  const gate = new Promise<Response>((res) => { release = res; });
  stubFetch(() => gate);
  const [a, b] = [upstreamV1Prefix(), upstreamV1Prefix()];
  release!(new Response('{}', { status: 200 }));
  assert.deepEqual(await Promise.all([a, b]), ['/v1/parley', '/v1/parley']);
  assert.equal(fetchCalls, 1, 'second caller must piggyback the in-flight probe');
});
