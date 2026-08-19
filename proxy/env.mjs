/**
 * Env-var compat shim for the Sidekick → Parley rename (2026-08).
 *
 * Every env var this stack reads is named `PARLEY_*` going forward, but
 * deployed machines (systemd drop-ins, ~/.hermes/.env, shell profiles,
 * cron entries) still export the legacy `SIDEKICK_*` spellings. This is
 * the ONE place the fallback lives — do not scatter `||` chains at call
 * sites.
 *
 * Resolution: the first DEFINED value wins, checked new-name-first.
 *   - PARLEY_X set (even to '')            → PARLEY_X
 *   - PARLEY_X unset, SIDEKICK_X set       → SIDEKICK_X
 *   - neither set                          → undefined
 * Presence-based (not truthiness) so call sites that give '' meaning
 * (e.g. PARLEY_AGENT_CMD='' = "skip the stub agent") keep working.
 *
 * Plain .mjs (not .ts) so both the type-stripped TS server code and the
 * un-stripped scripts/*.mjs + bin/cli.mjs can import it.
 *
 * Removal condition: delete the SIDEKICK_* fallback once no deployment
 * (systemd units, ~/.hermes/.env, shells) exports SIDEKICK_* anymore.
 *
 * Python twin: backends/hermes/plugin/parley_env.py (and the copy in
 * audio-bridge/parley_env.py) — keep the three in sync.
 */

const NEW_PREFIX = 'PARLEY_';
const LEGACY_PREFIX = 'SIDEKICK_';

/** Legacy (SIDEKICK_*) spelling for a PARLEY_* name, or null when the
 *  name is not PARLEY_-prefixed (PORT, HOST, …). */
export function legacyEnvName(name) {
  return name.startsWith(NEW_PREFIX)
    ? LEGACY_PREFIX + name.slice(NEW_PREFIX.length)
    : null;
}

/** Read an env var by its PARLEY_* name, honoring the legacy SIDEKICK_*
 *  spelling as a fallback. New name wins when both are set. */
export function readEnv(name, env = process.env) {
  if (env[name] !== undefined) return env[name];
  const legacy = legacyEnvName(name);
  if (legacy && env[legacy] !== undefined) return env[legacy];
  return undefined;
}

/** True when either spelling is defined. */
export function envIsSet(name, env = process.env) {
  return readEnv(name, env) !== undefined;
}

/** Set a default on an env object: writes `name` only when NEITHER
 *  spelling is already defined (a plain `env.PARLEY_X ??= v` would
 *  shadow a deployment's legacy SIDEKICK_X). */
export function setDefaultEnv(env, name, value) {
  if (!envIsSet(name, env)) env[name] = value;
  return readEnv(name, env);
}
