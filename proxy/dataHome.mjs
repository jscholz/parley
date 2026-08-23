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
