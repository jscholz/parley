/**
 * Legacy HTTP-path alias for the Sidekick → Parley rename (2026-08).
 *
 * The proxy's primary API prefix is `/api/parley/*`. Installed PWA and
 * Capacitor clients on phones keep calling `/api/sidekick/*` until they
 * are rebuilt/refreshed, so server.ts rewrites the legacy prefix to the
 * new one before routing — same handlers, both prefixes.
 *
 * Removal condition: drop the rewrite once no deployed client (check
 * proxy access logs) still calls /api/sidekick/*.
 */

const LEGACY_PREFIX = '/api/sidekick/';
const NEW_PREFIX = '/api/parley/';

/** Rewrite a legacy /api/sidekick/* URL to /api/parley/*; every other
 *  URL passes through untouched. Query strings survive verbatim. */
export function rewriteLegacyApiPath(url) {
  if (typeof url === 'string' && url.startsWith(LEGACY_PREFIX)) {
    return NEW_PREFIX + url.slice(LEGACY_PREFIX.length);
  }
  return url;
}
