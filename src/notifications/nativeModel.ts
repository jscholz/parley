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

/** The chat a tapped notification points at, or null. Separate from
 *  `tapTarget` on purpose: when the app is ALREADY running we want an
 *  in-place switch (instant, keeps the session list and SSE stream warm),
 *  and only a cold start should pay for a document navigation. Field
 *  2026-09-08: every tap called `location.assign`, so tapping a
 *  notification reloaded the whole CAP bundle and landed on an app whose
 *  session list had not been fetched yet ("sessions don't load"), and
 *  tapping through several notifications paid that cost each time.
 *
 *  A payload with an explicit `url` that is not a bare `?chat=` deep link
 *  (a settings link, an external page) has no in-place equivalent — those
 *  return null here and fall through to `tapTarget`. */
export function tapChatId(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  const chatId = typeof data.chat_id === 'string' ? data.chat_id.trim() : '';
  if (chatId) return chatId;
  // A url payload still carries the chat when it is our own deep link.
  const url = typeof data.url === 'string' ? data.url : '';
  if (!url) return null;
  const m = /[?&]chat=([^&#]+)/.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).trim() || null; } catch { return m[1] || null; }
}

/** The message a tapped notification points at, or null — threaded into
 *  the drill so the tap lands on the bubble, not just the chat. */
export function tapMessageId(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  for (const k of ['message_id', 'msg_id', 'msg']) {
    const v = (data as any)[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const url = typeof data.url === 'string' ? data.url : '';
  const m = url ? /[?&]msg=([^&#]+)/.exec(url) : null;
  if (!m) return null;
  try { return decodeURIComponent(m[1]).trim() || null; } catch { return m[1] || null; }
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
