import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { shouldRetryResume, RESUME_RETRY_DELAYS_MS } from './resumeRetry.ts';

describe('shouldRetryResume', () => {
  const blank = { stillViewed: true, renderedSomething: false };

  it('retries a blank transcript with growing backoff', () => {
    const d1 = shouldRetryResume(0, blank);
    const d2 = shouldRetryResume(1, blank);
    const d3 = shouldRetryResume(2, blank);
    assert.deepEqual(
      [d1, d2, d3].map((d) => (d.retry ? d.delayMs : null)),
      [...RESUME_RETRY_DELAYS_MS],
    );
    assert.deepEqual([d1, d2, d3].map((d) => (d.retry ? d.attempt : null)), [1, 2, 3]);
  });

  it('stops after the last delay rather than hammering a bad link', () => {
    const d = shouldRetryResume(RESUME_RETRY_DELAYS_MS.length, blank);
    assert.equal(d.retry, false);
    assert.equal(d.retry === false && d.reason, 'attempts-exhausted');
  });

  it('does not retry once the user has switched away', () => {
    const d = shouldRetryResume(0, { stillViewed: false, renderedSomething: false });
    assert.equal(d.retry, false);
    assert.equal(d.retry === false && d.reason, 'switched-away');
  });

  it('does not churn a view that already has cached rows on screen', () => {
    const d = shouldRetryResume(0, { stillViewed: true, renderedSomething: true });
    assert.equal(d.retry, false);
    assert.equal(d.retry === false && d.reason, 'already-rendered');
  });

  it('waits for the radio instead of burning attempts while offline', () => {
    const d = shouldRetryResume(0, { ...blank, offline: true });
    assert.equal(d.retry, false);
    assert.equal(d.retry === false && d.reason, 'offline');
  });
});
