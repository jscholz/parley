#!/usr/bin/env node
/**
 * Sidekick smoke runner.
 *
 * Discovers every `scripts/smoke/*.mjs` (except `lib.mjs`), runs each
 * scenario in sequence in its own fresh Chromium context, and prints
 * a one-line-per-scenario result table at the end.
 *
 * Usage:
 *   node scripts/run-smoke.mjs              # run all
 *   node scripts/run-smoke.mjs text-turn    # filter by name
 *   node scripts/run-smoke.mjs --headed     # show browsers (debug)
 *   node scripts/run-smoke.mjs --include-stubs   # run stubs (always FAIL)
 *   node scripts/run-smoke.mjs --mocked-only     # skip BACKEND='real' tests
 *                                                  (so the live hermes
 *                                                   doesn't accumulate
 *                                                   smoke-test sessions)
 *
 * Exit codes:
 *   0 — all enabled scenarios passed
 *   1 — at least one scenario failed
 *
 * Scenario contract (each file in scripts/smoke/):
 *   export const NAME: string
 *   export const DESCRIPTION: string
 *   export const STATUS: 'implemented' | 'stub' | 'install-only'
 *     - 'implemented'  → default suite
 *     - 'stub'         → skipped unless --include-stubs (placeholder)
 *     - 'install-only' → skipped unless --include-install or explicit name
 *                        filter. Use for tests gated on third-party API
 *                        keys or other heavy/expensive integration setup
 *                        (e.g. Tavily). Run at install / weekly cadence,
 *                        not on every dev-loop smoke run.
 *   export default async function run(ctx: SmokeContext): Promise<void>
 *
 * Scenarios should THROW on failure (or call ctx.fail). Returning =
 * passed. Each gets a fresh Playwright context — no state leaks.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchBrowser, launchSharedBrowser, launchAudioBrowser, attachConsoleCapture,
  dumpLines, DEFAULT_URL, resetServerSettings,
} from './smoke/lib.mjs';
import { installMockBackend } from './smoke/mock-backend.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_DIR = path.join(__dirname, 'smoke');

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const INCLUDE_STUBS = argv.includes('--include-stubs');
// --include-install opts in to STATUS='install-only' scenarios. Used by
// the post-install verifier; default dev-loop smoke skips them.
const INCLUDE_INSTALL = argv.includes('--include-install');
// --real-backend forces every scenario to run against the live hermes
// stack regardless of its declared BACKEND. Default mode honors each
// scenario's BACKEND export ('mocked' | 'real' | 'either').
const FORCE_REAL = argv.includes('--real-backend');
// --mocked-only skips scenarios that declare BACKEND='real'. Useful
// when iterating against a live hermes — real-backend smokes leave
// real chats in state.db that have to be cleaned up afterward.
const MOCKED_ONLY = argv.includes('--mocked-only');
if (FORCE_REAL && MOCKED_ONLY) {
  console.error('[smoke] --real-backend and --mocked-only are mutually exclusive');
  process.exit(2);
}
const filter = argv.filter(a => !a.startsWith('--'));

function logRunner(msg) { console.log(`[smoke] ${msg}`); }

async function loadScenarios() {
  const files = readdirSync(SMOKE_DIR)
    .filter(f => f.endsWith('.mjs') && f !== 'lib.mjs')
    .sort();
  const scenarios = [];
  for (const f of files) {
    const mod = await import(path.join(SMOKE_DIR, f));
    if (typeof mod.default !== 'function') continue;
    scenarios.push({
      file: f,
      name: mod.NAME || f.replace(/\.mjs$/, ''),
      description: mod.DESCRIPTION || '',
      status: mod.STATUS || 'unknown',
      backend: mod.BACKEND || 'either',  // 'mocked' | 'real' | 'either'
      mockSetup: mod.MOCK_SETUP || null,  // optional (mock) => void
      run: mod.default,
      module: mod,                       // full module for option flags (MOBILE, etc.)
    });
  }
  return scenarios;
}

async function runOne(scenario, browser) {
  const start = Date.now();
  // Reset proxy-side yaml-backed settings to canonical defaults BEFORE
  // we open a context. The proxy's settings table is global across
  // scenarios; per-context isolation only covers localStorage + IDB.
  // Without this, a test that flips streamingEngine='local' leaks into
  // every subsequent scenario. Scenarios can still override via their
  // own resetServerSettings() call after this.
  // SETTINGS POISONING FIX: the prior resetServerSettings here wrote
  // tts:false / realtime:false to the SHARED dev proxy at the start of
  // EVERY scenario, leaving those production values false after the suite
  // finished. Caller now captures the pre-scenario settings via the
  // wrapping main() and restores them post-suite, but for safety we ALSO
  // no longer reset mid-suite unless a scenario explicitly opts in. Smokes
  // that need specific values call resetServerSettings(page, {...})
  // themselves.
  // Scenarios that need iOS-shape coverage opt in via `MOBILE = true`
  // (mobile-only) or `MOBILE = 'both'` (expanded to desktop + mobile
  // pair by the runner). Resolved by main() into a per-variant flag.
  const useMobile = !!scenario.mobileVariant;
  // Audio scenarios opt out of the silent shared browser and get their
  // own Chromium that feeds a real WAV into getUserMedia (AUDIO_FIXTURE
  // = filename under smoke/fixtures, AUDIO_NOLOOP = play-once). The
  // dedicated browser is torn down by `cleanup` in the finally below.
  const audioFixture = scenario.module?.AUDIO_FIXTURE;
  let ctx, page, cleanup;
  if (audioFixture) {
    const fixturePath = path.join(SMOKE_DIR, 'fixtures', audioFixture);
    ({ ctx, page, cleanup } = await launchAudioBrowser(fixturePath, {
      headed: HEADED, noLoop: !!scenario.module?.AUDIO_NOLOOP,
    }));
  } else {
    ({ ctx, page, cleanup } = await launchBrowser(browser, { headed: HEADED, mobile: useMobile }));
  }
  const getConsole = attachConsoleCapture(page);
  const log = (msg) => console.log(`  [${scenario.name}] ${msg}`);
  let failMessage = null;
  const fail = (msg) => { failMessage = msg; throw new Error(msg); };

  // Decide backend: real if scenario demands it OR --real-backend flag.
  // Otherwise mocked (default for everything except LLM-shape tests).
  const useRealBackend =
    FORCE_REAL || scenario.backend === 'real';
  let mock = null;
  if (!useRealBackend) {
    mock = await installMockBackend(page);
    if (typeof scenario.mockSetup === 'function') {
      await scenario.mockSetup(mock);
    }
  }

  try {
    await scenario.run({ page, log, fail, url: DEFAULT_URL, ctx, mock });
    return { status: 'pass', durationMs: Date.now() - start, mode: useRealBackend ? 'real' : 'mocked' };
  } catch (e) {
    const tail = getConsole(30).map(l => `      ${l}`).join('\n');
    let lineDump = '';
    try { lineDump = await dumpLines(page, 15); } catch {}
    return {
      status: 'fail',
      durationMs: Date.now() - start,
      error: failMessage || e.message,
      stack: e.stack,
      consoleTail: tail,
      lineDump,
      mode: useRealBackend ? 'real' : 'mocked',
    };
  } finally {
    await cleanup();
    if (mock) { try { await mock.close(); } catch {} }
  }
}

async function main() {
  const scenarios = await loadScenarios();
  // Status gating:
  //   - 'implemented' always runs in the default suite.
  //   - 'stub' runs only with --include-stubs.
  //   - 'install-only' runs only with --include-install OR explicit name filter
  //     (e.g. `npm run smoke -- tool-turn-web-search`).
  let runnable;
  if (filter.length > 0) {
    // Explicit name filter overrides status — user intent wins. Allows
    // running install-only scenarios directly by name during dev.
    runnable = scenarios.filter(s => filter.some(f => s.name.includes(f)));
  } else {
    runnable = scenarios.filter(s => {
      if (s.status === 'implemented') return true;
      if (s.status === 'stub' && INCLUDE_STUBS) return true;
      if (s.status === 'install-only' && INCLUDE_INSTALL) return true;
      return false;
    });
  }
  if (MOCKED_ONLY) {
    runnable = runnable.filter(s => s.backend !== 'real');
  }
  // Scenarios that export MOBILE='both' run twice — once desktop, once
  // mobile — so coverage of iOS-shape paths (mobile breakpoint, touch,
  // .mobile-only buttons, swipe gestures) rides every CI/test run
  // alongside the desktop coverage. The two variants share name +
  // description; only the suffix `· mobile` distinguishes them in
  // the report. Saves authoring + maintaining parallel variant files.
  const expanded = [];
  for (const s of runnable) {
    const mob = s.module?.MOBILE;
    if (mob === 'both') {
      expanded.push({ ...s, name: `${s.name} · desktop`, mobileVariant: false });
      expanded.push({ ...s, name: `${s.name} · mobile`, mobileVariant: true });
    } else {
      expanded.push({ ...s, mobileVariant: !!mob });
    }
  }
  runnable = expanded;
  const skipped = scenarios.filter(s => !runnable.some(r => r.file === s.file));

  if (runnable.length === 0) {
    logRunner('no scenarios matched');
    process.exit(0);
  }

  logRunner(`running ${runnable.length} scenario(s) against ${DEFAULT_URL}${HEADED ? ' (headed)' : ''}`);
  console.log('');

  // Capture the live dev proxy's user-facing settings BEFORE running
  // anything. The runner used to call resetServerSettings(null) at
  // the start of every scenario, which wrote tts:false/realtime:false
  // to the shared proxy — leaving any connected PWA stuck on those false
  // values after the suite finished. Capture here + restore in the
  // `finally` so the proxy ends the run with exactly the values it
  // started with, regardless of crash path.
  const SETTINGS_TO_SNAPSHOT = [
    'tts', 'realtime', 'streaming', 'silenceSec',
    'commitPhrase', 'commitDelaySec', 'bargeIn', 'streamingEngine',
    'micAutoSend',
  ];
  const settingsSnapshot = {};
  try {
    const r = await fetch(`${DEFAULT_URL}/api/parley/config`);
    if (r.ok) {
      const j = await r.json();
      const live = j?.settings || {};
      for (const key of SETTINGS_TO_SNAPSHOT) {
        if (Object.prototype.hasOwnProperty.call(live, key)) {
          settingsSnapshot[key] = live[key];
        }
      }
    }
  } catch { /* dev proxy down — skip */ }

  // Notification push-prefs tripwire (incident 2026-07-25: push_kind_*
  // rows in the LIVE sidekick.db were flipped to all-false during a
  // dev/test session and stayed that way for 9 days — zero pushes,
  // zero alarms). Mocked scenarios are now fully intercepted
  // (mock-backend.mjs serves preferences in-memory), so any drift seen
  // here came from a real-backend scenario or a bug. Snapshot before
  // the suite; after the suite compare + RESTORE + shout, so a single
  // run can never leave production push prefs corrupted.
  let pushPrefsSnapshot = null;
  try {
    const r = await fetch(`${DEFAULT_URL}/api/parley/notifications/preferences`);
    if (r.ok) {
      const j = await r.json();
      if (j && typeof j === 'object' && !j.error) {
        pushPrefsSnapshot = { quiet_hours: j.quiet_hours, kinds: j.kinds };
      }
    }
  } catch { /* push feature off / proxy down — skip the tripwire */ }

  // One Chromium process for the whole run; each scenario gets its own
  // BrowserContext (isolated storage, IDB, SW). Skips ~2-3s of per-
  // scenario Chromium boot.
  const { browser, closeShared } = await launchSharedBrowser({ headed: HEADED });

  const results = [];
  try {
    for (const s of runnable) {
      process.stdout.write(`▸ ${s.name.padEnd(28)} `);
      const r = await runOne(s, browser);
      if (r.status === 'pass') {
        console.log(`PASS  (${r.durationMs} ms)`);
      } else {
        console.log(`FAIL  (${r.durationMs} ms)`);
        console.log(`    ${r.error}`);
        if (r.lineDump) console.log(`    -- DOM .line dump --\n${r.lineDump}`);
        if (r.consoleTail) console.log(`    -- last 30 console lines --\n${r.consoleTail}`);
      }
      results.push({ scenario: s, ...r });
    }
  } finally {
    await closeShared();
    // Restore captured settings even if the suite crashed mid-run.
    // Best-effort — log+continue on individual failures.
    for (const [key, value] of Object.entries(settingsSnapshot)) {
      try {
        await fetch(`${DEFAULT_URL}/api/parley/config/${key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
      } catch { /* shrug */ }
    }
    // Push-prefs drift check + restore (see snapshot above). LOUD on
    // drift: this is exactly the write pattern that caused the July
    // outage, and silent restoration would hide the offending scenario.
    if (pushPrefsSnapshot) {
      try {
        const r = await fetch(`${DEFAULT_URL}/api/parley/notifications/preferences`);
        const after = r.ok ? await r.json() : null;
        const afterSlim = after && !after.error
          ? { quiet_hours: after.quiet_hours, kinds: after.kinds }
          : null;
        if (afterSlim && JSON.stringify(afterSlim) !== JSON.stringify(pushPrefsSnapshot)) {
          console.error('');
          console.error('!'.repeat(70));
          console.error('[smoke] WARNING: notification push prefs DRIFTED during this run.');
          console.error(`[smoke]   before: ${JSON.stringify(pushPrefsSnapshot)}`);
          console.error(`[smoke]   after:  ${JSON.stringify(afterSlim)}`);
          console.error('[smoke] Some scenario wrote LIVE push prefs (2026-07 outage pattern).');
          console.error('[smoke] Restoring the pre-suite snapshot; find and fix the writer.');
          console.error('!'.repeat(70));
          await fetch(`${DEFAULT_URL}/api/parley/notifications/preferences`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pushPrefsSnapshot),
          });
        }
      } catch { /* proxy went away mid-run — nothing to restore against */ }
    }
  }

  console.log('');
  console.log('─── summary ' + '─'.repeat(50));
  for (const r of results) {
    const tag = r.status === 'pass' ? '✓' : '✗';
    const time = `${String(r.durationMs).padStart(5)} ms`;
    console.log(`  ${tag} ${r.scenario.name.padEnd(28)} ${time}  ${r.scenario.description}`);
  }
  for (const s of skipped) {
    if (s.status === 'stub') {
      console.log(`  · ${s.name.padEnd(28)}    skip   ${s.description} [stub]`);
    } else if (s.status === 'install-only') {
      console.log(`  · ${s.name.padEnd(28)}    skip   ${s.description} [install-only — use --include-install]`);
    }
  }
  console.log('─'.repeat(60));

  const failures = results.filter(r => r.status === 'fail');
  if (failures.length > 0) {
    console.log(`\n${failures.length} of ${results.length} FAILED`);
    process.exit(1);
  } else {
    console.log(`\nall ${results.length} passed`);
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(`[smoke runner] fatal: ${e.stack || e.message}`);
  process.exit(2);
});
