// When PARLEY_PUSH_OWNED_BY_PLUGIN=true, push storage + dispatch live
// in the backend plugin's supplemental DB (see
// backends/openclaw/src/push-*.js). The proxy stops
// owning the JSON files + web-push send; it just forwards the PWA's
// /api/parley/notifications/* calls to upstream /v1/push/* and skips
// local dispatch in stream.ts.
//
// Hermes still uses the legacy in-proxy storage until its plugin grows
// an equivalent surface. This env flag is the per-backend switch.

import * as http from 'node:http';
import { readEnv } from '../../env.mjs';

const UPSTREAM_BASE = (readEnv('PARLEY_PLATFORM_URL') || 'http://127.0.0.1:8645').replace(/\/+$/, '');
const UPSTREAM_TOKEN = (readEnv('PARLEY_PLATFORM_TOKEN') || '').trim();

export function isPushOwnedByPlugin(): boolean {
  const v = readEnv('PARLEY_PUSH_OWNED_BY_PLUGIN');
  return v === 'true' || v === '1';
}

interface ForwardResult {
  status: number;
  body: any;
}

const PUSH_KINDS = [
  'agent_reply',
  'cron',
  'approval',
];

const DEFAULT_BODY_CAP_BYTES = 8 * 1024;
export const PIN_BODY_CAP_BYTES = 64 * 1024;

function parseBoolPref(value: any): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (['true', '1', 'on', 'yes'].includes(v)) return true;
    if (['false', '0', 'off', 'no'].includes(v)) return false;
  }
  return undefined;
}

export function normalizePluginPrefs(raw: any): any {
  const prefs = raw?.prefs ?? raw ?? {};
  if (!prefs || typeof prefs !== 'object') return {};
  const out: any = { ...prefs };
  const kinds: Record<string, boolean> = {};
  for (const kind of PUSH_KINDS) {
    const parsed = parseBoolPref(prefs[`push_kind_${kind}`]);
    if (parsed !== undefined) kinds[kind] = parsed;
  }
  out.kinds = kinds;
  return out;
}

export function expandPreferenceUpdates(body: Record<string, any>): Array<{ key: string; value: any }> {
  const updates: Array<{ key: string; value: any }> = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === 'kinds' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [kind, enabled] of Object.entries(value)) {
        updates.push({ key: `push_kind_${kind}`, value: enabled });
      }
    } else {
      updates.push({ key, value });
    }
  }
  return updates;
}

async function forwardRaw(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body: any | null,
): Promise<ForwardResult> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (body !== null && body !== undefined) headers['content-type'] = 'application/json';
  if (UPSTREAM_TOKEN) headers['authorization'] = `Bearer ${UPSTREAM_TOKEN}`;
  const r = await fetch(`${UPSTREAM_BASE}${path}`, {
    method,
    headers,
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: any = null;
  try { parsed = await r.json(); }
  catch { parsed = null; }
  return { status: r.status, body: parsed };
}

function sendJson(res: http.ServerResponse, status: number, body: any): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendUpstreamUnavailable(res: http.ServerResponse, e: any): void {
  sendJson(res, 502, { error: 'upstream_unavailable', detail: e?.message ?? String(e) });
}

async function readBody(req: http.IncomingMessage, cap = DEFAULT_BODY_CAP_BYTES): Promise<any | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
      bytes += buf.byteLength;
      if (bytes > cap) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error(`body too large (${bytes} > ${cap} bytes)`));
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve(null);
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e as Error); }
    });
    req.on('error', reject);
  });
}

/** /api/parley/notifications/vapid-public-key → /v1/push/vapid-public-key */
export async function delegateVapid(req: http.IncomingMessage, res: http.ServerResponse) {
  const r = await forwardRaw('/v1/push/vapid-public-key', 'GET', null);
  sendJson(res, r.status, r.body ?? {});
}

export async function delegateSubscribe(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/subscribe', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegateUnsubscribe(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/unsubscribe', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

/** Native (APNs) device tokens from the Capacitor shell — plugin-owned store + sender. */
export async function delegateSubscribeNative(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/subscribe-native', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegateUnsubscribeNative(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/unsubscribe-native', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegateListMutes(req: http.IncomingMessage, res: http.ServerResponse) {
  const r = await forwardRaw('/v1/push/mutes', 'GET', null);
  // PWA expects `{muted_chats: string[]}` shape; plugin returns
  // `{mutes: [{chatId, mutedAt}]}`. Normalize here so the PWA surface
  // is unchanged regardless of whose storage backs it.
  const mutes = Array.isArray(r.body?.mutes) ? r.body.mutes : [];
  const muted_chats = mutes.map((m: any) => m.chatId).filter(Boolean);
  sendJson(res, r.status, { muted_chats });
}

export async function delegateSetMute(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/mute', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegateGetPrefs(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const r = await forwardRaw('/v1/push/prefs', 'GET', null);
    // Plugin stores flat keys (`push_kind_cron=false`); the PWA expects
    // nested `kinds.cron=false`. Normalize while preserving raw keys for
    // diagnostics/back-compat.
    sendJson(res, r.status, normalizePluginPrefs(r.body));
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegateSetPrefs(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'invalid_body' });
  }
  try {
    // PWA sends partial objects (`{quiet_hours: ...}` or
    // `{kinds: {cron: false}}`); plugin expects one `{key, value}` per
    // row. Flatten category toggles to the keys the plugin dispatcher
    // actually checks (`push_kind_<name>`).
    let last: ForwardResult | null = null;
    for (const { key, value } of expandPreferenceUpdates(body)) {
      last = await forwardRaw('/v1/push/prefs', 'POST', { key, value });
      if (last.status >= 400) return sendJson(res, last.status, last.body ?? {});
    }
    // Return the final state.
    const get = await forwardRaw('/v1/push/prefs', 'GET', null);
    sendJson(res, 200, normalizePluginPrefs(get.body));
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

/** GET the plugin's /v1/push/health blob for the diagnostics fold-in.
 *  Returns null on any upstream failure — push health is a diagnostic
 *  garnish; it must never break the diagnostics endpoint itself. */
export async function fetchPluginPushHealth(): Promise<any | null> {
  try {
    const r = await forwardRaw('/v1/push/health', 'GET', null);
    if (r.status >= 400) return null;
    return r.body?.push_health ?? null;
  } catch {
    return null;
  }
}

export async function delegateVisibility(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/visibility', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegateTest(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/test', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

// ── Unread state (SSOT for sidebar/app badge/push) ────────────────────

export async function delegateUnread(_req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const r = await forwardRaw('/v1/unread', 'GET', null);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegateUnreadSeen(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
  try {
    const r = await forwardRaw('/v1/unread/seen', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegateUnreadMark(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
  try {
    const r = await forwardRaw('/v1/unread/mark', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

// ── Agent questions (unified elicitation protocol, 2026-07-13) ────────

/** Retire an answered question from the SSE replay ring so it can never
 *  pop again on any device (field bug: an answered question replayed on
 *  every PWA refresh until its TTL expired). Dynamic import because
 *  stream.ts imports this module for isPushOwnedByPlugin — a static
 *  import here would close the cycle. Best-effort: a failure to retire
 *  must not fail the user's answer. */
async function retireAnsweredQuestion(questionId: string): Promise<void> {
  try {
    const stream = await import('../stream.ts');
    stream.resolveQuestion?.(questionId);
  } catch { /* ring suppression is best-effort */ }
}

/** POST /api/parley/questions/{id} → plugin /v1/questions/{id}.
 *  Resolves a blocking agent question (hermes clarify). 404 from
 *  upstream = the question lapsed (answered elsewhere / expired) —
 *  the PWA renders that state rather than treating it as an error.
 *
 *  On success the question is ALSO retired from the SSE replay ring:
 *  answering on one device must stop the pop-up on every other one. */
export async function delegateQuestionAnswer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  questionId: string,
) {
  let body: any;
  try { body = await readBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
  // In-process upstreams (claude-code) expose answerQuestion directly —
  // no HTTP hop, and their questions never exist on the plugin side.
  // false → 404 keeps "question lapsed" semantics identical to hermes.
  try {
    const { getUpstream } = await import('../index.ts');
    const up: any = getUpstream?.();
    if (up && typeof up.answerQuestion === 'function') {
      const ok = up.answerQuestion(questionId, String(body?.response ?? ''));
      if (ok) await retireAnsweredQuestion(questionId);
      return sendJson(res, ok ? 200 : 404,
        ok ? { ok: true } : { ok: false, error: 'no pending question with that id' });
    }
  } catch { /* fall through to the HTTP plugin route */ }
  try {
    const r = await forwardRaw(`/v1/questions/${encodeURIComponent(questionId)}`, 'POST', body);
    // Only on acceptance. A 404 means "no pending question with that id"
    // upstream, which the PWA renders as "lapsed" — leaving the ring
    // untouched there keeps expiry behavior exactly as it was.
    if (r.status >= 200 && r.status < 300) await retireAnsweredQuestion(questionId);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

// ── Pin sync (server-of-truth for cross-device pins) ──────────────────

export async function delegatePinsList(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const url = req.url || '/api/parley/pins';
    const query = url.includes('?') ? '?' + url.split('?')[1] : '';
    const r = await forwardRaw(`/v1/pins${query}`, 'GET', null);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegatePinUpsert(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req, PIN_BODY_CAP_BYTES); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
  try {
    const r = await forwardRaw('/v1/pins', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegatePinDelete(
  _req: http.IncomingMessage, res: http.ServerResponse,
  chatId: string, msgId: string,
) {
  try {
    const path = `/v1/pins/${encodeURIComponent(chatId)}/${encodeURIComponent(msgId)}`;
    const r = await forwardRaw(path, 'DELETE', null);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}


// ── Activity sync (server-of-truth for right-drawer Activity) ────────

export async function delegateActivityList(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const url = req.url || '/api/parley/activity';
    const query = url.includes('?') ? '?' + url.split('?')[1] : '';
    const r = await forwardRaw(`/v1/activity${query}`, 'GET', null);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegateActivityUpsert(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req, 64 * 1024); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
  try {
    const r = await forwardRaw('/v1/activity', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegateActivityResolve(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req, 8 * 1024); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
  try {
    const r = await forwardRaw('/v1/activity/resolve', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegateActivitySeen(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req, 8 * 1024); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
  try {
    const r = await forwardRaw('/v1/activity/seen', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegateActivityClear(_req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const r = await forwardRaw('/v1/activity/clear', 'POST', {});
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegateActivityDelete(
  _req: http.IncomingMessage, res: http.ServerResponse, id: string,
) {
  try {
    const r = await forwardRaw(`/v1/activity/${encodeURIComponent(id)}`, 'DELETE', null);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

// ── User settings (synced cross-device prefs: STT key-terms, …) ───────
// Plugin stores one JSON value per key in parley.db's user_settings.
// GET returns the whole map; a single-key read/write is one row.
//
// Keyterms clobber incident (2026-07-31): the single-key GET used to
// answer `{key, value: null}` for a missing row — indistinguishable
// from a transient failure once the client collapsed both to `null`,
// which made a phone re-upload its stale mirror over newer server
// state. The shape now carries an explicit `missing` flag plus the
// row's `updated_at` (the compare-and-swap base for the next PUT);
// the PUT forwards an optional `base_updated_at` and passes the
// plugin's 409-conflict body through untouched. All additive — old
// clients that only read `value` / send no base see LWW as before.

export async function delegateUserSettingsList(
  _req: http.IncomingMessage, res: http.ServerResponse,
) {
  try {
    const r = await forwardRaw('/v1/user-settings', 'GET', null);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegateUserSettingGet(
  _req: http.IncomingMessage, res: http.ServerResponse, key: string,
) {
  try {
    const r = await forwardRaw('/v1/user-settings', 'GET', null);
    if (r.status !== 200) {
      // Upstream failure: pass through so the client sees an ERROR,
      // never a fabricated "missing" (missing authorizes adoption
      // writes; a failure must stay read-only).
      return sendJson(res, r.status, r.body ?? {});
    }
    const settings = (r.body as any)?.settings;
    if (!settings || typeof settings !== 'object') {
      // A 200 whose body doesn't carry the settings map must NOT be
      // reported as `missing` — same read-only rule as above.
      return sendJson(res, 502, { error: 'bad_upstream_shape' });
    }
    const meta = (r.body && (r.body as any).updated_at) || {};
    const missing = !Object.prototype.hasOwnProperty.call(settings, key);
    sendJson(res, r.status, {
      key,
      value: settings[key] ?? null,
      missing,
      updated_at: missing ? null : (meta[key] ?? null),
    });
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}

export async function delegateUserSettingSet(
  req: http.IncomingMessage, res: http.ServerResponse, key: string,
) {
  let body: any;
  try { body = await readBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
  try {
    const upstream: any = { key, value: body?.value };
    // Forward the CAS base only when the caller sent one — its ABSENCE
    // is meaningful upstream (absent = unconditional LWW write).
    if (body && typeof body === 'object' && 'base_updated_at' in body) {
      upstream.base_updated_at = body.base_updated_at;
    }
    const r = await forwardRaw('/v1/user-settings', 'POST', upstream);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendUpstreamUnavailable(res, e); }
}
