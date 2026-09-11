/**
 * @fileoverview Tests for the pure transcript-cache helpers that back
 * "persist all loaded pages to IDB". These run
 * without the IndexedDB plumbing — they're the logic that decides what
 * the cache keeps when a freshly-fetched newest page is reconciled
 * against a (possibly deeper) cached transcript.
 *
 * The invariants under test are what make deep pins "get faster warm":
 *   - mergeNewestPage never SHRINKS a fuller cache (the truncation bug).
 *   - capTranscript keeps the newest slice + a valid load-earlier cursor.
 *   - sameTranscript is an id-sequence equality used to skip redundant
 *     re-renders on the resume reconcile.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeNewestPage,
  capTranscript,
  sameTranscript,
  MAX_CACHED_MESSAGES,
  prefetchMergeMode,
} from './sessionCache.ts';

const row = (id: number, content = `m${id}`) => ({ id, content });

describe('mergeNewestPage', () => {
  it('returns the page when cache is empty', () => {
    const page = [row(1), row(2)];
    assert.deepEqual(mergeNewestPage([], page), page);
  });

  it('returns the cache when page is empty', () => {
    const cached = [row(1), row(2)];
    assert.deepEqual(mergeNewestPage(cached, []), cached);
  });

  it('appends genuinely-new tail rows from the page', () => {
    const cached = [row(1), row(2), row(3)];
    const page = [row(2), row(3), row(4)]; // newest window, +1 new turn
    const merged = mergeNewestPage(cached, page);
    assert.deepEqual(merged.map(r => r.id), [1, 2, 3, 4]);
  });

  it('does NOT shrink a fuller cache to the newest page (the truncation bug)', () => {
    // cache holds deep history 1..10; server newest page is only 8..10.
    const cached = Array.from({ length: 10 }, (_, i) => row(i + 1));
    const page = [row(8), row(9), row(10)];
    const merged = mergeNewestPage(cached, page);
    assert.equal(merged.length, 10);
    assert.deepEqual(merged.map(r => r.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('replaces overlapping rows with the server copy (catches edits)', () => {
    const cached = [row(1, 'old'), row(2, 'old')];
    const page = [row(2, 'edited'), row(3, 'new')];
    const merged = mergeNewestPage(cached, page);
    assert.equal(merged.find(r => r.id === 2)!.content, 'edited');
    assert.equal(merged.find(r => r.id === 3)!.content, 'new');
  });

  it('handles string ids consistently with numeric ids', () => {
    const cached = [{ id: 'a' }, { id: 'b' }];
    const page = [{ id: 'b' }, { id: 'c' }];
    const merged = mergeNewestPage(cached, page);
    assert.deepEqual(merged.map(r => r.id), ['a', 'b', 'c']);
  });
});

describe('capTranscript', () => {
  it('is a no-op below the ceiling', () => {
    const messages = [row(1), row(2)];
    const pagination = { firstId: 1, hasMore: false };
    const out = capTranscript(messages, pagination);
    assert.equal(out.messages, messages);
    assert.equal(out.pagination, pagination);
  });

  it('keeps the newest MAX_CACHED_MESSAGES rows and resets the cursor', () => {
    const messages = Array.from({ length: MAX_CACHED_MESSAGES + 50 }, (_, i) => row(i + 1));
    const out = capTranscript(messages, { firstId: 1, hasMore: false });
    assert.equal(out.messages.length, MAX_CACHED_MESSAGES);
    // first kept row is row #51 (id 51), which becomes the new firstId.
    assert.equal(out.messages[0].id, 51);
    assert.equal(out.pagination.firstId, 51);
    assert.equal(out.pagination.hasMore, true);
  });

  it('falls back to prior firstId when the trimmed-oldest row has no numeric id', () => {
    const messages = Array.from({ length: MAX_CACHED_MESSAGES + 1 }, (_, i) => ({ id: `s${i}` }));
    const out = capTranscript(messages, { firstId: 999, hasMore: true });
    assert.equal(out.pagination.firstId, 999);
    assert.equal(out.pagination.hasMore, true);
  });
});

describe('sameTranscript', () => {
  it('true for identical id sequences', () => {
    assert.equal(sameTranscript([row(1), row(2)], [row(1), row(2)]), true);
  });

  it('true ignoring content differences (id-sequence only)', () => {
    assert.equal(sameTranscript([row(1, 'a')], [row(1, 'b')]), true);
  });

  it('false for different lengths', () => {
    assert.equal(sameTranscript([row(1)], [row(1), row(2)]), false);
  });

  it('false for reordered / different ids', () => {
    assert.equal(sameTranscript([row(1), row(2)], [row(2), row(1)]), false);
  });
});


describe('prefetchMergeMode', () => {
  // A 279-turn chat he had been in minutes earlier cached only 12 rows, so
  // every switch into it painted a near-empty transcript until the full page
  // landed ~6s later. Cause: the background prefetch REPLACED the cache with
  // its ~12-row window whenever that window did not overlap what was cached
  // — which is the normal state of a busy chat, since it advances by more
  // than a window between prefetches.
  it('prefetchMergeMode merges an overlapping window into a fuller cache', () => {
    assert.equal(prefetchMergeMode(200, 12, true), 'merge');
  });

  it('prefetchMergeMode KEEPS a fuller cache when the window does not overlap', () => {
    assert.equal(prefetchMergeMode(200, 12, false), 'keep-existing');
  });

  it('prefetchMergeMode replaces when there is nothing cached', () => {
    assert.equal(prefetchMergeMode(0, 12, false), 'replace');
  });

  it('prefetchMergeMode replaces when the window is at least as full as the cache', () => {
    assert.equal(prefetchMergeMode(12, 12, false), 'replace');
    assert.equal(prefetchMergeMode(5, 12, false), 'replace');
  });
});
