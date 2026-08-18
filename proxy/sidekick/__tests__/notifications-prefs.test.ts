/**
 * Notification preferences — quiet hours.
 *
 * Pins:
 *   - GET /api/parley/notifications/preferences returns defaults
 *     when no file exists (quiet_hours.enabled=false).
 *   - POST partial updates persist + don't clobber other fields.
 *   - Bad HH:MM strings return 400.
 *   - inQuietHours window semantics: simple, wrap-midnight, equal.
 *   - Dispatch gate suppresses non-urgent push during quiet hours.
 *   - Dispatch gate respects `urgent: true` flag (bypasses quiet hours).
 *
 * Covers cases 7 + 8 from the visibility-gate plan that were skipped
 * pending this commit.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { startRig } from './proxy-harness.ts';

const TEST_VAPID_PUBLIC = 'BMG3OhLOmIVDPfeI_prefs_test_pub';
const TEST_VAPID_PRIVATE = 'prefs_test_priv';
const TEST_VAPID_SUBJECT = 'mailto:prefs@sidekick.invalid';

async function startPrefsRig() {
  const rig = await startRig();
  const notif = await import('../notifications/index.ts');
  const dispatch = await import('../notifications/dispatch.ts');
  notif.__resetForTest();
  dispatch.__resetDispatchForTest();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-prefs-test-'));
  await notif.init({
    publicKey: TEST_VAPID_PUBLIC,
    privateKey: TEST_VAPID_PRIVATE,
    subject: TEST_VAPID_SUBJECT,
    dataDir,
  });
  const sent: Array<{ body: any }> = [];
  dispatch.__setSenderForTest(async (_target, body) => {
    sent.push({ body: JSON.parse(body) });
  });
  const sub = {
    endpoint: `https://push.test.invalid/prefs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    keys: { p256dh: 'p256_pref', auth: 'auth_pref' },
    userAgent: 'PrefsTest',
  };
  await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub),
  });
  return {
    rig,
    sent,
    async pushEnv(env: Record<string, any>) {
      const stream = await import('../stream.ts');
      stream.pushEnvelope(env as any);
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setTimeout(r, 10));
    },
    async stop() {
      await rig.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

// ── Defaults + persistence ─────────────────────────────────────────

test('prefs: GET returns defaults when no file exists', async () => {
  const g = await startPrefsRig();
  try {
    const r = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`);
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.quiet_hours.enabled, false);
    assert.equal(body.quiet_hours.start, '22:00');
    assert.equal(body.quiet_hours.end, '07:00');
  } finally {
    await g.stop();
  }
});

test('prefs: POST partial update persists + leaves other fields alone', async () => {
  const g = await startPrefsRig();
  try {
    const r1 = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quiet_hours: { enabled: true } }),
    });
    assert.equal(r1.status, 200);
    const body1: any = await r1.json();
    assert.equal(body1.quiet_hours.enabled, true);
    // Times unchanged — partial update only touched `enabled`.
    assert.equal(body1.quiet_hours.start, '22:00');
    assert.equal(body1.quiet_hours.end, '07:00');

    // Update times only — `enabled` should stay true.
    const r2 = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quiet_hours: { start: '23:30', end: '06:30' } }),
    });
    const body2: any = await r2.json();
    assert.equal(body2.quiet_hours.enabled, true);
    assert.equal(body2.quiet_hours.start, '23:30');
    assert.equal(body2.quiet_hours.end, '06:30');
  } finally {
    await g.stop();
  }
});

test('prefs: bad HH:MM string returns 400', async () => {
  const g = await startPrefsRig();
  try {
    for (const bad of ['25:00', '12:60', '7:00', '07:0', 'foo', '']) {
      const r = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quiet_hours: { start: bad } }),
      });
      assert.equal(r.status, 400,
        `expected 400 for quiet_hours.start=${JSON.stringify(bad)}, got ${r.status}`);
    }
  } finally {
    await g.stop();
  }
});

// ── inQuietHours() unit semantics ──────────────────────────────────

test('prefs: inQuietHours wraps midnight (22:00-07:00)', async () => {
  const g = await startPrefsRig();
  try {
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quiet_hours: { enabled: true, start: '22:00', end: '07:00' },
      }),
    });
    const { inQuietHours } = await import('../notifications/prefs.ts');
    // Fake clock — feed Dates directly so the test isn't wall-clock dependent.
    const at = (h: number, m: number) => {
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d;
    };
    assert.equal(inQuietHours(at(22, 0)), true,  '22:00 is INSIDE (start inclusive)');
    assert.equal(inQuietHours(at(23, 30)), true, 'late evening inside');
    assert.equal(inQuietHours(at(2, 0)), true,   'early morning inside');
    assert.equal(inQuietHours(at(6, 59)), true,  'minute before end inside');
    assert.equal(inQuietHours(at(7, 0)), false,  '07:00 is OUTSIDE (end exclusive)');
    assert.equal(inQuietHours(at(12, 0)), false, 'noon outside');
    assert.equal(inQuietHours(at(21, 59)), false, 'minute before start outside');
  } finally {
    await g.stop();
  }
});

test('prefs: inQuietHours simple interval (13:00-15:00)', async () => {
  const g = await startPrefsRig();
  try {
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quiet_hours: { enabled: true, start: '13:00', end: '15:00' },
      }),
    });
    const { inQuietHours } = await import('../notifications/prefs.ts');
    const at = (h: number, m: number) => {
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d;
    };
    assert.equal(inQuietHours(at(12, 59)), false);
    assert.equal(inQuietHours(at(13, 0)), true);
    assert.equal(inQuietHours(at(14, 0)), true);
    assert.equal(inQuietHours(at(15, 0)), false);
    assert.equal(inQuietHours(at(2, 0)), false, 'no midnight wrap');
  } finally {
    await g.stop();
  }
});

test('prefs: inQuietHours disabled = always false', async () => {
  const g = await startPrefsRig();
  try {
    // Default state: enabled=false. Don't even toggle. Quiet hours
    // should be off regardless of time.
    const { inQuietHours } = await import('../notifications/prefs.ts');
    const at = (h: number, m: number) => {
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d;
    };
    assert.equal(inQuietHours(at(2, 0)), false);
    assert.equal(inQuietHours(at(12, 0)), false);
    assert.equal(inQuietHours(at(23, 0)), false);
  } finally {
    await g.stop();
  }
});

test('prefs: inQuietHours start == end is never (ambiguous → safer no-suppress)', async () => {
  const g = await startPrefsRig();
  try {
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quiet_hours: { enabled: true, start: '12:00', end: '12:00' },
      }),
    });
    const { inQuietHours } = await import('../notifications/prefs.ts');
    const at = (h: number, m: number) => {
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d;
    };
    assert.equal(inQuietHours(at(12, 0)), false,
      'start == end is intentionally interpreted as "never" rather than "always"');
    assert.equal(inQuietHours(at(0, 0)), false);
  } finally {
    await g.stop();
  }
});

// ── Dispatch gate integration ──────────────────────────────────────

test('case 7: quiet hours active, non-urgent envelope → no push', async () => {
  const g = await startPrefsRig();
  try {
    // Configure quiet hours to span "right now" by setting start = a
    // minute ago (formatted backwards from now), end = 1 hour from now.
    const now = new Date();
    const start = `${pad(now.getHours())}:${pad(Math.max(0, now.getMinutes() - 1))}`;
    const endMin = (now.getMinutes() + 59) % 60;
    const endHr = (now.getHours() + (now.getMinutes() + 59 >= 60 ? 1 : 0)) % 24;
    const end = `${pad(endHr)}:${pad(endMin)}`;
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quiet_hours: { enabled: true, start, end } }),
    });
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-quiet',
      should_push: true,
      text: 'should be suppressed by quiet hours',
    });
    assert.equal(g.sent.length, 0,
      `quiet hours ${start}-${end} should suppress non-urgent push`);
  } finally {
    await g.stop();
  }
});

test('case 8: quiet hours active, urgent:true envelope → push fires anyway', async () => {
  const g = await startPrefsRig();
  try {
    const now = new Date();
    const start = `${pad(now.getHours())}:${pad(Math.max(0, now.getMinutes() - 1))}`;
    const endMin = (now.getMinutes() + 59) % 60;
    const endHr = (now.getHours() + (now.getMinutes() + 59 >= 60 ? 1 : 0)) % 24;
    const end = `${pad(endHr)}:${pad(endMin)}`;
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quiet_hours: { enabled: true, start, end } }),
    });
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-urgent',
      should_push: true,
      urgent: true,
      text: 'critical — bypasses quiet hours',
    });
    assert.equal(g.sent.length, 1,
      'urgent:true must bypass quiet hours — used for approval / critical envelopes');
  } finally {
    await g.stop();
  }
});

// ── Per-kind toggles ───────────────────────────────────────────────

test('kinds: defaults are both true on a fresh prefs file', async () => {
  const g = await startPrefsRig();
  try {
    const r = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`);
    const body: any = await r.json();
    assert.equal(body.kinds.agent_reply, true);
    assert.equal(body.kinds.cron, true);
    assert.equal(body.kinds.approval, true);
  } finally {
    await g.stop();
  }
});

test('kinds: toggling agent_reply=false suppresses reply_final push', async () => {
  const g = await startPrefsRig();
  try {
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kinds: { agent_reply: false } }),
    });
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-kind-1',
      should_push: true,
      text: 'should be suppressed by kind toggle',
    });
    assert.equal(g.sent.length, 0,
      'agent_reply=false must suppress reply_final pushes');

    // Notification envelopes for the same chat should still push.
    await g.pushEnv({
      type: 'notification',
      chat_id: 'chat-kind-1',
      should_push: true,
      kind: 'cron',
      content: 'cron should still push',
    });
    assert.equal(g.sent.length, 1, 'notification kind unaffected by agent_reply toggle');
  } finally {
    await g.stop();
  }
});

test('kinds: toggling cron=false suppresses only cron notification push', async () => {
  const g = await startPrefsRig();
  try {
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kinds: { cron: false } }),
    });
    await g.pushEnv({
      type: 'notification',
      chat_id: 'chat-kind-2',
      should_push: true,
      kind: 'cron',
      content: 'should be suppressed',
    });
    assert.equal(g.sent.length, 0);

    await g.pushEnv({
      type: 'notification',
      chat_id: 'chat-kind-2',
      should_push: true,
      kind: 'approval',
      urgent: true,
      content: 'approval still pushes',
    });
    assert.equal(g.sent.length, 1, 'approval kind unaffected by cron toggle');
  } finally {
    await g.stop();
  }
});

test('kinds: both off → no envelope kind pushes (master kill switch)', async () => {
  const g = await startPrefsRig();
  try {
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kinds: { agent_reply: false, cron: false, approval: false } }),
    });
    await g.pushEnv({ type: 'reply_final', chat_id: 'c1', should_push: true });
    await g.pushEnv({ type: 'notification', chat_id: 'c1', should_push: true, kind: 'cron' });
    await g.pushEnv({ type: 'notification', chat_id: 'c1', should_push: true, kind: 'approval', urgent: true });
    assert.equal(g.sent.length, 0, 'both kinds off = no push of any kind');
  } finally {
    await g.stop();
  }
});

test('kinds: partial update keeps the other kind untouched', async () => {
  const g = await startPrefsRig();
  try {
    // Disable agent_reply, leave notification at default (true).
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kinds: { agent_reply: false } }),
    });
    const r = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/preferences`);
    const body: any = await r.json();
    assert.equal(body.kinds.agent_reply, false);
    assert.equal(body.kinds.cron, true,
      'partial update of agent_reply must not flip cron');
    assert.equal(body.kinds.approval, true,
      'partial update of agent_reply must not flip approval');
  } finally {
    await g.stop();
  }
});

test('quiet hours disabled → push fires as normal', async () => {
  const g = await startPrefsRig();
  try {
    // Don't enable quiet hours; verify regular pushes still work.
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-normal',
      should_push: true,
      text: 'normal',
    });
    assert.equal(g.sent.length, 1, 'quiet hours disabled = no suppression');
  } finally {
    await g.stop();
  }
});

function pad(n: number): string { return n.toString().padStart(2, '0'); }
