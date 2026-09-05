import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { worstTone, reportLines, agoText, isStale } from './healthModel.ts';

test('worstTone maps statuses', () => {
  assert.equal(worstTone('OK'), 'ok'); assert.equal(worstTone('warn'), 'warn');
  assert.equal(worstTone('FAIL'), 'bad'); assert.equal(worstTone('CRASHED'), 'bad'); assert.equal(worstTone('UNKNOWN'), 'muted');
});

test('reportLines classifies digest rows and keeps the header', () => {
  const lines = reportLines('🔴 hermes health — x\nFAIL a — b\nWARN c — d\nOK   e — f\n\n');
  assert.deepEqual(lines.map((l) => l.kind), ['text', 'fail', 'warn', 'ok']);
});

test('agoText + isStale', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  assert.equal(agoText('2026-09-05T11:48:00Z', now), '12m ago');
  assert.equal(agoText('2026-09-05T09:00:00Z', now), '3h ago');
  assert.equal(agoText('2026-09-03T12:00:00Z', now), '2d ago');
  assert.equal(agoText(null, now), 'never');
  assert.equal(isStale('2026-09-05T09:00:00Z', now), false);
  assert.equal(isStale('2026-09-03T12:00:00Z', now), true);
  assert.equal(isStale(null, now), true);
});
