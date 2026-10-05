/**
 * @fileoverview parseChatDeepLink — the `/?chat=` grammar the transcript
 * intercepts so a branch link switches chats in place instead of
 * reloading the app (2026-10-05).
 *
 * Stripped-only TS: no parameter properties, enums or decorators.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseChatDeepLink } from './chatDeepLink.ts';

const ORIGIN = 'https://parley.example';

describe('parseChatDeepLink', () => {
  it('accepts the relative form hermes writes into the ⑂ branch reply', () => {
    assert.deepEqual(parseChatDeepLink('/?chat=parley:abc-123', ORIGIN),
      { chatId: 'parley:abc-123', msgId: null });
  });

  it('accepts a bare query string and an absolute same-origin URL', () => {
    assert.deepEqual(parseChatDeepLink('?chat=parley:x', ORIGIN), { chatId: 'parley:x', msgId: null });
    assert.deepEqual(parseChatDeepLink(`${ORIGIN}/?chat=parley:x&msg=msg_9`, ORIGIN),
      { chatId: 'parley:x', msgId: 'msg_9' });
    assert.deepEqual(parseChatDeepLink(`${ORIGIN}/index.html?chat=parley:x`, ORIGIN),
      { chatId: 'parley:x', msgId: null });
  });

  it('leaves everything that is not ours alone', () => {
    assert.equal(parseChatDeepLink('https://other.example/?chat=parley:x', ORIGIN), null);
    assert.equal(parseChatDeepLink('/docs/?chat=parley:x', ORIGIN), null);
    assert.equal(parseChatDeepLink('/?msg=only', ORIGIN), null);
    assert.equal(parseChatDeepLink('/?chat=', ORIGIN), null);
    assert.equal(parseChatDeepLink('#doc:abc', ORIGIN), null);
    assert.equal(parseChatDeepLink('', ORIGIN), null);
    assert.equal(parseChatDeepLink(null, ORIGIN), null);
    assert.equal(parseChatDeepLink('http://[bad', ORIGIN), null);
  });
});
