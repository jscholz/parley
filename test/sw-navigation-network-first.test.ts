// sw.js navigation handling (field 2026-10-15: deploys "kept not taking"
// on the laptop app — the index was served cache-first, so each reload
// booted the PREVIOUS deploy). Loads sw.js into a fake service-worker
// global and drives its fetch listener. Strip-only TS.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

function loadSw(net: (req: any) => Promise<any>, cachedIndex: any | null) {
  const listeners: Record<string, Function[]> = {};
  const store = new Map<string, any>();
  if (cachedIndex) store.set('http://x/', cachedIndex);
  const caches = {
    match: async (req: any) => store.get(typeof req === 'string' ? req : req.url) ?? null,
    open: async () => ({ put: async (req: any, res: any) => { store.set(req.url, res); }, match: async (req: any) => store.get(req.url) ?? null, delete: async () => true, keys: async () => [] }),
    keys: async () => [], delete: async () => true,
  };
  const self: any = {
    addEventListener: (t: string, fn: Function) => { (listeners[t] ||= []).push(fn); },
    location: { origin: 'http://x' }, registration: { scope: 'http://x/' }, clients: { claim: async () => {}, matchAll: async () => [] },
    skipWaiting: () => {},
  };
  const ctx: any = { self, caches, fetch: net, URL, Response: class { ok: boolean; status: number; body: string; constructor(b: string, init: any = {}) { this.body = b; this.status = init.status ?? 200; this.ok = this.status < 400; } clone() { return this; } }, setTimeout, clearTimeout, console, Promise, Date, Headers: class {}, Request: class {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return {
    store,
    async navigate(): Promise<any> {
      let responded: Promise<any> | null = null;
      const ev = { request: { url: 'http://x/', mode: 'navigate', method: 'GET', destination: 'document', headers: { get: () => null } }, respondWith: (p: Promise<any>) => { responded = p; }, waitUntil: () => {} };
      for (const fn of listeners.fetch || []) fn(ev);
      assert.ok(responded, 'the navigation must be answered by the SW');
      return responded;
    },
  };
}

const res = (body: string, status = 200) => ({ ok: status < 400, status, body, clone() { return this; } });

test('a reachable network wins over the cached shell (one reload = latest deploy)', async () => {
  const sw = loadSw(async () => res('NEW-INDEX'), res('OLD-INDEX'));
  const r = await sw.navigate();
  assert.equal(r.body, 'NEW-INDEX');
});

test('offline falls back to the cached shell', async () => {
  const sw = loadSw(async () => { throw new TypeError('offline'); }, res('OLD-INDEX'));
  const r = await sw.navigate();
  assert.equal(r.body, 'OLD-INDEX');
});

test('a network error status falls back to the cached shell', async () => {
  const sw = loadSw(async () => res('bad gateway', 502), res('OLD-INDEX'));
  const r = await sw.navigate();
  assert.equal(r.body, 'OLD-INDEX');
});

test('no cached shell: the network answer is used as is', async () => {
  const sw = loadSw(async () => res('NEW-INDEX'), null);
  const r = await sw.navigate();
  assert.equal(r.body, 'NEW-INDEX');
});

test('a link slower than the timeout boots the cached shell', async () => {
  const sw = loadSw(() => new Promise((r) => setTimeout(() => r(res('NEW-INDEX')), 3500)), res('OLD-INDEX'));
  const t0 = Date.now();
  const r = await sw.navigate();
  assert.equal(r.body, 'OLD-INDEX');
  assert.ok(Date.now() - t0 < 3400, 'answered at the timeout, not after the slow fetch');
});
