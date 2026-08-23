/**
 * Env access for the stack's `PARLEY_*` variables.
 *
 * Historical note: from the 2026-08 Sidekick → Parley rename until the
 * identity purge later that month, `readEnv` resolved a legacy
 * `SIDEKICK_*` fallback spelling. The purge flipped every deployment
 * surface (systemd units, ~/.hermes/.env, the gateway drop-in) to
 * `PARLEY_*`, meeting the documented removal condition, so the fallback
 * is gone. `readEnv`/`envIsSet`/`setDefaultEnv` remain the single
 * call-site convention — do not scatter raw `process.env` chains.
 *
 * Resolution is PRESENCE-based (not truthiness) so call sites that give
 * '' meaning (e.g. PARLEY_AGENT_CMD='' = "skip the stub agent") keep
 * working.
 *
 * Plain .mjs (not .ts) so both the type-stripped TS server code and the
 * un-stripped scripts/*.mjs + bin/cli.mjs can import it.
 *
 * Python twin: backends/hermes/plugin/parley_env.py (and the copy in
 * audio-bridge/parley_env.py) — keep the three in sync.
 */

/** Read an env var by name. `env` injectable for tests. */
export function readEnv(name, env = process.env) {
  return env[name] !== undefined ? env[name] : undefined;
}

/** True when the var is defined (even as an empty string). */
export function envIsSet(name, env = process.env) {
  return readEnv(name, env) !== undefined;
}

/** Set a default on an env object: writes `name` only when it is not
 *  already defined. */
export function setDefaultEnv(env, name, value) {
  if (!envIsSet(name, env)) env[name] = value;
  return readEnv(name, env);
}
