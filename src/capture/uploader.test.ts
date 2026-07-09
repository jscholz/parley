// Uploader contract tests (capture plan §Phase 1): exactly-once ack,
// outage survival via backoff, poison-segment drop, boot resume from
// the durable store. Memory backend + stub fetch — no IDB, no network.
// Strip-only TS: no enums / parameter properties anywhere in the file.
import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';

import { setBackend, memoryBackend, putSegment, listPending } from './segmentStore.ts';
import { createUploader } from './uploader.ts';

// node's test env has Blob; arrayBuffer() works on it.
function blobOf(text: string): Blob {
  return new Blob([text], { type: 'audio/mp4' });
}

beforeEach(() => {
  setBackend(memoryBackend());
});

function stubFetch(script: (call: { url: string; seq: number; n: number }) => number | 'netfail') {
  let n = 0;
  const calls: { url: string; seq: number }[] = [];
  const fn = async (url: any, _init?: any): Promise<Response> => {
    n += 1;
    const seq = Number(String(url).match(/segments\/(\d+)$/)?.[1] ?? -1);
    calls.push({ url: String(url), seq });
    const out = script({ url: String(url), seq, n });
    if (out === 'netfail') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ ok: out < 400 }), { status: out });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

test('drains in order and removes acked segments from the store', async () => {
  await putSegment({ captureId: 'cap_1_aaaaaa', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('a') });
  await putSegment({ captureId: 'cap_1_aaaaaa', seq: 1, t0Ms: 45_000, mime: 'audio/mp4', blob: blobOf('b') });
  const { fn, calls } = stubFetch(() => 200);
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1 });
  await up.drained();
  assert.deepEqual(calls.map((c) => c.seq), [0, 1]);
  assert.equal((await listPending()).length, 0);
});

test('outage: 503s then recovery → every segment acked exactly once, queue drained', async () => {
  await putSegment({ captureId: 'cap_2_bbbbbb', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('x') });
  await putSegment({ captureId: 'cap_2_bbbbbb', seq: 1, t0Ms: 45_000, mime: 'audio/mp4', blob: blobOf('y') });
  // First three attempts hit the outage; everything after succeeds.
  const { fn, calls } = stubFetch(({ n }) => (n <= 3 ? 503 : 200));
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1, maxDelayMs: 5 });
  await up.drained();
  const acked = calls.filter((_, i) => i >= 3);
  assert.deepEqual(acked.map((c) => c.seq), [0, 1]);   // order preserved through the outage
  assert.equal((await listPending()).length, 0);
});

test('network throw is transient — retries until success', async () => {
  await putSegment({ captureId: 'cap_3_cccccc', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('z') });
  const { fn } = stubFetch(({ n }) => (n === 1 ? 'netfail' : 200));
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1 });
  await up.drained();
  assert.equal((await listPending()).length, 0);
});

test('permanent 4xx drops the poison segment and keeps draining', async () => {
  await putSegment({ captureId: 'cap_4_dddddd', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('poison') });
  await putSegment({ captureId: 'cap_4_dddddd', seq: 1, t0Ms: 45_000, mime: 'audio/mp4', blob: blobOf('fine') });
  const dropped: number[] = [];
  const { fn, calls } = stubFetch(({ seq }) => (seq === 0 ? 404 : 200));
  const up = createUploader({
    fetchFn: fn, baseDelayMs: 1,
    onDropped: (seg) => dropped.push(seg.seq),
  });
  await up.drained();
  assert.deepEqual(dropped, [0]);
  assert.equal(calls.filter((c) => c.seq === 1).length, 1);
  assert.equal((await listPending()).length, 0);
});

test('409 retries a few times (corrupt-upload sha mismatch) then drops (divergent)', async () => {
  await putSegment({ captureId: 'cap_5_eeeeee', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('q') });
  const dropped: number[] = [];
  const { fn, calls } = stubFetch(() => 409);
  const up = createUploader({
    fetchFn: fn, baseDelayMs: 1, maxDelayMs: 2,
    onDropped: (seg) => dropped.push(seg.seq),
  });
  await up.drained();
  assert.equal(calls.length, 3);          // MAX_409_ATTEMPTS
  assert.deepEqual(dropped, [0]);
});

test('boot resume: segments left by a previous session drain on first kick', async () => {
  // "Previous session": store populated, no uploader running.
  await putSegment({ captureId: 'cap_6_ffffff', seq: 7, t0Ms: 315_000, mime: 'audio/mp4', blob: blobOf('tail') });
  // "Next boot": fresh uploader over the same durable store.
  const { fn, calls } = stubFetch(() => 200);
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1 });
  await up.drained();
  assert.deepEqual(calls.map((c) => c.seq), [7]);
  assert.equal((await listPending()).length, 0);
});

test('frozen-capture 409 PARKS the segment — durable copy kept, queue drains (audit P0#1)', async () => {
  await putSegment({ captureId: 'cap_7_aaaaaa', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('precious') });
  await putSegment({ captureId: 'cap_7_aaaaaa', seq: 1, t0Ms: 45_000, mime: 'audio/mp4', blob: blobOf('fine') });
  const dropped: [number, string][] = [];
  let n = 0;
  const fn = (async (url: any) => {
    n += 1;
    const seq = Number(String(url).match(/segments\/(\d+)$/)?.[1] ?? -1);
    if (seq === 0) {
      return new Response(JSON.stringify({ error: 'capture cap_7_aaaaaa is complete; segments are frozen' }), { status: 409 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const up = createUploader({
    fetchFn: fn, baseDelayMs: 1,
    onDropped: (seg, reason) => dropped.push([seg.seq, reason]),
  });
  await up.drained();
  // Frozen segment: reported as 'frozen', NOT removed from the store.
  assert.deepEqual(dropped, [[0, 'frozen']]);
  const left = await listPending();
  assert.deepEqual(left.map((s) => s.seq), [0]);   // durable copy survives
});
