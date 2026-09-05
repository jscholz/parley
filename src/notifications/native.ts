/**
 * @fileoverview Native push for the Capacitor iOS shell (APNs).
 *
 * WKWebView has no Web Push, so the installed iPhone app used to receive
 * nothing. Inside the shell we register with @capacitor/push-notifications,
 * hand the APNs device token to the proxy
 * (/api/parley/notifications/subscribe-native), and let the server send via
 * APNs alongside web push. subscription.ts branches here when
 * hasNativePush() is true so the settings toggle is unchanged.
 *
 * The token is remembered in localStorage only so the toggle can render
 * "on" — the server store is the source of truth.
 */
import { log } from '../util/log.ts';
import { apiUrl } from '../apiBase.ts';
import { hasNativePush, normaliseDeviceToken, tapTarget } from './nativeModel.ts';

const LS_KEY = 'parley.native-push.token';

function plugin(): any {
  const cap = (window as any).Capacitor;
  return cap?.Plugins?.PushNotifications ?? (typeof cap?.registerPlugin === 'function' ? cap.registerPlugin('PushNotifications') : null);
}

export { hasNativePush };

export function storedNativeToken(): string | null {
  try { return normaliseDeviceToken(localStorage.getItem(LS_KEY)); } catch { return null; }
}

/** Ask for permission, register with APNs, POST the token. Resolves with the token. */
export async function subscribeNative(): Promise<string> {
  const pn = plugin();
  if (!pn) throw new Error('Push plugin not available in this build');
  const perm = await pn.requestPermissions();
  if (perm?.receive !== 'granted') throw new Error('Notifications not allowed — enable them in iOS Settings › Parley');
  const token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('APNs registration timed out')), 20_000);
    pn.addListener('registration', (t: any) => {
      clearTimeout(timer);
      const tok = normaliseDeviceToken(t?.value);
      tok ? resolve(tok) : reject(new Error('APNs returned an unusable token'));
    });
    pn.addListener('registrationError', (e: any) => { clearTimeout(timer); reject(new Error(e?.error || 'APNs registration failed')); });
    pn.register().catch((e: any) => { clearTimeout(timer); reject(e); });
  });
  const res = await fetch(apiUrl('/api/parley/notifications/subscribe-native'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'ios', token, userAgent: navigator.userAgent }),
  });
  if (res.status === 503) throw new Error('Server not configured for APNs (see docs/APNS_SETUP.md)');
  if (!res.ok) throw new Error(`Native subscribe failed: ${res.status}`);
  try { localStorage.setItem(LS_KEY, token); } catch {}
  log('[notifications] native push registered');
  return token;
}

export async function unsubscribeNative(): Promise<void> {
  const token = storedNativeToken();
  try { localStorage.removeItem(LS_KEY); } catch {}
  if (!token) return;
  try {
    await fetch(apiUrl('/api/parley/notifications/unsubscribe-native'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
  } catch (e: any) { log('[notifications] native unsubscribe failed:', e?.message ?? e); }
  try { await plugin()?.unregister?.(); } catch {}
}

/** Wire tap + foreground handlers once at boot (no-op outside the shell). */
export function initNativePushHandlers(): void {
  if (!hasNativePush()) return;
  const pn = plugin();
  if (!pn) return;
  try {
    pn.addListener('pushNotificationActionPerformed', (ev: any) => {
      const target = tapTarget(ev?.notification?.data);
      if (target) location.assign(target);
    });
    pn.addListener('pushNotificationReceived', (n: any) => {
      // Foreground: iOS shows nothing by itself; the in-app unread badge /
      // SSE stream already reflects the reply, so just log.
      log('[notifications] push received in foreground:', n?.title);
    });
  } catch (e: any) { log('[notifications] native handlers failed:', e?.message ?? e); }
}
