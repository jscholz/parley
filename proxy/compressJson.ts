/**
 * Response compression for the proxy's JSON API.
 *
 * Why (field 2026-10-12, "unread sessions take a while to load"): the
 * server builds a newest-page history response in ~15–50 ms, but that
 * page is 300–700 KB of JSON (tool rows are >90% of it) and it went
 * over the Tailscale link UNCOMPRESSED — nothing in this stack set
 * Content-Encoding. On cellular that is seconds per cold switch. gzip
 * level 6 cuts a 688 KB page to ~210 KB for ~10 ms of CPU.
 *
 * Mechanism: 74 route handlers write JSON as `res.writeHead(...);
 * res.end(body)`, so rather than touch each one this installs on the
 * response and intercepts that pair. `writeHead` is deferred (headers
 * are not committed until the body is known); `end(body)` compresses
 * when the client accepts gzip, the content-type is JSON, and the body
 * is worth it. Any `write()` (streaming — SSE, media, ranges) flushes
 * the deferred head untouched and steps out of the way. Responses that
 * set headers via setHeader()/statusCode only are handled at `end` too.
 */
import type http from 'node:http';
import { gzipSync } from 'node:zlib';

/** Bodies below this aren't worth a gzip header + CPU. */
export const MIN_COMPRESS_BYTES = 1024;
const JSON_RE = /^application\/json/i;

function acceptsGzip(req: http.IncomingMessage): boolean {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}

/** Install on one request/response pair. Idempotent per response. */
export function installJsonCompression(req: http.IncomingMessage, res: http.ServerResponse): void {
  if ((res as any).__jsonCompression) return;
  (res as any).__jsonCompression = true;
  if (req.method === 'HEAD' || !acceptsGzip(req)) return;

  const origWriteHead = res.writeHead.bind(res) as typeof res.writeHead;
  const origWrite = res.write.bind(res) as typeof res.write;
  const origEnd = res.end.bind(res) as typeof res.end;
  let deferred: { status: number; message?: string; headers?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[] } | null = null;

  // Node's implicit-header path (end() without writeHead) calls
  // res.writeHead internally — it must reach the ORIGINAL once we are
  // done deferring, or the status line never gets written.
  const restoreWriteHead = () => { res.writeHead = origWriteHead; };
  const flushHead = () => {
    restoreWriteHead();
    if (!deferred) return;
    const d = deferred; deferred = null;
    if (d.message !== undefined) origWriteHead(d.status, d.message, d.headers as any);
    else origWriteHead(d.status, d.headers as any);
  };
  const headerOf = (name: string): string => {
    const h = deferred?.headers;
    if (h && !Array.isArray(h)) {
      for (const k of Object.keys(h)) if (k.toLowerCase() === name) return String(h[k] ?? '');
    }
    return String(res.getHeader(name) ?? '');
  };
  const stripHeader = (name: string) => {
    const h = deferred?.headers;
    if (h && !Array.isArray(h)) for (const k of Object.keys(h)) if (k.toLowerCase() === name) delete h[k];
    if (res.hasHeader(name)) res.removeHeader(name);
  };

  res.writeHead = ((status: number, a?: any, b?: any) => {
    if (res.headersSent) return origWriteHead(status, a, b);
    if (typeof a === 'string') deferred = { status, message: a, headers: b };
    else deferred = { status, headers: a };
    return res;
  }) as typeof res.writeHead;

  res.write = ((chunk: any, a?: any, b?: any) => {
    flushHead();
    return origWrite(chunk, a, b);
  }) as typeof res.write;

  res.end = ((chunk?: any, a?: any, b?: any) => {
    const cb = typeof a === 'function' ? a : (typeof b === 'function' ? b : undefined);
    const encoding = typeof a === 'string' ? a : undefined;
    const status = deferred?.status ?? res.statusCode;
    const body: Buffer | null = typeof chunk === 'string'
      ? Buffer.from(chunk, (encoding as BufferEncoding) || 'utf8')
      : (Buffer.isBuffer(chunk) ? chunk : null);
    const eligible = body !== null && !res.headersSent && status >= 200 && status !== 204 && status !== 304
      && body.length >= MIN_COMPRESS_BYTES && JSON_RE.test(headerOf('content-type')) && !headerOf('content-encoding');
    if (!eligible) {
      flushHead();
      return cb ? origEnd(chunk, encoding as any, cb) : origEnd(chunk, encoding as any);
    }
    const gz = gzipSync(body, { level: 6 });
    stripHeader('content-length');
    const extra: http.OutgoingHttpHeaders = { 'content-encoding': 'gzip', 'content-length': gz.length, vary: 'Accept-Encoding' };
    if (deferred) {
      const h = deferred.headers;
      deferred.headers = Array.isArray(h) ? [...h, ...Object.entries(extra).flat() as string[]] : { ...(h || {}), ...extra };
    } else {
      for (const [k, v] of Object.entries(extra)) res.setHeader(k, v as any);
    }
    flushHead();   // deferred head (if any) + original writeHead restored for the implicit path
    return cb ? origEnd(gz, cb) : origEnd(gz);
  }) as typeof res.end;
}
