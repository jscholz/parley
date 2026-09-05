// Parley proxy — scheduled-jobs extension (the Settings › Cron section).
//
//   GET  /api/parley/jobs                → upstream GET  /v1/jobs
//   POST /api/parley/jobs/{id}           → upstream POST /v1/jobs/{id}   {enabled?, deliver?, model?}
//   POST /api/parley/jobs/{id}/run       → upstream POST /v1/jobs/{id}/run
//   GET  /api/parley/jobs/{id}/runs      → upstream GET  /v1/jobs/{id}/runs?limit=N
//
// Contract: docs/ABSTRACT_AGENT_PROTOCOL.md "Optional scheduled-jobs
// extension". Thin forward, same shape as settings.ts: the agent owns
// the job list, the option catalogs AND validation; 404 from the agent
// propagates so the PWA hides the Cron section for agents without a
// scheduler.
import { getUpstream } from './index.ts';
import { UpstreamHTTPError } from './upstream.ts';

/** Job ids appear in the upstream URL path — conservative alphabet. */
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function json(res: any, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function forwardError(res: any, e: any, what: string) {
  if (e instanceof UpstreamHTTPError) {
    json(res, e.status, e.body ?? { error: { message: e.message } });
    return;
  }
  console.warn(`[parley] ${what} failed:`, e?.message);
  json(res, 502, { error: { message: e?.message || 'upstream error' } });
}

async function readJson(req: any, res: any): Promise<any | undefined> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      json(res, 413, { error: { message: 'body too large' } });
      return undefined;
    }
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { json(res, 400, { error: { message: 'invalid json' } }); return undefined; }
}

function requireUpstream(res: any) {
  const upstream = getUpstream();
  if (!upstream) json(res, 503, { error: 'parley_platform_unconfigured' });
  return upstream;
}

function validId(res: any, id: string): boolean {
  if (JOB_ID_RE.test(id)) return true;
  json(res, 400, { error: { message: 'invalid job id' } });
  return false;
}

/** GET /api/parley/jobs */
export async function handleParleyJobsList(_req: any, res: any) {
  const upstream = requireUpstream(res); if (!upstream) return;
  try {
    const payload = await upstream.listJobs();
    if (payload === null) { json(res, 404, { error: { message: 'agent does not implement /v1/jobs' } }); return; }
    json(res, 200, payload);
  } catch (e: any) { forwardError(res, e, 'jobs list'); }
}

/** POST /api/parley/jobs/{id} */
export async function handleParleyJobUpdate(req: any, res: any, id: string) {
  const upstream = requireUpstream(res); if (!upstream) return;
  if (!validId(res, id)) return;
  const body = await readJson(req, res); if (body === undefined) return;
  try { json(res, 200, await upstream.updateJob(id, body)); }
  catch (e: any) { forwardError(res, e, `job update ${id}`); }
}

/** POST /api/parley/jobs/{id}/run */
export async function handleParleyJobRun(_req: any, res: any, id: string) {
  const upstream = requireUpstream(res); if (!upstream) return;
  if (!validId(res, id)) return;
  try { json(res, 200, await upstream.runJob(id)); }
  catch (e: any) { forwardError(res, e, `job run ${id}`); }
}

/** GET /api/parley/jobs/{id}/runs?limit=N */
export async function handleParleyJobRuns(req: any, res: any, id: string) {
  const upstream = requireUpstream(res); if (!upstream) return;
  if (!validId(res, id)) return;
  const limit = Number(new URL(req.url, 'http://x').searchParams.get('limit') || '20');
  try { json(res, 200, await upstream.listJobRuns(id, Number.isFinite(limit) ? limit : 20)); }
  catch (e: any) { forwardError(res, e, `job runs ${id}`); }
}
