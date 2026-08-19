// Unit tests for the /api/sidekick/* → /api/parley/* alias rewrite
// (proxy/legacyPaths.mjs). Installed PWA/CAP clients on phones still
// call the legacy paths until rebuilt — the alias must hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteLegacyApiPath } from './legacyPaths.mjs';

test('rewrites the legacy prefix, preserving subpath and query', () => {
  assert.equal(
    rewriteLegacyApiPath('/api/sidekick/messages'),
    '/api/parley/messages',
  );
  assert.equal(
    rewriteLegacyApiPath('/api/sidekick/stream?chat_id=abc&live_only=1'),
    '/api/parley/stream?chat_id=abc&live_only=1',
  );
  assert.equal(
    rewriteLegacyApiPath('/api/sidekick/sessions/ses%3A1/messages'),
    '/api/parley/sessions/ses%3A1/messages',
  );
});

test('new-prefix and unrelated URLs pass through untouched', () => {
  assert.equal(rewriteLegacyApiPath('/api/parley/messages'), '/api/parley/messages');
  assert.equal(rewriteLegacyApiPath('/api/rtc/offer'), '/api/rtc/offer');
  assert.equal(rewriteLegacyApiPath('/config'), '/config');
  assert.equal(rewriteLegacyApiPath('/'), '/');
});

test('no false positives on lookalike paths', () => {
  // Bare prefix without trailing slash is not an API route.
  assert.equal(rewriteLegacyApiPath('/api/sidekick'), '/api/sidekick');
  assert.equal(rewriteLegacyApiPath('/api/sidekickery/x'), '/api/sidekickery/x');
});
