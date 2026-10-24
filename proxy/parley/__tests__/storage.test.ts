// Storage governance (proxy/parley/storage.ts, 2026-10-24): the sweep
// planner's TTL + ceiling rules, the inventory's categories, and the
// upload purge leaving a `.purged` marker behind. Scratch data home.
// Strip-only TS: no enums / parameter properties.
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { planSweep, inventory, readPolicy, writePolicy, sweep, setStorageHomeForTests, DEFAULT_POLICY } from '../storage.ts';

const DAY = 86_400_000;
let home = '';

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-storage-'));
  setStorageHomeForTests(() => home);
});
after(async () => {
  setStorageHomeForTests(null);
  await fs.rm(home, { recursive: true, force: true });
});

test('planSweep: TTLs pick the old, the ceiling takes the oldest remaining until it fits', () => {
  const now = Date.now();
  const audio = [
    { id: 'cap_old', bytes: 500, endedAt: now - 400 * DAY },
    { id: 'cap_mid', bytes: 300, endedAt: now - 100 * DAY },
    { id: 'cap_new', bytes: 200, endedAt: now - 2 * DAY },
  ];
  const uploads = [
    { umsg: 'u_old', bytes: 50, mtimeMs: now - 400 * DAY },
    { umsg: 'u_new', bytes: 40, mtimeMs: now - 1 * DAY },
  ];
  const ttlOnly = planSweep({ ...DEFAULT_POLICY, captureAudioTtlDays: 365, uploadsTtlDays: 365, maxTotalMb: 0 }, audio, uploads, now);
  assert.deepEqual(ttlOnly.captures, ['cap_old']);
  assert.deepEqual(ttlOnly.uploads, ['u_old']);
  assert.equal(ttlOnly.bytes, 550);
  assert.equal(ttlOnly.ceilingHit, false);

  const forever = planSweep({ ...DEFAULT_POLICY, captureAudioTtlDays: 0, uploadsTtlDays: 0, maxTotalMb: 0 }, audio, uploads, now);
  assert.equal(forever.captures.length + forever.uploads.length, 0, '0 = keep forever');

  // Ceiling of ~0 MB forces everything but checks oldest-first ordering:
  // with a ceiling that fits only the newest 240 bytes, mid + old go.
  const ceiling = planSweep({ ...DEFAULT_POLICY, captureAudioTtlDays: 0, uploadsTtlDays: 0, maxTotalMb: 240 / 1024 / 1024 * 1 + 0 }, audio, uploads, now);
  assert.equal(ceiling.ceilingHit, true);
  assert.ok(ceiling.captures.includes('cap_old') && ceiling.uploads.includes('u_old'), 'oldest go first');
});

test('policy: defaults when absent, clamped and persisted on write', async () => {
  assert.deepEqual(await readPolicy(), DEFAULT_POLICY);
  const p = await writePolicy({ captureAudioTtlDays: -5, uploadsTtlDays: 30, autoSweep: false });
  assert.equal(p.captureAudioTtlDays, 0, 'negatives clamp to 0 (= forever)');
  assert.equal(p.uploadsTtlDays, 30);
  assert.equal(p.autoSweep, false);
  assert.deepEqual(await readPolicy(), p);
  await writePolicy(DEFAULT_POLICY);
});

test('inventory + sweep: audio and uploads are categorised; an aged upload is purged leaving a marker', async () => {
  // A finished capture with audio + text, an old upload, a new upload.
  const cap = path.join(home, 'captures', 'cap_1_aaaaaa');
  await fs.mkdir(path.join(cap, 'seg'), { recursive: true });
  await fs.writeFile(path.join(cap, 'seg', '0.m4a'), Buffer.alloc(1000));
  await fs.writeFile(path.join(cap, 'seg', '0.txt'), 'hello');
  await fs.writeFile(path.join(cap, 'transcript.md'), '# t');
  await fs.writeFile(path.join(cap, 'manifest.json'), JSON.stringify({ id: 'cap_1_aaaaaa', status: 'complete', started_at: Date.now() - 3 * DAY, ended_at: Date.now() - 3 * DAY, segments: [] }));
  const oldUp = path.join(home, 'uploads', 'umsg_old');
  const newUp = path.join(home, 'uploads', 'umsg_new');
  await fs.mkdir(oldUp, { recursive: true }); await fs.mkdir(newUp, { recursive: true });
  await fs.writeFile(path.join(oldUp, '0-old.pdf'), Buffer.alloc(300));
  await fs.writeFile(path.join(newUp, '0-new.pdf'), Buffer.alloc(200));
  const old = new Date(Date.now() - 400 * DAY);
  await fs.utimes(path.join(oldUp, '0-old.pdf'), old, old);

  const inv = await inventory();
  assert.equal(inv.categories.capture_audio.bytes, 1000);
  assert.equal(inv.categories.capture_text.files, 3, 'txt + transcript + manifest');
  assert.equal(inv.categories.uploads.bytes, 500);
  assert.equal(inv.categories.uploads.items, 2);
  assert.equal(inv.due.uploads, 1, 'the 400-day-old upload is due under the 365-day default');
  assert.equal(inv.due.captures, 0);

  const dry = await sweep({ dryRun: true });
  assert.deepEqual(dry.uploadsPurged, ['umsg_old']);
  assert.ok(await fs.stat(path.join(oldUp, '0-old.pdf')), 'dry run deletes nothing');

  const real = await sweep();
  assert.deepEqual(real.uploadsPurged, ['umsg_old']);
  assert.equal(real.bytesFreed, 300);
  await assert.rejects(fs.stat(path.join(oldUp, '0-old.pdf')), 'the file is gone');
  assert.ok(await fs.stat(path.join(oldUp, '0-old.pdf.purged')), 'a marker records that it was there');
  const after = await inventory();
  assert.equal(after.categories.uploads.bytes, 200, 'markers do not count');
  assert.equal(after.lastSweep?.bytesFreed, 300);
});
