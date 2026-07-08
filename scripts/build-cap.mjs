#!/usr/bin/env node
/**
 * Populates the Capacitor webDir (mobile/webdir/) with the FULL app so the
 * iOS/Android shell serves assets locally (capacitor://localhost) for a
 * native-fast cold boot. Only server API calls go to the remote host (via
 * src/apiBase.ts); assets never touch the network.
 *
 * Run AFTER `npm run build` (it copies the compiled build/ output). The
 * `build:cap` npm script chains both.
 *
 * Layout produced in mobile/webdir/:
 *   index.html   — the committed host-picker (NOT overwritten here). It's
 *                  the launch entry; it saves the server URL then navigates
 *                  to ./app.html (the local app).
 *   app.html     — copy of the repo-root index.html (the real app).
 *   build/       — compiled .mjs (+ vendor bundles).
 *   styles/      — app.css etc.
 *   assets/      — icons, VAD wasm/onnx, etc.
 *   manifest.json, sw.js
 *
 * Everything except index.html is generated and gitignored.
 */

import { rm, cp, copyFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEBDIR = join(ROOT, 'mobile/webdir');

// Generated entries we own — wiped on each run so stale files don't linger.
// index.html (the host-picker) is deliberately absent: it's committed.
const DIRS = ['build', 'styles', 'assets'];
// capture-probe.html is TEMPORARY (capture Phase-1 CAP checkpoint —
// lock-screen recording spike, linked from Settings → Interaction).
// Drop it from this list when the probe file is deleted.
const FILES = ['manifest.json', 'sw.js', 'capture-probe.html'];

async function main() {
  await mkdir(WEBDIR, { recursive: true });

  // Clean previously-generated entries.
  for (const d of [...DIRS, ...FILES, 'app.html']) {
    await rm(join(WEBDIR, d), { recursive: true, force: true });
  }

  // The real app's HTML ships as app.html (index.html is the host-picker).
  // Prefer the hashed-build index (build/index.html — import map + hashed
  // entry, written by build.mjs); fall back to the vanilla root index.html
  // for unhashed dev builds.
  await copyFile(join(ROOT, 'build/index.html'), join(WEBDIR, 'app.html'))
    .catch(() => copyFile(join(ROOT, 'index.html'), join(WEBDIR, 'app.html')));

  for (const d of DIRS) {
    await cp(join(ROOT, d), join(WEBDIR, d), { recursive: true });
  }
  for (const f of FILES) {
    await copyFile(join(ROOT, f), join(WEBDIR, f));
  }

  console.log(`[build:cap] webdir populated → mobile/webdir/ (app.html + ${DIRS.join('/, ')}/ + ${FILES.join(', ')})`);
}

main().catch((err) => {
  console.error('[build:cap] failed:', err);
  process.exit(1);
});
