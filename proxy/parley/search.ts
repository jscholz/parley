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
import { searchArtifacts } from './artifactSearch.ts';

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
    res.end(JSON.stringify({ sessions: [], hits: [], artifacts: [] }));
    return;
  }
  let limit = 20;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit) {
    const n = Number(rawLimit);
    if (Number.isFinite(n) && n > 0) limit = Math.min(50, Math.floor(n));
  }
  // Scope (2026-11-08): `all` runs every category; a single category
  // skips the others and lifts its cap (the palette's chips).
  const scopeRaw = url.searchParams.get('scope') || 'all';
  const scope = (['all', 'sessions', 'artifacts', 'messages'] as const).includes(scopeRaw as any) ? scopeRaw as 'all' | 'sessions' | 'artifacts' | 'messages' : 'all';
  const wantUpstream = scope !== 'artifacts';
  const wantArtifacts = scope === 'all' || scope === 'artifacts';
  const artifactLimit = scope === 'artifacts' ? limit : Math.min(8, limit);

  const [upstreamOutcome, artifacts] = await Promise.all([
    wantUpstream
      ? upstream.searchConversations(q, limit).then((r) => ({ ok: true as const, r })).catch((e: any) => ({ ok: false as const, e }))
      : Promise.resolve({ ok: true as const, r: { sessions: [], hits: [] } }),
    wantArtifacts ? searchArtifacts(q, artifactLimit).catch((e: any) => { console.warn('[parley] artifact search failed:', e?.message); return []; }) : Promise.resolve([]),
  ]);
  if (!upstreamOutcome.ok) {
    const err = (upstreamOutcome as { e?: any }).e;
    console.warn('[parley] search fetch failed:', err?.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err?.message || 'upstream error' }));
    return;
  }
  const result = upstreamOutcome.r;
  if (result === null) {
    // The agent has no message index. Artifacts still answer (they are
    // the proxy's own), so this is a 200 with the sessions/messages
    // side marked unavailable rather than the old blanket 404.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [], hits: [], artifacts, error: 'agent does not implement /v1/conversations/search' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ...result, artifacts }));
}
