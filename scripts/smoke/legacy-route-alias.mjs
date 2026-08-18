// Parley rename (2026-08): the primary API prefix is /api/parley/*, but
// installed PWA/CAP clients on phones keep calling /api/sidekick/* until
// they are rebuilt. server.ts rewrites the legacy prefix to the new one
// before routing (proxy/legacyPaths.mjs) — this smoke pins that the SAME
// handlers answer on both prefixes against a really-running proxy.
//
// Node-level fetch (no page, no mock): the alias lives in the proxy's
// request handler, so it must hold regardless of which upstream is
// wired. Assertions are upstream-agnostic: status parity on every
// probed route, body parity on the deterministic ones, and query-string
// survival through the rewrite.

import { DEFAULT_URL, assert } from './lib.mjs';

export const NAME = 'legacy-route-alias';
export const DESCRIPTION = 'Legacy /api/sidekick/* alias serves the same handlers as /api/parley/*';
export const STATUS = 'implemented';
export const BACKEND = 'either';

export default async function run({ log }) {
  // Status parity everywhere the installed clients call.
  for (const route of ['/sessions', '/commands', '/settings/schema', '/config']) {
    const fresh = await fetch(`${DEFAULT_URL}/api/parley${route}`);
    const legacy = await fetch(`${DEFAULT_URL}/api/sidekick${route}`);
    assert(
      legacy.status === fresh.status,
      `status mismatch on ${route}: legacy=${legacy.status} fresh=${fresh.status}`,
    );
    log(`${route}: both prefixes → ${fresh.status}`);
  }

  // Body parity on a deterministic route (config snapshot is derived
  // from the yaml + defaults; identical across back-to-back calls).
  const a = await (await fetch(`${DEFAULT_URL}/api/parley/config`)).text();
  const b = await (await fetch(`${DEFAULT_URL}/api/sidekick/config`)).text();
  assert(a === b, 'legacy /config body differs from fresh /config body');

  // Query string survives the rewrite (404 would mean the rewrite ate it).
  const q = await fetch(`${DEFAULT_URL}/api/sidekick/sessions?limit=1`);
  const qFresh = await fetch(`${DEFAULT_URL}/api/parley/sessions?limit=1`);
  assert(
    q.status === qFresh.status,
    `query-string rewrite mismatch: legacy=${q.status} fresh=${qFresh.status}`,
  );
}
