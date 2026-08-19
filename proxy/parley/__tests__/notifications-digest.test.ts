/**
 * Bundle-digest tests — same-chat push burst collapses into a single
 * count-prefixed banner via the proxy + Apple's tag-replace relay.
 *
 * Strategy: dispatch pushes through the proxy, capture them via the
 * stub sender, and assert on the title decoration:
 *
 *   1st push:        "Clawdian"
 *   2nd within 30s:  "(2) Clawdian"
 *   3rd within 30s:  "(3) Clawdian"
 *   ...
 *   31s later:       "Clawdian"  (burst window expired)
 *
 * Per-chat isolation: chat A's counter is independent of chat B's.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { startRig } from './proxy-harness.ts';

const TEST_VAPID_PUBLIC = 'BMG3OhLOmIVDPfeI_digest_test_pub';
const TEST_VAPID_PRIVATE = 'digest_test_priv';
const TEST_VAPID_SUBJECT = 'mailto:digest@parley.invalid';

async function startDigestRig() {
  const rig = await startRig();
  const notif = await import('../notifications/index.ts');
  const dispatch = await import('../notifications/dispatch.ts');
  notif.__resetForTest();
  dispatch.__resetDispatchForTest();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-digest-test-'));
  const configured = await notif.init({
    publicKey: TEST_VAPID_PUBLIC,
    privateKey: TEST_VAPID_PRIVATE,
    subject: TEST_VAPID_SUBJECT,
    dataDir,
  });
  assert.equal(configured, true,
    'digest rig init must win — a false here means the harness env-init raced the reset');
  const sent: Array<{ body: any }> = [];
  dispatch.__setSenderForTest(async (_target, body) => {
    sent.push({ body: JSON.parse(body) });
  });
  await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint: `https://push.test.invalid/digest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      keys: { p256dh: 'p256_d', auth: 'auth_d' },
      userAgent: 'DigestTest',
    }),
  });
  return {
    rig,
    sent,
    async pushEnv(env: Record<string, any>) {
      const stream = await import('../stream.ts');
      const before = sent.length;
      stream.pushEnvelope(env as any);
      // Dispatch is async fire-and-forget; poll for the send rather than
      // sleeping a fixed interval (a 5ms sleep flaked under full-suite CPU
      // contention — sent was still empty at assert time). Every push in
      // this file expects exactly one send, so growth is the settle signal;
      // the deadline only guards against a genuinely dropped dispatch.
      const deadline = Date.now() + 2_000;
      while (sent.length === before && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 2));
      }
    },
    async stop() {
      await rig.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('digest: single push has plain title (no prefix)', async () => {
  const g = await startDigestRig();
  try {
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-solo',
      speaker: 'Clawdian',
      text: 'hi',
      should_push: true,
    });
    assert.equal(g.sent.length, 1);
    assert.equal(g.sent[0].body.title, '💬 Clawdian',
      'first push in a burst window has the reply-emoji prefix but no count prefix');
  } finally {
    await g.stop();
  }
});

test('digest: 2nd push within window prefixes title with (2)', async () => {
  const g = await startDigestRig();
  try {
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-burst', speaker: 'Clawdian', text: 'one', should_push: true });
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-burst', speaker: 'Clawdian', text: 'two', should_push: true });
    assert.equal(g.sent.length, 2);
    assert.equal(g.sent[0].body.title, '💬 Clawdian');
    assert.equal(g.sent[1].body.title, '(2) 💬 Clawdian',
      'second push in burst window prefixes title with count (after the reply-emoji prefix)');
  } finally {
    await g.stop();
  }
});

test('digest: 5-push burst counts up to (5)', async () => {
  const g = await startDigestRig();
  try {
    for (let i = 1; i <= 5; i++) {
      await g.pushEnv({
        type: 'reply_final',
        chat_id: 'chat-five',
        speaker: 'Clawdian',
        text: `msg ${i}`,
        should_push: true,
      });
    }
    assert.equal(g.sent.length, 5);
    const titles = g.sent.map(s => s.body.title);
    assert.deepEqual(titles, [
      '💬 Clawdian',
      '(2) 💬 Clawdian',
      '(3) 💬 Clawdian',
      '(4) 💬 Clawdian',
      '(5) 💬 Clawdian',
    ], 'burst count climbs monotonically while within the 30s window');
  } finally {
    await g.stop();
  }
});

test('digest: per-chat isolation — chat B counter unaffected by chat A burst', async () => {
  const g = await startDigestRig();
  try {
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', speaker: 'A', text: 'a1', should_push: true });
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', speaker: 'A', text: 'a2', should_push: true });
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-B', speaker: 'B', text: 'b1', should_push: true });
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', speaker: 'A', text: 'a3', should_push: true });
    assert.equal(g.sent.length, 4);
    assert.equal(g.sent[0].body.title, '💬 A',     '1st A');
    assert.equal(g.sent[1].body.title, '(2) 💬 A', '2nd A');
    assert.equal(g.sent[2].body.title, '💬 B',     '1st B — chat A burst shouldnt prefix B');
    assert.equal(g.sent[3].body.title, '(3) 💬 A', '3rd A — chat B push shouldnt reset A counter');
  } finally {
    await g.stop();
  }
});

test('digest: window expiry resets counter to 1', async () => {
  const g = await startDigestRig();
  try {
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-decay', speaker: 'X', text: '1', should_push: true });
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-decay', speaker: 'X', text: '2', should_push: true });
    assert.equal(g.sent[1].body.title, '(2) 💬 X');

    // Simulate 31s elapsing without sleeping.
    const dg = await import('../notifications/digest.ts');
    dg.__backdateDigestForTest('chat-decay', 31_000);

    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-decay', speaker: 'X', text: '3', should_push: true });
    assert.equal(g.sent.length, 3);
    assert.equal(g.sent[2].body.title, '💬 X',
      'after 31s of inactivity, the burst window closed → counter resets to 1');
  } finally {
    await g.stop();
  }
});

test('digest: sustained activity keeps the counter alive (window slides)', async () => {
  const g = await startDigestRig();
  try {
    // 4 pushes; between pushes 2 and 3, age the entry forward 25s
    // (still within the 30s window) — counter should still climb.
    const dg = await import('../notifications/digest.ts');
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-sus', speaker: 'Y', text: '1', should_push: true });
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-sus', speaker: 'Y', text: '2', should_push: true });
    dg.__backdateDigestForTest('chat-sus', 25_000);  // within 30s window
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-sus', speaker: 'Y', text: '3', should_push: true });
    // Each new push slides the window forward → still alive.
    dg.__backdateDigestForTest('chat-sus', 25_000);
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-sus', speaker: 'Y', text: '4', should_push: true });
    assert.deepEqual(
      g.sent.map(s => s.body.title),
      ['💬 Y', '(2) 💬 Y', '(3) 💬 Y', '(4) 💬 Y'],
      'sliding window — each push extends 30s out from now',
    );
  } finally {
    await g.stop();
  }
});

test('digest: notification envelope title (kind-based) gets the prefix too', async () => {
  const g = await startDigestRig();
  try {
    // notification envelopes use the `title` field directly, not speaker.
    await g.pushEnv({
      type: 'notification',
      chat_id: 'chat-notif',
      kind: 'cron',
      title: 'Notion',
      content: 'first',
      should_push: true,
    });
    await g.pushEnv({
      type: 'notification',
      chat_id: 'chat-notif',
      kind: 'cron',
      title: 'Notion',
      content: 'second',
      should_push: true,
    });
    assert.equal(g.sent[0].body.title, '⏰ Notion',
      'notification kind=cron gets the clock emoji prefix');
    assert.equal(g.sent[1].body.title, '(2) ⏰ Notion',
      'notification envelopes also get the digest count prefix');
  } finally {
    await g.stop();
  }
});
