import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normaliseDeviceToken, tapTarget, hasNativePush } from './nativeModel.ts';

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
