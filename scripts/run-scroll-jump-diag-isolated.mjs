#!/usr/bin/env node
/**
 * Self-contained runner for scripts/scroll-jump-diag-harness.mjs.
 *
 * The harness itself has NO server of its own — it only mocks
 * /api/parley/* via Playwright page.route(); the static PWA shell still
 * has to come from a real HTTP origin. Pointing --base-url at :3001
 * unconditionally (the harness's own default, kept for back-compat) means
 * every run drives whatever happens to be listening there — on this box
 * that is the OWNER'S LIVE deployment. A previous agent measured
 * "55px before, 0px after" that way without ever rebuilding between arms,
 * so both numbers came from identical code (see the harness's own header
 * comment). This script mirrors run-smoke-isolated.mjs: build the CURRENT
 * worktree, boot a throwaway `server.ts` on a free port with a throwaway
 * PARLEY_HOME, confirm /health reports data_home=isolated, run the diag
 * harness against THAT port, then tear the whole process group down.
 *
 *   node scripts/run-scroll-jump-diag-isolated.mjs [harness flags...]
 *   node scripts/run-scroll-jump-diag-isolated.mjs --wheel-dy=-28 --wheel-interval=8 --assert-max-px=8
 *
 * Every flag after the script name is forwarded verbatim to the harness.
 * A --base-url pointing at THIS run's isolated server is appended after
 * your forwarded flags; the harness's argStr/argNum parsing uses
 * Array.find (first match wins), so if you explicitly pass your own
 * --base-url=... it takes precedence over the one this script adds.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Ask the OS for a free port rather than guessing one. */
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
      // reports 'live' the port was already taken by the real server.
      if (j?.data_home === 'isolated') return;
      lastErr = `served /health with data_home=${JSON.stringify(j?.data_home)}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server on :${port} never reported an isolated data_home (${lastErr})`);
}

// Compile src/ before serving it — build/ is prebuilt static and server.ts
// does NOT rebuild it, so a product change (e.g. the candidate fix in
// src/chat.ts) is invisible to the browser until this runs. This is the
// exact gap that produced the false "55px / 0px" result: no rebuild
// between arms means both measurements graded the same compiled JS.
await new Promise((resolve, reject) => {
  const b = spawn(process.execPath, [path.join(__dirname, 'build.mjs')], {
    cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'],
  });
  b.on('exit', code => code === 0 ? resolve() : reject(new Error(`build failed (${code})`)));
});

const port = await freePort();
const home = mkdtempSync(path.join(os.tmpdir(), 'parley-scroll-diag-home-'));
const config = path.join(home, 'parley.config.yaml');
copyFileSync(path.join(ROOT, 'example.parley.config.yaml'), config);

const server = spawn(
  process.execPath,
  ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server.ts'],
  {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PARLEY_HOME: home, PARLEY_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so teardown gets children too
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
  console.error(`[scroll-diag:isolated] ${e.message}`);
  console.error(serverLog.join('').split('\n').slice(-20).join('\n'));
  teardown();
  process.exit(2);
}

console.log(`[scroll-diag:isolated] server :${port}  home ${home}  worktree ${ROOT}`);

const harness = spawn(
  process.execPath,
  [path.join(__dirname, 'scroll-jump-diag-harness.mjs'), ...process.argv.slice(2), `--base-url=http://127.0.0.1:${port}`],
  { cwd: ROOT, stdio: 'inherit' },
);
harness.on('exit', (code, signal) => {
  teardown();
  process.exit(signal ? 130 : (code ?? 1));
});
