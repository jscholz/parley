/**
 * Capture store contract tests (plan §Phase 1 gate: manifest
 * lifecycle, sha mismatch → 409, idempotent re-upload, PATCH
 * rename/link, atomic index, stale-recording auto-heal, marks).
 *
 * Module-level tests against a tmp dir — no HTTP rig; the handlers
 * are thin wrappers over these functions. Strip-only TS: no enums /
 * parameter properties (the whole file aborts at load otherwise).
 */
import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import {
  initCapture, createCapture, putSegment, stopCapture, patchCapture,
  addMark, getCapture, listCaptures, CaptureError,
} from '../capture.ts';

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-capture-test-'));
  initCapture({ dir });
});

function sha(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('lifecycle: create → segments → stop → complete manifest + index', async () => {
  const m = await createCapture({ title: 'Standup', linkedChat: 'sidekick:abc' });
  assert.match(m.id, /^cap_\d+_[0-9a-f]{6}$/);
  assert.equal(m.status, 'recording');
  assert.equal(m.diarize, true);            // default ON for meetings

  const seg0 = Buffer.from('segment-zero-bytes');
  const seg1 = Buffer.from('segment-one-bytes!');
  await putSegment(m.id, 0, seg0, { t0Ms: 0, mime: 'audio/mp4', sha256: sha(seg0) });
  await putSegment(m.id, 1, seg1, { t0Ms: 45_000, mime: 'audio/mp4', sha256: sha(seg1) });

  const stopped = await stopCapture(m.id);
  assert.equal(stopped.status, 'complete');
  assert.ok(stopped.ended_at! >= stopped.started_at);
  assert.equal(stopped.segments.length, 2);
  assert.deepEqual(stopped.segments.map((s) => s.seq), [0, 1]);

  // Segment bytes on disk, named by seq + mime ext.
  const segDir = path.join(dir, m.id, 'seg');
  const files = (await fs.readdir(segDir)).sort();
  assert.deepEqual(files, ['0.m4a', '1.m4a']);

  // index.json mirrors the manifests.
  const idx = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(idx.captures.length, 1);
  assert.equal(idx.captures[0].id, m.id);
  assert.equal(idx.captures[0].segment_count, 2);
  assert.equal(idx.captures[0].total_bytes, seg0.length + seg1.length);
});

test('sha mismatch → 409, nothing persisted', async () => {
  const m = await createCapture({});
  await assert.rejects(
    () => putSegment(m.id, 0, Buffer.from('real bytes'), {
      t0Ms: 0, mime: 'audio/mp4', sha256: 'deadbeef'.repeat(8),
    }),
    (e: CaptureError) => e.status === 409,
  );
  const after = await getCapture(m.id);
  assert.equal(after.segments.length, 0);
});

test('idempotent re-upload: same bytes ack as duplicate, different bytes 409', async () => {
  const m = await createCapture({});
  const body = Buffer.from('the-same-bytes');
  const first = await putSegment(m.id, 3, body, { t0Ms: 0, mime: 'audio/webm' });
  assert.equal(first.duplicate, false);
  const again = await putSegment(m.id, 3, body, { t0Ms: 0, mime: 'audio/webm' });
  assert.equal(again.duplicate, true);
  assert.equal((await getCapture(m.id)).segments.length, 1);

  await assert.rejects(
    () => putSegment(m.id, 3, Buffer.from('DIFFERENT bytes'), { t0Ms: 0, mime: 'audio/webm' }),
    (e: CaptureError) => e.status === 409,
  );
});

test('segments still accepted after stop is requested… but not after terminal state', async () => {
  // Resumable-uploader contract: an outage during the meeting means
  // tail segments arrive late. Terminal states freeze the capture.
  const m = await createCapture({});
  await stopCapture(m.id);   // Phase 1 goes straight to 'complete'
  await assert.rejects(
    () => putSegment(m.id, 0, Buffer.from('late'), { t0Ms: 0, mime: 'audio/mp4' }),
    (e: CaptureError) => e.status === 409,
  );
});

test('one active capture at a time; stale recording auto-heals', async () => {
  const a = await createCapture({ title: 'A' });
  await assert.rejects(() => createCapture({ title: 'B' }),
    (e: CaptureError) => e.status === 409);

  // Age the active capture past the stale window by rewriting its
  // start stamp (no segments → activity = started_at).
  const manifestPath = path.join(dir, a.id, 'manifest.json');
  const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  m.started_at = Date.now() - 11 * 60 * 1000;
  await fs.writeFile(manifestPath, JSON.stringify(m));

  const b = await createCapture({ title: 'B' });   // heals A, starts B
  assert.equal(b.status, 'recording');
  assert.equal((await getCapture(a.id)).status, 'failed');
});

test('patch: rename, re-link, diarize toggle; diarize frozen after finish', async () => {
  const m = await createCapture({ title: 'Meeting 2026-07-08' });
  const p1 = await patchCapture(m.id, { title: 'R2 fundraise sync', linkedChat: 'sidekick:xyz' });
  assert.equal(p1.title, 'R2 fundraise sync');
  assert.equal(p1.linked_chat, 'sidekick:xyz');
  const p2 = await patchCapture(m.id, { diarize: false });
  assert.equal(p2.diarize, false);

  await stopCapture(m.id);
  await assert.rejects(() => patchCapture(m.id, { diarize: true }),
    (e: CaptureError) => e.status === 409);
  // Rename after finish stays allowed (annotate-later covers history).
  const p3 = await patchCapture(m.id, { title: 'Renamed later' });
  assert.equal(p3.title, 'Renamed later');
});

test('marks append while recording only', async () => {
  const m = await createCapture({});
  await addMark(m.id, 61_500);
  await addMark(m.id, 125_000);
  assert.deepEqual((await getCapture(m.id)).marks, [{ t_ms: 61_500 }, { t_ms: 125_000 }]);
  await stopCapture(m.id);
  await assert.rejects(() => addMark(m.id, 200_000), (e: CaptureError) => e.status === 409);
});

test('id validation rejects traversal shapes', async () => {
  await assert.rejects(() => getCapture('../../etc/passwd' as any),
    (e: CaptureError) => e.status === 400);
  await assert.rejects(() => getCapture('cap_123_zzzzzz'),
    (e: CaptureError) => e.status === 400);
});

test('list: newest-first, torn manifest skipped not fatal', async () => {
  const a = await createCapture({ title: 'first' });
  await stopCapture(a.id);
  await new Promise((r) => setTimeout(r, 5));
  const b = await createCapture({ title: 'second' });
  await stopCapture(b.id);

  // Torn manifest: directory exists, manifest unreadable.
  const tornId = `cap_${Date.now()}_aaaaaa`;
  await fs.mkdir(path.join(dir, tornId), { recursive: true });
  await fs.writeFile(path.join(dir, tornId, 'manifest.json'), '{not json');

  const rows = await listCaptures();
  assert.deepEqual(rows.map((r) => r.title), ['second', 'first']);
});

test('stop is idempotent', async () => {
  const m = await createCapture({});
  const s1 = await stopCapture(m.id);
  const s2 = await stopCapture(m.id);
  assert.equal(s1.ended_at, s2.ended_at);
});
