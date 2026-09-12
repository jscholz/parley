/**
 * @fileoverview Tests for the pure cmd+K result model: highlight
 * segmentation, client/server reconciliation, and the sequence guard.
 * Run with: npm test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  highlightRanges, segments, reconcileSessions, viewFromServer, QuerySequence,
  sessionsEmptyText, messagesStatusText, hitMetaParts,
} from '../src/search/searchModel.ts';
import type { SessionView } from '../src/search/searchModel.ts';

const view = (id: string, title: string, extra: Partial<SessionView> = {}): SessionView => ({
  id, title, source: 'parley', messageCount: null, lastMessageAt: null,
  match: 'title', highlights: [], ...extra,
});

describe('searchModel.highlightRanges / segments', () => {
  it('finds each term once, case-insensitively, sorted', () => {
    assert.deepEqual(highlightRanges('Fix R2 investor calendar cron', ['cron', 'fix']), [[0, 3], [25, 29]]);
  });

  it('skips absent terms rather than failing', () => {
    assert.deepEqual(highlightRanges('hello', ['zzz', 'ell']), [[1, 4]]);
  });

  it('segments merge overlaps and clamp out-of-range', () => {
    const segs = segments('abcdef', [[1, 3], [2, 4], [10, 20], [5, 99]]);
    assert.deepEqual(segs, [
      { text: 'a', hit: false },
      { text: 'bcd', hit: true },
      { text: 'e', hit: false },
      { text: 'f', hit: true },
    ]);
  });

  it('segments with no ranges is one plain run', () => {
    assert.deepEqual(segments('plain', null), [{ text: 'plain', hit: false }]);
    assert.deepEqual(segments('plain', [[3, 3], ['x' as any, 2]]), [{ text: 'plain', hit: false }]);
  });
});

describe('searchModel.reconcileSessions', () => {
  it('keeps client rows the server did not list (the "fix cron" bug)', () => {
    const client = [view('parley:a', 'Fix R2 investor calendar cron', { highlights: [[0, 3]], lastMessageAt: 100 })];
    const server = [view('parley:b', 'Other chat', { lastMessageAt: 50 })];
    const out = reconcileSessions(client, server);
    assert.deepEqual(out.map((r) => r.id), ['parley:a', 'parley:b']);
    // Recency, not origin, decides order: an older client row sorts after
    // a newer server row but is still present.
    const older = reconcileSessions([view('parley:a', 'Fix cron', { lastMessageAt: 10 })], server);
    assert.deepEqual(older.map((r) => r.id), ['parley:b', 'parley:a']);
  });

  it('merges by id: client title wins, server fills recency/count', () => {
    const client = [view('parley:a', 'Renamed by user')];
    const server = [view('parley:a', 'auto title', { lastMessageAt: 1000, messageCount: 7, highlights: [[0, 4]] })];
    const [row] = reconcileSessions(client, server);
    assert.equal(row.title, 'Renamed by user');
    assert.equal(row.lastMessageAt, 1000);
    assert.equal(row.messageCount, 7);
    // Server highlights index into ITS title, so they do not transfer.
    assert.deepEqual(row.highlights, []);
  });

  it('server highlights transfer when titles agree', () => {
    const client = [view('parley:a', 'Same')];
    const server = [view('parley:a', 'Same', { highlights: [[0, 2]] })];
    assert.deepEqual(reconcileSessions(client, server)[0].highlights, [[0, 2]]);
  });

  it('orders id matches first, then recency, unknown recency last', () => {
    const client = [
      view('c1', 'old', { lastMessageAt: 10 }),
      view('c2', 'unknown'),
      view('c3', 'new', { lastMessageAt: 30 }),
    ];
    const server = [view('s1', 'by id', { match: 'id' })];
    assert.deepEqual(reconcileSessions(client, server).map((r) => r.id), ['s1', 'c3', 'c1', 'c2']);
  });

  it('caps the merged list and ignores rows without ids', () => {
    const client = Array.from({ length: 12 }, (_, i) => view(`c${i}`, `row ${i}`, { lastMessageAt: 100 - i }));
    const out = reconcileSessions(client, [{ ...view('', 'ghost') }], 10);
    assert.equal(out.length, 10);
    assert.equal(out[0].id, 'c0');
  });
});

describe('searchModel.viewFromServer', () => {
  it('defaults older backends to a title match with client highlights', () => {
    const v = viewFromServer({ id: 'x', title: 'Zephyr Pipeline' }, ['pipe']);
    assert.equal(v.match, 'title');
    assert.deepEqual(v.highlights, [[7, 11]]);
  });

  it('honours server match + highlights', () => {
    const v = viewFromServer({ id: 'x', title: 'T', match: 'id', highlights: [] }, ['t']);
    assert.equal(v.match, 'id');
    assert.deepEqual(v.highlights, []);
  });

  it('falls back to snippet then id for the label', () => {
    assert.equal(viewFromServer({ id: 'raw', title: '', snippet: 'first words' }, []).title, 'first words');
    assert.equal(viewFromServer({ id: 'raw' }, []).title, 'raw');
  });
});

describe('searchModel.QuerySequence', () => {
  it('only the latest ticket is current', () => {
    const seq = new QuerySequence();
    const a = seq.next();
    const b = seq.next();
    assert.equal(seq.isCurrent(a), false);
    assert.equal(seq.isCurrent(b), true);
  });
});

describe('searchModel empty/status copy', () => {
  it('sessions: never claims "no match" before the server answers', () => {
    assert.equal(sessionsEmptyText({ query: 'x', rowCount: 0, serverAnswered: false }), null);
    assert.equal(sessionsEmptyText({ query: 'x', rowCount: 0, serverAnswered: true }), 'No matching sessions.');
    assert.equal(sessionsEmptyText({ query: 'x', rowCount: 2, serverAnswered: true }), null);
    assert.equal(sessionsEmptyText({ query: '  ', rowCount: 0, serverAnswered: true }), null);
  });

  it('messages: pending, empty, error, and no-index states', () => {
    assert.equal(messagesStatusText({ query: 'x', hitCount: 0, serverAnswered: false, hasSearch: true }), '…');
    assert.equal(messagesStatusText({ query: 'x', hitCount: 0, serverAnswered: true, hasSearch: true }), 'no matches');
    assert.equal(messagesStatusText({ query: 'x', hitCount: 3, serverAnswered: true, hasSearch: true }), '');
    assert.equal(messagesStatusText({ query: 'x', hitCount: 0, serverAnswered: true, hasSearch: true, error: 'HTTP 502' }), 'HTTP 502');
    assert.equal(messagesStatusText({ query: 'x', hitCount: 0, serverAnswered: false, hasSearch: false }), '');
  });

  it('hit meta: chat name · role · time · +N more; parley source is implied', () => {
    const parts = hitMetaParts({
      session_id: 'parley:a', message_id: 1, role: 'user', snippet: 's', timestamp: 0,
      session_title: 'Daily recap', session_source: 'parley', more_in_session: 4,
    }, 'Sep 12, 1:00 AM');
    assert.deepEqual(parts, ['Daily recap', 'user', 'Sep 12, 1:00 AM', '+4 more in this chat']);
    const tg = hitMetaParts({ session_id: 't', message_id: 1, role: 'assistant', snippet: 's', timestamp: 0, session_source: 'telegram' }, '');
    assert.deepEqual(tg, ['telegram', 'assistant']);
  });
});
