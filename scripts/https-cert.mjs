/**
 * Self-signed cert provisioning for the auto-HTTPS trial path.
 *
 * WHY: browsers gate getUserMedia (mic), push, and PWA install behind a
 * secure context — localhost is exempt, but the "open Sidekick on your
 * phone" moment dies on plain HTTP. The FTUE research (2026-07-07)
 * found this is THE documented voice-breaking failure mode for
 * self-hosted chat UIs; none solve it out of the box. We do: generate a
 * self-signed cert once, serve HTTPS alongside HTTP, and let the phone
 * user click through the one-time browser warning.
 *
 * Zero new deps: shells out to openssl (ubiquitous on Linux/macOS; if
 * absent we skip HTTPS and say how to get it). The cert carries SANs
 * for localhost + 127.0.0.1 + the current LAN IPs; a sidecar meta file
 * records the SAN list so a changed LAN IP regenerates automatically.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** First non-internal IPv4 addresses, most-plausible-LAN first. */
export function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

export function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * Ensure a self-signed cert exists in `dir` covering the current LAN
 * IPs. Reuses a previous cert when its SAN set still matches.
 * @returns {{ certFile: string, keyFile: string, sans: string[] } | null}
 */
export function ensureSelfSignedCert(dir) {
  if (!opensslAvailable()) return null;
  fs.mkdirSync(dir, { recursive: true });
  const certFile = path.join(dir, 'sidekick.crt');
  const keyFile = path.join(dir, 'sidekick.key');
  const metaFile = path.join(dir, 'sidekick.cert-meta.json');

  const ips = ['127.0.0.1', ...lanAddresses()];
  const sans = ['DNS:localhost', ...ips.map(ip => `IP:${ip}`)];

  // Reuse when the SAN set is unchanged and both files exist.
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (
      Array.isArray(meta?.sans)
      && meta.sans.join(',') === sans.join(',')
      && fs.existsSync(certFile) && fs.existsSync(keyFile)
    ) {
      return { certFile, keyFile, sans };
    }
  } catch { /* no/invalid meta — regenerate */ }

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', keyFile, '-out', certFile,
      '-days', '825',
      '-subj', '/CN=sidekick.local',
      '-addext', `subjectAltName=${sans.join(',')}`,
    ], { stdio: 'ignore' });
    fs.chmodSync(keyFile, 0o600);
    fs.writeFileSync(metaFile, JSON.stringify({ sans, createdAt: new Date().toISOString() }));
    return { certFile, keyFile, sans };
  } catch {
    return null;
  }
}
