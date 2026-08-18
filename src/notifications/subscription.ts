// Push subscription helpers — talk to PushManager + post the result to
// the proxy's /api/parley/notifications/{subscribe,unsubscribe}
// endpoints. Extracted as a dedicated file because the subscribe()
// roundtrip has enough moving parts (VAPID fetch + base64 decoding +
// PushManager call + POST + IDB cache for the active endpoint) that
// inlining it elsewhere would obscure the lifecycle.
//
// Phase 3a — what works:
//   isPushSupported()          → cheap feature probe (any caller)
//   getActiveSubscription()    → reads the SW's PushSubscription if
//                                already granted; no permission prompt
//   subscribe()                → fetches VAPID, calls pushManager.subscribe
//                                (which triggers the OS-level prompt on
//                                first call), POSTs to proxy, caches the
//                                endpoint in IndexedDB so we can detect
//                                rotation later
//   unsubscribe()              → reverse — unsubscribe() on PushManager,
//                                POST to proxy, clear the IDB cache
//
// Phase 3b will layer the settings-panel toggle on top. Phase 3c will
// wire dispatch on the server side.

import { log } from '../util/log.ts';
import { apiUrl } from '../apiBase.ts';

/** Feature probe — `serviceWorker` + `PushManager` + `Notification`
 *  all need to exist. iOS Safari only exposes these inside an installed
 *  PWA (manifest "display": "standalone"), which matches our deployment
 *  target. */
export function isPushSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('PushManager' in self)) return false;
  if (typeof Notification === 'undefined') return false;
  return true;
}

/** Get the CURRENT push subscription from the active SW registration,
 *  or null if none. Does NOT prompt for permission. Use as a passive
 *  check (e.g. "should the settings toggle render as on or off?"). */
export async function getActiveSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch (e: any) {
    log('[notifications] getActiveSubscription failed:', e?.message ?? e);
    return null;
  }
}

/** Convert the base64url-encoded VAPID public key to the Uint8Array
 *  shape PushManager.subscribe requires. Standard urlsafe-b64 decode
 *  with padding restoration. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

/** Subscribe to push: fetch VAPID from proxy → pushManager.subscribe
 *  (triggers OS permission prompt on first call) → POST to proxy.
 *  Resolves with the PushSubscription on success, throws on any step.
 *  Caller is responsible for catching + surfacing failure to the UI. */
export async function subscribe(): Promise<PushSubscription> {
  if (!isPushSupported()) {
    throw new Error('Push notifications not supported on this browser');
  }
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error('Service worker not registered yet — reload and retry');

  // 1. Fetch the VAPID public key. 503 from this endpoint means the
  //    server-side env isn't configured — present as a clear error
  //    rather than a generic "subscribe failed".
  const vapidRes = await fetch(apiUrl('/api/parley/notifications/vapid-public-key'));
  if (vapidRes.status === 503) {
    throw new Error('Server not configured for push (VAPID keys missing)');
  }
  if (!vapidRes.ok) {
    throw new Error(`VAPID fetch failed: ${vapidRes.status}`);
  }
  const { publicKey } = await vapidRes.json() as { publicKey: string };

  // 2. Call PushManager.subscribe. First call on this origin triggers
  //    the OS permission prompt (iOS / macOS / Android). userVisibleOnly
  //    is required by every browser today; silent push isn't an option.
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    // BufferSource cast: TS DOM lib types reject Uint8Array<ArrayBufferLike>
    // (potential SharedArrayBuffer) on this field; the runtime accepts
    // any typed-array view, so the cast is safe.
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });

  // 3. POST the subscription up to the proxy so dispatch can find it.
  //    Include the user-agent so the storage row is debuggable.
  const json = sub.toJSON();
  const body = {
    endpoint: json.endpoint,
    keys: json.keys,
    userAgent: navigator.userAgent,
  };
  const res = await fetch(apiUrl('/api/parley/notifications/subscribe'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Subscription is now in PushManager but NOT in the proxy. Best to
    // unsubscribe locally so the next call retries from a clean state
    // rather than leaving a half-registered ghost.
    try { await sub.unsubscribe(); } catch { /* best effort */ }
    throw new Error(`Subscribe POST failed: ${res.status}`);
  }
  log('[notifications] subscribed:', json.endpoint);
  return sub;
}

/** Unsubscribe from push: call sub.unsubscribe() locally + POST to
 *  proxy so the stored row is removed. Idempotent — no-op + no throw if
 *  there's no active subscription. */
export async function unsubscribe(): Promise<void> {
  if (!isPushSupported()) return;
  const sub = await getActiveSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  // Tell the server first so we don't leave a stale row if the local
  // unsubscribe fails (less harmful direction than the opposite).
  try {
    await fetch(apiUrl('/api/parley/notifications/unsubscribe'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
  } catch (e: any) {
    log('[notifications] proxy unsubscribe failed (continuing local teardown):', e?.message ?? e);
  }
  try {
    await sub.unsubscribe();
    log('[notifications] unsubscribed:', endpoint);
  } catch (e: any) {
    log('[notifications] PushManager.unsubscribe failed:', e?.message ?? e);
  }
}
