/**
 * Playback endpoint tests — lazy stitch (once, cached, race-safe) +
 * HTTP Range semantics (scrubbing/tap-to-seek are Range requests).
 * Stitch stubbed via setStitchForTests; responses captured with a
 * minimal ServerResponse fake. Strip-only TS.
 */
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { initCapture, createCapture, putSegment, stopCapture } from '../capture.ts';
import { handleCaptureAudio, setStitchForTests } from '../captureAudio.ts';

let dir = '';
let stitchCalls = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-capaudio-test-'));
  initCapture({ dir });
  stitchCalls = 0;
  setStitchForTests(async (_files, out) => {
    stitchCalls += 1;
    await fs.writeFile(out, Buffer.from('0123456789abcdef'));   // 16 fake bytes
    return out;
  });
});

afterEach(() => setStitchForTests(null));

function fakeRes() {
  const chunks: Buffer[] = [];
  let statusCode = 0;
  let headers: Record<string, unknown> = {};
  let resolveDone: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const res: any = {
    writeHead(code: number, h: Record<string, unknown>) { statusCode = code; headers = h || {}; return res; },
    write(c: Buffer | string) { chunks.push(Buffer.from(c)); return true; },
    end(c?: Buffer | string) { if (c) chunks.push(Buffer.from(c)); resolveDone(); },
    // pipe target duck-typing:
    on(ev: string, fn: () => void) { if (ev === 'unpipe' || ev === 'error') { /* ignore */ } return res; },
    once() { return res; },
    emit() { return false; },
    removeListener() { return res; },
    destroy() { resolveDone(); },
    get status() { return statusCode; },
    get hdrs() { return headers; },
    get body() { return Buffer.concat(chunks); },
    finished: done,
  };
  return res;
}

async function mkCapture(): Promise<string> {
  const m = await createCapture({ title: 'Audio', diarize: false });
  await putSegment(m.id, 0, Buffer.from('seg-bytes'), { t0Ms: 0, mime: 'audio/mp4' });
  await stopCapture(m.id);
  return m.id;
}

test('full GET: 200, Accept-Ranges, whole body; stitch runs once and caches', async () => {
  const id = await mkCapture();
  const r1 = fakeRes();
  await handleCaptureAudio({ headers: {} } as any, r1, id);
  await r1.finished;
  assert.equal(r1.status, 200);
  assert.equal(r1.hdrs['Accept-Ranges'], 'bytes');
  assert.equal(r1.body.toString(), '0123456789abcdef');

  const r2 = fakeRes();
  await handleCaptureAudio({ headers: {} } as any, r2, id);
  await r2.finished;
  assert.equal(stitchCalls, 1);   // cached file reused
});

test('Range GET: 206 with correct slice + Content-Range', async () => {
  const id = await mkCapture();
  const r = fakeRes();
  await handleCaptureAudio({ headers: { range: 'bytes=4-7' } } as any, r, id);
  await r.finished;
  assert.equal(r.status, 206);
  assert.equal(r.hdrs['Content-Range'], 'bytes 4-7/16');
  assert.equal(r.body.toString(), '4567');
});

test('open-ended and suffix ranges', async () => {
  const id = await mkCapture();
  const tail = fakeRes();
  await handleCaptureAudio({ headers: { range: 'bytes=12-' } } as any, tail, id);
  await tail.finished;
  assert.equal(tail.status, 206);
  assert.equal(tail.body.toString(), 'cdef');

  const suffix = fakeRes();
  await handleCaptureAudio({ headers: { range: 'bytes=-4' } } as any, suffix, id);
  await suffix.finished;
  assert.equal(suffix.status, 206);
  assert.equal(suffix.body.toString(), 'cdef');
});

test('out-of-bounds range → 416; unknown capture → 404; no segments → 404', async () => {
  const id = await mkCapture();
  const oob = fakeRes();
  await handleCaptureAudio({ headers: { range: 'bytes=99-' } } as any, oob, id);
  await oob.finished;
  assert.equal(oob.status, 416);

  const missing = fakeRes();
  await handleCaptureAudio({ headers: {} } as any, missing, 'cap_1_ffffff');
  await missing.finished;
  assert.equal(missing.status, 404);

  const empty = await createCapture({ title: 'Empty', diarize: false });
  await stopCapture(empty.id);
  const noseg = fakeRes();
  await handleCaptureAudio({ headers: {} } as any, noseg, empty.id);
  await noseg.finished;
  assert.equal(noseg.status, 404);
});

// ── MP4 layout (2026-09-19: his Play button did nothing on the phone;
//    every stitched file carried the moov index at the END, ffmpeg's
//    default — Chrome range-reads the tail and copes, WebKit does not).
//    The stitch now passes +faststart; legacy cached files are
//    re-stitched once, on sight; unparseable fixtures are left alone. ──
import { mp4Layout, playbackFileFor } from '../captureAudio.ts';

function box(type: string, payload: Buffer): Buffer {
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32BE(8 + payload.length, 0);
  hdr.write(type, 4, 'latin1');
  return Buffer.concat([hdr, payload]);
}
const FTYP = box('ftyp', Buffer.from('M4A \0\0\0\0'));
const MOOV_LATE = Buffer.concat([FTYP, box('mdat', Buffer.alloc(40, 1)), box('moov', Buffer.alloc(24, 2))]);
const FASTSTART = Buffer.concat([FTYP, box('moov', Buffer.alloc(24, 2)), box('mdat', Buffer.alloc(40, 1))]);

test('mp4Layout: index-first, index-last, and not-an-mp4', async () => {
  const f = (name: string, b: Buffer) => fs.writeFile(path.join(dir, name), b).then(() => path.join(dir, name));
  assert.equal(await mp4Layout(await f('fast.m4a', FASTSTART)), 'faststart');
  assert.equal(await mp4Layout(await f('late.m4a', MOOV_LATE)), 'moov-late');
  assert.equal(await mp4Layout(await f('junk.m4a', Buffer.from('0123456789abcdef'))), 'unknown');
  // 64-bit largesize header on the leading box still walks.
  const big = Buffer.alloc(16);
  big.writeUInt32BE(1, 0); big.write('free', 4, 'latin1'); big.writeBigUInt64BE(BigInt(16), 8);
  assert.equal(await mp4Layout(await f('large.m4a', Buffer.concat([big, FASTSTART]))), 'faststart');
});

test('legacy index-at-end cache is re-stitched once; a faststart cache is served as-is', async () => {
  setStitchForTests(async (_files, out) => {
    stitchCalls += 1;
    await fs.writeFile(out, FASTSTART);
    return out;
  });
  const id = await mkCapture();
  await fs.writeFile(playbackFileFor(id, 1), MOOV_LATE);   // what every pre-09-19 stitch left behind

  const r1 = fakeRes();
  await handleCaptureAudio({ headers: {} } as any, r1, id);
  await r1.finished;
  assert.equal(r1.status, 200);
  assert.equal(stitchCalls, 1, 'index-at-end file must be replaced');
  assert.ok(r1.body.equals(FASTSTART), 'serves the re-stitched file');

  const r2 = fakeRes();
  await handleCaptureAudio({ headers: { range: 'bytes=0-1' } } as any, r2, id);
  await r2.finished;
  assert.equal(r2.status, 206);
  assert.equal(stitchCalls, 1, 'vetted once per process, not per request');

  const good = await mkCapture();
  await fs.writeFile(playbackFileFor(good, 1), FASTSTART);
  const r3 = fakeRes();
  await handleCaptureAudio({ headers: {} } as any, r3, good);
  await r3.finished;
  assert.equal(stitchCalls, 1, 'a faststart cache is never re-stitched');
});

test('HEAD: same status + headers as GET, no body', async () => {
  const id = await mkCapture();
  const full = fakeRes();
  await handleCaptureAudio({ method: 'HEAD', headers: {} } as any, full, id);
  await full.finished;
  assert.equal(full.status, 200);
  assert.equal(full.hdrs['Content-Length'], 16);
  assert.equal(full.hdrs['Accept-Ranges'], 'bytes');
  assert.equal(full.body.length, 0);

  const ranged = fakeRes();
  await handleCaptureAudio({ method: 'HEAD', headers: { range: 'bytes=0-1' } } as any, ranged, id);
  await ranged.finished;
  assert.equal(ranged.status, 206);
  assert.equal(ranged.hdrs['Content-Range'], 'bytes 0-1/16');
  assert.equal(ranged.body.length, 0);
});
