/**
 * Visibility-state aware push gate — 12 cases covering the "agent reply
 * mid-flight when I leave the app" bug class. This is the gate with the
 * highest annoying-bug risk (push fires while you're actively chatting →
 * constant banner spam, or fails to fire when you've backgrounded →
 * silent missed reply), so each case is its own test.
 *
 * Window constant: ENGAGED_WINDOW_MS = 10s. The PWA reports
 * visibility=visible + viewed-chat=X every time visibility toggles
 * AND every time the user switches chats. Within the engagement window, the
 * gate suppresses push. Beyond it, push fires.
 *
 * The legacy SSE+30s-idle gate remains as a fallback when visibility
 * has never been reported for the chat — covers older PWA bundles +
 * the first envelope before any visibilitychange event fires.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { startRig } from './proxy-harness.ts';

const TEST_VAPID_PUBLIC = 'BMG3OhLOmIVDPfeI_visibility_test_pub';
const TEST_VAPID_PRIVATE = 'visibility_test_priv';
const TEST_VAPID_SUBJECT = 'mailto:vis@sidekick.invalid';

function makeSubscription(suffix: string) {
  return {
    endpoint: `https://push.test.invalid/vis-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    keys: { p256dh: `p256_${suffix}`, auth: `auth_${suffix}` },
    userAgent: `VisTest/${suffix}`,
  };
}

async function startVisRig(opts: { subscriptionSuffix?: string } = {}) {
  const rig = await startRig();
  const notif = await import('../notifications/index.ts');
  const dispatch = await import('../notifications/dispatch.ts');
  notif.__resetForTest();
  dispatch.__resetDispatchForTest();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-vis-test-'));
  const configured = await notif.init({
    publicKey: TEST_VAPID_PUBLIC,
    privateKey: TEST_VAPID_PRIVATE,
    subject: TEST_VAPID_SUBJECT,
    dataDir,
  });
  assert.equal(configured, true);

  const sent: Array<{ endpoint: string; body: any }> = [];
  dispatch.__setSenderForTest(async (target, body) => {
    sent.push({ endpoint: target.endpoint, body: JSON.parse(body) });
  });

  const sub = makeSubscription(opts.subscriptionSuffix ?? 'default');
  await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub),
  });

  return {
    rig,
    sent,
    sub,
    async reportVisibility(state: 'visible' | 'hidden', chatId?: string) {
      const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/visibility`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, chat_id: chatId }),
      });
      assert.equal(r.status, 200);
    },
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

/** Backdate the engagement timestamp so tests can step past the engagement
 *  window without sleeping. Uses the module's test seam directly. */
async function backdateEngagement(chatId: string, msAgo: number) {
  const v = await import('../notifications/visibility.ts');
  v.__backdateVisibilityForTest(chatId, msAgo);
}

// ── Case 1: foregrounded + recent visibility → NO push ─────────────

test('case 1: chat foreground, fresh visibility=visible → no push (SSE delivers)', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'c1' });
  try {
    await g.reportVisibility('visible', 'chat-A');
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', should_push: true, text: 'reply' });
    assert.equal(g.sent.length, 0,
      'user is actively viewing chat-A — SSE delivery suffices, push must not fire');
  } finally {
    await g.stop();
  }
});

// ── Case 2: backgrounded → push ─────────────────────────────────────

test('case 2: chat backgrounded (visibility=hidden) → push fires', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'c2' });
  try {
    await g.reportVisibility('visible', 'chat-A');
    // User backgrounds the PWA.
    await g.reportVisibility('hidden', 'chat-A');
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', should_push: true, text: 'reply' });
    assert.equal(g.sent.length, 1,
      'backgrounded for 3s → engagement window expired → push must fire');
  } finally {
    await g.stop();
  }
});



test('hidden visibility clears engagement immediately', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'hidden-clear' });
  try {
    await g.reportVisibility('visible', 'chat-A');
    await g.reportVisibility('hidden', 'chat-A');
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', should_push: true, text: 'reply' });
    assert.equal(g.sent.length, 1,
      'hidden/blurred should clear engagement immediately, without a grace period');
  } finally {
    await g.stop();
  }
});

// ── Case 3: user switched to different chat in PWA → push for old ─

test('case 3: user switched to chat B in PWA, envelope for chat A → push for A', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'c3' });
  try {
    await g.reportVisibility('visible', 'chat-A');
    // User switches to chat B inside the PWA.
    await g.reportVisibility('visible', 'chat-B');
    // chat-A's timestamp is older than chat-B's now. Backdate it past
    // the window — this simulates the user having spent 2+ seconds
    // looking at chat-B since leaving A.
    await backdateEngagement('chat-A', 11_000);

    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', should_push: true, text: 'reply' });
    assert.equal(g.sent.length, 1,
      'user is on chat-B; chat-A is no longer engaged → push for A');
  } finally {
    await g.stop();
  }
});

// ── Case 4: stale SSE, no recent visibility → push ─────────────────

test('case 4: SSE attached, channel quiet >30s (legacy gate fallback) → push', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'c4' });
  try {
    const ac = new AbortController();
    const ssePromise = fetch(`${g.rig.proxyUrl}/api/parley/stream?chat_id=chat-A`, {
      signal: ac.signal,
    });
    await new Promise<void>((r) => setTimeout(r, 50));

    // No visibility reports — exercises the fallback path. With
    // prevBroadcastAt=0 (no prior broadcasts), idleMs is huge → fall
    // through to dispatch.
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', should_push: true, text: 'reply' });
    assert.equal(g.sent.length, 1,
      'no visibility report + no broadcast history → push fires via legacy idle path');

    ac.abort();
    try { await ssePromise; } catch { /* expected */ }
  } finally {
    await g.stop();
  }
});

// ── Case 5: two finals same chat within window → one push (tag coalesce) ─

test('case 5: two reply_finals for same chat in a short burst → one push (Apple-side coalesce via tag)', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'c5' });
  try {
    // User backgrounded, both envelopes off-screen.
    await g.reportVisibility('visible', 'chat-A');
    await g.reportVisibility('hidden', 'chat-A');

    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', should_push: true, text: 'reply 1' });
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', should_push: true, text: 'reply 2' });
    // The proxy dispatches both; Apple's relay coalesces by `tag` so
    // the user sees one banner. Our test asserts that the proxy emits
    // both with the SAME tag (= same chat_id), and that the second
    // payload overwrites the first OS-side.
    assert.equal(g.sent.length, 2,
      'proxy dispatches both — coalescing happens OS-side via shared tag');
    assert.equal(g.sent[0].body.tag, 'chat:chat-A');
    assert.equal(g.sent[1].body.tag, 'chat:chat-A',
      'both pushes share tag for OS-level replace-not-stack');
    assert.equal(g.sent[1].body.body, 'reply 2',
      'second push has the newer content (which replaces the first banner)');
  } finally {
    await g.stop();
  }
});

// ── Case 6: muted chat → no push even when off-screen ──────────────

test('case 6: muted chat, off-screen, eligible envelope → no push', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'c6' });
  try {
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/mute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'chat-quiet', muted: true }),
    });
    await g.reportVisibility('hidden', 'chat-A');

    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-quiet', should_push: true });
    assert.equal(g.sent.length, 0, 'mute beats visibility — silenced regardless of engagement');
  } finally {
    await g.stop();
  }
});

// ── Cases 7 & 8: quiet hours (pending wave 2 #6) ────────────────────
//
// Skipped here — quiet-hours gate doesn't exist yet. Will be filled
// in by wave 2 #6 with the same shape:
//   - 7: non-urgent + off-screen + quiet hours → no push
//   - 8: urgent + off-screen + quiet hours → push anyway

// ── Case 9: bundle digest (pending wave 2 #7) ───────────────────────
//
// Skipped here — digest collapse doesn't exist yet. Wave 2 #7 will
// pin: 10 envelopes within burst window → 1 push.

// ── Case 10: user typing in chat A, agent reply arrives → no push ──

test('case 10: typing event (visibility=visible just refreshed) + reply → no push', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'c10' });
  try {
    // User typing in chat A: PWA refreshes visibility=visible on every
    // typing event (or at least on focus). Most recent report wins.
    await g.reportVisibility('visible', 'chat-A');
    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', should_push: true, text: 'reply' });
    assert.equal(g.sent.length, 0,
      'user is here, just refreshed visibility — no push');
  } finally {
    await g.stop();
  }
});

// ── Case 11: hidden + 30s pass + reply → push (clean handoff) ──────

test('case 11: visibility=hidden → 30s wait → reply_final → push', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'c11' });
  try {
    await g.reportVisibility('visible', 'chat-A');
    await g.reportVisibility('hidden', 'chat-A');
    await backdateEngagement('chat-A', 30_000);

    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', should_push: true, text: 'reply' });
    assert.equal(g.sent.length, 1, 'long-backgrounded chat must push on next eligible envelope');
  } finally {
    await g.stop();
  }
});

// ── Case 12: hidden/blurred clears immediately ────────────────────

test('case 12: visibility=hidden for 200ms → reply during blur → push', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'c12' });
  try {
    await g.reportVisibility('visible', 'chat-A');
    await g.reportVisibility('hidden', 'chat-A');

    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', should_push: true, text: 'reply' });
    assert.equal(g.sent.length, 1,
      'hidden/blurred is not engaged, even inside the old grace period');
  } finally {
    await g.stop();
  }
});

// ── Bonus: stale visibility report (>2s) on subsequent envelope ─────

test('bonus: visibility=visible reported past engagement window → push fires (decay)', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'decay' });
  try {
    await g.reportVisibility('visible', 'chat-A');
    await backdateEngagement('chat-A', 11_000);  // outside the window

    await g.pushEnv({ type: 'reply_final', chat_id: 'chat-A', should_push: true, text: 'reply' });
    assert.equal(g.sent.length, 1,
      'engagement decays past the window — no fresh report means no engagement');
  } finally {
    await g.stop();
  }
});

// ── Bonus: visibility report with bad body returns 400 ──────────────

test('bonus: invalid visibility body returns 400', async () => {
  const g = await startVisRig({ subscriptionSuffix: 'bad' });
  try {
    const bad = [
      {},
      { state: 'maybe' },
      { state: 'visible', chat_id: 42 },
      null,
    ];
    for (const b of bad) {
      const r = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/visibility`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      });
      assert.equal(r.status, 400,
        `expected 400 for ${JSON.stringify(b)}, got ${r.status}`);
    }
  } finally {
    await g.stop();
  }
});

// ── Bonus: visibility endpoint accepts even when VAPID unconfigured ─

test('bonus: visibility report accepted with VAPID unconfigured (no 503)', async () => {
  const rig = await startRig();
  try {
    const notif = await import('../notifications/index.ts');
    notif.__resetForTest();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-vis-503-'));
    await notif.init({ publicKey: '', privateKey: '', subject: '', dataDir });
    const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/visibility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'visible', chat_id: 'x' }),
    });
    assert.equal(r.status, 200,
      'visibility reports should succeed even when push is off — they harmlessly no-op');
    await fs.rm(dataDir, { recursive: true, force: true });
  } finally {
    await rig.stop();
  }
});
