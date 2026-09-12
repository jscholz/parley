import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCronCommand, matchJob } from './cronCommand.ts';

describe('cronCommand.parseCronCommand', () => {
  it('bare and list open the panel', () => {
    assert.deepEqual(parseCronCommand('/cron'), { action: 'open' });
    assert.deepEqual(parseCronCommand('/cron   list'), { action: 'open' });
  });
  it('run takes a job reference and an optional -- note', () => {
    assert.deepEqual(parseCronCommand('/cron run Comms sweep'), { action: 'run', query: 'Comms sweep', note: null });
    assert.deepEqual(parseCronCommand('/cron run comms -- only Slack today'),
      { action: 'run', query: 'comms', note: 'only Slack today' });
  });
  it('anything else is a usage error', () => {
    assert.equal(parseCronCommand('/cron run').action, 'error');
    assert.equal(parseCronCommand('/cron delete x').action, 'error');
  });
});

describe('cronCommand.matchJob', () => {
  const jobs = [
    { id: 'fddb9e189342', name: 'R2 Pulse — 3-hour comms sweep' },
    { id: '2929d0c069be', name: 'R2 Investor meetings calendar' },
    { id: 'cb5fbd98', name: 'Daily recap' },
  ];
  it('matches id, exact name, unique prefix, unique substring', () => {
    assert.equal((matchJob(jobs, 'cb5fbd98') as any).job.name, 'Daily recap');
    assert.equal((matchJob(jobs, 'daily recap') as any).job.id, 'cb5fbd98');
    assert.equal((matchJob(jobs, 'Daily') as any).job.id, 'cb5fbd98');
    assert.equal((matchJob(jobs, 'calendar') as any).job.id, '2929d0c069be');
  });
  it('reports ambiguity and misses', () => {
    assert.match((matchJob(jobs, 'R2') as any).error, /matches 2 jobs/);
    assert.match((matchJob(jobs, 'zzz') as any).error, /no scheduled job/);
  });
});
