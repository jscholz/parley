// /api/parley/notifications/* handlers — Web Push subscription
// roundtrip. Phase 3a: subscribe/unsubscribe + the public-key probe
// the client needs before it can call PushManager.subscribe().
//
//   GET    /api/parley/notifications/vapid-public-key
//          → { publicKey: string } | 503
//   POST   /api/parley/notifications/subscribe
//          body: { endpoint, keys: {p256dh, auth}, userAgent? }
//          → { ok: true, created: boolean, total: number } | 503/400
//   POST   /api/parley/notifications/unsubscribe
//          body: { endpoint }
//          → { ok: true, removed: boolean } | 503/400
//   POST   /api/parley/notifications/test
//          body: { endpoint?, title?, body? }
//          → { ok: true, dispatched: number, failed: number } | 503
//          Phase 3a stub: returns { ok: true, dispatched: 0, failed: 0,
//          note: 'dispatch lands in 3c' }. The route exists now so the
//          client + smoke tests have a stable endpoint to call against.
//
// 503 is returned when VAPID env is missing — the feature is silently
// off, the UI surfaces the message. 400 is for malformed bodies.

import { isConfigured, getVapidConfig } from './index.ts';
import {
  upsertSubscription,
  removeSubscription,
  listSubscriptions,
} from './storage.ts';
import { dispatchPush } from './dispatch.ts';
import { setMuted, listMutedChats } from './mutes.ts';
import { recordVisibility } from './visibility.ts';
import { getPrefs, updatePrefs, computeLocalPushHealth, type Prefs } from './prefs.ts';
import { getRecentDecisions } from './diagnostics.ts';
import {
  isPushOwnedByPlugin,
  delegateVapid, delegateSubscribe, delegateUnsubscribe,
  delegateSubscribeNative, delegateUnsubscribeNative,
  delegateListMutes, delegateSetMute,
  delegateGetPrefs, delegateSetPrefs,
  delegateVisibility, delegateTest,
  fetchPluginPushHealth,
} from './delegate.ts';

const MAX_BODY_BYTES = 8 * 1024;  // subscriptions are tiny, generous

async function readJsonBody(req: any): Promise<any> {
  let raw = '';
  let aborted = false;
  req.on('data', (c: any) => {
    raw += c;
    if (raw.length > MAX_BODY_BYTES) {
      aborted = true;
      req.destroy();
    }
  });
  req.on('error', () => { aborted = true; });
  await new Promise<void>((resolve) => {
    req.on('end', () => resolve());
    req.on('close', () => resolve());
  });
  if (aborted) throw new Error('body too large');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function sendJson(res: any, status: number, payload: any): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** GET /api/parley/notifications/vapid-public-key
 *  Client fetches this before calling pushManager.subscribe(). The
 *  public key isn't a secret — it's the application-server identity
 *  that gets signed into every push request. Returns 503 (not 404) when
 *  VAPID env is missing so the client can distinguish "feature disabled"
 *  from "wrong proxy version". */
export function handleParleyVapidPublicKey(req: any, res: any): void {
  if (isPushOwnedByPlugin()) { delegateVapid(req, res).catch(() => sendJson(res, 502, { error: 'upstream_unavailable' })); return; }
  const vapid = getVapidConfig();
  if (!vapid) {
    return sendJson(res, 503, {
      error: 'vapid_unconfigured',
      detail: 'Set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT in .env.',
    });
  }
  sendJson(res, 200, { publicKey: vapid.publicKey });
}

/** POST /api/parley/notifications/subscribe
 *  Store a PushSubscription from the client. Body shape mirrors
 *  PushSubscription.toJSON() plus an optional userAgent for debugging:
 *    { endpoint: "https://...", keys: { p256dh, auth }, userAgent? }
 *  Re-subscribing the same endpoint updates the row (rotating keys). */
export async function handleParleySubscribe(req: any, res: any): Promise<void> {
  if (isPushOwnedByPlugin()) return delegateSubscribe(req, res);
  if (!isConfigured()) {
    return sendJson(res, 503, { error: 'vapid_unconfigured' });
  }
  let body: any;
  try { body = await readJsonBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e.message }); }
  if (!body || typeof body.endpoint !== 'string'
      || !body.keys || typeof body.keys.p256dh !== 'string'
      || typeof body.keys.auth !== 'string') {
    return sendJson(res, 400, {
      error: 'invalid_subscription',
      detail: 'Expected { endpoint, keys: { p256dh, auth }, userAgent? }',
    });
  }
  const userAgent = typeof body.userAgent === 'string' ? body.userAgent.slice(0, 200) : '';
  const result = await upsertSubscription({
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    userAgent,
  });
  sendJson(res, 200, { ok: true, ...result });
}

/** POST /api/parley/notifications/unsubscribe
 *  Remove a subscription by endpoint URL. Idempotent. */
export async function handleParleyUnsubscribe(req: any, res: any): Promise<void> {
  if (isPushOwnedByPlugin()) return delegateUnsubscribe(req, res);
  if (!isConfigured()) {
    return sendJson(res, 503, { error: 'vapid_unconfigured' });
  }
  let body: any;
  try { body = await readJsonBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e.message }); }
  if (!body || typeof body.endpoint !== 'string') {
    return sendJson(res, 400, { error: 'invalid_body', detail: 'Expected { endpoint }' });
  }
  const removed = await removeSubscription(body.endpoint);
  sendJson(res, 200, { ok: true, removed });
}

/** POST /api/parley/notifications/subscribe-native
 *  Capacitor iOS shell registers its APNs device token:
 *    { platform: "ios", token: "<64 hex>", userAgent? }
 *  Only the hermes plugin can send APNs (it owns the token store + key), so this
 *  route exists solely in plugin-owned mode; otherwise 503. */
export async function handleParleySubscribeNative(req: any, res: any): Promise<void> {
  if (isPushOwnedByPlugin()) return delegateSubscribeNative(req, res);
  return sendJson(res, 503, { error: 'native_push_requires_plugin' });
}

/** POST /api/parley/notifications/unsubscribe-native  { token } */
export async function handleParleyUnsubscribeNative(req: any, res: any): Promise<void> {
  if (isPushOwnedByPlugin()) return delegateUnsubscribeNative(req, res);
  return sendJson(res, 503, { error: 'native_push_requires_plugin' });
}

/** GET /api/parley/notifications/mutes
 *  Return the list of currently-muted chat_ids. PWA reads this at boot
 *  + after toggling so the 3-dots menu can show the right label
 *  ("Mute" vs "Unmute") per chat. */
export function handleParleyListMutes(req: any, res: any): void {
  if (isPushOwnedByPlugin()) { delegateListMutes(req, res).catch(() => sendJson(res, 502, { error: 'upstream_unavailable' })); return; }
  if (!isConfigured()) {
    return sendJson(res, 503, { error: 'vapid_unconfigured' });
  }
  sendJson(res, 200, { muted_chats: listMutedChats() });
}

/** POST /api/parley/notifications/mute
 *  Toggle a chat's mute state. Body:
 *    { chat_id: string, muted: boolean }
 *  Idempotent: setting an already-muted chat to muted=true returns the
 *  same result. Mute is GLOBAL across all subscriptions in v1. */
export async function handleParleySetMute(req: any, res: any): Promise<void> {
  if (isPushOwnedByPlugin()) return delegateSetMute(req, res);
  if (!isConfigured()) {
    return sendJson(res, 503, { error: 'vapid_unconfigured' });
  }
  let body: any;
  try { body = await readJsonBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e.message }); }
  if (!body || typeof body.chat_id !== 'string' || !body.chat_id
      || typeof body.muted !== 'boolean') {
    return sendJson(res, 400, {
      error: 'invalid_body',
      detail: 'Expected { chat_id: string, muted: boolean }',
    });
  }
  try {
    const result = await setMuted(body.chat_id, body.muted);
    sendJson(res, 200, { ok: true, ...result });
  } catch (e: any) {
    sendJson(res, 500, { error: 'mute_failed', detail: e?.message });
  }
}

/** GET /api/parley/notifications/preferences
 *  Return current user prefs (quiet_hours today; more knobs as wave 2
 *  fills in digest + per-kind toggles). Always 200 — defaults are
 *  returned even when no prefs file exists. */
export function handleParleyGetPreferences(req: any, res: any): void {
  if (isPushOwnedByPlugin()) { delegateGetPrefs(req, res).catch(() => sendJson(res, 502, { error: 'upstream_unavailable' })); return; }
  sendJson(res, 200, getPrefs());
}

/** POST /api/parley/notifications/preferences
 *  Update one or more preference fields. Partial — fields not in the
 *  body keep their current values. Returns the updated prefs blob.
 *  400 on malformed body (non-HH:MM times etc). */
export async function handleParleySetPreferences(req: any, res: any): Promise<void> {
  if (isPushOwnedByPlugin()) return delegateSetPrefs(req, res);
  let body: any;
  try { body = await readJsonBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e.message }); }
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'invalid_body', detail: 'Expected an object' });
  }
  try {
    const updated = await updatePrefs(body as Partial<Prefs>);
    sendJson(res, 200, updated);
  } catch (e: any) {
    sendJson(res, 400, { error: 'invalid_preference', detail: e?.message });
  }
}

/** POST /api/parley/notifications/visibility
 *  PWA reports a visibility transition (document.visibilitychange or
 *  a chat switch). Body:
 *    { state: 'visible' | 'hidden', chat_id?: string }
 *
 *  Updates the proxy's per-chat engagement clock; the dispatch gate
 *  consults it to suppress redundant pushes while the user is actively
 *  viewing the chat (short window; hidden/blur clears immediately).
 *
 *  Always returns 200 even when VAPID is unconfigured — reporting
 *  visibility is harmless when push is disabled; ignoring the data is
 *  fine, no need to surface 503. */
export async function handleParleyVisibility(req: any, res: any): Promise<void> {
  if (isPushOwnedByPlugin()) return delegateVisibility(req, res);
  let body: any;
  try { body = await readJsonBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e.message }); }
  if (!body || (body.state !== 'visible' && body.state !== 'hidden')) {
    return sendJson(res, 400, {
      error: 'invalid_body',
      detail: 'Expected { state: "visible" | "hidden", chat_id?: string }',
    });
  }
  // chat_id is optional but, when present, must be a string. Reject
  // wrong-type values (e.g., a numeric chat_id from a buggy client)
  // so we surface bugs at the wire instead of silently dropping data.
  if ('chat_id' in body && body.chat_id !== undefined
      && typeof body.chat_id !== 'string') {
    return sendJson(res, 400, {
      error: 'invalid_body',
      detail: 'chat_id, when present, must be a string',
    });
  }
  const chatId = typeof body.chat_id === 'string' ? body.chat_id : '';
  recordVisibility(body.state, chatId);
  sendJson(res, 200, { ok: true });
}

/** GET /api/parley/notifications/diagnostics
 *  Return the recent dispatch decisions (in-process ring, capped at
 *  50 entries) plus an aggregate `push_health` blob. Used by the
 *  Notifications settings panel for the "last decisions" readout —
 *  lets users see "why didn't my last push fire" without having to
 *  tail the proxy journal. Optional `?limit=N` to clip the result.
 *
 *  push_health (added after the 2026-07 outage where every push kind
 *  sat disabled for days): per-kind effective enablement, the
 *  all-kinds-disabled tripwire, and quiet-hours state. Plugin-owned
 *  push pulls it from /v1/push/health; otherwise computed from the
 *  proxy's local prefs. Upstream failure degrades to
 *  `{available:false}` — diagnostics itself never 5xxes over it. */
export async function handleParleyDiagnostics(req: any, res: any): Promise<void> {
  let limit = 10;
  try {
    const u = new URL(req.url, 'http://x');
    const raw = u.searchParams.get('limit');
    if (raw) limit = Math.max(1, Math.min(50, parseInt(raw, 10) || 10));
  } catch { /* fall through to default */ }
  let pushHealth: any;
  if (isPushOwnedByPlugin()) {
    const upstream = await fetchPluginPushHealth();
    pushHealth = upstream
      ? { owner: 'plugin', ...upstream }
      : { owner: 'plugin', available: false };
  } else {
    pushHealth = computeLocalPushHealth();
  }
  sendJson(res, 200, { decisions: getRecentDecisions(limit), push_health: pushHealth });
}

/** POST /api/parley/notifications/test
 *  Dispatch a synthetic push to every stored subscription. Body is
 *  optional:
 *    { title?, body? }
 *  Defaults to a "Test from Parley" payload. Returns counts of
 *  delivered / failed / pruned subscriptions. Pruned subscriptions are
 *  the ones the push service reported as gone (404/410) — storage
 *  removes them so future dispatches don't waste a roundtrip. */
export async function handleParleyTest(req: any, res: any): Promise<void> {
  if (isPushOwnedByPlugin()) return delegateTest(req, res);
  if (!isConfigured()) {
    return sendJson(res, 503, { error: 'vapid_unconfigured' });
  }
  let body: any = null;
  try { body = await readJsonBody(req); }
  catch { /* tolerate empty / malformed body — test endpoint is forgiving */ }
  const title = (body && typeof body.title === 'string' && body.title)
    || 'Test from Parley';
  const text = (body && typeof body.body === 'string' && body.body)
    || 'Web Push is wired end-to-end ✓';
  const eligible = listSubscriptions().length;
  const result = await dispatchPush({ title, body: text });
  sendJson(res, 200, { ok: true, eligible, ...result });
}
