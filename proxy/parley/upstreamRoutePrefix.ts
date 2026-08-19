// Upstream /v1 route-prefix resolver for the Sidekick → Parley rename
// (2026-08).
//
// The renamed plugin serves /v1/parley/* with /v1/sidekick/* kept as a
// deprecated alias, so a NEW plugin always answers an OLD proxy. This
// module covers the opposite mixed-version window: a NEW proxy talking
// to a PRE-RENAME plugin that only knows /v1/sidekick/* (the hermes
// agent restarts on its own schedule, not atomically with the proxy).
//
// Resolution: probe the primary spelling once; a 404 means pre-rename
// upstream → use the legacy prefix and re-probe every RECHECK_MS so a
// plugin upgrade is adopted within a minute. Any non-404 answer
// (200/401/503/…) proves the parley routes exist and is cached for the
// process lifetime. Probe failures (upstream down) keep the primary
// spelling — the caller's own error handling owns that case.
//
// Removal condition: delete this module (callers hardcode /v1/parley)
// once no deployment can pair a new proxy with a pre-rename plugin.

import { readEnv } from '../env.mjs';

const UPSTREAM_URL = (process.env.UPSTREAM_URL || 'http://127.0.0.1:8645').replace(/\/+$/, '');
const UPSTREAM_TOKEN = (process.env.UPSTREAM_TOKEN || readEnv('PARLEY_PLATFORM_TOKEN') || '').trim();

const PRIMARY = '/v1/parley';
const LEGACY = '/v1/sidekick';
const RECHECK_MS = 60 * 1000;

type Verdict = { prefix: string; final: boolean };

let cached: (Verdict & { at: number }) | null = null;
let inFlight: Promise<Verdict> | null = null;

async function probe(): Promise<Verdict> {
  try {
    const r = await fetch(`${UPSTREAM_URL}${PRIMARY}/auxiliary-models`, {
      headers: UPSTREAM_TOKEN ? { authorization: `Bearer ${UPSTREAM_TOKEN}` } : {},
    });
    // Any non-404 answer (200/401/503/…) proves the route exists —
    // that can never regress, so it's final. A 404 is a pre-rename
    // plugin: keep re-probing so an upgrade is adopted.
    if (r.status === 404) return { prefix: LEGACY, final: false };
    return { prefix: PRIMARY, final: true };
  } catch {
    // Unreachable — keep the primary spelling but DON'T finalize;
    // the upstream that eventually comes up may be pre-rename.
    return { prefix: PRIMARY, final: false };
  }
}

/** The upstream's /v1 route prefix: '/v1/parley' (post-rename plugin)
 *  or '/v1/sidekick' (pre-rename plugin still running). Memoized;
 *  non-final verdicts are re-probed every RECHECK_MS. */
export async function upstreamV1Prefix(): Promise<string> {
  if (cached && (cached.final || Date.now() - cached.at < RECHECK_MS)) {
    return cached.prefix;
  }
  if (inFlight) return (await inFlight).prefix;
  inFlight = probe().finally(() => { inFlight = null; });
  const verdict = await inFlight;
  cached = { ...verdict, at: Date.now() };
  return verdict.prefix;
}

/** Test hook — drop the memo so a new probe runs. */
export function resetUpstreamV1PrefixForTests(): void {
  cached = null;
  inFlight = null;
}
