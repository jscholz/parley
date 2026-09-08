import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normaliseDeviceToken, tapTarget, tapChatId, tapMessageId, hasNativePush } from './nativeModel.ts';

test('normaliseDeviceToken', () => {
  const hex = 'A'.repeat(64);
  assert.equal(normaliseDeviceToken(hex), 'a'.repeat(64));
  assert.equal(normaliseDeviceToken(' ' + hex + ' '), 'a'.repeat(64));
  assert.equal(normaliseDeviceToken('zz'), null);
  assert.equal(normaliseDeviceToken(42), null);
});

test('tapTarget prefers url, falls back to chat_id, else null', () => {
  assert.equal(tapTarget({ url: '/?chat=abc' }), './?chat=abc');
  assert.equal(tapTarget({ url: 'https://x/y' }), 'https://x/y');
  assert.equal(tapTarget({ chat_id: 'c 1' }), './app.html?chat=c%201');
  assert.equal(tapTarget({}), null);
  assert.equal(tapTarget(null), null);
});

test('hasNativePush requires Capacitor native platform + plugin surface', () => {
  assert.equal(hasNativePush(undefined), false);
  assert.equal(hasNativePush({}), false);
  assert.equal(hasNativePush({ Capacitor: { isNativePlatform: () => false, Plugins: { PushNotifications: {} } } }), false);
  assert.equal(hasNativePush({ Capacitor: { isNativePlatform: () => true, Plugins: { PushNotifications: {} } } }), true);
  assert.equal(hasNativePush({ Capacitor: { isNativePlatform: () => true, registerPlugin: () => ({}) } }), true);
});

// ── notification tap → in-place open (field 2026-09-08) ────────────────
// Tapping a notification used to call location.assign, reloading a running
// app: the CAP shell came back with an unpopulated session list and a run of
// taps paid a full boot each. tapChatId/tapMessageId let both tap paths
// (native push, sw notificationclick) switch in place instead.
test('tapChatId prefers an explicit chat_id', () => {
  assert.equal(tapChatId({ chat_id: ' c31cd523 ' }), 'c31cd523');
});

test('tapChatId falls back to the chat in our own deep link', () => {
  assert.equal(tapChatId({ url: '/app.html?chat=abc%2D123&msg=m1' }), 'abc-123');
  assert.equal(tapChatId({ url: './app.html?chat=plain' }), 'plain');
});

test('tapChatId returns null when there is no chat to switch to', () => {
  assert.equal(tapChatId(null), null);
  assert.equal(tapChatId({}), null);
  assert.equal(tapChatId({ url: '/settings' }), null);      // non-chat url → caller navigates
  assert.equal(tapChatId({ chat_id: '   ' }), null);
});

test('tapMessageId reads the message from either the payload or the url', () => {
  assert.equal(tapMessageId({ message_id: 'msg_1' }), 'msg_1');
  assert.equal(tapMessageId({ msg_id: 'msg_2' }), 'msg_2');
  assert.equal(tapMessageId({ url: '/app.html?chat=c&msg=msg_3' }), 'msg_3');
  assert.equal(tapMessageId({}), null);
  assert.equal(tapMessageId(null), null);
});

test('tapTarget still serves the cold-start path unchanged', () => {
  // No live window means a document navigation is the only option, so the
  // ?chat= deep link must keep working.
  assert.equal(tapTarget({ chat_id: 'c1' }), './app.html?chat=c1');
  assert.equal(tapTarget({ url: '/settings' }), './settings');
});
