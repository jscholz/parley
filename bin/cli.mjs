#!/usr/bin/env node
/**
 * `npx sidekick-portal` / `sidekick-portal` — one-command front door.
 *
 * Boots the whole trial stack (proxy + in-tree stub agent) from wherever
 * the package lives, with zero repo knowledge required of the user:
 *
 *   npx sidekick-portal            # from the npm registry
 *   npx github:jscholz/sidekick    # straight from GitHub (prepare builds)
 *
 * What it does, in order:
 *   1. Friendly Node >= 22 check (strip-types + loadEnvFile need it).
 *   2. Picks a DATA HOME for user state. Inside a git checkout that's the
 *      repo itself (unchanged dev behavior). From an npx cache / global
 *      install — both ephemeral or read-only — it's ~/.sidekick:
 *        ~/.sidekick/.env                  secrets (seeded from .env.example)
 *        ~/.sidekick/sidekick.config.yaml  optional deployment tuning
 *        ~/.sidekick/data/                 stub-agent conversation store
 *      Wired through the env contracts the stack already honors:
 *      SIDEKICK_ENV_FILE (start-all), SIDEKICK_CONFIG (server.ts),
 *      AGENT_DATA_DIR (backends/stub).
 *   3. Ensures a client build exists (published tarballs ship build/;
 *      a git checkout builds on demand).
 *   4. Hands off to scripts/start-all.mjs.
 */
import { spawnSync, spawn } from 'node:child_process';
import { readEnv, setDefaultEnv } from '../proxy/env.mjs';
import { dataHome } from '../proxy/dataHome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

// ── 1. Node version ─────────────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`Parley needs Node 22+ (you have ${process.version}).`);
  console.error('  macOS:  brew install node');
  console.error('  Linux:  https://nodejs.org or your package manager');
  console.error('  any:    nvm install 22 && nvm use 22');
  process.exit(1);
}

// ── 2. Data home ─────────────────────────────────────────────────────
// A git checkout is a developer working copy: keep every existing path
// convention (.env at repo root, stub data in backends/stub/data).
// Anything else (npx cache, global node_modules) gets the data home:
// ~/.parley for new installs, an existing ~/.sidekick honored in place
// (see proxy/dataHome.mjs).
const isCheckout = fs.existsSync(path.join(PKG_ROOT, '.git'));
const env = { ...process.env };

if (!isCheckout) {
  const home = dataHome(env);
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });

  const envFile = path.join(home, '.env');
  if (!fs.existsSync(envFile)) {
    const example = path.join(PKG_ROOT, '.env.example');
    try { fs.copyFileSync(example, envFile); }
    catch { fs.writeFileSync(envFile, '# Parley secrets — see .env.example in the repo\n'); }
    console.log(`[parley] created ${envFile}`);
  }
  setDefaultEnv(env, 'PARLEY_ENV_FILE', envFile);
  env.AGENT_DATA_DIR ??= path.join(home, 'data');

  // Deployment tuning file — new name preferred, legacy honored.
  for (const name of ['parley.config.yaml', 'sidekick.config.yaml']) {
    const cfgFile = path.join(home, name);
    if (fs.existsSync(cfgFile)) { setDefaultEnv(env, 'PARLEY_CONFIG', cfgFile); break; }
  }
  console.log(`[parley] data home: ${home}`);
}

// ── 3. Ensure a client build exists ──────────────────────────────────
// Published tarballs include build/ (prepack). Git checkouts and git-dep
// installs where prepare was skipped build here, once.
const buildMarker = path.join(PKG_ROOT, 'build', 'index.html');
if (!fs.existsSync(buildMarker)) {
  console.log('[parley] first run — building client (one-time, ~10s)…');
  const r = spawnSync(process.execPath, [path.join(PKG_ROOT, 'scripts', 'build.mjs')], {
    cwd: PKG_ROOT, stdio: 'inherit', env,
  });
  if (r.status !== 0) {
    console.error('[parley] build failed — see output above.');
    process.exit(r.status ?? 1);
  }
}

// Auto-HTTPS defaults ON for the npx trial: phones need a secure
// context for mic/PWA (see scripts/https-cert.mjs). `npm start` in a
// checkout keeps it opt-in. PARLEY_AUTO_HTTPS=0 disables.
setDefaultEnv(env, 'PARLEY_AUTO_HTTPS', '1');

// ── 4. Hand off to the orchestrator ──────────────────────────────────
const child = spawn(
  process.execPath,
  [path.join(PKG_ROOT, 'scripts', 'start-all.mjs')],
  { cwd: PKG_ROOT, stdio: 'inherit', env },
);
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* racing exit */ } });
}
