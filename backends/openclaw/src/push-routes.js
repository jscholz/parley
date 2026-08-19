/**
 * HTTP routes for plugin-owned push notification management.
 *
 *   GET  /v1/push/vapid-public-key
 *   POST /v1/push/subscribe                ← {endpoint, keys:{p256dh,auth}, userAgent}
 *   POST /v1/push/unsubscribe              ← {endpoint}
 *   GET  /v1/push/mutes
 *   POST /v1/push/mute                     ← {chat_id, muted}
 *   GET  /v1/push/prefs
 *   POST /v1/push/prefs                    ← {key, value}
 *   POST /v1/push/visibility               ← {chat_id, visible}
 *   POST /v1/push/test                     ← {chat_id?, text?}  (test push dispatch)
 *
 *  The proxy at /api/parley/notifications/* forwards to these when
 *  configured with PARLEY_PUSH_OWNED_BY_PLUGIN=true.
 */
import {
  ensureVapidKeys,
  upsertSubscription,
  removeSubscription,
  listSubscriptions,
  setMute,
  listMutes,
  getPref,
  setPref,
  listPrefs,
} from './push-storage.js';

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req, cap = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > cap) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

export function registerPushRoutes(api, { db, dispatcher }) {
  api.registerHttpRoute({
    path: '/v1/push/vapid-public-key',
    auth: 'plugin', match: 'exact',
    handler: (_req, res) => {
      const v = ensureVapidKeys(db);
      sendJson(res, 200, { publicKey: v.public_key, subject: v.subject });
      return true;
    },
  });

  api.registerHttpRoute({
    path: '/v1/push/subscribe',
    auth: 'plugin', match: 'exact',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
      const body = await readJson(req);
      const endpoint = body?.endpoint;
      const p256dh = body?.keys?.p256dh ?? body?.p256dh;
      const auth = body?.keys?.auth ?? body?.auth;
      const userAgent = body?.userAgent ?? body?.user_agent ?? '';
      if (!endpoint || !p256dh || !auth) {
        sendJson(res, 400, { error: 'invalid_request', message: 'endpoint + keys.p256dh + keys.auth required' });
        return true;
      }
      const { created } = upsertSubscription(db, { endpoint, p256dh, auth, userAgent });
      sendJson(res, created ? 201 : 200, { ok: true, created, total: listSubscriptions(db).length });
      return true;
    },
  });

  api.registerHttpRoute({
    path: '/v1/push/unsubscribe',
    auth: 'plugin', match: 'exact',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
      const body = await readJson(req);
      if (!body?.endpoint) { sendJson(res, 400, { error: 'invalid_request' }); return true; }
      const { removed } = removeSubscription(db, body.endpoint);
      sendJson(res, 200, { ok: true, removed, total: listSubscriptions(db).length });
      return true;
    },
  });

  api.registerHttpRoute({
    path: '/v1/push/mutes',
    auth: 'plugin', match: 'exact',
    handler: (_req, res) => {
      sendJson(res, 200, { mutes: listMutes(db) });
      return true;
    },
  });

  api.registerHttpRoute({
    path: '/v1/push/mute',
    auth: 'plugin', match: 'exact',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
      const body = await readJson(req);
      const chatId = body?.chat_id ?? body?.chatId;
      const muted = body?.muted !== false;
      if (!chatId) { sendJson(res, 400, { error: 'invalid_request', message: 'chat_id required' }); return true; }
      setMute(db, { chatId, muted });
      sendJson(res, 200, { ok: true, chat_id: chatId, muted });
      return true;
    },
  });

  api.registerHttpRoute({
    path: '/v1/push/prefs',
    auth: 'plugin', match: 'exact',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { prefs: listPrefs(db) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (!body?.key) { sendJson(res, 400, { error: 'invalid_request', message: 'key required' }); return true; }
        setPref(db, body.key, body.value);
        sendJson(res, 200, { ok: true, key: body.key, value: getPref(db, body.key) });
        return true;
      }
      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    },
  });

  api.registerHttpRoute({
    path: '/v1/push/visibility',
    auth: 'plugin', match: 'exact',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
      const body = await readJson(req);
      const chatId = body?.chat_id ?? body?.chatId;
      // PWA reports `state: 'visible' | 'hidden'` or boolean `visible`.
      const visible = body?.visible === true
        || body?.state === 'visible'
        || body?.state === 'focus';
      if (!chatId) { sendJson(res, 400, { error: 'invalid_request', message: 'chat_id required' }); return true; }
      if (visible) dispatcher.engagement.markVisible(chatId);
      else dispatcher.engagement.markHidden?.(chatId);
      sendJson(res, 200, { ok: true, chat_id: chatId, visible });
      return true;
    },
  });

  api.registerHttpRoute({
    path: '/v1/push/test',
    auth: 'plugin', match: 'exact',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
      const body = await readJson(req);
      const chatId = body?.chat_id ?? body?.chatId ?? 'parley-test';
      const text = body?.text ?? 'Test notification from openclaw plugin';
      const result = await dispatcher.dispatchPush({ chatId, text, kind: 'test' });
      sendJson(res, 200, { ok: true, ...result });
      return true;
    },
  });
}
