/**
 * Deployment-config path resolution.
 *
 *   1. PARLEY_CONFIG env, when it points at an existing file
 *   2. <dir>/parley.config.yaml
 *   3. <dir>/config.yaml
 *
 * (The legacy `sidekick.config.yaml` step was removed by the 2026-08
 * identity purge; deployed files were renamed in the same cutover.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEnv } from './env.mjs';

export const CONFIG_FILENAMES = ['parley.config.yaml', 'config.yaml'];

/** Resolve the deployment config path, or null when none exists.
 *  `env` injectable for tests; `dir` is where the candidates live
 *  (repo root for the server). */
export function resolveConfigPath(dir, env = process.env) {
  const envPath = readEnv('PARLEY_CONFIG', env);
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const name of CONFIG_FILENAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
