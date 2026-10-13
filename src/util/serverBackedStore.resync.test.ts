// Catch-up refresh triggers (field 2026-10-12: a pin made on the phone
// never reached a laptop window that stayed open). Strip-only TS.
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';

const win = new EventTarget() as any;
const doc = new EventTarget() as any;
doc.visibilityState = 'visible';
(globalThis as any).window = win;
(globalThis as any).document = doc;
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
win.dispatchEvent = EventTarget.prototype.dispatchEvent.bind(win);

const { ServerBackedStore } = await import('./serverBackedStore.ts');

let fetches = 0;
const fakeFetch = (async () => { fetches += 1; return { ok: true, json: async () => ({ items: [] }) }; }) as unknown as typeof fetch;
let store: any;

function make(pollMs = 0) {
  store = new ServerBackedStore<{ id: string }>({
    storageKey: null, endpoint: '/x', fetchImpl: fakeFetch, extract: (d: any) => d.items, parse: (r: any) => r, idOf: (i) => i.id,
    changeEvent: 'test-changed', debounceMs: 5, resync: { pollMs },
  });
  store.hydrate();
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { fetches = 0; doc.visibilityState = 'visible'; });
afterEach(() => { store?.dispose(); });

for (const ev of ['focus', 'online', 'parley:stream-gap']) {
  test(`window "${ev}" triggers a refresh`, async () => {
    make();
    await tick(20);
    const before = fetches;
    win.dispatchEvent(new Event(ev));
    await tick(30);
    assert.equal(fetches, before + 1);
  });
}

test('the safety poll refreshes while visible and pauses while hidden', async () => {
  make(25);
  await tick(20);
  const t0 = fetches;
  await tick(90);
  assert.ok(fetches - t0 >= 2, `expected polls while visible, got ${fetches - t0}`);
  doc.visibilityState = 'hidden';
  await tick(20);
  const t1 = fetches;
  await tick(90);
  assert.equal(fetches, t1, 'no polling while hidden');
});

test('a burst of triggers coalesces into one refresh', async () => {
  make();
  await tick(20);
  const before = fetches;
  for (const ev of ['focus', 'online', 'parley:stream-gap', 'focus']) win.dispatchEvent(new Event(ev));
  await tick(30);
  assert.equal(fetches, before + 1);
});
