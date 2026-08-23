/**
 * @fileoverview Tests for the shared session filter parser/applier.
 * Run with: npm test (uses node --test --experimental-strip-types).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, applyFilter, applyRecordingFilter, defaultRecordingFilter } from '../src/sessionFilter.ts';

const sessions = [
  { id: 'parley-main', title: 'Project Hermes', snippet: 'migration plan', source: 'api_server' },
  { id: 'wa-2026-04-20-jane', title: 'WhatsApp: Jane', snippet: 'lunch tomorrow', source: 'whatsapp' },
  { id: 'tg-bob', title: null, snippet: 'standup notes', source: 'telegram' },
  { id: 'cli-debug', title: 'Debug session', snippet: 'log inspection', source: 'cli' },
  { id: 'parley-1234', title: 'Trip to Paris', snippet: 'flights and hotels', source: 'api_server' },
];

describe('sessionFilter.parseQuery', () => {
  it('returns empty query for empty input', () => {
    const q = parseQuery('');
    assert.equal(q.raw, '');
    assert.deepEqual(q.terms, []);
    assert.deepEqual(q.globs, []);
  });

  it('tokenizes plain whitespace-separated terms', () => {
    const q = parseQuery('hermes plan');
    assert.deepEqual(q.terms, ['hermes', 'plan']);
    assert.deepEqual(q.globs, []);
  });

  it('classifies tokens with * or ? as globs', () => {
    const q = parseQuery('foo* bar?baz plain');
    assert.deepEqual(q.terms, ['plain']);
    assert.deepEqual(q.globs, ['foo*', 'bar?baz']);
  });

  it('tolerates reserved field prefixes by stripping them', () => {
    // source:whatsapp → 'whatsapp' as a regular term (no field-aware
    // matching yet; the tolerance prevents user-typed prefixes from
    // crashing or filtering to zero).
    const q = parseQuery('source:whatsapp Jane');
    assert.deepEqual(q.terms, ['whatsapp', 'Jane']);
  });

  it('drops empty-value reserved-prefix tokens', () => {
    const q = parseQuery('source: jane');
    assert.deepEqual(q.terms, ['jane']);
  });
});

describe('sessionFilter.applyFilter', () => {
  it('empty query passes through all sessions', () => {
    const out = applyFilter(sessions, parseQuery(''));
    assert.equal(out.length, sessions.length);
  });

  it('single term substring matches title/snippet/source/id union', () => {
    const out = applyFilter(sessions, parseQuery('paris'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'parley-1234');
  });

  it('multi-term query AND-matches across the union', () => {
    // 'whatsapp' hits source, 'jane' hits title — both must match.
    const out = applyFilter(sessions, parseQuery('whatsapp jane'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'wa-2026-04-20-jane');
  });

  it('glob with * matches across union', () => {
    // 'parley-*' should hit both parley-* sessions via id.
    const out = applyFilter(sessions, parseQuery('parley-*'));
    assert.equal(out.length, 2);
    assert.ok(out.every((s) => s.id.startsWith('parley-')));
  });

  it('case-insensitive', () => {
    const out = applyFilter(sessions, parseQuery('HERMES'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'parley-main');
  });

  it('no-match returns empty array', () => {
    const out = applyFilter(sessions, parseQuery('zzzzznevergonnamatch'));
    assert.deepEqual(out, []);
  });

  it('handles missing optional fields without crashing', () => {
    // tg-bob has title=null. Searching for 'standup' (in snippet) still hits.
    const out = applyFilter(sessions, parseQuery('standup'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'tg-bob');
  });

  it('combined term + glob both required', () => {
    // 'parley-*' filters to the two parley rows; 'paris' narrows to one.
    const out = applyFilter(sessions, parseQuery('parley-* paris'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'parley-1234');
  });

  it('matches raw hermes session ids via sessionIds', () => {
    // Field bug 2026-06-11: the row's own id is the parley:<uuid>
    // chat id, so pasting a raw hermes session id (incl. a rotated
    // child's) matched nothing. sessionIds carries the space-joined
    // raw ids from the backend listing.
    const rows = [
      { id: 'parley:c31cd523', title: 'Investor Call', snippet: '', source: 'parley',
        sessionIds: '20260601_120000_aaaaaa 20260611_223425_98bd2b' },
      { id: 'parley:other', title: 'Other', snippet: '', source: 'parley',
        sessionIds: '20260530_090000_cccccc' },
    ];
    const out = applyFilter(rows, parseQuery('20260611_223425_98bd2b'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'parley:c31cd523');
    // Fragment matches too (substring semantics).
    const frag = applyFilter(rows, parseQuery('98bd2b'));
    assert.equal(frag.length, 1);
    assert.equal(frag[0].id, 'parley:c31cd523');
    // Rows without sessionIds still work.
    const none = applyFilter([{ id: 'x', title: 't', snippet: null, source: 's' }],
      parseQuery('98bd2b'));
    assert.deepEqual(none, []);
  });
});

describe('sessionFilter.applyRecordingFilter (meeting-polish #25)', () => {
  const rows = [
    { id: 'chat-rec', title: 'Standup', snippet: null, source: 'api_server' },
    { id: 'chat-plain', title: 'Notes', snippet: null, source: 'api_server' },
    { id: 'chat-rec-2', title: 'Retro', snippet: null, source: 'api_server' },
  ];
  const recorded = new Set(['chat-rec', 'chat-rec-2']);
  const hasRec = (id: string) => recorded.has(id);

  it('defaults: disengaged, has-recording option pre-ticked', () => {
    const st = defaultRecordingFilter();
    assert.equal(st.engaged, false, 'the drawer must not boot filtered');
    assert.equal(st.hasRecording, true, 'option defaults to on per spec');
  });

  it('disengaged → pass-through regardless of option', () => {
    assert.deepEqual(
      applyRecordingFilter(rows, { engaged: false, hasRecording: true }, hasRec),
      rows,
    );
  });

  it('engaged + option on → only sessions with recordings', () => {
    const out = applyRecordingFilter(rows, { engaged: true, hasRecording: true }, hasRec);
    assert.deepEqual(out.map((r) => r.id), ['chat-rec', 'chat-rec-2']);
  });

  it('engaged + option unticked → pass-through (no option constrains)', () => {
    assert.deepEqual(
      applyRecordingFilter(rows, { engaged: true, hasRecording: false }, hasRec),
      rows,
    );
  });

  it('rows without an id never pass an engaged has-recording filter', () => {
    const out = applyRecordingFilter(
      [...rows, { title: 'ghost', snippet: null, source: 'api_server' }],
      { engaged: true, hasRecording: true },
      () => true,
    );
    assert.deepEqual(out.map((r: any) => r.id), ['chat-rec', 'chat-plain', 'chat-rec-2']);
  });

  it('stacks with the text filter (drawer order: text first, then option)', () => {
    const texted = applyFilter(rows, parseQuery('re'));   // Retro + chat-rec ids…
    const out = applyRecordingFilter(texted, { engaged: true, hasRecording: true }, hasRec);
    assert.ok(out.every((r) => recorded.has(r.id)));
  });
});
