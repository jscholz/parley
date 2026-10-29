// A page-lifetime override must never reach the account (2026-10-29: the
// ?silence_sec test flag went through set(), PUT silenceSec=1 into the
// real account's synced prefs, and call mode sent on every pause).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const puts: string[] = [];
(globalThis as any).fetch = (async (url: string, init?: { method?: string }) => {
  if (init?.method === 'PUT') puts.push(String(url));
  return { ok: true, status: 200, json: async () => ({}) };
}) as unknown as typeof fetch;
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const settings = await import('../src/settings.ts');

test('overrideForSession changes the value without a PUT or a local write', () => {
  puts.length = 0; store.clear();
  settings.overrideForSession('silenceSec', 1);
  assert.equal(settings.get().silenceSec, 1);
  assert.deepEqual(puts, []);
  settings.save();
  for (const v of store.values()) assert.ok(!v.includes('"silenceSec"'), `persisted: ${v}`);
});

test('the override survives a server value landing in the cache', () => {
  settings.overrideForSession('silenceSec', 1);
  (settings.get() as any).silenceSec = 30;   // what a background revalidate does
  assert.equal(settings.get().silenceSec, 1);
});

test('a real set() ends the override and persists normally', () => {
  puts.length = 0;
  settings.overrideForSession('silenceSec', 1);
  settings.set('silenceSec', 20);
  assert.equal(settings.get().silenceSec, 20);
  assert.ok(puts.some(u => u.endsWith('/prefs/silenceSec')), `PUTs: ${puts.join(', ')}`);
});
