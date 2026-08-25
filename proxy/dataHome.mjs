/**
 * Data-home resolution.
 *
 * User state (env file, deployment yaml, captures, notifications,
 * media registry, stub-agent data) lives under `~/.parley`:
 *
 *   1. PARLEY_HOME env
 *   2. ~/.parley
 *
 * (The ~/.sidekick fallback was removed by the 2026-08 identity purge;
 * the live dir was moved to ~/.parley in the same cutover.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv } from './env.mjs';

/** Resolve the Parley data home. `env`/`homedir` injectable for tests. */
export function dataHome(env = process.env, homedir = os.homedir()) {
  const explicit = readEnv('PARLEY_HOME', env);
  if (explicit) return explicit;
  return path.join(homedir, '.parley');
}

/** True when this process is backed by the REAL user state dir rather
 *  than a throwaway sandbox.
 *
 *  Test-safety sentinel, surfaced on /health as `data_home`. The smoke
 *  runner refuses to drive a server that reports "live", because
 *  `resetServerSettings` POSTs to /api/parley/config/<key> and would
 *  overwrite the user's actual voice preferences (tts, realtime,
 *  bargeIn, commitPhrase, …). The runner does snapshot-and-restore, but
 *  that is best-effort: a crashed or killed run leaves the live settings
 *  rewritten, which is how a test suite quietly becomes a config editor.
 *
 *  Deliberately compares the RESOLVED path rather than merely asking
 *  whether PARLEY_HOME is set — `PARLEY_HOME=~/.parley` is still live,
 *  and a guard you can defeat by setting an env var is not a guard. */
export function isLiveDataHome(env = process.env, homedir = os.homedir()) {
  return path.resolve(dataHome(env, homedir))
    === path.resolve(path.join(homedir, '.parley'));
}
