#!/usr/bin/env node
/**
 * Boot the sidekick proxy AND the in-tree stub agent in one command.
 *
 * Spawns two child processes:
 *   - proxy: `node --experimental-strip-types ... server.ts`
 *   - agent: `cd backends/stub && npm start` (echo LLM)
 *
 * Stdout from each is prefixed (`[proxy]` / `[agent]`) so a single
 * terminal can follow both. SIGINT (Ctrl-C) cleanly tears down both
 * children before the script exits.
 *
 * Ports + URLs
 * ────────────
 * Reads PROXY_PORT (or PORT) and AGENT_PORT from the env. Defaults:
 * 3001 / 4001. If either port is busy, the pair shifts forward
 * together (3002/4002, 3003/4003, ...) up to PORT_RETRY_MAX so the
 * proxy always knows where the agent is. Pass `PARLEY_PLATFORM_URL`
 * explicitly to point the proxy at an already-running agent (and set
 * `PARLEY_AGENT_CMD=` to skip booting the in-tree stub).
 *
 * No new dep — pure `child_process`. Used by `npm start`.
 *
 * Override the agent command with `PARLEY_AGENT_CMD` to swap the
 * stub for a different upstream (a different binary, a docker exec,
 * etc.). Set it to an empty string to skip starting the agent
 * entirely (useful when running against an already-running
 * backends/hermes/plugin).
 */
import { spawn } from 'node:child_process';
import { readEnv } from '../proxy/env.mjs';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Load .env into process.env BEFORE reading any config below. Nothing
// else in the terminal path does this — systemd deployments get it via
// EnvironmentFile=, but `npm start` / install.sh users were silently
// running without their .env (the README's "add a Deepgram key to
// .env" promise was broken outside systemd). Real env vars win:
// loadEnvFile never overrides variables that are already set.
// PARLEY_ENV_FILE lets the npx launcher (bin/cli.mjs) point at a
// data-home .env outside the (ephemeral) package directory.
const envFile = readEnv('PARLEY_ENV_FILE') ?? path.join(REPO_ROOT, '.env');
try {
  process.loadEnvFile(envFile);
  process.stdout.write(`[start-all] loaded env from ${envFile}\n`);
} catch {
  // No .env — fine; defaults + real env vars cover the ground.
}

const PORT_RETRY_MAX = 8;

/** Probe whether `port` is bindable on 127.0.0.1. Resolves true if
 *  free, false if EADDRINUSE. Other errors propagate. */
function portFree(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
      else reject(err);
    });
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** Find the first pair (proxy, agent) that's both free, starting at
 *  the requested base. Shifts the pair forward together so the proxy
 *  → agent URL stays in sync. */
async function pickPortPair(baseProxy, baseAgent) {
  for (let i = 0; i < PORT_RETRY_MAX; i++) {
    const proxyPort = baseProxy + i;
    const agentPort = baseAgent + i;
    if (await portFree(proxyPort) && await portFree(agentPort)) {
      return { proxyPort, agentPort, shifted: i > 0 };
    }
  }
  return null;
}

const agentCmd = readEnv('PARLEY_AGENT_CMD');
const skipAgent = agentCmd === '';

const requestedProxy = Number(process.env.PROXY_PORT ?? process.env.PORT ?? 3001);
const requestedAgent = Number(process.env.AGENT_PORT ?? 4001);

let proxyPort = requestedProxy;
let agentPort = requestedAgent;

// Skip auto-shift when the user pinned an explicit upstream URL —
// they're driving the agent themselves and the proxy port is the only
// thing we need free.
const explicitUpstream = !!readEnv('PARLEY_PLATFORM_URL');

if (skipAgent || explicitUpstream) {
  if (!(await portFree(proxyPort))) {
    console.error(`[start-all] proxy port ${proxyPort} is busy. Set PROXY_PORT to override.`);
    process.exit(1);
  }
} else {
  const pair = await pickPortPair(requestedProxy, requestedAgent);
  if (!pair) {
    console.error(
      `[start-all] couldn't find a free port pair after ${PORT_RETRY_MAX} attempts ` +
      `starting at ${requestedProxy}/${requestedAgent}. ` +
      `Free up the ports or set PROXY_PORT/AGENT_PORT explicitly.`,
    );
    process.exit(1);
  }
  proxyPort = pair.proxyPort;
  agentPort = pair.agentPort;
  if (pair.shifted) {
    process.stdout.write(
      `[start-all] ports ${requestedProxy}/${requestedAgent} busy — using ${proxyPort}/${agentPort} instead\n`,
    );
  }
}

// Proxy reads PORT for itself and PARLEY_PLATFORM_URL for upstream.
// We always set both so the children's own defaults can't drift.
const upstreamUrl = readEnv('PARLEY_PLATFORM_URL') ?? `http://127.0.0.1:${agentPort}`;

/** Spawn with prefixed stdout so `[proxy]` and `[agent]` lines are
 *  distinguishable in one terminal. Inherits stderr to surface
 *  crashes loudly. */
function spawnPrefixed(label, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const prefix = `[${label}] `;
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      process.stdout.write(prefix + buf.slice(0, idx + 1));
      buf = buf.slice(idx + 1);
      idx = buf.indexOf('\n');
    }
  });
  child.on('exit', (code, signal) => {
    if (buf.length) process.stdout.write(prefix + buf + '\n');
    process.stdout.write(prefix + `exited (code=${code}${signal ? `, signal=${signal}` : ''})\n`);
  });
  return child;
}

// ── Auto-HTTPS (trial path) ──────────────────────────────────────────
// Phones need a secure context for mic/PWA/push; localhost is exempt
// but LAN access is not. When enabled (SIDEKICK_AUTO_HTTPS=1 — the npx
// launcher's default) and no cert is explicitly configured, provision a
// self-signed cert and have the proxy serve HTTPS on HTTPS_PORT
// alongside HTTP (server.ts dual mode). Opt-in for plain `npm start`
// so existing deployments (systemd, reverse-proxied) see no new
// listener unless asked.
let httpsInfo = null;
const autoHttpsWanted = readEnv('PARLEY_AUTO_HTTPS') === '1'
  && !readEnv('PARLEY_HTTPS_CERT_FILE');
if (autoHttpsWanted) {
  const { ensureSelfSignedCert, lanAddresses } = await import('./https-cert.mjs');
  const envHome = readEnv('PARLEY_HOME');
  const certDir = readEnv('PARLEY_CERT_DIR')
    || (envHome ? path.join(envHome, 'certs')
        : path.join(REPO_ROOT, '.certs'));
  const cert = ensureSelfSignedCert(certDir);
  if (cert) {
    const httpsPort = Number(readEnv('PARLEY_HTTPS_PORT') || proxyPort + 442);
    httpsInfo = { ...cert, port: httpsPort, lan: lanAddresses()[0] || null };
  } else {
    process.stdout.write(
      '[start-all] openssl not found — skipping auto-HTTPS (phone mic/PWA need it;'
      + ' install openssl and restart, or configure PARLEY_HTTPS_CERT_FILE)\n',
    );
  }
}

// Prefer the bundled server.mjs (built by scripts/build.mjs; ships in the
// npm tarball) — Node refuses --experimental-strip-types for files under
// node_modules, so npm/npx installs CANNOT run server.ts. Dev checkouts
// without a bundle fall back to strip-types as before.
const serverBundle = path.join(REPO_ROOT, 'server.mjs');
const proxyArgs = fs.existsSync(serverBundle)
  ? [serverBundle]
  : ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server.ts'];
const proxy = spawnPrefixed(
  'proxy',
  process.execPath,
  proxyArgs,
  { env: {
      PORT: String(proxyPort),
      PARLEY_PLATFORM_URL: upstreamUrl,
      ...(httpsInfo ? {
        PARLEY_HTTPS_CERT_FILE: httpsInfo.certFile,
        PARLEY_HTTPS_KEY_FILE: httpsInfo.keyFile,
        PARLEY_HTTPS_PORT: String(httpsInfo.port),
      } : {}),
  } },
);

let agent = null;
if (!skipAgent) {
  if (agentCmd) {
    // User-supplied agent command (e.g. `node my-agent.mjs`). Split on
    // whitespace; not shell-quoting-aware, but adequate for the
    // straightforward override path most callers want.
    const [bin, ...args] = agentCmd.split(/\s+/).filter(Boolean);
    agent = spawnPrefixed('agent', bin, args, {
      env: { AGENT_PORT: String(agentPort) },
    });
  } else {
    // Default: in-tree stub agent.
    agent = spawnPrefixed('agent', 'npm', ['start'], {
      cwd: path.join(REPO_ROOT, 'backends', 'stub'),
      env: { AGENT_PORT: String(agentPort) },
    });
  }
}

// Two prints: a prominent banner with the URL the user should open
// (the proxy / PWA), and a follow-up dev line that names both ports
// for log-readers. install.sh's "Open the URL printed below" wording
// points readers at the banner — keep it visually distinct from the
// child-prefixed log lines so it doesn't get lost in the boot spew.
const userUrl = `http://localhost:${proxyPort}`;
const phoneUrl = httpsInfo?.lan ? `https://${httpsInfo.lan}:${httpsInfo.port}` : null;
process.stdout.write(
  '\n' +
  '────────────────────────────────────────────────────────\n' +
  `  Sidekick is ready — open ${userUrl} in your browser.\n` +
  (phoneUrl
    ? `  On your phone (same wifi): ${phoneUrl}\n` +
      '  (self-signed cert — accept the one-time browser warning)\n'
    : '') +
  '────────────────────────────────────────────────────────\n\n',
);
// QR for the phone URL — the "add to home screen" moment shouldn't
// require typing an IP. Best-effort: qrcode-terminal is a tiny dep but
// keep boot resilient if it's somehow absent.
if (phoneUrl) {
  try {
    const { default: qrcode } = await import('qrcode-terminal');
    qrcode.generate(phoneUrl, { small: true }, (qr) => process.stdout.write(qr + '\n'));
  } catch { /* dep missing — the printed URL above still works */ }
}
process.stdout.write(
  `[start-all] proxy on ${userUrl}` +
  (skipAgent ? ' (no in-tree agent)\n' : `, agent on http://127.0.0.1:${agentPort}\n`),
);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[start-all] received ${signal}, stopping children…\n`);
  for (const child of [proxy, agent].filter(Boolean)) {
    try { child.kill(signal); } catch {}
  }
  // Hard backstop — if a child ignores the first signal, force-kill
  // after a grace window so the parent doesn't hang.
  setTimeout(() => {
    for (const child of [proxy, agent].filter(Boolean)) {
      try { child.kill('SIGKILL'); } catch {}
    }
    process.exit(0);
  }, 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// If either child exits unexpectedly, take the other down with it —
// running half a stack just makes diagnosis harder.
proxy.on('exit', () => shutdown('SIGTERM'));
if (agent) agent.on('exit', () => shutdown('SIGTERM'));
