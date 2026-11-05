import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRelative } from './relativeTime.ts';

const now = new Date(2026, 10, 5, 21, 0, 0).getTime();   // local time, no TZ surprises
const ago = (ms: number) => now - ms;

test('the last hour is relative', () => {
  assert.equal(formatRelative(ago(10_000), now), 'just now');
  assert.equal(formatRelative(ago(60_000), now), '1 minute ago');
  assert.equal(formatRelative(ago(8 * 60_000), now), '8 minutes ago');
});

test('later today is the clock time; earlier days carry the day in front', () => {
  assert.equal(formatRelative(ago(3 * 3_600_000), now), '18:00');
  assert.equal(formatRelative(ago(26 * 3_600_000), now), 'yesterday 19:00');
  assert.match(formatRelative(new Date(2026, 9, 15, 14, 32).getTime(), now), /^(15 Oct|Oct 15) 14:32$/);
  assert.match(formatRelative(new Date(2025, 0, 3, 9, 5).getTime(), now), /2025 09:05$/);
});

test('a stamp from the future never goes negative', () => {
  assert.equal(formatRelative(now + 5_000, now), 'just now');
});
