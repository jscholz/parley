/** Pure helpers for native (Capacitor) push — testable without a WebView. */

/** APNs device tokens arrive as 64 hex chars; normalise case, reject junk. */
export function normaliseDeviceToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
}

/** Where to navigate when a notification is tapped: explicit url, else
 *  the chat deep link, else nowhere. Mirrors sw.js's notificationclick. */
export function tapTarget(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  const url = typeof data.url === 'string' ? data.url : '';
  if (url) return url.startsWith('/') ? `.${url}` : url;
  const chatId = typeof data.chat_id === 'string' ? data.chat_id : '';
  return chatId ? `./app.html?chat=${encodeURIComponent(chatId)}` : null;
}

/** True when running inside the Capacitor iOS/Android shell with the
 *  PushNotifications plugin available. */
export function hasNativePush(win: any = typeof window !== 'undefined' ? window : undefined): boolean {
  const cap = win?.Capacitor;
  if (!cap) return false;
  try {
    if (typeof cap.isNativePlatform === 'function' && !cap.isNativePlatform()) return false;
  } catch { return false; }
  return !!(cap.Plugins?.PushNotifications || typeof cap.registerPlugin === 'function');
}
