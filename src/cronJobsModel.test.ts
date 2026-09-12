import { test, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  statusTone, statusText, relativeTime, chatLinkFor, groupOptions, mergeJob, withCurrentOption, bulkModelHeader, formatDuration, liveDurationMs, runLabel, runTone, runMeta, jobsSummary, consolePrefix, formatConsoleTime,
} from './cronJobsModel.ts';

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

test('bulkModelHeader — uniform (all unpinned, all pinned alike) vs mixed', () => {
  assert.deepEqual(bulkModelHeader([]), { kind: 'uniform', value: '' });
  assert.deepEqual(bulkModelHeader([{ model: '' }, { model: '' }]), { kind: 'uniform', value: '' });
  assert.deepEqual(
    bulkModelHeader([{ model: 'gpt-5.6-sol' }, { model: 'gpt-5.6-sol' }]),
    { kind: 'uniform', value: 'gpt-5.6-sol' },
  );
  assert.deepEqual(bulkModelHeader([{ model: '' }, { model: 'gpt-5.6-sol' }]), { kind: 'mixed' });
  assert.deepEqual(bulkModelHeader([{ model: 'gpt-5.6-sol' }, { model: 'gpt-6-astra' }]), { kind: 'mixed' });
  // a single job is trivially uniform, never mixed
  assert.deepEqual(bulkModelHeader([{ model: 'gpt-5.6-sol' }]), { kind: 'uniform', value: 'gpt-5.6-sol' });
});

describe('cronJobsModel runs (2026-09-12 run feedback)', () => {
  const base = {
    id: 'r1', job_id: 'j1', source: 'manual', note: null, model: 'gpt-5.4-mini',
    started_at: '2026-09-12T20:00:00.000Z', finished_at: null, duration_ms: null, error: null,
    delivery: { status: 'pending', error: null }, console: true,
  };
  const NOW = Date.parse('2026-09-12T20:00:14.000Z');

  it('formatDuration is compact', () => {
    assert.equal(formatDuration(14_000), '0:14');
    assert.equal(formatDuration(69_000), '1:09');
    assert.equal(formatDuration(3_720_000), '1h02m');
    assert.equal(formatDuration(null), '');
  });

  it('active runs tick from started_at; finished runs use the agent figure', () => {
    assert.equal(liveDurationMs({ ...base, status: 'running' }, NOW), 14_000);
    assert.equal(liveDurationMs({ ...base, status: 'succeeded', duration_ms: 69_000 }, NOW), 69_000);
    assert.equal(runLabel({ ...base, status: 'running' }, NOW), 'Running · 0:14');
    assert.equal(runLabel({ ...base, status: 'queued' }, NOW), 'Queued…');
    assert.equal(runLabel({ ...base, status: 'succeeded', duration_ms: 69_000 }, NOW), 'Done in 1:09');
    assert.equal(runLabel({ ...base, status: 'failed', duration_ms: 31_000 }, NOW), 'Failed after 0:31');
  });

  it('tone and meta reflect delivery', () => {
    assert.equal(runTone({ ...base, status: 'running' }), 'warn');
    assert.equal(runTone({ ...base, status: 'succeeded', delivery: { status: 'delivered', error: null } }), 'ok');
    assert.equal(runTone({ ...base, status: 'succeeded', delivery: { status: 'failed', error: 'x' } }), 'bad');
    assert.equal(runTone({ ...base, status: 'failed' }), 'bad');
    const meta = runMeta({ ...base, status: 'succeeded', delivery: { status: 'delivered', error: null }, note: 'only Slack' }, NOW);
    assert.deepEqual(meta, ['manual', 'just now', 'gpt-5.4-mini', 'delivered', 'note: only Slack']);
  });

  it('an active latest run makes the job pill read running', () => {
    const job: any = { state: 'scheduled', enabled: true, last_status: 'ok', last_error: null, last_run: { ...base, status: 'running' } };
    assert.equal(statusText(job), 'running');
    assert.equal(statusTone(job), 'warn');
  });

  it('jobsSummary counts running, failed today, and the next fire', () => {
    const jobs: any[] = [
      { id: 'a', enabled: true, next_run_at: new Date(NOW + 40 * 60_000).toISOString(), last_run: { ...base, status: 'running' } },
      { id: 'b', enabled: true, next_run_at: new Date(NOW + 3 * 3600_000).toISOString(),
        last_run: { ...base, status: 'failed', finished_at: new Date(NOW - 3600_000).toISOString() } },
      { id: 'c', enabled: false, next_run_at: null, last_run: null },
    ];
    assert.equal(jobsSummary(jobs, NOW), '3 jobs · 1 running · 1 failed today · next in 40m');
  });

  it('console glyphs and clock', () => {
    assert.equal(consolePrefix('tool_call'), '▶');
    assert.equal(consolePrefix('error'), '✖');
    assert.equal(formatConsoleTime(0), '--:--:--');
    assert.match(formatConsoleTime(1_757_700_000), /^\d\d:\d\d:\d\d$/);
  });
});
