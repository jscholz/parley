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
  initCapture, createCapture, activateCapture, putSegment, stopCapture,
  patchCapture, addMark, getCapture, listCaptures, discardCapture,
  purgeCapture, CaptureError,
} from '../capture.ts';

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-capture-test-'));
  initCapture({ dir });
});

function sha(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('lifecycle: create → activate → segments → stop → complete manifest + index', async () => {
  const created = await createCapture({ title: 'Standup', linkedChat: 'parley:abc' });
  assert.match(created.id, /^cap_\d+_[0-9a-f]{6}$/);
  // Two-phase (2026-08-18 postmortem): create is a PENDING placeholder;
  // only /activate — after the client proved a running recorder —
  // makes it 'recording'.
  assert.equal(created.status, 'pending');
  assert.equal(created.diarize, true);      // default ON for meetings
  const m = await activateCapture(created.id);
  assert.equal(m.status, 'recording');

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
  await activateCapture(m.id);
  await stopCapture(m.id);   // Phase 1 goes straight to 'complete'
  await assert.rejects(
    () => putSegment(m.id, 0, Buffer.from('late'), { t0Ms: 0, mime: 'audio/mp4' }),
    (e: CaptureError) => e.status === 409,
  );
});

test('one active capture at a time; stale recording auto-heals', async () => {
  const a = await createCapture({ title: 'A' });
  await activateCapture(a.id);
  await assert.rejects(() => createCapture({ title: 'B' }),
    (e: CaptureError) => e.status === 409);

  // Age the active capture past the stale window: the activity clock
  // is the manifest FILE MTIME (arrival time — audit 2026-07-09 #11),
  // so backdate both the stamp and the mtime.
  const manifestPath = path.join(dir, a.id, 'manifest.json');
  const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  m.started_at = Date.now() - 11 * 60 * 1000;
  await fs.writeFile(manifestPath, JSON.stringify(m));
  const old = new Date(Date.now() - 11 * 60 * 1000);
  await fs.utimes(manifestPath, old, old);

  const b = await createCapture({ title: 'B' });   // heals A, starts B
  assert.equal(b.status, 'pending');
  // Segment-less husk → 'failed' (a capture WITH audio heals to
  // 'complete' instead — see the dedicated test below).
  assert.equal((await getCapture(a.id)).status, 'failed');
});

test('patch: rename, re-link, diarize toggle; diarize frozen after finish', async () => {
  const m = await createCapture({ title: 'Meeting 2026-07-08' });
  await activateCapture(m.id);
  const p1 = await patchCapture(m.id, { title: 'R2 fundraise sync', linkedChat: 'parley:xyz' });
  assert.equal(p1.title, 'R2 fundraise sync');
  assert.equal(p1.linked_chat, 'parley:xyz');
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
  // Pending (not yet activated) refuses marks too — nothing is
  // "recording" until a device proved a recorder.
  await assert.rejects(() => addMark(m.id, 100), (e: CaptureError) => e.status === 409);
  await activateCapture(m.id);
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

test('deleteCapture refuses segment-bearing captures; discard → purge is the removal lane', async () => {
  const a = await createCapture({ title: 'Keep' });
  await activateCapture(a.id);
  await stopCapture(a.id);
  const b = await createCapture({ title: 'Discard' });
  await putSegment(b.id, 0, Buffer.from('bytes'), { t0Ms: 0, mime: 'audio/mp4' });

  const { deleteCapture } = await import('../capture.ts');
  // Hard delete of real audio is impossible (2026-08-18 postmortem) —
  // this exact call erased a 20-minute meeting. Legacy DELETE is
  // safety-mapped to the soft discard: tombstone, audio intact.
  await deleteCapture(b.id);
  assert.equal((await getCapture(b.id)).status, 'discarded');
  await fs.access(path.join(dir, b.id, 'seg', '0.m4a'));

  // The deliberate second step removes it for real.
  await purgeCapture(b.id, { reason: 'test cleanup' });
  await assert.rejects(() => getCapture(b.id), (e: CaptureError) => e.status === 404);
  await assert.rejects(
    () => putSegment(b.id, 1, Buffer.from('late'), { t0Ms: 45_000, mime: 'audio/mp4' }),
    (e: CaptureError) => e.status === 404,
  );
  const rows = await listCaptures();
  assert.deepEqual(rows.map((r) => r.title), ['Keep']);
  await assert.rejects(() => fs.access(path.join(dir, b.id)), 'directory must be gone');
});

// ── Audit 2026-07-09 regressions ───────────────────────────────────────

test('concurrent putSegment: every segment lands in the manifest (per-id lock)', async () => {
  const m = await createCapture({ title: 'Parallel' });
  // Five parallel uploads — pre-lock, read-modify-write lost entries.
  await Promise.all([0, 1, 2, 3, 4].map((seq) =>
    putSegment(m.id, seq, Buffer.from(`bytes-${seq}`), { t0Ms: seq * 45_000, mime: 'audio/mp4' })));
  const after = await getCapture(m.id);
  assert.deepEqual(after.segments.map((s) => s.seq), [0, 1, 2, 3, 4]);
});

test('concurrent createCapture: one-active rule holds (global lock + supersede)', async () => {
  // Two-phase semantics: both creates mint PENDING placeholders (the
  // serialized second one supersedes the first — failed in place), so
  // at most ONE can ever activate into a real recording.
  const results = await Promise.allSettled([
    createCapture({ title: 'X' }), createCapture({ title: 'Y' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled')
    .map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof createCapture>>>).value);
  assert.equal(ok.length, 2);
  const activations = await Promise.allSettled(ok.map((m) => activateCapture(m.id)));
  const activated = activations.filter((r) => r.status === 'fulfilled');
  const refused = activations.filter((r) => r.status === 'rejected');
  assert.equal(activated.length, 1);
  assert.equal(refused.length, 1);
  // And a fresh create is now blocked by the one that activated.
  await assert.rejects(() => createCapture({ title: 'Z' }),
    (e: CaptureError) => e.status === 409);
});

test('stale heal COMPLETES a segment-bearing capture (audio is a meeting, not a failure)', async () => {
  const a = await createCapture({ title: 'CrashMid' });
  await putSegment(a.id, 0, Buffer.from('real audio'), { t0Ms: 0, mime: 'audio/mp4' });
  // Age it: stale-heal reads the manifest mtime, so backdate the file.
  const mp = path.join(dir, a.id, 'manifest.json');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  await fs.utimes(mp, old, old);
  const raw = JSON.parse(await fs.readFile(mp, 'utf8'));
  raw.started_at = Date.now() - 12 * 60 * 1000;
  await fs.writeFile(mp, JSON.stringify(raw));
  await fs.utimes(mp, old, old);

  const b = await createCapture({ title: 'Next' });
  assert.equal(b.status, 'pending');
  assert.equal((await getCapture(a.id)).status, 'complete');   // NOT 'failed'
});

test('capture_control rejects unknown actions with 400 (no default-to-start)', async () => {
  const { handleCaptureControl } = await import('../capture.ts');
  const { Readable } = await import('node:stream');
  const mkReq = (body: string) => {
    const r: any = Readable.from([Buffer.from(body)]);
    r.headers = {};
    return r;
  };
  const mkRes = () => {
    let status = 0; let payload = '';
    return {
      writeHead(code: number) { status = code; return this; },
      end(b?: string) { payload = b || ''; },
      get status() { return status; },
      get body() { return payload; },
    } as any;
  };
  const bad = mkRes();
  await handleCaptureControl(mkReq('{}'), bad);
  assert.equal(bad.status, 400);

  const typo = mkRes();
  await handleCaptureControl(mkReq('{"action":"begin"}'), typo);
  assert.equal(typo.status, 400);

  const good = mkRes();
  await handleCaptureControl(mkReq('{"action":"stop"}'), good);
  assert.equal(good.status, 202);
});

// ── Segment-upload headers are genuinely read ──────────────────────────
//
// x-parley-t0-ms places the segment on the capture timeline (a 0
// fallback would stack every segment at capture start, scrambling
// transcript timing + mark alignment) and x-parley-sha256 is a real
// integrity check, not merely tolerated.
test('segment upload reads x-parley-* headers', async () => {
  const { handleCaptureSegment } = await import('../capture.ts');
  const { Readable } = await import('node:stream');
  const mkRes = () => {
    let status = 0;
    return {
      writeHead(code: number) { status = code; return this; },
      setHeader() { /* noop */ },
      end() { /* noop */ },
      get status() { return status; },
    } as any;
  };
  const mkReq = (body: Buffer, headers: Record<string, string>) => {
    const r: any = Readable.from([body]);
    r.headers = { 'content-type': 'audio/mp4', ...headers };
    return r;
  };

  const cap = await createCapture({ title: 'Header client', linkedChat: null });
  await activateCapture(cap.id);

  const bytes = Buffer.from('bundle-segment');
  const res = mkRes();
  await handleCaptureSegment(
    mkReq(bytes, {
      'x-parley-t0-ms': '45000',
      'x-parley-sha256': sha(bytes),
    }),
    res, cap.id, '0',
  );
  assert.equal(res.status, 200);
  const after = await getCapture(cap.id);
  assert.equal(after.segments[0].t0_ms, 45_000,
    'x-parley-t0-ms must survive — a 0 fallback scrambles transcript timing');
  assert.equal(after.segments[0].sha256, sha(bytes));

  // A sha256 that does NOT match must be rejected (409) — proving the
  // header is genuinely read, not merely tolerated.
  const mismatch = mkRes();
  await handleCaptureSegment(
    mkReq(Buffer.from('other-bytes'), { 'x-parley-sha256': sha(Buffer.from('not-these')) }),
    mismatch, cap.id, '1',
  );
  assert.equal(mismatch.status, 409);
});
