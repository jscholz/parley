/**
 * Data-home resolution for the Sidekick → Parley rename (2026-08).
 *
 * User state (env file, deployment yaml, captures, notifications,
 * media registry, stub-agent data) lives under `~/.parley` going
 * forward, but existing installs — including the owner's live one —
 * still have `~/.sidekick`. Resolution:
 *
 *   1. PARLEY_HOME env (legacy SIDEKICK_HOME honored via proxy/env.mjs)
 *   2. ~/.parley    — when it exists
 *   3. ~/.sidekick  — when it exists (KEEP READING the old dir; we
 *                     deliberately never move/copy a live dir)
 *   4. ~/.parley    — fresh installs get the new name
 *
 * Removal condition: drop step 3 once no install has a ~/.sidekick dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv } from './env.mjs';

/** Resolve the Parley data home. `env`/`homedir` injectable for tests. */
export function dataHome(env = process.env, homedir = os.homedir()) {
  const explicit = readEnv('PARLEY_HOME', env);
  if (explicit) return explicit;
  const parley = path.join(homedir, '.parley');
  if (fs.existsSync(parley)) return parley;
  const legacy = path.join(homedir, '.sidekick');
  if (fs.existsSync(legacy)) return legacy;
  return parley;
}
