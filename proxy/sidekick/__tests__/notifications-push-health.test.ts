/**
 * push_health — aggregate "are pushes structurally alive?" signal.
 *
 * Regression suite for the 2026-07 outage: every push kind sat
 * disabled in the live store for days and the only trace was
 * per-skip journal lines. The diagnostics endpoint now folds in a
 * push_health blob so the PWA settings panel can surface "pushes
 * are disabled" without journal access.
 *
 * Pins:
 *   - computeLocalPushHealth: defaults → healthy; all kinds false →
 *     all_kinds_disabled; disabled_kinds listed sorted; quiet_hours
 *     active-flag honors the injected clock.
 *   - GET /api/parley/notifications/diagnostics carries push_health
 *     alongside decisions (proxy-owned mode).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { startRig } from './proxy-harness.ts';

async function initTmpPrefs() {
  const prefs = await import('../notifications/prefs.ts');
  prefs.__resetPrefsForTest();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-push-health-'));
  await prefs.initPrefs({ dataDir });
  return {
    prefs,
    async cleanup() {
      prefs.__resetPrefsForTest();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('push-health: defaults are healthy', async () => {
  const { prefs, cleanup } = await initTmpPrefs();
  try {
    const h = prefs.computeLocalPushHealth();
    assert.equal(h.owner, 'proxy');
    assert.equal(h.all_kinds_disabled, false);
    assert.deepEqual(h.disabled_kinds, []);
    assert.equal(h.quiet_hours.active, false);
  } finally {
    await cleanup();
  }
});

test('push-health: all kinds disabled trips the tripwire', async () => {
  const { prefs, cleanup } = await initTmpPrefs();
  try {
    await prefs.updatePrefs({
      kinds: { agent_reply: false, cron: false, approval: false },
    });
    const h = prefs.computeLocalPushHealth();
    assert.equal(h.all_kinds_disabled, true);
    assert.deepEqual(h.disabled_kinds, ['agent_reply', 'approval', 'cron']);
  } finally {
    await cleanup();
  }
});

test('push-health: partial disable lists just the disabled kinds', async () => {
  const { prefs, cleanup } = await initTmpPrefs();
  try {
    await prefs.updatePrefs({ kinds: { cron: false } });
    const h = prefs.computeLocalPushHealth();
    assert.equal(h.all_kinds_disabled, false);
    assert.deepEqual(h.disabled_kinds, ['cron']);
  } finally {
    await cleanup();
  }
});

test('push-health: quiet_hours.active follows the clock', async () => {
  const { prefs, cleanup } = await initTmpPrefs();
  try {
    // The incident shape: enabled window "now → now+1h".
    await prefs.updatePrefs({
      quiet_hours: { enabled: true, start: '09:51', end: '10:51' },
    });
    const inside = new Date(2026, 6, 16, 10, 15);
    const outside = new Date(2026, 6, 16, 11, 15);
    assert.equal(prefs.computeLocalPushHealth(inside).quiet_hours.active, true);
    assert.equal(prefs.computeLocalPushHealth(outside).quiet_hours.active, false);
    assert.equal(prefs.computeLocalPushHealth(inside).quiet_hours.enabled, true);
  } finally {
    await cleanup();
  }
});

test('push-health: diagnostics endpoint carries push_health', async () => {
  const rig = await startRig();
  const { cleanup } = await initTmpPrefs();
  try {
    const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/diagnostics?limit=5`);
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.ok(Array.isArray(body.decisions));
    assert.ok(body.push_health, 'push_health missing from diagnostics response');
    assert.equal(body.push_health.owner, 'proxy');
    assert.equal(typeof body.push_health.all_kinds_disabled, 'boolean');
  } finally {
    await cleanup();
    await rig.stop();
  }
});
