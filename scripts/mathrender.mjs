#!/usr/bin/env node
/**
 * Math render harness (not a smoke). Boots a THROWAWAY Parley server on a
 * free port with a throwaway PARLEY_HOME — same shape as
 * run-smoke-isolated.mjs, and here for the same reason: CONTRIBUTING's
 * rule is never point a harness at the live :3001, and a render harness
 * that seeds chats and prefs must not do it against his real data.
 *
 *   node scripts/mathrender.mjs [label]     # default label: math
 *
 * Seeds a transcript of Jonathan's actual example plus the cases the
 * styling has to survive — a long expression that must scroll at 390px, a
 * matrix, math inside a code fence, and a deliberately malformed
 * expression (which must show its literal source) — then shoots
 * phone × {dark,light} and desktop × {dark,light} into
 * /tmp/ux-renders/<label>/.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LABEL = process.argv[2] || 'math';
const OUT = `/tmp/ux-renders/${LABEL}`;

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
const home = mkdtempSync(path.join(os.tmpdir(), 'parley-mathrender-home-'));
const config = path.join(home, 'parley.config.yaml');
copyFileSync(path.join(ROOT, 'example.parley.config.yaml'), config);

const server = spawn(
  process.execPath,
  ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server.ts'],
  {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PARLEY_HOME: home, PARLEY_CONFIG: config },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  },
);
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
await waitForIsolated(port);
process.env.SMOKE_URL = `http://127.0.0.1:${port}`;
console.log(`[mathrender] server :${port}  home ${home}`);

const { launchSharedBrowser, launchBrowser, waitForReady } =
  await import('./smoke/lib.mjs');
const { installMockBackend } = await import('./smoke/mock-backend.mjs');

const URL_ = `http://127.0.0.1:${port}`;
const CHAT = 'math-demo';
const tSec = Date.now() / 1000;

// Jonathan's screenshot, verbatim, plus the cases the CSS must survive.
const MESSAGES = [
  {
    role: 'user',
    content: 'Why does a wrench orthogonal to the twist do no work?',
    message_id: 'm1', parley_id: 'm1', timestamp: tSec - 600,
  },
  {
    role: 'assistant',
    content: `Power is the pairing of a wrench with a twist:

\\[
P = w^\\top v
\\]

A wrench component satisfying \\(w^\\top v=0\\) has no kinematic signature. That is the constraint-force subspace: it shows up in the force sensor and never in the velocity.`,
    message_id: 'm2', parley_id: 'm2', timestamp: tSec - 580,
  },
  {
    role: 'user',
    content: 'Show me the full manipulator equation and the wrench basis.',
    message_id: 'm3', parley_id: 'm3', timestamp: tSec - 300,
  },
  {
    role: 'assistant',
    content: `The rigid-body dynamics, written out in full — this one is wider than a phone, so the block scrolls:

$$ M(q)\\ddot{q} + C(q,\\dot{q})\\dot{q} + g(q) = \\tau + \\sum_{i=1}^{n} J_i(q)^\\top w_i + \\int_0^t K(t-s)\\,\\dot{q}(s)\\,ds $$

The contact wrench basis for a point contact with friction:

\\[
B_c = \\begin{bmatrix} 1 & 0 & 0 \\\\ 0 & 1 & 0 \\\\ 0 & 0 & 1 \\\\ 0 & 0 & 0 \\end{bmatrix}
\\]

with the cone \\(\\|f_t\\| \\leq \\mu f_n\\). Costs about $5 to $10 of compute per sweep, so single dollars stay literal.`,
    message_id: 'm4', parley_id: 'm4', timestamp: tSec - 280,
  },
  {
    role: 'assistant',
    content: `Source form, so you can paste it — code wins over math:

\`\`\`latex
\\[
P = w^\\top v
\\]
\`\`\`

And a deliberately malformed one, which must show its literal source rather than blow up the bubble: \\[ \\frac{1}{ \\]`,
    message_id: 'm5', parley_id: 'm5', timestamp: tSec - 100,
  },
];

function seed(mock) {
  mock.addChat(CHAT, {
    title: 'Wrench / twist pairing',
    source: 'parley',
    messages: MESSAGES,
    lastActiveAt: Date.now(),
  });
}

async function shoot(browser, { mobile, theme }) {
  const { page, cleanup } = await launchBrowser(browser, { mobile });
  const mock = await installMockBackend(page);
  seed(mock);
  await waitForReady(page, URL_);
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.click(`#sessions-list li[data-chat-id="${CHAT}"]`).catch(() => {});
  // Wait for the lazily-imported Temml bundle + the upgrade sweep, so we
  // never shoot the transient raw-LaTeX state and call it the design.
  await page.waitForFunction(() => {
    const els = document.querySelectorAll('#transcript math');
    return els.length >= 4 && !document.querySelector('#transcript .math-pending');
  }, null, { timeout: 15_000, polling: 100 });
  await page.waitForTimeout(400);
  const variant = `${mobile ? 'mobile' : 'desktop'}-${theme}`;
  // The transcript is its own scroller, so a fullPage shot only ever
  // catches wherever it is parked (the tail). Take a frame at the top —
  // where his actual example and the must-scroll equation live — and one
  // at the bottom, where the code fence and the malformed fallback are.
  await page.evaluate(() => {
    const t = document.querySelector('#transcript');
    if (t) t.scrollTop = 0;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${variant}-top.png`, fullPage: true });
  console.log('shot', `${variant}-top.png`);
  await page.evaluate(() => {
    const t = document.querySelector('#transcript');
    if (t) t.scrollTop = Math.round(t.scrollHeight * 0.42);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${variant}-mid.png`, fullPage: true });
  console.log('shot', `${variant}-mid.png`);
  await page.evaluate(() => {
    const t = document.querySelector('#transcript');
    if (t) t.scrollTop = t.scrollHeight;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${variant}-bottom.png`, fullPage: true });
  console.log('shot', `${variant}-bottom.png`);
  await mock.close?.().catch?.(() => {});
  await cleanup();
}

mkdirSync(OUT, { recursive: true });
const { browser, closeShared } = await launchSharedBrowser({});
for (const mobile of [true, false]) {
  for (const theme of ['dark', 'light']) {
    await shoot(browser, { mobile, theme });
  }
}
await closeShared();
console.log('DONE ->', OUT);
teardown();
process.exit(0);
