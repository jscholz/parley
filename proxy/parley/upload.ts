// POST /api/parley/upload — large-file staging pass-through (task #158).
//
// Streams the raw request body straight to the upstream plugin's
// /v1/parley/upload route and returns its { upload_id } verbatim. NO
// buffering: the Node request stream is piped into the undici fetch body
// (duplex:'half'), so a 100 MB PDF never lands fully in proxy memory.
//
// The PWA uploads the raw file bytes here (no base64, no multipart), gets
// back an upload_id, then sends its normal turn on /api/parley/messages
// with the attachment carrying { ..., uploadId } instead of inline
// base64 `content`. That keeps the JSON message body small while big
// files take the streamed path. See src/attachments.ts toSendPayload.

import { readEnv } from '../env.mjs';

const UPSTREAM_URL = (process.env.UPSTREAM_URL || 'http://127.0.0.1:8645').replace(/\/+$/, '');
const UPSTREAM_TOKEN = (process.env.UPSTREAM_TOKEN || readEnv('PARLEY_PLATFORM_TOKEN') || '').trim();

export async function handleParleyUpload(req, res) {
  const headers: Record<string, string> = {};
  if (UPSTREAM_TOKEN) headers['authorization'] = `Bearer ${UPSTREAM_TOKEN}`;
  // Forward the body's content-type + length so the upstream's request
  // stream behaves identically. The plugin reads request.content
  // regardless, but forwarding keeps the hop transparent.
  const ct = req.headers['content-type'];
  if (typeof ct === 'string') headers['content-type'] = ct;
  const cl = req.headers['content-length'];
  if (typeof cl === 'string') headers['content-length'] = cl;

  try {
    const upstream = await fetch(`${UPSTREAM_URL}/v1/parley/upload`, {
      method: 'POST',
      headers,
      body: req,
      // Required by undici when streaming a Node Readable as the body.
      duplex: 'half',
    } as any);

    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
    });
    res.end(text);
  } catch (e: any) {
    console.error(`[parley] /api/parley/upload failed: ${e?.message || e}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upload pass-through failed' }));
    }
  }
}
