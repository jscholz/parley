/** User-upload lane (2026-10-11): strict path shape, symlink escape refused,
 *  inline for images, download for the rest, Range for video. Strip-only TS. */
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleUploadGet, resolveUpload, setUploadsRootForTests } from '../uploads.ts';

let dir = '';
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'parley-upl-')));
  setUploadsRootForTests(() => dir);
  await fs.mkdir(path.join(dir, 'umsg_1_ab'));
  await fs.writeFile(path.join(dir, 'umsg_1_ab', '0-wrist 1.png'), 'PNG!');
  await fs.writeFile(path.join(dir, 'umsg_1_ab', '1-deck.pptx'), 'PPTX');
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function res() {
  const chunks: Buffer[] = []; let status = 0; let headers: any = {}; let done: () => void;
  const p = new Promise<void>((r) => { done = r; });
  const r: any = { writeHead(c: number, h: any) { status = c; headers = h || {}; return r; }, write(c: any) { chunks.push(Buffer.from(c)); return true; },
    end(c?: any) { if (c) chunks.push(Buffer.from(c)); done(); }, on() { return r; }, once() { return r; }, emit() { return false; },
    get status() { return status; }, get headers() { return headers; }, get body() { return Buffer.concat(chunks); }, done: p };
  return r;
}

test('resolves <idx>-<name> inside the root only', async () => {
  assert.equal((await resolveUpload('umsg_1_ab', '0'))?.name, 'wrist 1.png');
  assert.equal(await resolveUpload('umsg_1_ab', '7'), null);
  assert.equal(await resolveUpload('../etc', '0'), null);
  assert.equal(await resolveUpload('umsg_1_ab', 'x'), null);
  await fs.symlink('/etc/hostname', path.join(dir, 'umsg_1_ab', '2-escape.txt'));
  assert.equal(await resolveUpload('umsg_1_ab', '2'), null);
});

test('images inline + nosniff; other files as attachment; 404 unknown', async () => {
  const a = res(); await handleUploadGet({ method: 'GET', headers: {} } as any, a, 'umsg_1_ab', '0'); await a.done;
  assert.equal(a.status, 200); assert.equal(a.headers['Content-Type'], 'image/png');
  assert.match(String(a.headers['Content-Disposition']), /^inline; filename="wrist 1.png"/);
  assert.equal(a.headers['X-Content-Type-Options'], 'nosniff'); assert.equal(a.body.toString(), 'PNG!');
  const b = res(); await handleUploadGet({ method: 'GET', headers: {} } as any, b, 'umsg_1_ab', '1'); await b.done;
  assert.equal(b.headers['Content-Type'], 'application/octet-stream');
  assert.match(String(b.headers['Content-Disposition']), /^attachment; filename="deck.pptx"/);
  const c = res(); await handleUploadGet({ method: 'GET', headers: {} } as any, c, 'umsg_9_zz', '0'); await c.done;
  assert.equal(c.status, 404);
});

test('Range on an inline file answers 206', async () => {
  const r = res(); await handleUploadGet({ method: 'GET', headers: { range: 'bytes=1-2' } } as any, r, 'umsg_1_ab', '0'); await r.done;
  assert.equal(r.status, 206); assert.equal(r.headers['Content-Range'], 'bytes 1-2/4'); assert.equal(r.body.toString(), 'NG');
});

// HEIC/TIFF uploads carry a JPEG thumbnail beside the original (2026-10-27):
// `/thumb` serves it; the plain index never returns the thumbnail file.
test('serves the plugin-written thumbnail at <idx>/thumb and never as the original', async () => {
  await fs.writeFile(path.join(dir, 'umsg_1_ab', '3-IMG_1619.HEIC'), 'HEIC!');
  await fs.writeFile(path.join(dir, 'umsg_1_ab', '3-thumb.jpg'), 'JPEG!');
  assert.equal((await resolveUpload('umsg_1_ab', '3'))?.name, 'IMG_1619.HEIC');
  assert.equal((await resolveUpload('umsg_1_ab', '3', true))?.name, 'thumb.jpg');
  assert.equal(await resolveUpload('umsg_1_ab', '0', true), null);          // no thumbnail for a PNG
  const r = res();
  await handleUploadGet({ headers: {}, method: 'GET' } as any, r, 'umsg_1_ab', '3', true);
  await r.done;
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'image/jpeg');
  assert.equal(r.body.toString(), 'JPEG!');
});
