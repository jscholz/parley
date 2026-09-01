#!/usr/bin/env node
/**
 * Isolated wrapper for scripts/rectdensity-render.mjs — same shape as
 * scripts/run-smoke-isolated.mjs, and here for the same two reasons.
 *
 *   node scripts/rectdensity-render-isolated.mjs <label>
 *
 *  1. CONTRIBUTING's rule: never point a harness at the live :3001. The
 *     render harness POSTs prefs/pins/activity; those are page.route()d
 *     by the mock, but the guard shouldn't depend on that staying true.
 *  2. A before/after render pair is worthless if both halves are served
 *     by the SAME server. lib.mjs's DEFAULT_URL is :3001, so shooting
 *     "before" from a git worktree still fetches the working tree's
 *     styles/app.css through the running dev server — the two sets come
 *     out identical and the pass looks like it changed nothing. Each run
 *     gets a server rooted in ITS OWN tree.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForIsolated(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no response';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      const j = await r.json();
      if (j?.data_home === 'isolated') return;
      lastErr = `served /health with data_home=${JSON.stringify(j?.data_home)}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server on :${port} never reported an isolated data_home (${lastErr})`);
}

await new Promise((resolve, reject) => {
  const b = spawn(process.execPath, [path.join(__dirname, 'build.mjs')], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  });
  b.on('exit', code => code === 0 ? resolve() : reject(new Error(`build failed (${code})`)));
});

const port = await freePort();
const home = mkdtempSync(path.join(os.tmpdir(), 'parley-render-home-'));
const config = path.join(home, 'parley.config.yaml');
copyFileSync(path.join(ROOT, 'example.parley.config.yaml'), config);

const server = spawn(
  process.execPath,
  ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server.ts'],
  {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PARLEY_HOME: home, PARLEY_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  },
);
const serverLog = [];
server.stdout.on('data', d => serverLog.push(d.toString()));
server.stderr.on('data', d => serverLog.push(d.toString()));

let torndown = false;
function teardown() {
  if (torndown) return;
  torndown = true;
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', teardown);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { teardown(); process.exit(130); });
}

try {
  await waitForIsolated(port);
} catch (e) {
  console.error(`[render:isolated] ${e.message}`);
  console.error(serverLog.join('').split('\n').slice(-20).join('\n'));
  teardown();
  process.exit(2);
}
console.log(`[render:isolated] server :${port}  root ${ROOT}`);

const runner = spawn(
  process.execPath,
  [path.join(__dirname, 'rectdensity-render.mjs'), ...process.argv.slice(2)],
  { cwd: ROOT, env: { ...process.env, SMOKE_URL: `http://127.0.0.1:${port}` }, stdio: 'inherit' },
);
runner.on('exit', (code, signal) => {
  teardown();
  process.exit(signal ? 130 : (code ?? 1));
});
