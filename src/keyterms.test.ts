/**
 * @fileoverview Cross-device sync tests for the keyterms module —
 * regression suite for the 2026-07-31 clobber incident: a phone with a
 * stale IDB mirror booted onto flaky cellular, its server GET failed
 * transiently, and the legacy-adoption path re-uploaded the stale
 * mirror over a newer server row (30 curated terms → 27).
 *
 * Pins the three defense layers:
 *   1. Tri-state server read — adoption (a WRITE) happens only on an
 *      affirmative `missing`; a transient failure is read-only.
 *   2. Dirty-flag + 3-way merge — a silently-failed PUT marks the
 *      mirror dirty; the next successful read merges (base=lastSynced,
 *      mine=local, theirs=server) and re-uploads without resurrecting
 *      deletions.
 *   3. Compare-and-swap — PUTs carry the last-seen updated_at; a 409
 *      triggers one merge-and-retry against the returned row.
 *
 * All network/IDB goes through the _setFetchForTests/_setIdbForTests
 * seams (same pattern as notifications/badge.test.ts).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeKeytermLists, readList, writeList, loadOrSeed,
  _setFetchForTests, _setIdbForTests, type KeytermsRecord,
} from './keyterms.ts';

// ── Harness ────────────────────────────────────────────────────────────

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** Scripted fetch: pops one queued Response (or throws one queued
 *  Error) per call and records every call for assertions. */
function fakeFetch() {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const queue: Array<Response | Error> = [];
  const impl = async (url: string, opts: RequestInit & { timeoutMs: number }) => {
    calls.push({
      url,
      method: String(opts?.method ?? 'GET'),
      body: typeof opts?.body === 'string' ? JSON.parse(opts.body) : null,
    });
    const next = queue.shift();
    if (!next) throw new Error(`fakeFetch: unscripted call ${opts?.method ?? 'GET'} ${url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  const puts = () => calls.filter((c) => c.method === 'PUT');
  return { calls, queue, impl, puts };
}

/** One-record in-memory stand-in for the IDB mirror. */
function fakeIdb(initial: KeytermsRecord | null = null) {
  const box: { rec: KeytermsRecord | null } = { rec: initial };
  return {
    box,
    read: async () => box.rec,
    write: async (rec: KeytermsRecord) => { box.rec = rec; },
  };
}

/** The exact record shape the incident phone had: pre-CAS mirror with
 *  no sync-state fields at all. */
function legacyRecord(terms: string[]): KeytermsRecord {
  return { id: 'list', terms, updatedAt: 1_700_000_000_000 };
}

let f: ReturnType<typeof fakeFetch>;
let idb: ReturnType<typeof fakeIdb>;

function wire(initial: KeytermsRecord | null = null) {
  f = fakeFetch();
  idb = fakeIdb(initial);
  _setFetchForTests(f.impl);
  _setIdbForTests(idb);
}

beforeEach(() => wire());
afterEach(() => { _setFetchForTests(null); _setIdbForTests(null); });

// ── 3-way merge (pure) ─────────────────────────────────────────────────

describe('mergeKeytermLists', () => {
  it('keeps additions from both sides', () => {
    assert.deepEqual(
      mergeKeytermLists(['a'], ['a', 'mine'], ['a', 'theirs']),
      ['a', 'theirs', 'mine'],
    );
  });

  it('honors deletions from both sides', () => {
    // I deleted b; they deleted c. Neither comes back.
    assert.deepEqual(
      mergeKeytermLists(['a', 'b', 'c'], ['a', 'c'], ['a', 'b']),
      ['a'],
    );
  });

  it('add+delete overlap: my delete of a term they kept wins; adds survive', () => {
    assert.deepEqual(
      mergeKeytermLists(['a', 'b'], ['a', 'new'], ['a', 'b', 'srv']),
      ['a', 'srv', 'new'],
    );
  });

  it('identity is case-insensitive and theirs casing wins', () => {
    assert.deepEqual(
      mergeKeytermLists([], ['deepgram'], ['Deepgram']),
      ['Deepgram'],
    );
  });

  it('orders theirs first, then new local adds in mine order', () => {
    assert.deepEqual(
      mergeKeytermLists([], ['m1', 'm2'], ['t1', 't2']),
      ['t1', 't2', 'm1', 'm2'],
    );
  });

  it('empty base degrades to a union (nothing counts as deleted)', () => {
    assert.deepEqual(
      mergeKeytermLists([], ['a', 'b'], ['b', 'c']),
      ['b', 'c', 'a'],
    );
  });
});

// ── Tri-state server read ──────────────────────────────────────────────

describe('readList tri-state', () => {
  it('ok+value: adopts the server list and records the CAS base', async () => {
    f.queue.push(response(200, {
      key: 'stt_keyterms', value: ['A', 'B'], missing: false, updated_at: 100.5,
    }));
    assert.deepEqual(await readList(), ['A', 'B']);
    assert.equal(f.puts().length, 0);
    assert.deepEqual(idb.box.rec?.terms, ['A', 'B']);
    assert.equal(idb.box.rec?.dirty, false);
    assert.deepEqual(idb.box.rec?.lastSynced, ['A', 'B']);
    assert.equal(idb.box.rec?.serverUpdatedAt, 100.5);
  });

  it('affirmative missing + legacy mirror: adopts onto the server with a null CAS base', async () => {
    wire(legacyRecord(['Hermes', 'Deepgram']));
    f.queue.push(response(200, { key: 'stt_keyterms', value: null, missing: true, updated_at: null }));
    f.queue.push(response(200, { ok: true, key: 'stt_keyterms', value: ['Hermes', 'Deepgram'], updated_at: 200.0 }));
    assert.deepEqual(await readList(), ['Hermes', 'Deepgram']);
    const puts = f.puts();
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].body, { value: ['Hermes', 'Deepgram'], base_updated_at: null });
    assert.equal(idb.box.rec?.dirty, false);
    assert.equal(idb.box.rec?.serverUpdatedAt, 200.0);
  });

  it('affirmative missing + no mirror: returns null (caller seeds), no PUT', async () => {
    f.queue.push(response(200, { key: 'stt_keyterms', value: null, missing: true, updated_at: null }));
    assert.equal(await readList(), null);
    assert.equal(f.calls.length, 1);
  });

  it('INCIDENT REGRESSION: 5xx read + stale mirror returns the mirror and NEVER uploads it', async () => {
    wire(legacyRecord(['Hermes', 'Deepgram', 'StaleOnly']));
    f.queue.push(response(503, { error: 'upstream_unavailable' }));
    assert.deepEqual(await readList(), ['Hermes', 'Deepgram', 'StaleOnly']);
    assert.equal(f.puts().length, 0, 'a transient read failure must never mutate server state');
    assert.equal(f.calls.length, 1);
  });

  it('INCIDENT REGRESSION: network throw (cellular timeout) is equally read-only', async () => {
    wire(legacyRecord(['Hermes']));
    f.queue.push(new Error('fetch timed out after 5000ms'));
    assert.deepEqual(await readList(), ['Hermes']);
    assert.equal(f.puts().length, 0);
  });

  it('ambiguous legacy shape (value:null, no missing flag) is treated as an error, not missing', async () => {
    // An old proxy can't distinguish no-row from anything else; without
    // the affirmative flag the client must not write.
    wire(legacyRecord(['Hermes']));
    f.queue.push(response(200, { key: 'stt_keyterms', value: null }));
    assert.deepEqual(await readList(), ['Hermes']);
    assert.equal(f.puts().length, 0);
  });
});

// ── Dirty flag + recovery merge ────────────────────────────────────────

describe('writeList dirty lifecycle', () => {
  it('successful PUT clears dirty and advances lastSynced + CAS base', async () => {
    wire({ id: 'list', terms: ['old'], updatedAt: 1, dirty: false, lastSynced: ['old'], serverUpdatedAt: 100 });
    f.queue.push(response(200, { ok: true, key: 'stt_keyterms', value: ['x'], updated_at: 101 }));
    await writeList(['x']);
    const puts = f.puts();
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].body, { value: ['x'], base_updated_at: 100 });
    assert.deepEqual(idb.box.rec, {
      id: 'list', terms: ['x'], updatedAt: idb.box.rec!.updatedAt,
      dirty: false, lastSynced: ['x'], serverUpdatedAt: 101,
    });
  });

  it('failed PUT marks the mirror dirty and leaves lastSynced untouched', async () => {
    wire({ id: 'list', terms: ['old'], updatedAt: 1, dirty: false, lastSynced: ['old'], serverUpdatedAt: 100 });
    f.queue.push(new Error('offline'));
    await writeList(['old', 'new']);
    assert.equal(idb.box.rec?.dirty, true);
    assert.deepEqual(idb.box.rec?.terms, ['old', 'new']);
    assert.deepEqual(idb.box.rec?.lastSynced, ['old']);
    assert.equal(idb.box.rec?.serverUpdatedAt, 100);
  });

  it('legacy record (pre-CAS): PUT sends no base at all (old LWW), then upgrades', async () => {
    wire(legacyRecord(['a']));
    f.queue.push(response(200, { ok: true, key: 'stt_keyterms', value: ['a', 'b'], updated_at: 300 }));
    await writeList(['a', 'b']);
    const puts = f.puts();
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].body, { value: ['a', 'b'] });
    assert.ok(!('base_updated_at' in puts[0].body));
    assert.equal(idb.box.rec?.serverUpdatedAt, 300);
    assert.equal(idb.box.rec?.dirty, false);
  });

  it('a later successful read 3-way merges a dirty mirror and re-uploads it', async () => {
    // Silently-failed write left mine=['a','mine'] (I also deleted 'b');
    // meanwhile another device pushed ['a','b','theirs'].
    wire({
      id: 'list', terms: ['a', 'mine'], updatedAt: 1,
      dirty: true, lastSynced: ['a', 'b'], serverUpdatedAt: 100,
    });
    f.queue.push(response(200, {
      key: 'stt_keyterms', value: ['a', 'b', 'theirs'], missing: false, updated_at: 150,
    }));
    f.queue.push(response(200, {
      ok: true, key: 'stt_keyterms', value: ['a', 'theirs', 'mine'], updated_at: 151,
    }));
    assert.deepEqual(await readList(), ['a', 'theirs', 'mine']);
    const puts = f.puts();
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].body, { value: ['a', 'theirs', 'mine'], base_updated_at: 150 });
    assert.equal(idb.box.rec?.dirty, false);
    assert.deepEqual(idb.box.rec?.lastSynced, ['a', 'theirs', 'mine']);
    assert.equal(idb.box.rec?.serverUpdatedAt, 151);
  });

  it('dirty mirror whose edits already landed: read clears dirty without a PUT', async () => {
    wire({
      id: 'list', terms: ['a', 'b'], updatedAt: 1,
      dirty: true, lastSynced: ['a'], serverUpdatedAt: 100,
    });
    f.queue.push(response(200, {
      key: 'stt_keyterms', value: ['a', 'b'], missing: false, updated_at: 150,
    }));
    assert.deepEqual(await readList(), ['a', 'b']);
    assert.equal(f.puts().length, 0);
    assert.equal(idb.box.rec?.dirty, false);
    assert.equal(idb.box.rec?.serverUpdatedAt, 150);
  });
});

// ── Compare-and-swap on write ──────────────────────────────────────────

describe('writeList 409 merge-retry', () => {
  it('merges against the 409 body and retries once with the new base', async () => {
    wire({ id: 'list', terms: ['a', 'b'], updatedAt: 1, dirty: false, lastSynced: ['a', 'b'], serverUpdatedAt: 100 });
    f.queue.push(response(409, { error: 'conflict', key: 'stt_keyterms', value: ['a', 'b', 'theirs'], updated_at: 200 }));
    f.queue.push(response(200, { ok: true, key: 'stt_keyterms', value: ['a', 'b', 'theirs', 'mine'], updated_at: 201 }));
    const result = await writeList(['a', 'b', 'mine']);
    assert.deepEqual(result, ['a', 'b', 'theirs', 'mine']);
    const puts = f.puts();
    assert.equal(puts.length, 2);
    assert.deepEqual(puts[0].body, { value: ['a', 'b', 'mine'], base_updated_at: 100 });
    assert.deepEqual(puts[1].body, { value: ['a', 'b', 'theirs', 'mine'], base_updated_at: 200 });
    assert.equal(idb.box.rec?.dirty, false);
    assert.deepEqual(idb.box.rec?.lastSynced, ['a', 'b', 'theirs', 'mine']);
    assert.equal(idb.box.rec?.serverUpdatedAt, 201);
  });

  it('a second 409 gives up dirty (no third PUT); the merged list is kept locally', async () => {
    wire({ id: 'list', terms: ['a'], updatedAt: 1, dirty: false, lastSynced: ['a'], serverUpdatedAt: 100 });
    f.queue.push(response(409, { error: 'conflict', key: 'stt_keyterms', value: ['a', 't1'], updated_at: 200 }));
    f.queue.push(response(409, { error: 'conflict', key: 'stt_keyterms', value: ['a', 't1', 't2'], updated_at: 300 }));
    await writeList(['a', 'mine']);
    assert.equal(f.puts().length, 2, 'retry exactly once');
    assert.equal(idb.box.rec?.dirty, true);
    // Both conflicts' rows got merged in; nothing was lost locally.
    assert.deepEqual(idb.box.rec?.terms, ['a', 't1', 't2', 'mine']);
    // We KNOW the server holds the last 409's row — record it as the
    // new base so the next sync merges against reality.
    assert.deepEqual(idb.box.rec?.lastSynced, ['a', 't1', 't2']);
    assert.equal(idb.box.rec?.serverUpdatedAt, 300);
  });
});

// ── First-boot seeding vs server errors ────────────────────────────────

describe('loadOrSeed under server errors', () => {
  it('server unreachable + no mirror: renders the seed but does NOT persist it', async () => {
    f.queue.push(response(503, { error: 'upstream_unavailable' })); // prefs GET
    f.queue.push(response(200, 'foo, bar'));                        // /api/keyterms seed file
    assert.deepEqual(await loadOrSeed(), ['foo', 'bar']);
    assert.equal(f.puts().length, 0, 'seeding over an unreadable row could clobber it');
    assert.equal(idb.box.rec, null, 'no mirror either — nothing to adopt later');
  });

  it('affirmative missing + no mirror: seeds and persists with a null CAS base', async () => {
    f.queue.push(response(200, { key: 'stt_keyterms', value: null, missing: true, updated_at: null })); // prefs GET
    f.queue.push(response(200, 'foo, bar'));                                                            // seed file
    f.queue.push(response(200, { ok: true, key: 'stt_keyterms', value: ['foo', 'bar'], updated_at: 400 }));
    assert.deepEqual(await loadOrSeed(), ['foo', 'bar']);
    const puts = f.puts();
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].body, { value: ['foo', 'bar'], base_updated_at: null });
    assert.equal(idb.box.rec?.serverUpdatedAt, 400);
  });
});
