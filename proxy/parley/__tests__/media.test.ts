/**
 * Agent-pushed media endpoint tests — registration guards (roots,
 * dotfiles, extensions, idempotency) + HTTP Range semantics on GET.
 * Registry + roots pointed at a temp dir via env so tests never touch
 * the real ~/.parley. fakeRes pattern from captureAudio.test.ts.
 * Strip-only TS.
 */
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  registerMedia, handleMediaGet, MediaError, __resetForTests,
} from '../media.ts';

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-media-test-'));
  // realpath: on macOS /tmp is a symlink into /private — the module
  // realpaths incoming files, so the allowed root must be the resolved
  // form too or every containment check fails spuriously.
  dir = await fs.realpath(dir);
  process.env.PARLEY_MEDIA_REGISTRY = path.join(dir, 'registry.json');
  process.env.PARLEY_MEDIA_ROOTS = dir;
  __resetForTests();
});

afterEach(async () => {
  delete process.env.PARLEY_MEDIA_REGISTRY;
  delete process.env.PARLEY_MEDIA_ROOTS;
  __resetForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

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
    on(ev: string, _fn: () => void) { void ev; return res; },
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

async function mkVideo(name = 'clip.mp4', bytes = '0123456789abcdef'): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, Buffer.from(bytes));
  return p;
}

test('register returns id/mime/size and GET serves the full body', async () => {
  const p = await mkVideo();
  const { id, entry } = await registerMedia(p);
  assert.match(id, /^[a-f0-9]{16}$/);
  assert.equal(entry.mime, 'video/mp4');
  assert.equal(entry.size, 16);

  const res = fakeRes();
  await handleMediaGet({ headers: {} } as any, res, id);
  await res.finished;
  assert.equal(res.status, 200);
  assert.equal(res.hdrs['Content-Type'], 'video/mp4');
  assert.equal(res.hdrs['Content-Length'], 16);
  assert.equal(res.body.toString(), '0123456789abcdef');
});

test('GET honors Range requests with 206 + Content-Range', async () => {
  const p = await mkVideo();
  const { id } = await registerMedia(p);
  const res = fakeRes();
  await handleMediaGet({ headers: { range: 'bytes=4-7' } } as any, res, id);
  await res.finished;
  assert.equal(res.status, 206);
  assert.equal(res.hdrs['Content-Range'], 'bytes 4-7/16');
  assert.equal(res.body.toString(), '4567');
});

test('GET answers 416 for an unsatisfiable range', async () => {
  const { id } = await registerMedia(await mkVideo());
  const res = fakeRes();
  await handleMediaGet({ headers: { range: 'bytes=99-' } } as any, res, id);
  assert.equal(res.status, 416);
});

test('unknown id → 404; vanished file → 410 tombstone', async () => {
  const res404 = fakeRes();
  await handleMediaGet({ headers: {} } as any, res404, 'deadbeefdeadbeef');
  assert.equal(res404.status, 404);

  const p = await mkVideo('gone.mp4');
  const { id } = await registerMedia(p);
  await fs.rm(p);
  const res410 = fakeRes();
  await handleMediaGet({ headers: {} } as any, res410, id);
  assert.equal(res410.status, 410);
});

test('re-registering the same path is idempotent (same id)', async () => {
  const p = await mkVideo();
  const a = await registerMedia(p);
  const b = await registerMedia(p);
  assert.equal(a.id, b.id);
});

test('registry persists across a module-state reset (server restart)', async () => {
  const { id } = await registerMedia(await mkVideo());
  __resetForTests();  // simulates a fresh process reloading the json
  const res = fakeRes();
  await handleMediaGet({ headers: {} } as any, res, id);
  await res.finished;
  assert.equal(res.status, 200);
});

test('rejects paths outside the allowed roots', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-media-outside-'));
  try {
    const p = path.join(outside, 'x.mp4');
    await fs.writeFile(p, 'x');
    await assert.rejects(() => registerMedia(p), (e: any) => e instanceof MediaError && e.status === 403);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('rejects dotfile path components even under an allowed root', async () => {
  const hidden = path.join(dir, '.secrets');
  await fs.mkdir(hidden);
  const p = path.join(hidden, 'x.mp4');
  await fs.writeFile(p, 'x');
  await assert.rejects(() => registerMedia(p), (e: any) => e instanceof MediaError && e.status === 403);
});

test('rejects a symlink that escapes the allowed roots', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-media-target-'));
  try {
    const target = path.join(outside, 'real.mp4');
    await fs.writeFile(target, 'x');
    const link = path.join(dir, 'inside.mp4');
    await fs.symlink(target, link);
    await assert.rejects(() => registerMedia(link), (e: any) => e instanceof MediaError && e.status === 403);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('rejects unsupported extensions and non-files', async () => {
  const p = path.join(dir, 'notes.txt');
  await fs.writeFile(p, 'hello');
  await assert.rejects(() => registerMedia(p), (e: any) => e instanceof MediaError && e.status === 415);
  await assert.rejects(() => registerMedia(dir), (e: any) => e instanceof MediaError);
  await assert.rejects(() => registerMedia(path.join(dir, 'missing.mp4')),
    (e: any) => e instanceof MediaError && e.status === 404);
});

// Field 2026-10-13: a 1.7 MB generated image re-downloaded on every switch
// back to its chat — `no-cache` with no validator. Now an ETag lets the
// browser revalidate to a 304, and a rewritten file gets a new tag.
test('GET carries an ETag; a matching If-None-Match is a 304 with no body', async () => {
  const p = await mkVideo('pic.mp4');
  const { id } = await registerMedia(p);
  const first = fakeRes();
  await handleMediaGet({ headers: {} } as any, first, id);
  await first.finished;
  const etag = first.hdrs.ETag as string;
  assert.match(etag, /^"[0-9a-f]+-[0-9a-f]+"$/);
  assert.ok(first.hdrs['Last-Modified']);
  assert.match(String(first.hdrs['Cache-Control']), /no-cache/);

  const again = fakeRes();
  await handleMediaGet({ headers: { 'if-none-match': etag } } as any, again, id);
  await again.finished;
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
});

test('rewriting the file under the same id changes the ETag (no stale image)', async () => {
  const p = await mkVideo('pic2.mp4', 'aaaa');
  const { id } = await registerMedia(p);
  const a = fakeRes();
  await handleMediaGet({ headers: {} } as any, a, id);
  await a.finished;
  await new Promise((r) => setTimeout(r, 15));
  await fs.writeFile(p, Buffer.from('bbbbbbbb'));
  const b = fakeRes();
  await handleMediaGet({ headers: { 'if-none-match': a.hdrs.ETag } } as any, b, id);
  await b.finished;
  assert.equal(b.status, 200);
  assert.notEqual(b.hdrs.ETag, a.hdrs.ETag);
  assert.equal(b.body.toString(), 'bbbbbbbb');
});
