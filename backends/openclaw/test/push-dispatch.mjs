import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { openDb, close } from '../src/db.js';
import { upsertSubscription, setMute } from '../src/push-storage.js';
import { listActivityItems } from '../src/activity-storage.js';
import { PushDispatcher, EngagementState, ENGAGEMENT_WINDOW_MS, buildPayload, normalizeChatId } from '../src/push-dispatch.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-openclaw-push-'));
    const db = openDb({ path: join(dir, 'sidekick.db') });
    try {
      return await fn(db);
    } finally {
      close(db);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function addSub(db, endpoint = 'https://push.test/openclaw-1') {
  upsertSubscription(db, {
    endpoint,
    p256dh: 'test-p256dh',
    auth: 'test-auth',
    userAgent: 'test',
  });
}

test('push payload routes with chat and msg params, not chat_id', () => {
  const payload = buildPayload({
    chatId: 'agent:dev:sidekick:abc',
    text: 'hello',
    kind: 'reply_final',
    messageId: 'msg_123',
  });
  assert.equal(payload.chat_id, 'sidekick:abc');
  assert.equal(payload.url, '/?chat=sidekick%3Aabc&msg=msg_123');
  assert.equal(payload.url.includes('chat_id='), false);
});

test('engagement normalizes OpenClaw agent session keys', () => {
  const engagement = new EngagementState();
  engagement.markVisible('sidekick:abc');
  assert.equal(engagement.isEngaged('agent:dev:sidekick:abc'), true);
  engagement.markHidden('agent:dev:sidekick:abc');
  assert.equal(engagement.isEngaged('sidekick:abc'), false);
  assert.equal(ENGAGEMENT_WINDOW_MS >= 8000, true);
  assert.equal(normalizeChatId('agent:dev:sidekick:abc'), 'sidekick:abc');
});

test('delivered push creates an Activity item and activity_changed event', withDb(async (db) => {
  addSub(db);
  const sent = [];
  const oldSend = webpush.sendNotification;
  webpush.sendNotification = async (_sub, payload) => { sent.push(JSON.parse(payload)); };
  const pushed = [];
  try {
    const dispatcher = new PushDispatcher({ db, eventBus: { pushEnvelope: (env) => pushed.push(env) } });
    const out = await dispatcher.dispatchPush({
      chatId: 'agent:dev:sidekick:abc',
      text: 'Agent reply body',
      messageId: 'msg_reply_1',
    });
    assert.equal(out.delivered, 1);
    assert.equal(sent[0].url, '/?chat=sidekick%3Aabc&msg=msg_reply_1');
    const items = listActivityItems(db);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'msg_reply_1');
    assert.equal(items[0].messageId, 'msg_reply_1');
    assert.equal(items[0].chatId, 'sidekick:abc');
    assert.equal(items[0].kind, 'agent_reply');
    assert.equal(items[0].body, 'Agent reply body');
    assert.equal(items[0].read, false);
    assert.equal(pushed[0].type, 'activity_changed');
  } finally {
    webpush.sendNotification = oldSend;
  }
}));

test('suppressed push does not create Activity item', withDb(async (db) => {
  addSub(db);
  const dispatcher = new PushDispatcher({ db });
  dispatcher.engagement.markVisible('sidekick:abc');
  const out = await dispatcher.dispatchPush({
    chatId: 'agent:dev:sidekick:abc',
    text: 'Should not notify',
    messageId: 'msg_suppressed_1',
  });
  assert.equal(out.skipped, 'user_engaged');
  assert.deepEqual(listActivityItems(db), []);
}));

test('muted normalized chat suppresses push before Activity write', withDb(async (db) => {
  addSub(db);
  setMute(db, { chatId: 'sidekick:abc', muted: true });
  const dispatcher = new PushDispatcher({ db });
  const out = await dispatcher.dispatchPush({
    chatId: 'agent:dev:sidekick:abc',
    text: 'Should not notify',
    messageId: 'msg_muted_1',
  });
  assert.equal(out.skipped, 'muted');
  assert.deepEqual(listActivityItems(db), []);
}));
