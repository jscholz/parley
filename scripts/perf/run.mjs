#!/usr/bin/env node
/**
 * Sidekick perf measurement runner.
 *
 * Discovers every scripts/perf/*.mjs scenario (except lib.mjs and this
 * file), runs each, collects p50/p95/min/max for the metrics it
 * reports, prints a summary table, and writes a JSON snapshot to
 * /tmp/perf-<ISO>.json for trend tracking.
 *
 * Usage:
 *   node scripts/perf/run.mjs                 # all scenarios, default N
 *   node scripts/perf/run.mjs text-turn       # filter by name
 *   node scripts/perf/run.mjs --runs 5        # override N (per-scenario default still wins if larger)
 *   node scripts/perf/run.mjs --runs 5 --force-runs
 *                                             # --force-runs overrides per-scenario defaults
 *   node scripts/perf/run.mjs --skip cold-switch warm-switch
 *
 * Each scenario module exports:
 *   NAME, DESCRIPTION, DEFAULT_RUNS, BACKEND
 *   default async function run({ N, log }): Promise<{ [metric]: number[] }>
 *
 * Exit codes:
 *   0 — all scenarios completed (failed iterations are reported but
 *       individual scenario throws abort that scenario only)
 *   1 — at least one scenario threw before producing samples
 */

import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printTable } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERF_DIR = __dirname;

const argv = process.argv.slice(2);
const filterArgs = [];
const skipArgs = [];
let runsOverride = null;
let forceRuns = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--runs') { runsOverride = Number(argv[++i]); continue; }
  if (a === '--force-runs') { forceRuns = true; continue; }
  if (a === '--skip') {
    while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      skipArgs.push(argv[++i]);
    }
    continue;
  }
  if (!a.startsWith('--')) filterArgs.push(a);
}

async function loadScenarios() {
  const files = readdirSync(PERF_DIR)
    .filter((f) => f.endsWith('.mjs') && f !== 'lib.mjs' && f !== 'run.mjs')
    .sort();
  const scenarios = [];
  for (const f of files) {
    const mod = await import(path.join(PERF_DIR, f));
    if (typeof mod.default !== 'function') continue;
    scenarios.push({
      file: f,
      name: mod.NAME || f.replace(/\.mjs$/, ''),
      description: mod.DESCRIPTION || '',
      defaultRuns: typeof mod.DEFAULT_RUNS === 'number' ? mod.DEFAULT_RUNS : 5,
      backend: mod.BACKEND || 'real',
      run: mod.default,
    });
  }
  return scenarios;
}

async function main() {
  const scenarios = await loadScenarios();
  let runnable = scenarios;
  if (filterArgs.length > 0) {
    runnable = runnable.filter((s) => filterArgs.some((f) => s.name.includes(f)));
  }
  if (skipArgs.length > 0) {
    runnable = runnable.filter((s) => !skipArgs.includes(s.name));
  }
  if (!runnable.length) {
    console.error('[perf] no scenarios match filter');
    process.exit(2);
  }

  console.log(`[perf] running ${runnable.length} scenario(s) against ${process.env.SMOKE_URL || 'http://127.0.0.1:3001'}`);
  const results = [];
  let exitCode = 0;

  for (const s of runnable) {
    const N = forceRuns && runsOverride
      ? runsOverride
      : (runsOverride != null ? Math.max(s.defaultRuns, runsOverride) : s.defaultRuns);
    console.log(`\n[perf] ▶ ${s.name} (N=${N}, backend=${s.backend})`);
    console.log(`        ${s.description}`);
    const t0 = Date.now();
    let samples = null;
    let error = null;
    try {
      samples = await s.run({ N, log: (m) => console.log(m) });
    } catch (e) {
      error = e;
      exitCode = 1;
    }
    const elapsedMs = Date.now() - t0;
    console.log(`        ⏱  scenario took ${(elapsedMs / 1000).toFixed(1)}s`);
    if (error) {
      console.log(`        ✗ ERROR: ${error.message}`);
      if (error.stack) console.log(error.stack.split('\n').slice(0, 6).join('\n'));
    }
    results.push({
      name: s.name,
      backend: s.backend,
      N,
      elapsedMs,
      samples: samples || {},
      error: error ? error.message : null,
    });
  }

  console.log('\n══════ PERF SUMMARY ══════');
  printTable(results.map((r) => ({ label: r.name, samples: r.samples })));

  // Write JSON snapshot. Use UTC ISO with `:` swapped for `-` so the
  // file is portable across filesystems.
  const ts = new Date().toISOString().replace(/:/g, '-');
  const outPath = `/tmp/perf-${ts}.json`;
  try {
    writeFileSync(outPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      url: process.env.SMOKE_URL || 'http://127.0.0.1:3001',
      results,
    }, null, 2));
    console.log(`\n[perf] wrote snapshot → ${outPath}`);
  } catch (e) {
    console.log(`[perf] failed to write snapshot: ${e.message}`);
  }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[perf] fatal:', e);
  process.exit(2);
});
