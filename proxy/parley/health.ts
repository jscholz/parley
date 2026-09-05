// Parley proxy — health extension (the Settings › Health section).
//
//   GET  /api/parley/health              → upstream GET  /v1/health
//   POST /api/parley/health/{id}/run     → upstream POST /v1/health/{id}/run
//
// Contract: docs/ABSTRACT_AGENT_PROTOCOL.md "Optional health extension".
// Thin forward like settings.ts / jobs.ts: the agent owns the check list,
// the reports and the runners; 404 from the agent → 404 here so the PWA
// shows "not supported".
import { getUpstream } from './index.ts';
import { UpstreamHTTPError } from './upstream.ts';

const CHECK_ID_RE = /^[a-z0-9_-]{1,32}$/;

function json(res: any, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function forwardError(res: any, e: any, what: string) {
  if (e instanceof UpstreamHTTPError) { json(res, e.status, e.body ?? { error: { message: e.message } }); return; }
  console.warn(`[parley] ${what} failed:`, e?.message);
  json(res, 502, { error: { message: e?.message || 'upstream error' } });
}

export async function handleParleyHealthList(_req: any, res: any) {
  const upstream = getUpstream();
  if (!upstream) { json(res, 503, { error: 'parley_platform_unconfigured' }); return; }
  try {
    const payload = await upstream.listHealth();
    if (payload === null) { json(res, 404, { error: { message: 'agent does not implement /v1/health' } }); return; }
    json(res, 200, payload);
  } catch (e: any) { forwardError(res, e, 'health list'); }
}

export async function handleParleyHealthRun(_req: any, res: any, id: string) {
  const upstream = getUpstream();
  if (!upstream) { json(res, 503, { error: 'parley_platform_unconfigured' }); return; }
  if (!CHECK_ID_RE.test(id)) { json(res, 400, { error: { message: 'invalid check id' } }); return; }
  try { json(res, 200, await upstream.runHealth(id)); }
  catch (e: any) { forwardError(res, e, `health run ${id}`); }
}
