/**
 * Dispatch-gate tests — pins the proxy's push-decision logic with
 * the webpush sender stubbed out.
 *
 * Together with notifications.test.ts (subscribe/unsubscribe routes)
 * and the badge smoke (PWA-side increment), this completes the
 * mock-coverage layer for Web Push end-to-end:
 *
 *   PWA send (mocked smoke) ──► proxy gate (THIS FILE) ──► sender stub
 *                                     ▲                         ▲
 *                                     │                         │
 *                                     │                         (real device only)
 *                                     │
 *                                     pinned: should_push flag,
 *                                     hasActiveSubFor, 30s idle,
 *                                     coalesce, mute, type allowlist
 *
 * The remaining unpinned wire is the sw.js push handler running inside
 * a real service worker — deferred until we actually break it.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { startRig } from './proxy-harness.ts';

const TEST_VAPID_PUBLIC = 'BMG3OhLOmIVDPfeI_dispatch_gate_pub';
const TEST_VAPID_PRIVATE = 'dispatch_gate_priv';
const TEST_VAPID_SUBJECT = 'mailto:gate@parley.invalid';

// Per-test endpoint identity so concurrent tests don't share state via
// the storage singleton. Each rig also gets its own dataDir.
function makeSubscription(suffix: string) {
  return {
    endpoint: `https://push.test.invalid/${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    keys: {
      p256dh: `p256_${suffix}`,
      auth: `auth_${suffix}`,
    },
    userAgent: `GateTest/${suffix}`,
  };
}

/** Rig with notifications init'd, a stubbed sender that captures every
 *  call, and a sample subscription pre-registered (so dispatch has a
 *  target). Returns helpers for invariant assertions + cleanup. */
async function startGateRig(opts: { subscriptionSuffix?: string } = {}) {
  const rig = await startRig();
  const notif = await import('../notifications/index.ts');
  const dispatch = await import('../notifications/dispatch.ts');
  notif.__resetForTest();
  dispatch.__resetDispatchForTest();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-gate-test-'));
  const configured = await notif.init({
    publicKey: TEST_VAPID_PUBLIC,
    privateKey: TEST_VAPID_PRIVATE,
    subject: TEST_VAPID_SUBJECT,
    dataDir,
  });
  assert.equal(configured, true);

  // Capture every send the gate decides to fire.
  const sent: Array<{ endpoint: string; body: any; opts: any }> = [];
  dispatch.__setSenderForTest(async (target, body, sendOpts) => {
    sent.push({ endpoint: target.endpoint, body: JSON.parse(body), opts: sendOpts });
  });

  // Pre-register one subscription so dispatch has somewhere to fan out
  // to. Subscribe through the route so we exercise the same path the
  // PWA would.
  const sub = makeSubscription(opts.subscriptionSuffix ?? 'default');
  const r = await fetch(`${rig.proxyUrl}/api/parley/notifications/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub),
  });
  assert.equal(r.status, 200, 'pre-register subscription should succeed');

  return {
    rig,
    sent,
    sub,
    /** Push an envelope into the proxy's broadcast loop the same way
     *  a hermes envelope arriving on the persistent /v1/events SSE
     *  would land. */
    async pushEnv(env: Record<string, any>) {
      const stream = await import('../stream.ts');
      stream.pushEnvelope(env as any);
      // pushEnvelope dispatches via Promise.all but doesn't await; nudge
      // the event loop so the sender stub records before we assert.
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setTimeout(r, 5));
    },
    async stop() {
      await rig.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

// ── Type allowlist + should_push flag ──────────────────────────────

test('gate: no should_push + non-eligible type → no dispatch', async () => {
  const g = await startGateRig();
  try {
    await g.pushEnv({
      type: 'tool_call',
      chat_id: 'chat-A',
      tool_name: 'web_search',
    });
    assert.equal(g.sent.length, 0,
      'tool_call is not push-eligible and the plugin set should_push:false by default');
  } finally {
    await g.stop();
  }
});

test('gate: should_push:true + non-eligible type → dispatches (plugin override)', async () => {
  const g = await startGateRig();
  try {
    await g.pushEnv({
      type: 'tool_call',
      chat_id: 'chat-A',
      tool_name: 'long_running',
      should_push: true,
    });
    assert.equal(g.sent.length, 1,
      'plugin can promote a normally-suppressed envelope type via should_push:true');
  } finally {
    await g.stop();
  }
});

test('gate: should_push:false + eligible type → no dispatch (plugin override)', async () => {
  const g = await startGateRig();
  try {
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-A',
      message_id: 'msg-1',
      should_push: false,
    });
    assert.equal(g.sent.length, 0,
      'plugin can suppress a normally-eligible envelope via should_push:false');
  } finally {
    await g.stop();
  }
});

test('gate: reply_final without should_push → dispatches via type allowlist fallback', async () => {
  const g = await startGateRig();
  try {
    // No should_push field — exercises the backwards-compat fallback to
    // PUSH_ELIGIBLE_TYPES = {reply_final, notification} when older
    // plugin versions haven't adopted the flag yet.
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-A',
      message_id: 'msg-1',
    });
    assert.equal(g.sent.length, 1);
  } finally {
    await g.stop();
  }
});

// ── hasActiveSubFor gate ───────────────────────────────────────────

test('gate: active SSE subscriber + visibility=visible → no dispatch (SSE handles it)', async () => {
  const g = await startGateRig();
  try {
    // Open an SSE subscriber for chat-A AND report visibility=visible
    // — together these mean "the user has the PWA foregrounded on this
    // chat right now." Push should be skipped (live tab will render the
    // envelope itself).
    //
    // (As of 2026-05-12, SSE-attached alone is no longer sufficient —
    // the visibility-state gate is the canonical engagement signal.
    // SSE without visibility falls to the legacy idleMs gate, which
    // for a fresh chat with no prior broadcasts dispatches. This
    // matches real-PWA behavior: initVisibilityReporting fires on
    // boot before the first envelope arrives.)
    const ac = new AbortController();
    const ssePromise = fetch(`${g.rig.proxyUrl}/api/parley/stream?chat_id=chat-A`, {
      signal: ac.signal,
    });
    await new Promise<void>((r) => setTimeout(r, 50));
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/visibility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'visible', chat_id: 'chat-A' }),
    });

    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-A',
      message_id: 'msg-active',
      should_push: true,
    });
    assert.equal(g.sent.length, 0,
      'SSE + visibility=visible = engaged, push must be skipped');

    ac.abort();
    try { await ssePromise; } catch { /* aborted */ }
  } finally {
    await g.stop();
  }
});

test('gate: SSE subscriber for DIFFERENT chat → still dispatches for envelope chat', async () => {
  const g = await startGateRig();
  try {
    const ac = new AbortController();
    const ssePromise = fetch(`${g.rig.proxyUrl}/api/parley/stream?chat_id=chat-B`, {
      signal: ac.signal,
    });
    await new Promise<void>((r) => setTimeout(r, 50));

    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-A',  // different from the subscribed chat
      message_id: 'msg-cross',
      should_push: true,
    });
    assert.equal(g.sent.length, 1,
      'subscriber is for chat-B; chat-A envelope should still push (user not viewing A)');

    ac.abort();
    try { await ssePromise; } catch { /* aborted */ }
  } finally {
    await g.stop();
  }
});

// ── Payload shape ──────────────────────────────────────────────────

test('payload: envelope → push payload mapping (title, body, tag, url)', async () => {
  const g = await startGateRig();
  try {
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-payload',
      message_id: 'msg-pl',
      speaker: 'Clawdian',
      text: 'A short reply',
      should_push: true,
    });
    assert.equal(g.sent.length, 1);
    const sent = g.sent[0];
    assert.equal(sent.body.title, '💬 Clawdian',
      'reply_final title is speaker label prefixed with the reply emoji');
    assert.equal(sent.body.body, 'A short reply');
    assert.equal(sent.body.chat_id, 'chat-payload');
    assert.equal(sent.body.tag, 'chat:chat-payload',
      'tag is chat-scoped so same-chat pushes replace rather than stack');
    assert.equal(sent.body.url, '/?chat=chat-payload',
      'tap-to-focus URL carries chat_id so PWA can deep-link');
    assert.equal(sent.opts.TTL, 30,
      '30s TTL: missed-window users get caught up via state.db replay, not delayed push');
  } finally {
    await g.stop();
  }
});

test('payload: long body truncated to ≤140 chars with ellipsis', async () => {
  const g = await startGateRig();
  try {
    const longText = 'A '.repeat(200);  // 400 chars
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-long',
      text: longText,
      should_push: true,
    });
    assert.equal(g.sent.length, 1);
    const body = g.sent[0].body.body;
    assert.ok(body.length <= 140,
      `body should be truncated to ≤140 chars; got ${body.length}`);
    assert.ok(body.endsWith('…'),
      'truncated body should end with ellipsis');
  } finally {
    await g.stop();
  }
});

test('payload: notification envelope uses content field over text', async () => {
  const g = await startGateRig();
  try {
    await g.pushEnv({
      type: 'notification',
      chat_id: 'chat-notif',
      kind: 'cron',
      content: 'Daily rollover complete',
      title: 'Notion',
      should_push: true,
    });
    assert.equal(g.sent.length, 1);
    assert.equal(g.sent[0].body.title, '⏰ Notion',
      'explicit title field wins over speaker fallback; cron kind adds the clock emoji');
    assert.equal(g.sent[0].body.body, 'Daily rollover complete');
  } finally {
    await g.stop();
  }
});

test('payload: reply_final body preview is pulled from buffered reply_delta text', async () => {
  // The hermes plugin spec is explicit: reply_final carries
  // {type, chat_id, message_id} — no text. Without buffering, every
  // reply push had an empty body and the OS banner just showed
  // "Parley" with nothing under it. stream.ts threads the cumulative
  // reply_delta text through as a body override so the banner shows
  // a preview.
  const g = await startGateRig();
  try {
    // Stream a couple of reply_deltas, then the reply_final. The
    // dispatch gate only fires for reply_final (reply_delta is
    // not push-eligible), so we expect exactly one sent push.
    await g.pushEnv({
      type: 'reply_delta',
      chat_id: 'chat-preview',
      message_id: 'msg-preview',
      text: 'Hello',
      should_push: false,
    });
    await g.pushEnv({
      type: 'reply_delta',
      chat_id: 'chat-preview',
      message_id: 'msg-preview',
      text: 'Hello, the weather today is sunny.',
      should_push: false,
    });
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-preview',
      message_id: 'msg-preview',
      speaker: 'Clawdian',
      should_push: true,
    });
    assert.equal(g.sent.length, 1, 'only reply_final triggers a push');
    assert.equal(g.sent[0].body.title, '💬 Clawdian');
    assert.equal(
      g.sent[0].body.body,
      'Hello, the weather today is sunny.',
      'body preview comes from the latest buffered reply_delta text',
    );
  } finally {
    await g.stop();
  }
});

test('payload: reply_final without preceding reply_delta has empty body (no buffered text)', async () => {
  // Edge case: proxy started mid-turn, or reply_final raced ahead of
  // the first reply_delta. Falls back to empty body; OS banner
  // shows "💬 Parley" with nothing under it. That's the original
  // pre-buffer behavior preserved as a graceful fallback.
  const g = await startGateRig();
  try {
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-naked-final',
      message_id: 'msg-naked',
      should_push: true,
    });
    assert.equal(g.sent.length, 1);
    assert.equal(g.sent[0].body.title, '💬 Parley',
      'no speaker → falls back to the default Parley label');
    assert.equal(g.sent[0].body.body, '',
      'no buffered reply text + no envelope text → empty body');
  } finally {
    await g.stop();
  }
});

test('payload: notification envelope without kind gets the generic bell emoji', async () => {
  const g = await startGateRig();
  try {
    await g.pushEnv({
      type: 'notification',
      chat_id: 'chat-generic-notif',
      title: 'Reminder',
      content: 'pick up the kids',
      should_push: true,
    });
    assert.equal(g.sent.length, 1);
    assert.equal(g.sent[0].body.title, '🔔 Reminder',
      'notification without specific kind gets the generic bell emoji');
    assert.equal(g.sent[0].body.body, 'pick up the kids');
  } finally {
    await g.stop();
  }
});

// ── Cron envelope formatting (watch-readability pass) ───────────────
//
// Cron notifications arrived with boilerplate ("Cronjob Response: <task>",
// "(job_id: <hex>)", "session_id: <ts>_<hash>") filling the visible band
// before reaching the agent's actual reply. envelopeToPayload now parses
// the canonical scheduler.py boilerplate out so title leads with the task
// name + emoji and body leads with the agent's content. Job-id moves to a
// short suffix.

test('payload: cron envelope strips scheduler boilerplate, leads with agent reply', async () => {
  const g = await startGateRig();
  try {
    const cronContent =
      'Cronjob Response: Workstation quote watchdog\n' +
      '(job_id: 0ce025d187eb43c4)\n' +
      '-------------\n\n' +
      'session_id: 20260514_173104_8aca03\n' +
      '------\n' +
      'Quote at £4,200 still tracking the budget. ' +
      'I\'ll keep watching for the £120-per-drive offer until Friday.\n\n' +
      'To stop or manage this job, send me a new message (e.g. "stop reminder Workstation quote watchdog").';
    await g.pushEnv({
      type: 'notification',
      chat_id: 'chat-cron',
      kind: 'cron',
      content: cronContent,
      should_push: true,
    });
    assert.equal(g.sent.length, 1);
    const { title, body } = g.sent[0].body;
    assert.equal(title, '⏰ Workstation quote watchdog',
      'title leads with clock emoji + task name (no "Cronjob Response:" prefix)');
    assert.ok(
      body.startsWith('Quote at £4,200'),
      `body should lead with the agent\'s actual reply, got: ${JSON.stringify(body.slice(0, 80))}`,
    );
    assert.ok(
      !body.includes('session_id:'),
      `body should not include the agent\'s session_id metadata, got: ${JSON.stringify(body)}`,
    );
    assert.ok(
      !body.includes('Cronjob Response'),
      'body should not include the "Cronjob Response" boilerplate header',
    );
    assert.ok(
      !body.includes('To stop or manage'),
      'body should not include the stop-instructions footer',
    );
    assert.ok(
      body.includes('0ce025d1'),
      `body suffix should carry the short job-id for debugging, got: ${JSON.stringify(body)}`,
    );
  } finally {
    await g.stop();
  }
});

test('payload: cron envelope without canonical wrapper degrades gracefully', async () => {
  // Defensive — future hermes versions may change the template. Plain
  // content (not wrapped) should fall through with no exception, just
  // no parsing wins.
  const g = await startGateRig();
  try {
    await g.pushEnv({
      type: 'notification',
      chat_id: 'chat-cron-plain',
      kind: 'cron',
      title: 'Daily digest',
      content: 'Three new emails this morning. Two flagged for follow-up.',
      should_push: true,
    });
    assert.equal(g.sent.length, 1);
    assert.equal(g.sent[0].body.title, '⏰ Daily digest',
      'falls back to env.title when parser doesn\'t recognize the content shape');
    assert.equal(
      g.sent[0].body.body,
      'Three new emails this morning. Two flagged for follow-up.',
      'unparsed content passes through verbatim',
    );
  } finally {
    await g.stop();
  }
});

test('payload: generic notification strips leading metadata lines from body', async () => {
  // Generic notification kind (not cron) — any agent that prepends
  // session_id / job_id / chat_id lines to its content shouldn\'t
  // see those lines occupy the first watch-visible band of body.
  const g = await startGateRig();
  try {
    await g.pushEnv({
      type: 'notification',
      chat_id: 'chat-meta-strip',
      title: 'Approval',
      content:
        'session_id: 20260514_173104\n' +
        'chat_id: abc-def\n' +
        '---\n' +
        '\n' +
        'Run terraform apply? ' +
        '(plan: 3 changes, 0 destroys)',
      should_push: true,
    });
    assert.equal(g.sent.length, 1);
    assert.ok(
      g.sent[0].body.body.startsWith('Run terraform apply?'),
      `body should lead with the actual prompt, got: ${JSON.stringify(g.sent[0].body.body.slice(0, 60))}`,
    );
  } finally {
    await g.stop();
  }
});

// ── Multi-subscription fan-out ─────────────────────────────────────

test('fan-out: dispatches to every subscription, marks each used', async () => {
  const g = await startGateRig({ subscriptionSuffix: 'fanout-a' });
  try {
    // Add a second subscription so a single envelope must fan to both.
    const sub2 = makeSubscription('fanout-b');
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub2),
    });

    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-fan',
      message_id: 'msg-fan',
      should_push: true,
    });
    assert.equal(g.sent.length, 2,
      'two subscriptions = two dispatches per envelope (one device per subscription)');
    const endpoints = g.sent.map(s => s.endpoint).sort();
    const expected = [g.sub.endpoint, sub2.endpoint].sort();
    assert.deepEqual(endpoints, expected);
  } finally {
    await g.stop();
  }
});

// ── No-subscription edge case ──────────────────────────────────────

test('no subscriptions: dispatch is a no-op (no errors thrown)', async () => {
  // startGateRig pre-registers a subscription; remove it before pushing.
  const g = await startGateRig({ subscriptionSuffix: 'empty' });
  try {
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: g.sub.endpoint }),
    });
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-empty',
      should_push: true,
    });
    assert.equal(g.sent.length, 0,
      'no stored subscriptions = nothing to fan out to; must not throw');
  } finally {
    await g.stop();
  }
});

// ── Error handling: 404/410 prunes subscription ────────────────────

test('error: sender 410 Gone → subscription pruned automatically', async () => {
  const g = await startGateRig({ subscriptionSuffix: 'gone' });
  try {
    const dispatch = await import('../notifications/dispatch.ts');
    // Override sender to throw a 410 (Apple's "subscription expired" code).
    dispatch.__setSenderForTest(async () => {
      const err: any = new Error('Gone');
      err.statusCode = 410;
      throw err;
    });

    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-gone',
      should_push: true,
    });

    // Verify the subscription was removed from the store.
    const r = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: g.sub.endpoint }),
    });
    const body: any = await r.json();
    assert.equal(body.removed, false,
      'subscription should already be gone (pruned on 410), so unsubscribe finds nothing to remove');
  } finally {
    await g.stop();
  }
});

// ── Per-chat mute gate ─────────────────────────────────────────────

test('mute: muted chat skips dispatch even for push-eligible envelope', async () => {
  const g = await startGateRig({ subscriptionSuffix: 'mute-1' });
  try {
    const mutedChat = 'chat-quiet-please';
    const r = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/mute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: mutedChat, muted: true }),
    });
    assert.equal(r.status, 200);

    await g.pushEnv({
      type: 'reply_final',
      chat_id: mutedChat,
      should_push: true,
      text: 'should not push',
    });
    assert.equal(g.sent.length, 0,
      'muted chat must skip dispatch regardless of should_push / type / subscriber state');

    // Confirm an UNRELATED chat still pushes normally.
    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-not-muted',
      should_push: true,
      text: 'should push',
    });
    assert.equal(g.sent.length, 1,
      'unmuted chat unaffected by another chat being muted');
  } finally {
    await g.stop();
  }
});

test('mute: unmute restores dispatch for the same chat', async () => {
  const g = await startGateRig({ subscriptionSuffix: 'mute-2' });
  try {
    const chat = 'chat-toggle';
    // Mute, push, expect 0 dispatched.
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/mute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, muted: true }),
    });
    await g.pushEnv({ type: 'reply_final', chat_id: chat, should_push: true });
    assert.equal(g.sent.length, 0);

    // Unmute, push again, expect 1 dispatched.
    await fetch(`${g.rig.proxyUrl}/api/parley/notifications/mute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, muted: false }),
    });
    await g.pushEnv({ type: 'reply_final', chat_id: chat, should_push: true });
    assert.equal(g.sent.length, 1, 'unmute should restore dispatch');
  } finally {
    await g.stop();
  }
});

test('mute: GET /mutes returns the current list', async () => {
  const g = await startGateRig({ subscriptionSuffix: 'mute-list' });
  try {
    // Initially empty.
    const r1 = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/mutes`);
    assert.equal(r1.status, 200);
    assert.deepEqual((await r1.json()).muted_chats, []);

    // Mute two chats, verify list reflects them (sorted).
    for (const c of ['chat-b', 'chat-a']) {
      await fetch(`${g.rig.proxyUrl}/api/parley/notifications/mute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: c, muted: true }),
      });
    }
    const r2 = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/mutes`);
    const body: any = await r2.json();
    assert.deepEqual(body.muted_chats, ['chat-a', 'chat-b'],
      'list should be sorted for stable client-side rendering');

    // Idempotent re-mute returns the same total.
    const r3 = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/mute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'chat-a', muted: true }),
    });
    const body3: any = await r3.json();
    assert.equal(body3.total, 2, 'idempotent mute should leave total unchanged');
  } finally {
    await g.stop();
  }
});

test('mute: invalid bodies return 400', async () => {
  const g = await startGateRig({ subscriptionSuffix: 'mute-bad' });
  try {
    const bad = [
      {},
      { chat_id: 'x' },                 // no muted field
      { muted: true },                   // no chat_id
      { chat_id: 'x', muted: 'yes' },    // wrong type
      { chat_id: '', muted: true },      // empty chat_id
      { chat_id: 42, muted: true },      // non-string chat_id
    ];
    for (const b of bad) {
      const r = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/mute`, {
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

test('error: sender transient 5xx → counted as failed, subscription kept', async () => {
  const g = await startGateRig({ subscriptionSuffix: 'transient' });
  try {
    const dispatch = await import('../notifications/dispatch.ts');
    dispatch.__setSenderForTest(async () => {
      const err: any = new Error('Internal Server Error');
      err.statusCode = 503;
      throw err;
    });

    await g.pushEnv({
      type: 'reply_final',
      chat_id: 'chat-transient',
      should_push: true,
    });

    // Subscription should NOT have been pruned — 5xx is transient.
    const r = await fetch(`${g.rig.proxyUrl}/api/parley/notifications/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: g.sub.endpoint }),
    });
    const body: any = await r.json();
    assert.equal(body.removed, true,
      'transient 5xx must NOT prune; the subscription is still in storage and unsubscribe removes it');
  } finally {
    await g.stop();
  }
});
