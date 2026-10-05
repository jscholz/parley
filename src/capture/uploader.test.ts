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

// ── offline-first (2026-10-05): the ledger drives create/activate/stop ──

import { putLedger, getLedger, listLedger } from './segmentStore.ts';

function ledgerRow(id: string, extra: Partial<Parameters<typeof putLedger>[0]> = {}) {
  return putLedger({
    id, title: 'Board sync', linkedChat: 'parley:abc', mintedSession: true, diarize: true,
    createdAt: Date.now(), registered: false, activated: false, stopRequested: false, marks: [],
    ...extra,
  });
}

/** Scripted fetch keyed on METHOD + path tail; records the call order. */
function stubApi(script: (c: { method: string; path: string; n: number; body?: any }) => number | 'netfail') {
  let n = 0;
  const calls: { method: string; path: string; body?: any }[] = [];
  const fn = async (url: any, init?: any): Promise<Response> => {
    n += 1;
    const path = String(url).replace(/^.*\/api\/parley/, '');
    const method = String(init?.method || 'GET');
    let body: any;
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    calls.push({ method, path, body });
    const out = script({ method, path, n, body });
    if (out === 'netfail') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(out < 400
      ? { ok: true, capture: { id: body?.id ?? 'cap_9_ffffff', linked_chat: 'parley:abc', title: 'Board sync', status: 'pending' } }
      : { error: out === 409 ? 'capture cap_x is already recording' : `nope ${out}` }), { status: out });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

test('ledgered capture: create + activate land BEFORE its first segment; segments then drain', async () => {
  await ledgerRow('cap_10_aaaaaa');
  await putSegment({ captureId: 'cap_10_aaaaaa', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('a') });
  await putSegment({ captureId: 'cap_10_aaaaaa', seq: 1, t0Ms: 45_000, mime: 'audio/mp4', blob: blobOf('b') });
  const { fn, calls } = stubApi(() => 200);
  const registered: string[] = [];
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1, onRegistered: (e) => registered.push(e.id) });
  await up.drained();
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'POST /captures', 'POST /captures/cap_10_aaaaaa/activate',
    'POST /captures/cap_10_aaaaaa/segments/0', 'POST /captures/cap_10_aaaaaa/segments/1',
  ]);
  assert.equal(calls[0].body.id, 'cap_10_aaaaaa');            // the client-minted id travels
  assert.equal(calls[0].body.minted_session, true);
  assert.deepEqual(registered, ['cap_10_aaaaaa']);
  assert.equal((await getLedger('cap_10_aaaaaa'))?.registered, true);
  assert.equal((await listPending()).length, 0);
});

test('offline start: create keeps failing on the network → nothing is dropped; syncs when it answers', async () => {
  await ledgerRow('cap_11_bbbbbb');
  await putSegment({ captureId: 'cap_11_bbbbbb', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('a') });
  const net: boolean[] = [];
  const { fn, calls } = stubApi(({ n }) => (n <= 4 ? 'netfail' : 200));
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1, maxDelayMs: 2, onNetwork: (o) => net.push(o) });
  await up.drained();
  assert.equal(calls.filter((c) => c.path === '/captures').length, 5);   // 4 failures + the one that landed
  assert.equal((await listPending()).length, 0);
  assert.deepEqual(net, [false, true]);                                 // offline, then back
});

test('segment 404 on a ledgered capture re-registers instead of dropping (lost create ack)', async () => {
  await ledgerRow('cap_12_cccccc', { registered: true, activated: true });
  await putSegment({ captureId: 'cap_12_cccccc', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('a') });
  let created = false;
  const { fn, calls } = stubApi(({ method, path }) => {
    if (path === '/captures') { created = true; return 201; }
    if (path.endsWith('/segments/0')) return created ? 200 : 404;
    return 200;
  });
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1 });
  await up.drained();
  assert.deepEqual(calls.map((c) => c.path.replace(/^\/captures\/cap_12_cccccc/, '')), [
    '/segments/0', '/captures', '/activate', '/segments/0',
  ]);
  assert.equal((await listPending()).length, 0);
});

test('segment 404 on a capture with NO ledger row is still a permanent drop (pre-ledger client)', async () => {
  await putSegment({ captureId: 'cap_13_dddddd', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('a') });
  const dropped: string[] = [];
  const { fn } = stubApi(() => 404);
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1, onDropped: (s, r) => dropped.push(`${s.key}:${r}`) });
  await up.drained();
  assert.deepEqual(dropped, ['cap_13_dddddd:0:permanent']);
});

test('deferred stop: POST /stop fires only after the last segment is acked, then the ledger row goes', async () => {
  await ledgerRow('cap_14_eeeeee', { stopRequested: true });
  await putSegment({ captureId: 'cap_14_eeeeee', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('a') });
  await putSegment({ captureId: 'cap_14_eeeeee', seq: 1, t0Ms: 45_000, mime: 'audio/mp4', blob: blobOf('b') });
  const stopped: string[] = [];
  const { fn, calls } = stubApi(() => 200);
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1, onStopped: (id) => stopped.push(id) });
  await up.drained();
  const order = calls.map((c) => c.path.replace(/^\/captures\/cap_14_eeeeee/, ''));
  assert.equal(order[order.length - 1], '/stop');
  assert.ok(order.indexOf('/segments/1') < order.indexOf('/stop'));
  assert.deepEqual(stopped, ['cap_14_eeeeee']);
  assert.equal(await getLedger('cap_14_eeeeee'), null);
});

test('deferred stop survives a dead network: retried until the server answers', async () => {
  await ledgerRow('cap_15_ffffff', { registered: true, activated: true, stopRequested: true });
  const { fn, calls } = stubApi(({ path, n }) => (path.endsWith('/stop') && n <= 3 ? 'netfail' : 200));
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1, maxDelayMs: 2 });
  await up.drained();
  assert.equal(calls.filter((c) => c.path.endsWith('/stop')).length, 4);
  assert.equal(await getLedger('cap_15_ffffff'), null);
});

test('one-active 409 at create is transient: this meeting syncs after the other device stops', async () => {
  await ledgerRow('cap_16_aaaaaa');
  await putSegment({ captureId: 'cap_16_aaaaaa', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('a') });
  const { fn, calls } = stubApi(({ path, n }) => (path === '/captures' && n <= 2 ? 409 : 200));
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1, maxDelayMs: 2 });
  await up.drained();
  assert.equal(calls.filter((c) => c.path === '/captures').length, 3);
  assert.equal((await listPending()).length, 0);
});

test('create refused for good (400): audio is PARKED (kept), ledger records the refusal, drain completes', async () => {
  await ledgerRow('cap_17_bbbbbb');
  await putSegment({ captureId: 'cap_17_bbbbbb', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('a') });
  await putSegment({ captureId: 'cap_18_cccccc', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('z') }); // another, legacy
  const refused: string[] = [];
  const { fn, calls } = stubApi(({ path }) => (path === '/captures' ? 400 : 200));
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1, onRegisterFailed: (e, r) => refused.push(`${e.id}:${r}`) });
  await up.drained();
  assert.equal(refused.length, 1);
  assert.match((await getLedger('cap_17_bbbbbb'))!.registerFailed!, /nope 400/);
  assert.deepEqual((await listPending()).map((s) => s.key), ['cap_17_bbbbbb:0']);   // kept, not deleted
  assert.ok(calls.some((c) => c.path.endsWith('cap_18_cccccc/segments/0')));         // the other one drained
});

test('queued marks and a dirty title are delivered right after registration', async () => {
  await ledgerRow('cap_19_dddddd', { marks: [1000, 2000], registered: true, activated: true, titleDirty: true });
  await putSegment({ captureId: 'cap_19_dddddd', seq: 0, t0Ms: 0, mime: 'audio/mp4', blob: blobOf('a') });
  const { fn, calls } = stubApi(() => 200);
  const up = createUploader({ fetchFn: fn, baseDelayMs: 1 });
  await up.drained();
  const marks = calls.filter((c) => c.path.endsWith('/marks')).map((c) => c.body.t_ms);
  assert.deepEqual(marks, [1000, 2000]);
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.body.title === 'Board sync'));
  const row = await getLedger('cap_19_dddddd');
  assert.deepEqual(row?.marks, []);
  assert.equal(row?.titleDirty, false);
  assert.equal((await listLedger()).length, 1);   // not stopped → row stays
});
