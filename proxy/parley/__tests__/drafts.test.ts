import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  mergeDraft, readDrafts, updateDraft, setDraftsRootForTests, validChatId,
  MAX_ROWS, MAX_TEXT, TOMBSTONE_TTL_MS, type DraftsState,
} from '../drafts.ts';

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-drafts-'));
  setDraftsRootForTests(() => dir);
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const empty = (): DraftsState => ({ version: 0, drafts: {} });

test('the newer edit wins; an older edit is refused and the standing row is returned', () => {
  const a = mergeDraft(empty(), 'c1', { text: 'from the laptop', updatedAt: 1_000, by: 'laptop' }, 5_000);
  assert.equal(a.applied, true);
  assert.equal(a.state.version, 1);
  const b = mergeDraft(a.state, 'c1', { text: 'from the phone', updatedAt: 2_000, by: 'phone' }, 5_000);
  assert.equal(b.applied, true);
  assert.equal(b.row.text, 'from the phone');
  const stale = mergeDraft(b.state, 'c1', { text: 'laptop again, but older', updatedAt: 1_500, by: 'laptop' }, 5_000);
  assert.equal(stale.applied, false);
  assert.equal(stale.changed, false);
  assert.equal(stale.row.text, 'from the phone', 'the loser is told what stands');
  assert.equal(stale.state, b.state, 'nothing written');
});

test('a send is an empty tombstone that beats the other device\'s older copy of the text', () => {
  const typed = mergeDraft(empty(), 'c1', { text: 'hello', updatedAt: 1_000, by: 'laptop' }, 5_000);
  const sent = mergeDraft(typed.state, 'c1', { text: '', updatedAt: 3_000, by: 'phone' }, 5_000);
  assert.equal(sent.row.text, '');
  const resurrect = mergeDraft(sent.state, 'c1', { text: 'hello', updatedAt: 1_000, by: 'laptop' }, 5_000);
  assert.equal(resurrect.applied, false, 'the laptop\'s stale copy cannot bring the sent text back');
  assert.equal(resurrect.row.text, '');
});

test('the same edit twice changes nothing and bumps no version', () => {
  const a = mergeDraft(empty(), 'c1', { text: 'x', updatedAt: 1_000, by: 'a' }, 5_000);
  const again = mergeDraft(a.state, 'c1', { text: 'x', updatedAt: 1_000, by: 'a' }, 5_000);
  assert.equal(again.changed, false);
  assert.equal(again.applied, true);
  assert.equal(again.state.version, 1);
});

test('a client clock far ahead is clamped so it cannot hold the chat hostage', () => {
  const far = mergeDraft(empty(), 'c1', { text: 'future', updatedAt: 10_000_000, by: 'a' }, 5_000);
  assert.equal(far.row.updatedAt, 65_000);
  const honest = mergeDraft(far.state, 'c1', { text: 'now', updatedAt: 70_000, by: 'b' }, 70_000);
  assert.equal(honest.applied, true);
});

test('missing stamp = now; text is capped; chat ids are validated', () => {
  const r = mergeDraft(empty(), 'c1', { text: 'y'.repeat(MAX_TEXT + 10) }, 5_000);
  assert.equal(r.row.updatedAt, 5_000);
  assert.equal(r.row.text.length, MAX_TEXT);
  assert.equal(validChatId('parley:abc'), true);
  assert.equal(validChatId(''), false);
  assert.equal(validChatId('has space'), false);
  assert.equal(validChatId('a/b'), false);
});

test('expired tombstones are swept and the row cap drops the oldest', () => {
  let s = empty();
  s = mergeDraft(s, 'old-tomb', { text: '', updatedAt: 1, by: 'a' }, 2).state;
  const now = 1 + TOMBSTONE_TTL_MS + 10;
  s = mergeDraft(s, 'fresh', { text: 'kept', updatedAt: now, by: 'a' }, now).state;
  assert.equal(s.drafts['old-tomb'], undefined);
  for (let i = 0; i < MAX_ROWS + 5; i++) s = mergeDraft(s, `c${i}`, { text: `t${i}`, updatedAt: now + i + 1, by: 'a' }, now + i + 1).state;
  assert.equal(Object.keys(s.drafts).length, MAX_ROWS);
  assert.equal(s.drafts['c0'], undefined, 'the oldest went');
  assert.ok(s.drafts[`c${MAX_ROWS + 4}`], 'the newest stayed');
});

test('updateDraft persists across reads and serializes concurrent writers', async () => {
  await Promise.all([
    updateDraft('c1', { text: 'one', updatedAt: 100, by: 'a' }),
    updateDraft('c2', { text: 'two', updatedAt: 100, by: 'b' }),
    updateDraft('c1', { text: 'one, newer', updatedAt: 200, by: 'a' }),
  ]);
  const s = await readDrafts();
  assert.equal(s.version, 3, 'three distinct writes, three versions, none lost');
  assert.equal(s.drafts.c1.text, 'one, newer');
  assert.equal(s.drafts.c2.text, 'two');
});
