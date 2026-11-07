// Docs shelf sync (2026-10-24): the merge rule, the doc-id parity with
// the client, the content cache, and the HTTP surface. Strip-only TS.
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  mergeShelf, docIdFor, readShelf, updateShelf, cacheDocShow, readCachedDoc,
  setDocShelfRootForTests, type ShelfState,
} from '../docShelf.ts';
import { docIdFor as clientDocIdFor } from '../../../src/rightDrawer/docStore.ts';

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-shelf-'));
  setDocShelfRootForTests(() => dir);
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const empty = (): ShelfState => ({ version: 0, updatedAt: 0, by: '', order: [], docs: {} });
const doc = (id: string, updatedAt = 1) => ({ id, title: `Doc ${id}`, format: 'markdown', updatedAt });

test('doc ids match the client algorithm byte for byte', () => {
  for (const [p, t] of [['/w/alpha.md', 'Alpha'], [undefined, 'Meeting: standup'], ['', '  Title Case '], ['/cap/x.md', '']] as const) {
    assert.equal(docIdFor(p as any, t), clientDocIdFor(p as any, t));
  }
});

test('a writer that saw the current version replaces the shelf (closes propagate)', () => {
  const v1 = mergeShelf(empty(), { base_version: 0, by: 'a', order: ['1', '2'], docs: [doc('1'), doc('2')] }, 100);
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.order, ['1', '2']);
  const v2 = mergeShelf(v1, { base_version: 1, by: 'b', order: ['2'], docs: [doc('2')] }, 200);
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.order, ['2'], 'doc 1 was closed by a writer that knew about it');
  assert.equal(Object.keys(v2.docs).length, 1);
});

test('a stale writer gets a union: newest copy per doc, its order first, unknown ids appended', () => {
  const v1 = mergeShelf(empty(), { base_version: 0, by: 'a', order: ['1', '2'], docs: [doc('1', 5), doc('2', 5)] });
  // Device b never saw v1 (base 0): it opened 3 and has an older copy of 1.
  const v2 = mergeShelf(v1, { base_version: 0, by: 'b', order: ['3', '1'], docs: [doc('3', 9), { ...doc('1', 1), title: 'stale' }] });
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.order, ['3', '1', '2']);
  assert.equal(v2.docs['1'].title, 'Doc 1', 'the newer copy of doc 1 wins');
  assert.ok(v2.docs['2'], 'doc 2 survives — the stale writer did not know to close it');
});

test('garbage entries are dropped and the shelf is capped at 12 newest', () => {
  const many = Array.from({ length: 15 }, (_, i) => doc(String(i), i));
  const v = mergeShelf(empty(), { base_version: 0, by: 'a', order: many.map((d) => d.id), docs: [...many, null as any, { title: 'no id' } as any] });
  assert.equal(v.order.length, 12);
  assert.ok(!v.docs['0'] && !v.docs['1'] && !v.docs['2'], 'the three oldest fell off');
  assert.ok(v.docs['14']);
});

test('updateShelf persists and serializes concurrent writers', async () => {
  const [a, b] = await Promise.all([
    updateShelf({ base_version: 0, by: 'a', order: ['1'], docs: [doc('1')] }),
    updateShelf({ base_version: 0, by: 'b', order: ['2'], docs: [doc('2')] }),
  ]);
  assert.deepEqual([a.version, b.version].sort(), [1, 2], 'two writes, two versions');
  const onDisk = await readShelf();
  assert.equal(onDisk.version, 2);
  assert.deepEqual(new Set(onDisk.order), new Set(['1', '2']), 'the second writer was stale → union');
});

test('doc_show content is cached under the client id and served back', async () => {
  cacheDocShow({ type: 'doc_show', chat_id: 'c', title: 'Alpha', content: '# A', format: 'markdown', path: '/w/alpha.md', displayed_at: 123 });
  const id = clientDocIdFor('/w/alpha.md', 'Alpha');
  // write is async + best-effort; poll briefly
  let got = null as any;
  for (let i = 0; i < 50 && !got; i++) { got = await readCachedDoc(id); if (!got) await new Promise((r) => setTimeout(r, 10)); }
  assert.ok(got, 'cached');
  assert.equal(got.content, '# A');
  assert.equal(got.displayed_at, 123);
  assert.equal(await readCachedDoc('nope'), null);
  assert.equal(await readCachedDoc('../etc/passwd'), null, 'id shape is enforced');
});

// ── Recently closed (2026-11-07) ─────────────────────────────────────

test('closed: what a merge drops goes to the front of the closed list; reopening removes it; cap 10', () => {
  const v1 = mergeShelf(empty(), { base_version: 0, by: 'a', order: ['1', '2', '3'], docs: [doc('1'), doc('2'), doc('3')] }, 100);
  assert.deepEqual(v1.closed, []);
  const v2 = mergeShelf(v1, { base_version: 1, by: 'a', order: ['2', '3'], docs: [doc('2'), doc('3')] }, 200);
  assert.deepEqual(v2.closed.map((c) => [c.id, c.closedAt]), [['1', 200]]);
  const v3 = mergeShelf(v2, { base_version: 2, by: 'a', order: ['3'], docs: [doc('3')] }, 300);
  assert.deepEqual(v3.closed.map((c) => c.id), ['2', '1'], 'newest first');
  // Reopen 1 → it leaves the closed list.
  const v4 = mergeShelf(v3, { base_version: 3, by: 'a', order: ['3', '1'], docs: [doc('3'), doc('1', 400)] }, 400);
  assert.deepEqual(v4.closed.map((c) => c.id), ['2']);
  // Cap: close fourteen, keep ten.
  let s = mergeShelf(empty(), { base_version: 0, by: 'a', order: [], docs: [] }, 500);
  for (let i = 0; i < 14; i++) {
    const id = `d${i}`;
    s = mergeShelf(s, { base_version: s.version, by: 'a', order: [id], docs: [doc(id)] }, 600 + i * 2);
    s = mergeShelf(s, { base_version: s.version, by: 'a', order: [], docs: [] }, 601 + i * 2);
  }
  assert.equal(s.closed.length, 10);
  assert.equal(s.closed[0].id, 'd13');
});

test('closed: a stale writer that still lists a doc does not close it; the shelf cap eviction does', () => {
  const v1 = mergeShelf(empty(), { base_version: 0, by: 'a', order: ['1', '2'], docs: [doc('1'), doc('2')] }, 100);
  // Stale writer (base 0) sends only doc 2 → union keeps 1 open, nothing closed.
  const v2 = mergeShelf(v1, { base_version: 0, by: 'b', order: ['2'], docs: [doc('2', 150)] }, 200);
  assert.deepEqual(Object.keys(v2.docs).sort(), ['1', '2']);
  assert.deepEqual(v2.closed, []);
});

test('closed: round-trips through the shelf file', async () => {
  await updateShelf({ base_version: 0, by: 'a', order: ['1'], docs: [doc('1')] });
  await updateShelf({ base_version: 1, by: 'a', order: [], docs: [] });
  const s = await readShelf();
  assert.deepEqual(s.closed.map((c) => c.id), ['1']);
  assert.equal(typeof s.closed[0].closedAt, 'number');
});

test('closed: entries whose absolute path is gone are pruned on read; captures and relative paths are kept', async () => {
  const { pruneMissingClosed } = await import('../docShelf.ts');
  const present = path.join(dir, 'present.md');
  await fs.writeFile(present, '# here');
  const out = await pruneMissingClosed([
    { ...doc('a'), path: present, closedAt: 1 },
    { ...doc('b'), path: path.join(dir, 'gone.md'), closedAt: 2 },
    { ...doc('c'), path: 'relative/x.md', closedAt: 3 },
    { ...doc('d'), path: path.join(dir, 'gone-cap.md'), source: 'capture', captureId: 'cap', closedAt: 4 },
    { ...doc('e'), closedAt: 5 },
  ]);
  assert.deepEqual(out.map((c) => c.id), ['a', 'c', 'd', 'e']);
});
