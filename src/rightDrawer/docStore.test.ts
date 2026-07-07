// Doc shelf store — the v2 multi-doc model's load-bearing semantics:
// path-identity dedup (re-push replaces in place), LRU cap, per-doc
// remove with active fallback, and the one-time v1 migration.
//
// The store is a module singleton with a hydrate guard, so tests that
// need fresh module state re-import with a cache-busting query.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser shims — the store guards every touch with try/catch,
// but the tests want REAL persistence behavior, so give it a Map-backed
// localStorage and a no-op event target.
const backing = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => backing.has(k) ? backing.get(k)! : null,
  setItem: (k: string, v: string) => { backing.set(k, String(v)); },
  removeItem: (k: string) => { backing.delete(k); },
};
(globalThis as any).window = {
  dispatchEvent: () => true,
};
(globalThis as any).CustomEvent = class {
  type: string; detail: any;
  constructor(type: string, opts: any) { this.type = type; this.detail = opts?.detail; }
};

let bust = 0;
async function freshStore() {
  bust++;
  return await import(`./docStore.ts?bust=${bust}`);
}

beforeEach(() => backing.clear());

test('setDoc adds; same-path re-push replaces in place and re-activates', async () => {
  const s = await freshStore();
  s.setDoc({ title: 'Deck', content: 'v1', format: 'markdown', path: '/w/deck.md' });
  s.setDoc({ title: 'Notes', content: 'n', format: 'markdown', path: '/w/notes.md' });
  assert.equal(s.docCount(), 2);
  assert.equal(s.currentDoc()?.title, 'Notes');

  s.setDoc({ title: 'Deck v2', content: 'v2', format: 'markdown', path: '/w/deck.md' });
  assert.equal(s.docCount(), 2, 're-push must not duplicate');
  assert.equal(s.currentDoc()?.content, 'v2', 're-push replaces content');
  assert.equal(s.currentDoc()?.title, 'Deck v2');
});

test('re-push preserves receivedAt (first seen) but bumps updatedAt', async () => {
  const s = await freshStore();
  s.setDoc({ title: 'Deck', content: 'v1', format: 'markdown', path: '/w/deck.md' });
  const first = s.currentDoc()!;
  await new Promise(r => setTimeout(r, 5));
  s.setDoc({ title: 'Deck', content: 'v2', format: 'markdown', path: '/w/deck.md' });
  const second = s.currentDoc()!;
  assert.equal(second.receivedAt, first.receivedAt);
  assert.ok(second.updatedAt >= first.updatedAt);
});

test('shelf caps at 7 docs, evicting the oldest', async () => {
  const s = await freshStore();
  for (let i = 1; i <= 9; i++) {
    s.setDoc({ title: `Doc ${i}`, content: 'x', format: 'text', path: `/w/${i}.txt` });
  }
  assert.equal(s.docCount(), 7);
  const titles = s.listDocs().map((d: any) => d.title);
  assert.equal(titles[0], 'Doc 9');
  assert.ok(!titles.includes('Doc 1'));
  assert.ok(!titles.includes('Doc 2'));
});

test('removeDoc falls back to next-newest as active; selectDoc switches', async () => {
  const s = await freshStore();
  s.setDoc({ title: 'A', content: 'a', format: 'text', path: '/a' });
  s.setDoc({ title: 'B', content: 'b', format: 'text', path: '/b' });
  const aId = s.listDocs().find((d: any) => d.title === 'A')!.id;
  s.selectDoc(aId);
  assert.equal(s.currentDoc()?.title, 'A');
  s.removeDoc(aId);
  assert.equal(s.currentDoc()?.title, 'B');
  s.removeDoc(s.currentDoc()!.id);
  assert.equal(s.currentDoc(), null);
  assert.equal(s.docCount(), 0);
});

test('title-only docs dedup by normalized title', async () => {
  const s = await freshStore();
  s.setDoc({ title: 'Scratch Pad', content: '1', format: 'text' });
  s.setDoc({ title: 'scratch pad', content: '2', format: 'text' });
  assert.equal(s.docCount(), 1);
  assert.equal(s.currentDoc()?.content, '2');
});

test('persists across module reload (hydrateDocs)', async () => {
  const s1 = await freshStore();
  s1.setDoc({ title: 'Deck', content: 'v1', format: 'markdown', path: '/w/deck.md' });
  s1.setDoc({ title: 'Notes', content: 'n', format: 'markdown', path: '/w/notes.md' });
  const s2 = await freshStore();
  s2.hydrateDocs();
  assert.equal(s2.docCount(), 2);
  assert.equal(s2.currentDoc()?.title, 'Notes');
});

test('migrates the v1 single-slot key once', async () => {
  backing.set('sidekick.doc.current', JSON.stringify({
    title: 'Legacy', content: 'old', format: 'markdown', path: '/w/legacy.md',
    receivedAt: 123,
  }));
  const s = await freshStore();
  s.hydrateDocs();
  assert.equal(s.docCount(), 1);
  assert.equal(s.currentDoc()?.title, 'Legacy');
  assert.equal(s.currentDoc()?.receivedAt, 123);
  assert.equal(backing.has('sidekick.doc.current'), false, 'legacy key removed');
  assert.ok(backing.has('sidekick.docs.v2'), 'migrated to v2 key');
});

test('char budget evicts oldest non-active from PERSISTENCE', async () => {
  const s1 = await freshStore();
  const big = 'x'.repeat(900_000);
  s1.setDoc({ title: 'Big1', content: big, format: 'text', path: '/1' });
  s1.setDoc({ title: 'Big2', content: big, format: 'text', path: '/2' });
  s1.setDoc({ title: 'Big3', content: big, format: 'text', path: '/3' });
  // ~2.7MB serialized > 2.5MB budget → oldest (Big1) dropped from LS,
  // though all 3 remain in memory this session.
  assert.equal(s1.docCount(), 3);
  const s2 = await freshStore();
  s2.hydrateDocs();
  const titles = s2.listDocs().map((d: any) => d.title);
  assert.ok(titles.includes('Big3'));
  assert.ok(!titles.includes('Big1'), 'oldest evicted from persistence');
});

test('docIdFor matches the plugin-side djb2 mirror', async () => {
  const s = await freshStore();
  // Pinned expectation — if this changes, sidekick_doc_tool._doc_id_for
  // must change in lockstep (the tool result's doc_id keys the shelf).
  assert.equal(s.docIdFor('/w/deck.md', 'Deck'), s.docIdFor('/w/deck.md', 'other title'));
  assert.notEqual(s.docIdFor('/w/a.md', 'T'), s.docIdFor('/w/b.md', 'T'));
  assert.equal(s.docIdFor(undefined, 'Same Title'), s.docIdFor(undefined, 'same title'));
});
