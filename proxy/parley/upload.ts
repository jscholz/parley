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

import { upstreamOrDefault } from './index.ts';


export async function handleParleyUpload(req, res) {
  // One upstream client (audit phase 2): URL + token live in HTTPAgentUpstream.
  const up = upstreamOrDefault();
  if (typeof up.extension !== 'function') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unsupported', detail: 'this upstream has no upload surface' }));
    return;
  }
  const headers: Record<string, string> = {};
  const ct = req.headers['content-type'];
  if (typeof ct === 'string') headers['content-type'] = ct;
  const cl = req.headers['content-length'];
  if (typeof cl === 'string') headers['content-length'] = cl;

  try {
    const r = await up.extension('POST', '/v1/parley/upload', undefined, { rawBody: req, headers, text: true });
    res.writeHead(r.status, { 'content-type': r.contentType || 'application/json' });
    res.end(r.text ?? '');
  } catch (e: any) {
    console.error(`[parley] /api/parley/upload failed: ${e?.message || e}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upload pass-through failed' }));
    }
  }
}
