/**
 * @fileoverview Fallback card parser tests — media lane round 2.
 *
 * Focus:
 *   1. classifyMediaUrl: extension → video / audio / image, incl. the
 *      m4a/mp3/wav/ogg audio set the media route serves (proxy media.ts)
 *      and query-string tolerance.
 *   2. parseCardsFromText markdown-image classification produces an
 *      `audio` card for an audio link (the agent-pushed lane) while
 *      leaving video/image behavior intact.
 *   3. cardHash — the dedup predicate the historical/live overlap relies
 *      on: identical payloads hash equal, differing ones don't.
 *
 * Strip-only TS: no parameter properties / enums.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMediaUrl, parseCardsFromText } from './fallback.ts';
import { cardHash } from './attach.ts';

describe('classifyMediaUrl', () => {
  it('classifies video extensions', () => {
    for (const u of [
      '/api/parley/media/abcd.mp4',
      'https://x/y.m4v',
      '/a/b.mov',
      '/a/b.webm',
    ]) {
      assert.equal(classifyMediaUrl(u), 'video', u);
    }
  });

  it('classifies audio extensions', () => {
    for (const u of [
      '/api/parley/media/abcd.m4a',
      'https://x/y.mp3',
      '/a/b.wav',
      '/a/b.ogg',
    ]) {
      assert.equal(classifyMediaUrl(u), 'audio', u);
    }
  });

  it('tolerates a trailing query string', () => {
    assert.equal(classifyMediaUrl('/api/parley/media/x.mp3?t=12'), 'audio');
    assert.equal(classifyMediaUrl('/api/parley/media/x.mp4?v=2'), 'video');
  });

  it('falls back to image for anything else', () => {
    for (const u of ['/a/b.png', '/a/b.jpg', '/a/b.webp', '/a/b', '/a/b.txt']) {
      assert.equal(classifyMediaUrl(u), 'image', u);
    }
  });

  it('is case-insensitive on the extension', () => {
    assert.equal(classifyMediaUrl('/a/B.MP3'), 'audio');
    assert.equal(classifyMediaUrl('/a/B.MP4'), 'video');
  });
});

describe('parseCardsFromText — audio markdown link', () => {
  it('renders an audio card from a markdown audio link', () => {
    const cards = parseCardsFromText(
      'here is the mix ![Final master](/api/parley/media/deadbeefdeadbeef.m4a)',
    );
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'audio');
    assert.equal(cards[0].payload.url, '/api/parley/media/deadbeefdeadbeef.m4a');
    assert.equal(cards[0].payload.caption, 'Final master');
  });

  it('still classifies video + image links correctly alongside audio', () => {
    const cards = parseCardsFromText(
      '![v](/m/a.mp4) ![a](/m/b.mp3) ![i](/m/c.png)',
    );
    assert.deepEqual(cards.map((c) => c.kind), ['video', 'audio', 'image']);
  });
});

describe('cardHash — dedup predicate', () => {
  it('hashes identical payloads equal', () => {
    const a = { v: 1, kind: 'audio', payload: { url: '/m/x.mp3', caption: 'c' } };
    const b = { v: 1, kind: 'audio', payload: { url: '/m/x.mp3', caption: 'c' } };
    assert.equal(cardHash(a), cardHash(b));
  });

  it('distinguishes different urls', () => {
    const a = { v: 1, kind: 'audio', payload: { url: '/m/x.mp3' } };
    const b = { v: 1, kind: 'audio', payload: { url: '/m/y.mp3' } };
    assert.notEqual(cardHash(a), cardHash(b));
  });

  it('distinguishes different kinds for the same url', () => {
    const a = { v: 1, kind: 'audio', payload: { url: '/m/x' } };
    const b = { v: 1, kind: 'video', payload: { url: '/m/x' } };
    assert.notEqual(cardHash(a), cardHash(b));
  });
});
