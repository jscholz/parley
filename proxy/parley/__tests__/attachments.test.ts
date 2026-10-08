/**
 * Agent-pushed attachments — the general-file lane (2026-10-08).
 * Registration shares media.ts's guard (roots, dotfiles, symlinks); what
 * is pinned here is the DOWNLOAD-ONLY serving posture: Content-
 * Disposition attachment, nosniff, octet-stream for unknown types, a
 * useful mime for known ones, HEAD support, 410 tombstones, size cap.
 * Strip-only TS.
 */
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  registerAttachment, handleAttachmentGet, handleAttachmentRegister, attachmentUrl, safeFilename,
  __resetAttachmentsForTests,
} from '../attachments.ts';
import { MediaError, __resetForTests } from '../media.ts';

let dir = '';

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'parley-attach-test-')));
  process.env.PARLEY_ATTACHMENT_REGISTRY = path.join(dir, 'registry.json');
  process.env.PARLEY_MEDIA_ROOTS = dir;
  __resetAttachmentsForTests();
  __resetForTests();
});

afterEach(async () => {
  delete process.env.PARLEY_ATTACHMENT_REGISTRY;
  delete process.env.PARLEY_MEDIA_ROOTS;
  delete process.env.PARLEY_ATTACHMENT_MAX_MB;
  __resetAttachmentsForTests();
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
    write(c: any) { chunks.push(Buffer.from(c)); return true; },
    end(c?: any) { if (c) chunks.push(Buffer.from(c)); resolveDone(); },
    on() { return res; }, once() { return res; }, emit() { return false; },
    get status() { return statusCode; },
    get headers() { return headers; },
    get body() { return Buffer.concat(chunks); },
    done,
  };
  return res;
}

function fakeReq(method = 'GET', body = ''): any {
  const chunks = [Buffer.from(body)];
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
}

test('register names the file, picks a useful mime, GET downloads with attachment disposition + nosniff', async () => {
  const f = path.join(dir, 'R2 deck — v3.pptx');
  await fs.writeFile(f, 'PK\u0003\u0004deck bytes');
  const { id, entry } = await registerAttachment(f);
  assert.match(id, /^[a-f0-9]{16}$/);
  assert.equal(entry.mime, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(entry.filename, 'R2 deck — v3.pptx');
  assert.equal(attachmentUrl(id, entry), `/api/parley/attachments/${id}/${encodeURIComponent('R2 deck — v3.pptx')}`);

  const res = fakeRes();
  await handleAttachmentGet(fakeReq('GET'), res, id);
  await res.done;
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), 'PK\u0003\u0004deck bytes');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(String(res.headers['Content-Disposition']), /^attachment; filename="R2 deck _ v3.pptx"; filename\*=UTF-8''R2%20deck%20%E2%80%94%20v3\.pptx$/);
});

test('unknown extensions download as octet-stream — never rendered', async () => {
  const f = path.join(dir, 'model.weights');
  await fs.writeFile(f, 'x');
  const { id, entry } = await registerAttachment(f);
  assert.equal(entry.mime, 'application/octet-stream');
  const res = fakeRes();
  await handleAttachmentGet(fakeReq('GET'), res, id);
  await res.done;
  assert.equal(res.headers['Content-Type'], 'application/octet-stream');
  assert.match(String(res.headers['Content-Disposition']), /^attachment;/);
});

test('an .html/.svg attachment is still download-only (the reason the media lane refused them)', async () => {
  const f = path.join(dir, 'report.html');
  await fs.writeFile(f, '<script>alert(1)</script>');
  const { id } = await registerAttachment(f);
  const res = fakeRes();
  await handleAttachmentGet(fakeReq('GET'), res, id);
  await res.done;
  assert.match(String(res.headers['Content-Disposition']), /^attachment;/);
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
});

test('HEAD answers the headers without a body', async () => {
  const f = path.join(dir, 'a.pdf');
  await fs.writeFile(f, 'pdf!');
  const { id } = await registerAttachment(f);
  const res = fakeRes();
  await handleAttachmentGet(fakeReq('HEAD'), res, id);
  await res.done;
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Length'], 4);
  assert.equal(res.body.length, 0);
});

test('unknown id → 404; vanished file → 410 tombstone; same path re-registers to the same id', async () => {
  const f = path.join(dir, 'gone.zip');
  await fs.writeFile(f, 'z');
  const a = await registerAttachment(f);
  const b = await registerAttachment(f);
  assert.equal(a.id, b.id);
  const r404 = fakeRes();
  await handleAttachmentGet(fakeReq(), r404, 'deadbeefdeadbeef');
  await r404.done;
  assert.equal(r404.status, 404);
  await fs.rm(f);
  const r410 = fakeRes();
  await handleAttachmentGet(fakeReq(), r410, a.id);
  await r410.done;
  assert.equal(r410.status, 410);
});

test('shares the media guard: outside roots / dotfile components / non-files are refused', async () => {
  await assert.rejects(registerAttachment('/etc/hostname'), (e: any) => e instanceof MediaError && e.status === 403);
  await fs.mkdir(path.join(dir, '.secrets'));
  const dot = path.join(dir, '.secrets', 'k.txt');
  await fs.writeFile(dot, 'k');
  await assert.rejects(registerAttachment(dot), (e: any) => e.status === 403);
  await assert.rejects(registerAttachment(dir), (e: any) => e.status === 400);
  await assert.rejects(registerAttachment(path.join(dir, 'nope.pdf')), (e: any) => e.status === 404);
});

test('size cap is enforced at registration (413)', async () => {
  process.env.PARLEY_ATTACHMENT_MAX_MB = '0.000001';   // ~1 byte
  const f = path.join(dir, 'big.bin');
  await fs.writeFile(f, 'more than one byte');
  await assert.rejects(registerAttachment(f), (e: any) => e.status === 413);
});

test('HTTP register handler returns the url/mime/size/filename contract', async () => {
  const f = path.join(dir, 'notes.md');
  await fs.writeFile(f, '# hi');
  const res = fakeRes();
  await handleAttachmentRegister(fakeReq('POST', JSON.stringify({ path: f })), res);
  await res.done;
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body.toString());
  assert.match(body.url, /^\/api\/parley\/attachments\/[a-f0-9]{16}\/notes\.md$/);
  assert.equal(body.mime, 'text/markdown');
  assert.equal(body.size, 4);
  assert.equal(body.filename, 'notes.md');
});

test('safeFilename strips separators, control chars and quotes', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('a"b\u0001c.txt'), 'a_b_c.txt');
  assert.equal(safeFilename(''), 'file');
});
