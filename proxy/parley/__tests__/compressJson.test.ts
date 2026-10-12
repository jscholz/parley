// JSON response compression (2026-10-12): the newest-page history is
// hundreds of KB of JSON over a cellular Tailscale link and was never
// compressed. Real http server + raw client; strip-only TS.
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

import { installJsonCompression, MIN_COMPRESS_BYTES } from '../../compressJson.ts';

const BIG = JSON.stringify({ messages: Array.from({ length: 200 }, (_, i) => ({ id: i, content: 'tool output '.repeat(20) })) });
let server: http.Server;
let base = '';

before(async () => {
  server = http.createServer((req, res) => {
    installJsonCompression(req, res);
    const url = String(req.url);
    if (url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(BIG); return; }
    if (url === '/json-setheader') { res.setHeader('Content-Type', 'application/json'); res.statusCode = 200; res.end(BIG); return; }
    if (url === '/small') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    if (url === '/text') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(BIG); return; }
    if (url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n'); res.write('data: two\n\n'); res.end();
      return;
    }
    if (url === '/chunked-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(BIG.slice(0, 100)); res.end(BIG.slice(100));
      return;
    }
    if (url === '/err') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(BIG); return; }
    res.writeHead(404); res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

// Node's fetch transparently decodes gzip; use the raw client to see the wire.
function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get(base + path, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('a large JSON writeHead+end response is gzipped for a client that accepts it', async () => {
  const r = await raw('/json', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers.vary, 'Accept-Encoding');
  assert.equal(Number(r.headers['content-length']), r.body.length);
  assert.ok(r.body.length < BIG.length / 3, `wire ${r.body.length} vs raw ${BIG.length}`);
  assert.equal(gunzipSync(r.body).toString('utf8'), BIG);
});

test('setHeader/statusCode-style JSON responses are gzipped too', async () => {
  const r = await raw('/json-setheader', { 'accept-encoding': 'gzip' });
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(r.body).toString('utf8'), BIG);
});

test('no Accept-Encoding → identity, byte-for-byte', async () => {
  const r = await raw('/json');
  assert.equal(r.headers['content-encoding'], undefined);
  assert.equal(r.body.toString('utf8'), BIG);
});

test('small bodies and non-JSON bodies pass through unchanged; JSON errors compress like any JSON', async () => {
  const small = await raw('/small', { 'accept-encoding': 'gzip' });
  assert.equal(small.headers['content-encoding'], undefined);
  assert.equal(small.body.toString('utf8'), '{"ok":true}');
  assert.ok('{"ok":true}'.length < MIN_COMPRESS_BYTES);
  const text = await raw('/text', { 'accept-encoding': 'gzip' });
  assert.equal(text.headers['content-encoding'], undefined);
  assert.equal(text.body.toString('utf8'), BIG);
  const err = await raw('/err', { 'accept-encoding': 'gzip' });
  assert.equal(err.status, 500);
  assert.equal(err.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(err.body).toString('utf8'), BIG);
});

test('streamed responses (write before end) are left alone — SSE keeps flowing', async () => {
  const s = await raw('/stream', { 'accept-encoding': 'gzip' });
  assert.equal(s.headers['content-encoding'], undefined);
  assert.equal(s.headers['content-type'], 'text/event-stream');
  assert.equal(s.body.toString('utf8'), 'data: one\n\ndata: two\n\n');
  const c = await raw('/chunked-json', { 'accept-encoding': 'gzip' });
  assert.equal(c.headers['content-encoding'], undefined);
  assert.equal(c.body.toString('utf8'), BIG);
});
