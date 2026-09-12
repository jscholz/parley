// Parley proxy — cross-conversation FTS5 search.
//
// One route:
//
//   GET /api/parley/search?q=&limit=20  → { sessions, hits }
//
// Forwards to the upstream's /v1/conversations/search contract and
// returns its body verbatim — the SearchResult shape
// `src/proxyClientTypes.ts` defines. The contract is backend-agnostic:
//
//   sessions[] — chats whose VISIBLE name matched (`match: "title"`) or
//                whose id contains the query (`match: "id"`), with
//                `highlights` = [start, end) ranges into `title`.
//   hits[]     — messages whose conversational text matched: plain-text
//                `snippet`, `highlights` into it, `session_title`,
//                `role`, `timestamp`, and `more_in_session` for hits
//                the backend collapsed per chat.
//
// How a backend decides a match (FTS tables, envelope stripping, parent
// walking…) is its own business and never leaks past this boundary; the
// PWA only paints `match` and `highlights`.
//
// 404 from the upstream propagates as 404 — agents that don't implement
// search simply leave the cmd+K Messages section showing nothing. Other
// errors collapse to 502.

import http from 'node:http';
import { getUpstream } from './index.ts';

export async function handleParleySearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const upstream = getUpstream();
  if (!upstream) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'parley_platform_unconfigured' }));
    return;
  }
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [], hits: [] }));
    return;
  }
  let limit = 20;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit) {
    const n = Number(rawLimit);
    if (Number.isFinite(n) && n > 0) limit = Math.min(50, Math.floor(n));
  }
  let result;
  try {
    result = await upstream.searchConversations(q, limit);
  } catch (e: any) {
    console.warn('[parley] search fetch failed:', e?.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message || 'upstream error' }));
    return;
  }
  if (result === null) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'agent does not implement /v1/conversations/search' },
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}
