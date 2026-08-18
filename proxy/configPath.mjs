/**
 * Deployment-config path resolution (Parley rename, 2026-08).
 *
 * The tuning file is `parley.config.yaml` going forward; existing
 * deployments — including the owner's live gitignored file — still have
 * `sidekick.config.yaml`. Resolution order:
 *
 *   1. PARLEY_CONFIG env (legacy SIDEKICK_CONFIG honored via env.mjs),
 *      when it points at an existing file
 *   2. <dir>/parley.config.yaml
 *   3. <dir>/sidekick.config.yaml   — legacy name, predates the rename
 *   4. <dir>/config.yaml
 *
 * Removal condition: drop step 3 once no deployment carries the old
 * filename.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEnv } from './env.mjs';

export const CONFIG_FILENAMES = ['parley.config.yaml', 'sidekick.config.yaml', 'config.yaml'];

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
