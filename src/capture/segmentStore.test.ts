// IndexedDB backend: a connection the browser closed underneath us is
// reopened, not reported (field 2026-10-11: "Could not start recording:
// Failed to execute 'transaction' on 'IDBDatabase': The database
// connection is closing" on Start meeting — WebKit had evicted the
// handle cached since the app last woke). Fake IDBFactory: one shared
// store across connections, a connection that can be closed silently
// (no event, like the eviction) or with `close` fired. Strip-only TS.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { idbBackend, isClosedConnectionError } from './segmentStore.ts';

function fakeRequest(resultFn: () => unknown) {
  const req: any = { onsuccess: null, onerror: null, result: undefined, error: null };
  queueMicrotask(() => {
    try { req.result = resultFn(); req.onsuccess?.(); }
    catch (e) { req.error = e; req.onerror?.(); }
  });
  return req;
}

function fakeFactory() {
  const stores = new Map<string, Map<string, unknown>>();
  const connections: any[] = [];
  const closedError = () => Object.assign(new Error("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing."), { name: 'InvalidStateError' });
  const factory = {
    open(_name: string, _version: number) {
      const db: any = {
        closed: false, onclose: null, onversionchange: null,
        objectStoreNames: { contains: (n: string) => stores.has(n) },
        createObjectStore(n: string) { stores.set(n, new Map()); },
        close() { db.closed = true; },
        transaction(store: string, _mode: string) {
          if (db.closed) throw closedError();
          const m = stores.get(store)!;
          return { objectStore: () => ({
            put: (v: any) => fakeRequest(() => { m.set(v.key ?? v.id, v); }),
            getAll: () => fakeRequest(() => Array.from(m.values())),
            delete: (k: string) => fakeRequest(() => { m.delete(k); }),
            clear: () => fakeRequest(() => { m.clear(); }),
          }) };
        },
      };
      connections.push(db);
      const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db };
      queueMicrotask(() => { if (!stores.size) req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  };
  return { factory: factory as unknown as IDBFactory, connections };
}

const seg = (seq: number) => ({ key: `cap:${seq}`, captureId: 'cap', seq, t0Ms: seq * 45_000, mime: 'audio/mp4', blob: new Blob(['x']), createdAt: 1 });

test('put/getAll round-trip through the fake IDB on one connection', async () => {
  const { factory, connections } = fakeFactory();
  const b = idbBackend(() => factory);
  await b.put(seg(0)); await b.put(seg(1));
  assert.equal((await b.getAll()).length, 2);
  assert.equal(connections.length, 1);
});

test('a silently evicted connection (no close event) is reopened once and the write lands', async () => {
  const { factory, connections } = fakeFactory();
  const b = idbBackend(() => factory);
  await b.put(seg(0));
  connections[0].closed = true;                     // WebKit took it away behind the app's back
  await b.put(seg(1));                              // used to throw straight into the Start toast
  assert.equal(connections.length, 2, 'exactly one reopen');
  assert.deepEqual((await b.getAll()).map((s) => s.seq), [0, 1]);
  assert.equal(connections.length, 2, 'the fresh handle is cached again');
});

test('a close event drops the cached handle; the next call opens fresh without ever seeing the error', async () => {
  const { factory, connections } = fakeFactory();
  const b = idbBackend(() => factory);
  await b.putCapture({ id: 'c1', title: 't', linkedChat: null, mintedSession: true, diarize: true, createdAt: 1, registered: false, activated: false, stopRequested: false, marks: [] });
  connections[0].closed = true;
  connections[0].onclose?.();
  assert.equal((await b.getCaptures()).length, 1);
  assert.equal(connections.length, 2);
});

test('a non-connection error is thrown, not retried', async () => {
  const { factory, connections } = fakeFactory();
  const b = idbBackend(() => factory);
  await b.put(seg(0));
  connections[0].transaction = () => { throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); };
  await assert.rejects(b.put(seg(1)), /quota/);
  assert.equal(connections.length, 1);
});

test('isClosedConnectionError recognises WebKit and Chromium wording', () => {
  assert.ok(isClosedConnectionError({ name: 'InvalidStateError', message: 'x' }));
  assert.ok(isClosedConnectionError(new Error('The database connection is closing.')));
  assert.ok(!isClosedConnectionError(new Error('QuotaExceededError')));
});
