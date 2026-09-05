import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { statusTone, statusText, relativeTime, chatLinkFor, groupOptions, mergeJob, withCurrentOption } from './cronJobsModel.ts';

const base = { state: 'scheduled', enabled: true, last_status: 'ok', last_error: null, deliver: 'origin', origin: null } as any;

test('statusTone/statusText — failure beats paused beats scheduled', () => {
  assert.equal(statusTone(base), 'ok');
  assert.equal(statusText(base), 'scheduled');
  assert.equal(statusTone({ ...base, last_error: 'boom' }), 'bad');
  assert.equal(statusText({ ...base, last_error: 'boom' }), 'last run failed');
  assert.equal(statusTone({ ...base, last_status: 'blocked_config' }), 'bad');
  assert.equal(statusTone({ ...base, enabled: false, state: 'paused' }), 'muted');
  assert.equal(statusText({ ...base, enabled: false, state: 'paused' }), 'paused');
  assert.equal(statusTone({ ...base, state: 'running' }), 'warn');
});

test('relativeTime — both directions, rounding, invalid input', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  assert.equal(relativeTime('2026-09-05T15:00:00Z', now), 'in 3h');
  assert.equal(relativeTime('2026-09-07T12:00:00Z', now), 'in 2d');
  assert.equal(relativeTime('2026-09-05T11:48:00Z', now), '12m ago');
  assert.equal(relativeTime('2026-09-05T12:00:20Z', now), 'in <1m');
  assert.equal(relativeTime('2026-09-05T11:59:50Z', now), 'just now');
  assert.equal(relativeTime(null, now), '');
  assert.equal(relativeTime('garbage', now), '');
});

test('chatLinkFor — parley deliver target, origin fallback, other platforms none', () => {
  assert.deepEqual(chatLinkFor({ deliver: 'parley:abc-1', origin: null }),
    { href: '?chat=abc-1', label: 'Open target chat' });
  assert.deepEqual(chatLinkFor({ deliver: 'origin', origin: { platform: 'parley', chat_id: 'o-9', label: 'x' } }),
    { href: '?chat=o-9', label: 'Open origin chat' });
  assert.equal(chatLinkFor({ deliver: 'origin', origin: { platform: 'telegram', chat_id: '1', label: 'x' } }), null);
  assert.equal(chatLinkFor({ deliver: 'local', origin: null }), null);
  assert.equal(chatLinkFor({ deliver: 'telegram,parley:zz', origin: null }), null, 'first target wins');
});

test('groupOptions + mergeJob', () => {
  const groups = groupOptions([
    { value: 'origin', label: 'Origin', group: 'Routing' },
    { value: 'parley:a', label: 'A', group: 'Parley chats' },
    { value: 'x', label: 'X' },
    { value: 'local', label: 'Local', group: 'Routing' },
  ]);
  assert.deepEqual(groups.map(([g, o]) => [g, o.length]), [['Routing', 2], ['Parley chats', 1], ['Other', 1]]);
  const jobs = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] as any;
  assert.deepEqual(mergeJob(jobs, { id: 'b', name: 'B2' } as any).map((j: any) => j.name), ['A', 'B2']);
});

test('withCurrentOption — appends a missing current value, leaves listed/empty alone', () => {
  const opts = [{ value: 'origin', label: 'Origin', group: 'Routing' }];
  assert.equal(withCurrentOption(opts, 'origin'), opts);
  assert.equal(withCurrentOption(opts, ''), opts);
  const out = withCurrentOption(opts, 'sidekick:old');
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], { value: 'sidekick:old', label: 'sidekick:old (current)', group: 'Current' });
});
