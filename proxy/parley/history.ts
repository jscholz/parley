// GET /api/parley/sessions/<chat_id>/messages — per-chat transcript
// replay through the agent contract. The upstream's
// `/v1/conversations/{id}/items` walks the parent_session_id chain
// server-side so the proxy doesn't need to maintain its own CTE; we
// just translate OAI items → the existing on-the-wire shape that the
// PWA renderer consumes today.

import { getUpstream } from './index.ts';
import type { UpstreamAgent } from './upstream.ts';

/** Tool-row content beyond this many characters is cut to a preview on
 *  transcript pages (2026-10-12): tool output was >90% of a 60-row page
 *  (688 KB, one row 81 KB) and nobody reads it until they open the row —
 *  which now fetches the full row from /messages/<id>. 2 KB keeps short
 *  outputs (file reads, search hits) whole and cuts that page to ~150 KB. */
export const TOOL_PREVIEW_CHARS = 2048;

/** One upstream item → the wire row the PWA consumes. Pure; exported for
 *  the tests. */
export function shapeHistoryItem(it: any): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: it.id,
    role: it.role,
    content: it.content,
    timestamp: it.created_at,
    ...(it.tool_name ? { toolName: it.tool_name } : {}),
    ...(it.tool_call_id ? { tool_call_id: it.tool_call_id } : {}),
    ...(it.tool_calls ? { tool_calls: it.tool_calls } : {}),
    ...(it.parley_id ? { parley_id: it.parley_id } : {}),
    ...(Array.isArray(it.attachments) && it.attachments.length ? { attachments: it.attachments } : {}),
    ...(it.kind ? { kind: it.kind } : {}),
  };
  if (it.role === 'tool' && typeof it.content === 'string' && it.content.length > TOOL_PREVIEW_CHARS) {
    row.content = it.content.slice(0, TOOL_PREVIEW_CHARS);
    row.truncated = true;
    row.contentBytes = Buffer.byteLength(it.content, 'utf8');
  }
  return row;
}

/** GET /api/parley/sessions/{chat}/messages/{row} — one row, full content
 *  (the page above carries tool output as a preview). */
export async function handleParleySessionMessage(req: any, res: any, chatId: string, rowId: string, upstreamOverride?: UpstreamAgent | null): Promise<void> {
  if (!chatId || !/^[A-Za-z0-9._@:-]{1,128}$/.test(chatId) || !rowId || !/^[A-Za-z0-9._:-]{1,128}$/.test(rowId)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid id' }));
    return;
  }
  const upstream = upstreamOverride === undefined ? getUpstream() : upstreamOverride;
  if (!upstream || typeof upstream.getMessage !== 'function') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not available' }));
    return;
  }
  try {
    const it = await upstream.getMessage(chatId, rowId);
    if (!it) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const row = shapeHistoryItem(it);
    row.content = it.content;          // full content, by definition of this endpoint
    delete row.truncated;
    delete row.contentBytes;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(row));
  } catch (e: any) {
    console.error('[parley] session message failed:', e.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

export async function handleParleySessionMessages(req, res, chatId: string) {
  // Validate chat_id shape. Accepts:
  //   - IDB-minted UUIDs (URL-safe base16+dash) for parley chats
  //   - Cross-platform IDs (whatsapp `@lid` / `@s.whatsapp.net`,
  //     telegram numeric, slack `[CD]<id>`, etc.) for sessions
  //     surfaced through /v1/gateway/conversations
  // Allowed: alphanumeric + the chars commonly seen in messaging
  // platform identifiers: . _ - @ : . Length cap stays 128.
  if (!chatId || !/^[A-Za-z0-9._@:-]{1,128}$/.test(chatId)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid chat_id' }));
    return;
  }
  const upstream = getUpstream();
  if (!upstream) {
    // Match the sessions-list endpoint: return an empty transcript
    // rather than 503 so the PWA can render its IDB cache without
    // showing an error toast for what's really an enrichment endpoint.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      messages: [], firstId: null, hasMore: false, unconfigured: true,
    }));
    return;
  }
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10)));
  const beforeRaw = url.searchParams.get('before');
  const before = beforeRaw && /^\d+$/.test(beforeRaw) ? parseInt(beforeRaw, 10) : null;
  // `around=<parley_id|state.db id>` requests the deep-target window in
  // one round trip (the tail-contiguous slice containing the target),
  // instead of N serial `before=` pages. The plugin returns target_found
  // false (empty list) when the target is missing or too deep for the
  // wire ceiling — the PWA then falls back to its serial drill.
  const aroundRaw = url.searchParams.get('around');
  const around = aroundRaw && /^[A-Za-z0-9._:-]{1,128}$/.test(aroundRaw) ? aroundRaw : null;
  // `after=<state.db id>` pages FORWARD (load-newer) from a cursor — the
  // symmetric counterpart to `before=`. Used by the PWA's loadLater path
  // to connect a floating deep `around` window back to the live tail, so
  // the contiguous run can persist + grow the IDB cache.
  const afterRaw = url.searchParams.get('after');
  const after = afterRaw && /^\d+$/.test(afterRaw) ? parseInt(afterRaw, 10) : null;
  return handleSessionMessagesViaUpstream(upstream, res, chatId, limit, before, around, after);
}

async function handleSessionMessagesViaUpstream(
  upstream: UpstreamAgent,
  res: any,
  chatId: string,
  limit: number,
  before: number | null,
  around: string | null = null,
  after: number | null = null,
): Promise<void> {
  // [/messages-trace] instrumentation — diagnose where server-side
  // latency lives. Three phase timings: enter, upstream-call,
  // response-serialize. Disable by commenting out once the bottleneck
  // is identified.
  const traceId = `msgs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const t0 = Date.now();
  const trace = (event: string, extra: string = '') =>
    console.log(`[messages-trace ${traceId}] +${Date.now() - t0}ms ${event} chat=${chatId}${extra ? ' ' + extra : ''}`);
  trace('enter', `limit=${limit}${before !== null ? ` before=${before}` : ''}${around !== null ? ` around=${around}` : ''}${after !== null ? ` after=${after}` : ''}`);
  try {
    trace('upstream-call-start');
    const r = await upstream.getMessages(chatId, {
      limit,
      ...(before !== null ? { before } : {}),
      ...(around !== null ? { around } : {}),
      ...(after !== null ? { after } : {}),
    });
    trace('upstream-call-end', `n=${r.items?.length ?? 0}`);
    const messages = r.items.map(shapeHistoryItem);
    // In-flight envelopes carried from the upstream's
    // /v1/conversations/{id}/items response. Plugin (hermes + openclaw)
    // owns the TurnBuffer and now emits live-SSE-shape envelopes under
    // `inflight: [...]`. PWA's `backend.replayInflight()` feeds them
    // through the same handlers the live SSE stream uses, so a
    // reconnected client renders STREAMING bubbles keyed by message_id —
    // subsequent live deltas update those same bubbles instead of
    // forking duplicates. Crack C, 2026-05-17 turn-taking audit:
    // replaces both the older proxy-side inflight cache AND the
    // finalized-items merge (which dropped message_id on the in-flight
    // assistant, causing visible double-renders on reload).
    //
    // Skip on `before`-cursor paging (an older-history page can't be the
    // resume snapshot that carries in-flight). `after` pages DO carry
    // inflight — but only when the page reaches the live tail
    // (has_more_newer === false): that's the delta-resume snapshot
    // (#191, the PWA catching up from its cached tail), which needs
    // mid-turn envelopes for streaming-bubble catch-up exactly like the
    // first-page resume. Intermediate after-pages stay bare. Empty
    // array when no turn is active.
    const reachesTail = after === null || r.has_more_newer === false;
    const inflightEnvelopes = before === null && reachesTail ? r.inflight : [];
    trace('serialize-start');
    const body = JSON.stringify({
      messages,
      firstId: r.first_id,
      hasMore: r.has_more,
      ...(typeof r.target_found === 'boolean' ? { targetFound: r.target_found } : {}),
      ...(r.last_id != null ? { lastId: r.last_id } : {}),
      ...(typeof r.has_more_newer === 'boolean' ? { hasMoreNewer: r.has_more_newer } : {}),
      // Authoritative live-turn flag from the agent; the PWA gates every
      // in-flight indicator on it (see transcript/projection.ts).
      ...(typeof r.turn_active === 'boolean' ? { turnActive: r.turn_active } : {}),
      // turn_start/turn_end capability + per-message 👀/✓/✗ marks.
      ...(r.turn_lifecycle === true ? { turnLifecycle: true } : {}),
      ...(r.turn_acks ? { turnAcks: r.turn_acks } : {}),
      ...(inflightEnvelopes.length > 0 ? { inflight: inflightEnvelopes } : {}),
    });
    trace('serialize-end', `bytes=${body.length}${inflightEnvelopes.length ? ` inflight=${inflightEnvelopes.length}` : ''}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    trace('response-sent');
  } catch (e: any) {
    trace('failed', `err=${e.message}`);
    console.error('[parley] session messages failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}
