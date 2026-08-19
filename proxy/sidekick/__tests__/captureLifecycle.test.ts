/**
 * Two-phase capture lifecycle + soft-discard + audit contract tests
 * (2026-08-18 data-loss postmortem, §Required fix P0s).
 *
 * The incident: a capture was server-created and ANNOUNCED before the
 * phone's mic ever started, then hard-deleted by an automatic error
 * path 21 minutes later — no audit, no recovery boundary. These tests
 * pin the replacement contract:
 *
 *   create → 'pending' (no announce)  → activate → 'recording' (announce)
 *                     ↘ abort-start / TTL-expiry → 'failed' IN PLACE
 *   discard → 'discarded' tombstone (dir intact, restorable)
 *   purge   → the ONLY irreversible verb, discarded-only
 *   DELETE  → rejected for live/segment-bearing captures
 *   audit   → append-only, outside capture dirs, survives purge
 *
 * Strip-only TS: no enums / parameter properties (file aborts at load).
 */
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  initCapture, createCapture, activateCapture, abortStartCapture,
  discardCapture, restoreCapture, purgeCapture, deleteCapture,
  putSegment, stopCapture, getCapture, listCaptures, sweepCaptures,
  setCaptureHooks, CaptureError,
  type CaptureManifest,
} from '../capture.ts';
import { readCaptureAudit } from '../captureAudit.ts';

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-caplife-test-'));
  initCapture({ dir });
});

afterEach(() => {
  setCaptureHooks(null);
});

function hookRecorder() {
  const events: { hook: string; id: string }[] = [];
  setCaptureHooks({
    onCreated(m: CaptureManifest) { events.push({ hook: 'created', id: m.id }); },
    onActivated(m: CaptureManifest) { events.push({ hook: 'activated', id: m.id }); },
    onDiscarded(id: string) { events.push({ hook: 'discarded', id }); },
    onDeleted(id: string) { events.push({ hook: 'deleted', id }); },
  });
  return events;
}

function activatedCount(events: { hook: string }[]): number {
  return events.filter((e) => e.hook === 'activated').length;
}

async function backdateManifest(id: string, ageMs: number): Promise<void> {
  const mp = path.join(dir, id, 'manifest.json');
  const raw = JSON.parse(await fs.readFile(mp, 'utf8'));
  raw.started_at = Date.now() - ageMs;
  await fs.writeFile(mp, JSON.stringify(raw));
  const old = new Date(Date.now() - ageMs);
  await fs.utimes(mp, old, old);
}

// ── P0 #1: two-phase activation ────────────────────────────────────────

test('create → pending; no activation side-effect fires', async () => {
  const events = hookRecorder();
  const m = await createCapture({ title: 'Standup', linkedChat: 'sidekick:abc' });
  assert.equal(m.status, 'pending');
  assert.equal(activatedCount(events), 0);
  // onCreated still fires (extension seam) but is NOT the announce hook.
  assert.deepEqual(events.map((e) => e.hook), ['created']);
});

test('activate: pending → recording, hook fires EXACTLY once (idempotent re-activate)', async () => {
  const events = hookRecorder();
  const m = await createCapture({ title: 'Standup' });
  const a1 = await activateCapture(m.id);
  assert.equal(a1.status, 'recording');
  assert.ok(a1.activated_at! >= a1.started_at);
  assert.equal(activatedCount(events), 1);
  const a2 = await activateCapture(m.id);   // client retry — must not re-announce
  assert.equal(a2.status, 'recording');
  assert.equal(activatedCount(events), 1);
});

test('activate on a failed/aborted capture → 409 (client must not claim success)', async () => {
  const m = await createCapture({});
  await abortStartCapture(m.id, { reason: 'mic denied' });
  await assert.rejects(() => activateCapture(m.id), (e: CaptureError) => e.status === 409);
});

test('compat gate: first segment from a legacy client implies activation (once)', async () => {
  const events = hookRecorder();
  const m = await createCapture({ title: 'OldClient' });
  assert.equal(m.status, 'pending');
  await putSegment(m.id, 0, Buffer.from('legacy bytes'), { t0Ms: 0, mime: 'audio/mp4' });
  const after = await getCapture(m.id);
  assert.equal(after.status, 'recording');
  assert.equal(activatedCount(events), 1);
  await putSegment(m.id, 1, Buffer.from('more bytes'), { t0Ms: 45_000, mime: 'audio/mp4' });
  assert.equal(activatedCount(events), 1);   // still once
});

test('abort-start: pending → failed IN PLACE with reason; dir survives; never announced', async () => {
  const events = hookRecorder();
  const m = await createCapture({ title: 'FrozeniPhone' });
  const aborted = await abortStartCapture(m.id, { reason: 'getUserMedia rejected' });
  assert.equal(aborted.status, 'failed');
  assert.match(String(aborted.failed_reason), /getUserMedia rejected/);
  assert.equal(activatedCount(events), 0);
  // Directory + manifest survive — forensics never destroyed again.
  await fs.access(path.join(dir, m.id, 'manifest.json'));
  assert.equal((await getCapture(m.id)).status, 'failed');
});

test('abort-start rejects an activated capture (409) — it can only kill a pending husk', async () => {
  const m = await createCapture({});
  await activateCapture(m.id);
  await putSegment(m.id, 0, Buffer.from('real audio'), { t0Ms: 0, mime: 'audio/mp4' });
  await assert.rejects(() => abortStartCapture(m.id, { reason: 'late failure' }),
    (e: CaptureError) => e.status === 409);
  assert.equal((await getCapture(m.id)).segments.length, 1);   // audio untouched
});

test('sweep: pending past TTL expires to failed in place — no announce, no delete', async () => {
  const events = hookRecorder();
  const m = await createCapture({ title: 'ReloadDuringStart' });
  await backdateManifest(m.id, 3 * 60 * 1000);   // > PENDING_TTL (2 min)
  await sweepCaptures();
  const after = await getCapture(m.id);
  assert.equal(after.status, 'failed');
  assert.match(String(after.failed_reason), /expired|never activated/i);
  assert.equal(activatedCount(events), 0);
  await fs.access(path.join(dir, m.id));   // dir still there
});

test('sweep leaves a FRESH pending capture alone', async () => {
  const m = await createCapture({});
  await sweepCaptures();
  assert.equal((await getCapture(m.id)).status, 'pending');
});

test('create supersedes a zero-segment pending (frozen phone must not wedge new recordings)', async () => {
  const a = await createCapture({ title: 'HungStart' });
  const b = await createCapture({ title: 'Retry' });
  assert.equal(b.status, 'pending');
  const oldA = await getCapture(a.id);
  assert.equal(oldA.status, 'failed');
  assert.match(String(oldA.failed_reason), /superseded/i);
  // The superseded capture can no longer activate — its client gets a
  // clean failure, not a phantom recording.
  await assert.rejects(() => activateCapture(a.id), (e: CaptureError) => e.status === 409);
});

test('one-active rule still holds for RECORDING captures', async () => {
  const a = await createCapture({ title: 'Live' });
  await activateCapture(a.id);
  await assert.rejects(() => createCapture({ title: 'Second' }),
    (e: CaptureError) => e.status === 409);
});

// ── P0 #2: no path may hard-delete audio — legacy DELETE is safety-mapped ──
//
// THE incident path (corrected forensics 2026-08-18): the old client
// bundle's pill ✕ fired this raw DELETE against a HEALTHY recording
// with ~28 uploaded segments, and fs.rm erased 20 minutes of meeting.
// The phone keeps running that old bundle until the next CAP rebuild,
// so the server alone must make the same call harmless: DELETE on
// anything live or segment-bearing performs the SOFT DISCARD
// (tombstone, restorable) — never fs.rm.

test('THE INCIDENT: legacy DELETE on a live capture with N uploaded segments tombstones — audio intact, restorable, rm never happens', async () => {
  const m = await createCapture({ title: 'Board sync' });
  await activateCapture(m.id);
  const bodies: Buffer[] = [];
  for (let seq = 0; seq < 5; seq++) {
    const body = Buffer.from(`meeting audio segment ${seq} — irreplaceable`);
    bodies.push(body);
    await putSegment(m.id, seq, body, { t0Ms: seq * 45_000, mime: 'audio/mp4' });
  }

  // The old bundle's cancel path: raw DELETE, mid-recording.
  await deleteCapture(m.id, { source: 'legacy-pwa', userAgent: 'OldBundle/1.0' });

  // Tombstoned, not erased.
  const after = await getCapture(m.id);
  assert.equal(after.status, 'discarded');
  assert.equal(after.pre_discard_status, 'recording');
  assert.equal(after.segments.length, 5);
  for (let seq = 0; seq < 5; seq++) {
    const onDisk = await fs.readFile(path.join(dir, m.id, 'seg', `${seq}.m4a`));
    assert.deepEqual(onDisk, bodies[seq], `segment ${seq} bytes must survive`);
  }

  // Attributable: the audit names the caller and what was at stake.
  const events = (await readCaptureAudit()).filter((e) => e.capture_id === m.id);
  const del = events.find((e) => e.action === 'delete')!;
  assert.equal(del.source, 'legacy-pwa');
  assert.equal(del.user_agent, 'OldBundle/1.0');
  const discard = events.find((e) => e.action === 'discard')!;
  assert.equal(discard.segment_count, 5);
  assert.ok(discard.total_bytes! > 0);

  // And the meeting comes back whole.
  const restored = await restoreCapture(m.id);
  assert.equal(restored.status, 'complete');
  assert.equal(restored.segments.length, 5);
});

test('legacy DELETE on an empty pending capture fails it in place (old startup rollback)', async () => {
  const p = await createCapture({});
  await deleteCapture(p.id, { source: 'legacy-pwa' });
  const after = await getCapture(p.id);
  assert.equal(after.status, 'failed');            // in place — dir survives
  await fs.access(path.join(dir, p.id, 'manifest.json'));
});

test('legacy DELETE on a segment-bearing COMPLETE capture also tombstones', async () => {
  const r = await createCapture({});
  await activateCapture(r.id);
  await putSegment(r.id, 0, Buffer.from('meeting audio'), { t0Ms: 0, mime: 'audio/mp4' });
  await stopCapture(r.id);
  await deleteCapture(r.id);
  assert.equal((await getCapture(r.id)).status, 'discarded');
  await fs.access(path.join(dir, r.id, 'seg', '0.m4a'));   // audio recoverable
});

test('DELETE on a discarded capture → 409 (purge is the only irreversible verb)', async () => {
  const m = await createCapture({});
  await activateCapture(m.id);
  await discardCapture(m.id, { reason: 'cancel' });
  await assert.rejects(() => deleteCapture(m.id), (e: CaptureError) => e.status === 409);
});

test('DELETE still works for a terminal zero-segment husk', async () => {
  const m = await createCapture({});
  await abortStartCapture(m.id, { reason: 'mic denied' });
  await deleteCapture(m.id);
  await assert.rejects(() => getCapture(m.id), (e: CaptureError) => e.status === 404);
});

test('discard: tombstone, dir + audio intact, hidden from default list, restorable', async () => {
  const events = hookRecorder();
  const m = await createCapture({ title: 'CancelMe' });
  await activateCapture(m.id);
  const body = Buffer.from('precious audio bytes');
  await putSegment(m.id, 0, body, { t0Ms: 0, mime: 'audio/mp4' });

  const d = await discardCapture(m.id, { reason: 'user cancel' });
  assert.equal(d.status, 'discarded');
  assert.ok(d.discarded_at! > 0);
  assert.equal(d.pre_discard_status, 'recording');
  assert.ok(events.some((e) => e.hook === 'discarded' && e.id === m.id));

  // Bytes still on disk — recoverable.
  const onDisk = await fs.readFile(path.join(dir, m.id, 'seg', '0.m4a'));
  assert.deepEqual(onDisk, body);

  // Hidden from the default list; visible when asked for.
  assert.ok(!(await listCaptures()).some((r) => r.id === m.id));
  assert.ok((await listCaptures({ includeDiscarded: true })).some((r) => r.id === m.id));

  // Discarded captures no longer block new recordings.
  const next = await createCapture({ title: 'NextMeeting' });
  assert.equal(next.status, 'pending');

  // Restore: had segments while live → lands 'complete' (usable meeting).
  const restored = await restoreCapture(m.id);
  assert.equal(restored.status, 'complete');
  assert.equal(restored.discarded_at, undefined);
  assert.ok((await listCaptures()).some((r) => r.id === m.id));
});

test('discard is idempotent; restore of a non-discarded capture → 409', async () => {
  const m = await createCapture({});
  await activateCapture(m.id);
  await discardCapture(m.id, { reason: 'cancel' });
  const again = await discardCapture(m.id, { reason: 'double tap' });
  assert.equal(again.status, 'discarded');
  const fresh = await createCapture({});
  await assert.rejects(() => restoreCapture(fresh.id), (e: CaptureError) => e.status === 409);
});

test('restore of an empty discarded capture lands failed (no phantom meetings)', async () => {
  const m = await createCapture({});
  await activateCapture(m.id);
  await discardCapture(m.id, { reason: 'cancel' });
  const restored = await restoreCapture(m.id);
  assert.equal(restored.status, 'failed');
});

test('segments to a discarded capture are frozen (409, message says so)', async () => {
  // The client uploader parks on /frozen/i — durable copy kept in IDB.
  const m = await createCapture({});
  await activateCapture(m.id);
  await discardCapture(m.id, { reason: 'cancel' });
  await assert.rejects(
    () => putSegment(m.id, 0, Buffer.from('tail audio'), { t0Ms: 0, mime: 'audio/mp4' }),
    (e: CaptureError) => e.status === 409 && /frozen/i.test(e.message),
  );
});

test('purge: discarded-only (409 otherwise), removes the dir irreversibly', async () => {
  const m = await createCapture({});
  await activateCapture(m.id);
  await putSegment(m.id, 0, Buffer.from('audio'), { t0Ms: 0, mime: 'audio/mp4' });
  // Live capture cannot be purged — not even deliberately.
  await assert.rejects(() => purgeCapture(m.id), (e: CaptureError) => e.status === 409);
  await stopCapture(m.id);
  // Terminal but not discarded — still no: purge is a two-step verb.
  await assert.rejects(() => purgeCapture(m.id), (e: CaptureError) => e.status === 409);
  await discardCapture(m.id, { reason: 'user delete' });
  await purgeCapture(m.id, { reason: 'user purge from management UI' });
  await assert.rejects(() => getCapture(m.id), (e: CaptureError) => e.status === 404);
  await assert.rejects(() => fs.access(path.join(dir, m.id)));
});

test('sweep purges discarded captures only after the retention window', async () => {
  const m = await createCapture({});
  await activateCapture(m.id);
  await discardCapture(m.id, { reason: 'cancel' });
  await sweepCaptures();
  assert.equal((await getCapture(m.id)).status, 'discarded');   // fresh — kept

  // Age the tombstone past 7 days.
  const mp = path.join(dir, m.id, 'manifest.json');
  const raw = JSON.parse(await fs.readFile(mp, 'utf8'));
  raw.discarded_at = Date.now() - 8 * 24 * 60 * 60 * 1000;
  await fs.writeFile(mp, JSON.stringify(raw));
  await sweepCaptures();
  await assert.rejects(() => getCapture(m.id), (e: CaptureError) => e.status === 404);
});

// ── P0 #3: append-only lifecycle audit, survives purge ────────────────

test('audit: every lifecycle transition is attributable AFTER the capture is purged', async () => {
  const m = await createCapture({ title: 'Audited' });
  await activateCapture(m.id, { source: 'test-client', userAgent: 'UnitTest/1.0' });
  await putSegment(m.id, 0, Buffer.from('audio-bytes'), { t0Ms: 0, mime: 'audio/mp4' });
  await stopCapture(m.id);
  await discardCapture(m.id, { reason: 'user delete', source: 'test-client' });
  await purgeCapture(m.id, { reason: 'user purge', source: 'test-client' });

  const events = (await readCaptureAudit()).filter((e) => e.capture_id === m.id);
  const actions = events.map((e) => e.action);
  for (const expected of ['create', 'activate', 'segment', 'stop', 'discard', 'purge']) {
    assert.ok(actions.includes(expected), `audit missing '${expected}' (got: ${actions.join(', ')})`);
  }
  // Field completeness on the destructive records.
  const discard = events.find((e) => e.action === 'discard')!;
  assert.equal(discard.prior_status, 'complete');
  assert.equal(discard.new_status, 'discarded');
  assert.equal(discard.segment_count, 1);
  assert.ok(discard.total_bytes! > 0);
  assert.match(String(discard.reason), /user delete/);
  assert.equal(discard.source, 'test-client');
  const purge = events.find((e) => e.action === 'purge')!;
  assert.equal(purge.segment_count, 1);
  // Every event has an id + timestamp; the log is OUTSIDE the (now
  // deleted) capture dir.
  for (const e of events) {
    assert.ok(e.event_id);
    assert.ok(e.ts > 0);
  }
  await assert.rejects(() => fs.access(path.join(dir, m.id)));   // capture gone, audit not
});

test('audit: abort-start and TTL expiry record their reasons', async () => {
  const a = await createCapture({});
  await abortStartCapture(a.id, { reason: 'MediaRecorder.start() threw', source: 'pwa-recorder' });
  const b = await createCapture({});
  await backdateManifest(b.id, 3 * 60 * 1000);
  await sweepCaptures();

  const events = await readCaptureAudit();
  const abort = events.find((e) => e.capture_id === a.id && e.action === 'abort-start')!;
  assert.match(String(abort.reason), /MediaRecorder/);
  assert.equal(abort.prior_status, 'pending');
  assert.equal(abort.new_status, 'failed');
  const expiry = events.find((e) => e.capture_id === b.id && e.action === 'expire-pending')!;
  assert.equal(expiry.new_status, 'failed');
});

// ── Normal stop stays intact (regression 8) ────────────────────────────

test('normal stop unchanged: activate → segments → stop → complete, audio preserved', async () => {
  const m = await createCapture({ title: 'RealMeeting' });
  await activateCapture(m.id);
  await putSegment(m.id, 0, Buffer.from('seg0'), { t0Ms: 0, mime: 'audio/mp4' });
  await putSegment(m.id, 1, Buffer.from('seg1'), { t0Ms: 45_000, mime: 'audio/mp4' });
  const stopped = await stopCapture(m.id);
  assert.equal(stopped.status, 'complete');
  assert.equal(stopped.segments.length, 2);
  await fs.access(path.join(dir, m.id, 'seg', '0.m4a'));
  await fs.access(path.join(dir, m.id, 'seg', '1.m4a'));
});
