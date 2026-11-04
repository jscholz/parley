import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRelative } from './relativeTime.ts';

const now = new Date(2026, 10, 4, 21, 0, 0).getTime();   // local time, no TZ surprises
const ago = (ms: number) => now - ms;

test('seconds read as just now; minutes and hours count', () => {
  assert.equal(formatRelative(ago(10_000), now), 'just now');
  assert.equal(formatRelative(ago(60_000), now), '1 minute ago');
  assert.equal(formatRelative(ago(8 * 60_000), now), '8 minutes ago');
  assert.equal(formatRelative(ago(3 * 3_600_000), now), '3 hours ago');
});

test('days read as yesterday, then a count, then a date', () => {
  assert.equal(formatRelative(ago(26 * 3_600_000), now), 'yesterday');
  assert.equal(formatRelative(ago(3 * 86_400_000), now), '3 days ago');
  assert.match(formatRelative(ago(20 * 86_400_000), now), /15 Oct|Oct 15/);
  assert.match(formatRelative(new Date(2025, 0, 3).getTime(), now), /2025/);
});

test('a stamp from the future never goes negative', () => {
  assert.equal(formatRelative(now + 5_000, now), 'just now');
});
