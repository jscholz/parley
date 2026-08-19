#!/usr/bin/env node
/**
 * Parley barge smoke runner.
 *
 * Boots the orchestrated smoke rig (stub agent, audio-bridge with
 * fixture TTS, parley proxy on smoke ports) and runs the barge
 * scenarios against it. Each scenario gets a fresh chromium context
 * but shares the booted services within a single run.
 *
 * Separate from `npm run smoke` (the existing fast-mocked suite)
 * because the barge rig is heavier — real WebRTC, real audio playback
 * timing, ~30 s per scenario — and shouldn't slow the everyday smokes.
 *
 *   node scripts/run-smoke-barge.mjs                 # run all scenarios
 *   node scripts/run-smoke-barge.mjs silence         # filter by name
 *   node scripts/run-smoke-barge.mjs --headed        # show browsers
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { bootRig, FIXTURES, PROXY_URL } from './smoke-barge/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_DIR = path.join(__dirname, 'smoke-barge');

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const NAME_FILTER = argv.find(a => !a.startsWith('--'));
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM || '/usr/bin/chromium';

function discoverScenarios() {
  return readdirSync(SMOKE_DIR)
    .filter(f => f.endsWith('.mjs') && f !== 'lib.mjs')
    .map(f => path.join(SMOKE_DIR, f));
}

async function loadScenarios() {
  const out = [];
  for (const file of discoverScenarios()) {
    const mod = await import(file);
    if (typeof mod.default !== 'function') continue;
    out.push({
      file,
      name: mod.NAME || path.basename(file, '.mjs'),
      description: mod.DESCRIPTION || '',
      run: mod.default,
    });
  }
  return out;
}

async function runScenario(s, browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1024, height: 800 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  // Note: log capture is per-scenario via attachLogCapture(page) in
  // each scenario file. The runner only watches for fatal page errors.
  page.on('pageerror', err => console.error(`  [page-error] ${err?.message || err}`));
  const log = (...args) => console.log(`  [${s.name}]`, ...args);
  try {
    await s.run({ page, log });
    return { name: s.name, ok: true };
  } catch (e) {
    return { name: s.name, ok: false, error: e?.message || String(e) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  const scenarios = await loadScenarios();
  const filtered = NAME_FILTER
    ? scenarios.filter(s => s.name.includes(NAME_FILTER))
    : scenarios;

  if (filtered.length === 0) {
    console.error(`No scenarios match "${NAME_FILTER || '*'}"`);
    process.exit(1);
  }

  console.log(`Booting barge smoke rig (${filtered.length} scenario(s))…`);
  const teardown = await bootRig({ wavPath: FIXTURES.agentCounts });
  console.log(`Rig ready at ${PROXY_URL}\n`);

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: !HEADED,
  });

  const results = [];
  try {
    for (const s of filtered) {
      console.log(`▶ ${s.name} — ${s.description}`);
      const r = await runScenario(s, browser);
      results.push(r);
      console.log(r.ok ? `  ✓ ${s.name}\n` : `  ✗ ${s.name}: ${r.error}\n`);
    }
  } finally {
    await browser.close();
    await teardown();
  }

  const failed = results.filter(r => !r.ok);
  console.log('────────');
  console.log(`${results.length - failed.length}/${results.length} passed`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.error ? `  (${r.error})` : ''}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
