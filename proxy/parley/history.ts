// GET /api/parley/sessions/<chat_id>/messages — per-chat transcript
// replay through the agent contract. The upstream's
// `/v1/conversations/{id}/items` walks the parent_session_id chain
// server-side so the proxy doesn't need to maintain its own CTE; we
// just translate OAI items → the existing on-the-wire shape that the
// PWA renderer consumes today.

import { getUpstream } from './index.ts';
import type { UpstreamAgent } from './upstream.ts';

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
    const messages = r.items.map((it) => ({
      id: it.id,
      role: it.role,
      content: it.content,
      timestamp: it.created_at,
      ...(it.tool_name ? { toolName: it.tool_name } : {}),
      // tool_call_id (role='tool' rows) + tool_calls JSON (role='assistant'
      // rows that issued tool calls). The PWA's sessionResume rebuild path
      // routes tool rows through activityRow.appendToolResult and parses
      // tool_calls to rebuild the activity row's headers. Without these
      // fields, post-session-switch reload showed assistant text but no
      // tool activity ("tool calls disappeared" on session resume).
      ...(it.tool_call_id ? { tool_call_id: it.tool_call_id } : {}),
      ...(it.tool_calls ? { tool_calls: it.tool_calls } : {}),
      // SSE-shape id (umsg_*/msg_*) when the plugin recorded a link
      // for this row in parley_msg_links. PWA's renderHistoryMessage
      // prefers this over the integer id as the dedup key so reload
      // bubbles match the IDB-cached SSE-shape ones. Absent for
      // legacy rows / other-channel rows / tool+system rows.
      ...(it.parley_id ? { parley_id: it.parley_id } : {}),
      // Notification kind ('cron', 'reminder', etc.) — plumbed
      // through for role='notification' rows so the PWA's renderer
      // can show the appropriate emoji + label.
      ...(it.kind ? { kind: it.kind } : {}),
    }));
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
