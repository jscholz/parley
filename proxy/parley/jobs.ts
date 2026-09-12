// Parley proxy — scheduled-jobs extension (the Settings › Cron section).
//
//   GET  /api/parley/jobs                → upstream GET  /v1/jobs
//   POST /api/parley/jobs/{id}           → upstream POST /v1/jobs/{id}   {enabled?, deliver?, model?}
//   POST /api/parley/jobs/model          → upstream POST /v1/jobs/model {model}  ("model for all jobs")
//   POST /api/parley/jobs/{id}/run       → upstream POST /v1/jobs/{id}/run
//   GET  /api/parley/jobs/{id}/runs      → upstream GET  /v1/jobs/{id}/runs?limit=N
//   DELETE /api/parley/jobs/{id}         → upstream DELETE /v1/jobs/{id}
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

/** POST /api/parley/jobs/model {model} → the listJobs-shaped payload.
 *  Must be routed BEFORE /api/parley/jobs/{id} — see server.ts's ordering
 *  comment, same reason the run/runs suffixes are checked first. */
export async function handleParleyJobsSetModel(req: any, res: any) {
  const upstream = requireUpstream(res); if (!upstream) return;
  const body = await readJson(req, res); if (body === undefined) return;
  if (typeof body?.model !== 'string') { json(res, 400, { error: { message: "body must include a string 'model'" } }); return; }
  try { json(res, 200, await upstream.setAllJobsModel(body.model)); }
  catch (e: any) { forwardError(res, e, 'jobs bulk model update'); }
}

/** POST /api/parley/jobs/{id}/run  {note?} → job view with `last_run`.
 *  Fires immediately upstream; 409 (already running) forwards as-is. */
export async function handleParleyJobRun(req: any, res: any, id: string) {
  const upstream = requireUpstream(res); if (!upstream) return;
  if (!validId(res, id)) return;
  const body = await readJson(req, res); if (body === undefined) return;
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : undefined;
  try { json(res, 200, await upstream.runJob(id, note ? { note } : {})); }
  catch (e: any) { forwardError(res, e, `job run ${id}`); }
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** GET /api/parley/jobs/{id}/runs/{runId} */
export async function handleParleyJobRunGet(_req: any, res: any, id: string, runId: string) {
  const upstream = requireUpstream(res); if (!upstream) return;
  if (!validId(res, id)) return;
  if (!RUN_ID_RE.test(runId)) { json(res, 400, { error: { message: 'invalid run id' } }); return; }
  try { json(res, 200, await upstream.getJobRun(id, runId)); }
  catch (e: any) { forwardError(res, e, `job run ${id}/${runId}`); }
}

/** GET /api/parley/jobs/{id}/runs/{runId}/console?after=N — ephemeral
 *  console lines straight from the upstream; the proxy stores nothing. */
export async function handleParleyJobRunConsole(req: any, res: any, id: string, runId: string) {
  const upstream = requireUpstream(res); if (!upstream) return;
  if (!validId(res, id)) return;
  if (!RUN_ID_RE.test(runId)) { json(res, 400, { error: { message: 'invalid run id' } }); return; }
  const after = Number(new URL(req.url, 'http://x').searchParams.get('after') || '0');
  try { json(res, 200, await upstream.getJobRunConsole(id, runId, Number.isFinite(after) ? after : 0)); }
  catch (e: any) { forwardError(res, e, `job run console ${id}/${runId}`); }
}

/** GET /api/parley/jobs/{id}/runs?limit=N */
export async function handleParleyJobRuns(req: any, res: any, id: string) {
  const upstream = requireUpstream(res); if (!upstream) return;
  if (!validId(res, id)) return;
  const limit = Number(new URL(req.url, 'http://x').searchParams.get('limit') || '20');
  try { json(res, 200, await upstream.listJobRuns(id, Number.isFinite(limit) ? limit : 20)); }
  catch (e: any) { forwardError(res, e, `job runs ${id}`); }
}

/** DELETE /api/parley/jobs/{id} */
export async function handleParleyJobDelete(_req: any, res: any, id: string) {
  const upstream = requireUpstream(res); if (!upstream) return;
  if (!validId(res, id)) return;
  try { json(res, 200, await upstream.deleteJob(id)); }
  catch (e: any) { forwardError(res, e, `job delete ${id}`); }
}
