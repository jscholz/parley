#!/usr/bin/env node
/**
 * Smoke suite, self-contained: starts a throwaway Parley server on a free
 * port with a throwaway PARLEY_HOME, runs the suite against it, and tears
 * everything down — including on Ctrl-C and on crash.
 *
 *   npm run smoke:isolated                 # whole suite
 *   npm run smoke:isolated -- drill-window-cache   # filter, flags pass through
 *
 * Why this exists rather than a paragraph in CONTRIBUTING telling you to
 * export three env vars by hand:
 *
 *  - The suite POSTs to /api/parley/config/<key>. Pointed at the live
 *    proxy it silently rewrites real voice settings (tts, realtime,
 *    bargeIn, commitPhrase, …). run-smoke.mjs now refuses a live target,
 *    but refusing is only half a fix — the safe path also has to be the
 *    easy one, or people route around the guard.
 *  - Hand-rolled setups leak. A backgrounded server survives the shell
 *    that started it, and `kill <pid>` misses it because the nohup'd node
 *    spawns a CHILD (galatea, 2026-08-25: two orphaned stacks, found only
 *    by `ss -ltn`). This spawns a process GROUP and kills the group.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Ask the OS for a free port rather than guessing one — a hardcoded
 *  port collides with a colleague's stack or a previous leaked run. */
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
      // Not just "is it up" — assert it is the SANDBOX. If this ever
      // reports 'live' the port was already taken by the real server and
      // running here would edit production settings.
      if (j?.data_home === 'isolated') return;
      lastErr = `served /health with data_home=${JSON.stringify(j?.data_home)}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server on :${port} never reported an isolated data_home (${lastErr})`);
}

const port = await freePort();
const home = mkdtempSync(path.join(os.tmpdir(), 'parley-smoke-home-'));

// Seed a deployment config. Without one the settings endpoint answers
// every write with `no parley.config.yaml configured (set PARLEY_CONFIG)`
// — and `resetServerSettings` treats write failures as non-fatal, so the
// suite runs on whatever defaults the server booted with and the failure
// surfaces much later as a wrong-behaviour assertion. That is exactly how
// listen-local-engine failed on a sandbox (2026-08-25): it asks for
// streamingEngine='local', the write was rejected, the client stayed on
// the server engine, and the test reported the product as broken.
const config = path.join(home, 'parley.config.yaml');
copyFileSync(path.join(ROOT, 'example.parley.config.yaml'), config);

const server = spawn(
  process.execPath,
  ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server.ts'],
  {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PARLEY_HOME: home, PARLEY_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,        // own process group, so teardown gets the children too
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
  console.error(`[smoke:isolated] ${e.message}`);
  console.error(serverLog.join('').split('\n').slice(-20).join('\n'));
  teardown();
  process.exit(2);
}

console.log(`[smoke:isolated] server :${port}  home ${home}`);

const runner = spawn(
  process.execPath,
  [path.join(__dirname, 'run-smoke.mjs'), ...process.argv.slice(2)],
  {
    cwd: ROOT,
    env: { ...process.env, SMOKE_URL: `http://127.0.0.1:${port}` },
    stdio: 'inherit',
  },
);
runner.on('exit', (code, signal) => {
  teardown();
  process.exit(signal ? 130 : (code ?? 1));
});
