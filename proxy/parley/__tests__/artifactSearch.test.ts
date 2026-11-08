// Artifacts search (2026-11-08): ranking, excerpts, scope. Strip-only TS.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  rankArtifacts, parseTerms, searchArtifacts, __setArtifactIndexForTests,
} from '../artifactSearch.ts';
import type { CachedDoc } from '../docShelf.ts';

const doc = (id: string, title: string, content: string, extra: Partial<CachedDoc> = {}): CachedDoc => ({
  id, title, content, format: 'markdown', ...extra,
});
const entry = (d: CachedDoc) => ({ doc: d, titleLc: d.title.toLowerCase(), pathLc: (d.path || '').toLowerCase(), contentLc: d.content.toLowerCase() });

test('every term must match; title beats path beats content; newest first within a tier', () => {
  const docs = [
    doc('a', 'Weekly notes', 'Trajectory is mentioned deep in the body of this one.', { displayed_at: 100 }),
    doc('b', 'Trajectory + continual learning: expert briefing', 'An expert briefing.', { displayed_at: 50 }),
    doc('c', 'Market field guide', 'nothing relevant', { path: '/w/trajectory-notes.md', displayed_at: 200 }),
    doc('d', 'Trajectory follow-up', 'later', { displayed_at: 300 }),
    doc('e', 'Investor FAQ', 'Trajectory, but no continual learning here', { displayed_at: 400 }),
  ];
  const hits = rankArtifacts(docs.map(entry), parseTerms('trajectory'), 10);
  // d (title, 300) → b (title, 50) → c (path) → e (content, 400) → a (content, 100)
  assert.deepEqual(hits.map((h) => h.id), ['d', 'b', 'c', 'e', 'a']);
  assert.equal(hits[0].match, 'title');
  assert.equal(hits[2].match, 'path');
  assert.equal(hits[3].match, 'content');
  // Two terms: only docs carrying both (b in the title, e in the body).
  const both = rankArtifacts(docs.map(entry), parseTerms('trajectory continual'), 10);
  assert.deepEqual(both.map((h) => h.id), ['b', 'e']);
  assert.deepEqual(rankArtifacts(docs.map(entry), parseTerms('trajectory briefing'), 10).map((h) => h.id), ['b']);
});

test('excerpt surrounds the first content match with highlight ranges into the snippet', () => {
  const body = 'x'.repeat(300) + ' The Trajectory team raised a round. ' + 'y'.repeat(300);
  const [h] = rankArtifacts([entry(doc('a', 'Notes', body))], parseTerms('trajectory'), 1);
  assert.equal(h.match, 'content');
  assert.ok(h.snippet.startsWith('…') && h.snippet.endsWith('…'), h.snippet);
  const [[s, e]] = h.highlights;
  assert.equal(h.snippet.slice(s, e).toLowerCase(), 'trajectory');
  // A title match whose body lacks the term shows the first prose line.
  const [t] = rankArtifacts([entry(doc('b', 'Trajectory brief', '# Brief\n\nFirst real line here.\n'))], parseTerms('trajectory'), 1);
  assert.equal(t.snippet, 'First real line here.');
  assert.deepEqual(t.title_highlights, [[0, 10]]);
});

test('searchArtifacts honours the limit and skips blank queries', async () => {
  __setArtifactIndexForTests(Array.from({ length: 12 }, (_, i) => doc(`d${i}`, `Trajectory ${i}`, 'body', { displayed_at: i })));
  assert.deepEqual(await searchArtifacts('   '), []);
  const hits = await searchArtifacts('trajectory', 5);
  assert.equal(hits.length, 5);
  assert.equal(hits[0].id, 'd11', 'newest first');
  __setArtifactIndexForTests(null);
});
