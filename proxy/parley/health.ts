// Parley proxy — health extension (Settings › Integrations: integrations +
// system checks).
//
//   GET  /api/parley/health                         → upstream GET  /v1/health
//   POST /api/parley/health/{id}/run                → upstream POST /v1/health/{id}/run
//   GET  /api/parley/health/catalog                 → upstream GET  /v1/health/catalog
//   POST /api/parley/health/catalog/{p}/add         → upstream POST /v1/health/catalog/{p}/add
//   POST /api/parley/health/{id}/actions/{action}   → upstream POST …/actions/{action}
//        (the proxy stamps `origin` = the Origin/Host the client used, so the
//        agent builds an OAuth redirect URI the browser can follow)
//   GET  /api/parley/health/flows/{flow}            → upstream GET  /v1/health/flows/{flow}
//   POST /api/parley/health/flows/{flow}/cancel     → upstream POST …/cancel
//   GET  /api/parley/integrations/oauth/callback/{server}?code&state
//        → upstream GET /v1/health/oauth/callback/{server} and a small
//        "you can close this tab" page (the provider redirects the BROWSER here).
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

const SUB_ID_RE = /^[A-Za-z0-9_.~-]{1,128}$/;

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: any) => { data += c; if (data.length > 64 * 1024) { data = ''; req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/** The origin the client reached us on (what its browser can follow back). */
export function clientOrigin(req: any): string {
  const origin = String(req.headers?.origin || '');
  if (/^https?:\/\//.test(origin)) return origin;
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '');
  if (!host) return '';
  const proto = String(req.headers?.['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http'));
  return `${proto}://${host}`;
}

async function passthrough(res: any, what: string, call: () => Promise<{ status: number; body: any }>) {
  const upstream = getUpstream();
  if (!upstream) { json(res, 503, { error: 'parley_platform_unconfigured' }); return;
  }
  if (typeof upstream.healthCall !== 'function') { json(res, 404, { error: { message: 'agent does not implement integration flows' } }); return; }
  try {
    const r = await call();
    json(res, r.status, r.body ?? {});
  } catch (e: any) { forwardError(res, e, what); }
}

export async function handleParleyHealthCatalog(_req: any, res: any) {
  await passthrough(res, 'health catalog', () => getUpstream()!.healthCall!('GET', 'catalog'));
}

export async function handleParleyHealthCatalogAdd(req: any, res: any, provider: string) {
  if (!SUB_ID_RE.test(provider)) { json(res, 400, { error: { message: 'invalid provider' } }); return; }
  const body = await readBody(req);
  await passthrough(res, `health catalog add ${provider}`, () =>
    getUpstream()!.healthCall!('POST', `catalog/${encodeURIComponent(provider)}/add`, { ...body, origin: clientOrigin(req) }));
}

export async function handleParleyHealthAction(req: any, res: any, id: string, action: string) {
  if (!CHECK_ID_RE.test(id) || !CHECK_ID_RE.test(action)) { json(res, 400, { error: { message: 'invalid id' } }); return; }
  const body = await readBody(req);
  await passthrough(res, `health action ${id}/${action}`, () =>
    getUpstream()!.healthCall!('POST', `${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, { ...body, origin: clientOrigin(req) }));
}

export async function handleParleyHealthFlow(_req: any, res: any, flowId: string, cancel: boolean) {
  if (!SUB_ID_RE.test(flowId)) { json(res, 400, { error: { message: 'invalid flow id' } }); return; }
  await passthrough(res, `health flow ${flowId}`, () =>
    cancel ? getUpstream()!.healthCall!('POST', `flows/${encodeURIComponent(flowId)}/cancel`, {})
           : getUpstream()!.healthCall!('GET', `flows/${encodeURIComponent(flowId)}`));
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** The page the user's browser lands on after the provider redirects.
 *  Exported for the unit test. */
export function oauthCallbackPage(ok: boolean, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Parley · ${ok ? 'Signed in' : 'Sign-in problem'}</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#0f1211;color:#e6e8e6;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:28rem;padding:24px;text-align:center}h1{font-size:1.25rem;margin:0 0 8px}p{margin:0;color:#a9b0ac}</style></head>
<body><main><h1>${ok ? '✅ Signed in' : '⚠️ Sign-in problem'}</h1><p>${esc(message)}</p></main>
<script>try{if(window.opener)window.opener.postMessage({type:'parley:oauth-callback',ok:${ok ? 'true' : 'false'}},'*')}catch(e){}</script></body></html>`;
}

export async function handleParleyOAuthCallback(req: any, res: any, server: string) {
  const upstream = getUpstream();
  const html = (status: number, ok: boolean, message: string) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(oauthCallbackPage(ok, message));
  };
  if (!upstream || typeof upstream.healthCall !== 'function') { html(503, false, 'Parley is not connected to its agent right now.'); return; }
  if (!SUB_ID_RE.test(server)) { html(400, false, 'This sign-in link is not valid.'); return; }
  const url = new URL(req.url, 'http://x');
  const qs = new URLSearchParams();
  for (const k of ['code', 'state', 'error', 'iss', 'error_description']) {
    const v = url.searchParams.get(k);
    if (v !== null) qs.set(k, v);
  }
  try {
    const r = await upstream.healthCall('GET', `oauth/callback/${encodeURIComponent(server)}?${qs.toString()}`);
    const body = r.body || {};
    const ok = r.status === 200 && body.ok === true;
    html(ok ? 200 : (r.status >= 400 ? r.status : 400), ok, String(body.message || (ok ? 'Signed in. You can close this tab and go back to Parley.' : 'Something went wrong. Go back to Parley and try again.')));
  } catch (e: any) {
    console.warn(`[parley] oauth callback ${server} failed:`, e?.message);
    html(502, false, 'Parley could not reach its agent to finish the sign-in. Go back to Parley and try again.');
  }
}
