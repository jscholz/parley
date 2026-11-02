import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkProgress } from './chunkProgress.ts';

const base = { phase: 'recording', segmentStartedAt: 10_000, segmentMs: 45_000, sealedSegments: 0, uploadedSegments: 0, landedSegments: 0 };

test('the pie fills over the chunk and clamps at full', () => {
  assert.equal(chunkProgress(base, 10_000).fraction, 0);
  assert.equal(chunkProgress(base, 32_500).fraction, 0.5);
  assert.equal(chunkProgress(base, 99_000).fraction, 1);
  assert.equal(chunkProgress(base, 32_500).elapsedSec, 22);
});

test('no running chunk → empty pie (paused, finishing, before the first chunk)', () => {
  assert.equal(chunkProgress({ ...base, phase: 'paused' }, 30_000).fraction, 0);
  assert.equal(chunkProgress({ ...base, segmentStartedAt: 0 }, 30_000).fraction, 0);
});

test('the previous chunk walks sending → transcribing → landed', () => {
  assert.equal(chunkProgress(base).previous, 'none');
  assert.equal(chunkProgress({ ...base, sealedSegments: 1 }).previous, 'sending');
  assert.equal(chunkProgress({ ...base, sealedSegments: 1, uploadedSegments: 1 }).previous, 'transcribing');
  assert.equal(chunkProgress({ ...base, sealedSegments: 1, uploadedSegments: 1, landedSegments: 1 }).previous, 'landed');
  // A second seal while the first is still transcribing: back to the honest pending state.
  assert.equal(chunkProgress({ ...base, sealedSegments: 2, uploadedSegments: 2, landedSegments: 1 }).previous, 'transcribing');
});

test('the label says chunk number, elapsed and the previous state', () => {
  const p = chunkProgress({ ...base, sealedSegments: 1, uploadedSegments: 1 }, 25_000);
  assert.equal(p.chunkNo, 2);
  assert.equal(p.label, 'Chunk 2: 15 s of 45 s · last chunk transcribing');
});
