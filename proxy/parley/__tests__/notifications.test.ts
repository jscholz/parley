/**
 * Integration tests for the Web Push notification routes — Phase 3a
 * subscribe-roundtrip pin.
 *
 *   GET    /api/parley/notifications/vapid-public-key
 *   POST   /api/parley/notifications/subscribe
 *   POST   /api/parley/notifications/unsubscribe
 *
 * Storage is JSON-file backed at <dataDir>/push-subscriptions.json
 * (see notifications/storage.ts). Each test gets a fresh tmp dataDir
 * via os.tmpdir() so cases don't bleed state.
 *
 * Two regimes per route:
 *   - VAPID unconfigured → all subscribe/unsubscribe return 503,
 *     vapid-public-key returns 503 with a recovery hint.
 *   - VAPID configured → routes accept + roundtrip correctly,
 *     idempotency holds, malformed bodies surface 400.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { startRig } from './proxy-harness.ts';

// Real base64url-encoded test keys — these don't need to be valid VAPID
// keys for the route-level tests (we never actually call webpush.send).
// Just unique strings so a regression that drops VAPID config detection
// trips a meaningful assertion.
const TEST_VAPID_PUBLIC = 'BMG3OhLOmIVDPfeI_test_public_key_base64url_encoded_value';
const TEST_VAPID_PRIVATE = 'test_private_key_base64url_value';
const TEST_VAPID_SUBJECT = 'mailto:test@parley.invalid';

/** Spawn a fresh rig + initialize notifications with isolated VAPID +
 *  a tmp dataDir. Returns the rig + cleanup callback.
 *
 *  `__resetForTest` is called after startRig() because the proxy's
 *  parley.init() already fires a fire-and-forget initNotifications()
 *  (reading process.env.VAPID_*) which sets ready=true; without the
 *  reset, our explicit init() short-circuits and never sees the test
 *  VAPID values. */
async function startNotifiedRig() {
  const rig = await startRig();
  const notif = await import('../notifications/index.ts');
  notif.__resetForTest();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-notif-test-'));
  const configured = await notif.init({
    publicKey: TEST_VAPID_PUBLIC,
    privateKey: TEST_VAPID_PRIVATE,
    subject: TEST_VAPID_SUBJECT,
    dataDir,
  });
  assert.equal(configured, true, 'expected notifications.init to report ready=true with full VAPID');
  return {
    rig,
    dataDir,
    async stop() {
      await rig.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Spawn a rig with notifications init'd but VAPID-empty — exercises the
 *  503 path the production proxy returns when VAPID env vars are missing. */
async function startUnconfiguredRig() {
  const rig = await startRig();
  const notif = await import('../notifications/index.ts');
  notif.__resetForTest();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-notif-test-'));
  const configured = await notif.init({
    publicKey: '',
    privateKey: '',
    subject: '',
    dataDir,
  });
  assert.equal(configured, false, 'expected notifications.init to report ready=false with empty VAPID');
  return {
    rig,
    dataDir,
    async stop() {
      await rig.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

// Per-iteration entropy so concurrent tests don't share endpoints.
function fakeSubscription(suffix: string) {
  return {
    endpoint: `https://push.test.invalid/${suffix}-${Date.now()}`,
    keys: {
      p256dh: `BMG3OhLOmIVDPfeI_p256dh_${suffix}`,
      auth: `auth_${suffix}_value`,
    },
    userAgent: `ParleyTest/${suffix}`,
  };
}

test('vapid-public-key — returns 503 with hint when VAPID unconfigured', async () => {
  const { rig, stop } = await startUnconfiguredRig();
  try {
    const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/vapid-public-key`);
    assert.equal(r.status, 503);
    const body: any = await r.json();
    assert.equal(body.error, 'vapid_unconfigured');
    assert.match(body.detail, /VAPID/i,
      'expected the recovery hint to mention VAPID so the operator knows what to fix');
  } finally {
    await stop();
  }
});

test('vapid-public-key — returns 200 with publicKey when configured', async () => {
  const { rig, stop } = await startNotifiedRig();
  try {
    const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/vapid-public-key`);
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.publicKey, TEST_VAPID_PUBLIC);
    assert.equal(body.privateKey, undefined,
      'CRITICAL: private key MUST NOT leak through this endpoint');
  } finally {
    await stop();
  }
});

test('subscribe — 503 when VAPID unconfigured', async () => {
  const { rig, stop } = await startUnconfiguredRig();
  try {
    const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fakeSubscription('a')),
    });
    assert.equal(r.status, 503);
  } finally {
    await stop();
  }
});

test('subscribe — 400 on malformed body', async () => {
  const { rig, stop } = await startNotifiedRig();
  try {
    // Each shape is missing one required field.
    const bad = [
      {},
      { endpoint: 'https://x' },                                      // no keys
      { endpoint: 'https://x', keys: {} },                            // empty keys
      { endpoint: 'https://x', keys: { p256dh: 'a' } },               // no auth
      { keys: { p256dh: 'a', auth: 'b' } },                           // no endpoint
      { endpoint: 42, keys: { p256dh: 'a', auth: 'b' } },             // wrong type
    ];
    for (const body of bad) {
      const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 400,
        `expected 400 for malformed body ${JSON.stringify(body)}, got ${r.status}`);
      const j: any = await r.json();
      assert.equal(j.error, 'invalid_subscription');
    }
  } finally {
    await stop();
  }
});

test('subscribe — creates a fresh row + returns total count', async () => {
  const { rig, stop, dataDir } = await startNotifiedRig();
  try {
    const sub = fakeSubscription('fresh');
    const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub),
    });
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.created, true);
    assert.equal(body.total, 1);

    // Verify the row landed on disk in the documented shape — guards
    // against a regression that swaps in a different storage backend
    // without updating the on-disk schema callers may depend on.
    const stored = JSON.parse(
      await fs.readFile(path.join(dataDir, 'push-subscriptions.json'), 'utf8'),
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0].endpoint, sub.endpoint);
    assert.equal(stored[0].keys.p256dh, sub.keys.p256dh);
    assert.equal(stored[0].keys.auth, sub.keys.auth);
    assert.equal(stored[0].userAgent, sub.userAgent);
    assert.ok(stored[0].createdAt, 'createdAt should be set');
    assert.equal(stored[0].lastUsedAt, null, 'lastUsedAt is null until first dispatch');
  } finally {
    await stop();
  }
});

test('subscribe — re-subscribe with same endpoint upserts (created=false)', async () => {
  const { rig, stop } = await startNotifiedRig();
  try {
    const sub = fakeSubscription('reup');
    const r1 = await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub),
    });
    assert.equal((await r1.json()).created, true);

    // Same endpoint, rotated keys (simulates the browser issuing fresh
    // p256dh/auth on an internal subscription refresh while preserving
    // the endpoint URL — happens in practice on some Android browsers).
    const rotated = { ...sub, keys: { p256dh: 'rotated_p256', auth: 'rotated_auth' } };
    const r2 = await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rotated),
    });
    assert.equal(r2.status, 200);
    const body: any = await r2.json();
    assert.equal(body.created, false, 'second subscribe should report upsert, not create');
    assert.equal(body.total, 1, 'total stays 1 — same endpoint = same row');
  } finally {
    await stop();
  }
});

test('unsubscribe — removes existing row, returns removed=true; idempotent on second call', async () => {
  const { rig, stop } = await startNotifiedRig();
  try {
    const sub = fakeSubscription('byebye');
    await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub),
    });

    // First unsubscribe — removes the row.
    const r1 = await fetch(`${rig.proxyUrl}/api/parley/notifications/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    assert.equal(r1.status, 200);
    const body1: any = await r1.json();
    assert.equal(body1.ok, true);
    assert.equal(body1.removed, true);

    // Second unsubscribe — no row to remove. Must NOT 4xx (PWA may retry
    // on a flaky network and a 4xx would surface as an error to the user).
    const r2 = await fetch(`${rig.proxyUrl}/api/parley/notifications/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    assert.equal(r2.status, 200);
    const body2: any = await r2.json();
    assert.equal(body2.ok, true);
    assert.equal(body2.removed, false,
      'second unsubscribe should be idempotent — removed=false, not 404');
  } finally {
    await stop();
  }
});

test('unsubscribe — 400 on missing endpoint, 503 when VAPID unconfigured', async () => {
  // Empty-body path.
  const ok = await startNotifiedRig();
  try {
    const r = await fetch(`${ok.rig.proxyUrl}/api/parley/notifications/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const body: any = await r.json();
    assert.equal(body.error, 'invalid_body');
  } finally {
    await ok.stop();
  }

  // Unconfigured path — 503 even with a valid body shape.
  const off = await startUnconfiguredRig();
  try {
    const r = await fetch(`${off.rig.proxyUrl}/api/parley/notifications/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://x' }),
    });
    assert.equal(r.status, 503);
  } finally {
    await off.stop();
  }
});

test('multiple subscribers — each tracked independently, total increments', async () => {
  const { rig, stop } = await startNotifiedRig();
  try {
    const subs = [
      fakeSubscription('multi-a'),
      fakeSubscription('multi-b'),
      fakeSubscription('multi-c'),
    ];
    for (let i = 0; i < subs.length; i++) {
      const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subs[i]),
      });
      const body: any = await r.json();
      assert.equal(body.created, true);
      assert.equal(body.total, i + 1, `total should be ${i + 1} after subscribe #${i + 1}`);
    }

    // Remove the middle one — total drops by 1, ordering of remainders
    // doesn't matter for correctness but the row count must be right.
    const rm = await fetch(`${rig.proxyUrl}/api/parley/notifications/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: subs[1].endpoint }),
    });
    assert.equal((await rm.json()).removed, true);

    // Re-subscribing the OTHER endpoints is still an upsert (total unchanged).
    const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(subs[0]),
    });
    const body: any = await r.json();
    assert.equal(body.created, false);
    assert.equal(body.total, 2, 'total stays at 2 after the middle unsubscribe + re-subscribe of an existing endpoint');
  } finally {
    await stop();
  }
});
