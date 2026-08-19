// Client-side visibility reporter. Posts visibility/focus-state changes
// to the proxy so the dispatch gate knows whether the user is actively
// engaged with a chat (within a short engagement window).
//
// Three fire conditions:
//
//   1. document.visibilitychange + window focus/blur — PWA foregrounds /
//      backgrounds, and macOS/browser focus changes when another app covers it.
//      The current `sessionDrawer.getViewed()` is the chat the user
//      is on; we attach it so the proxy can scope the engagement
//      signal per-chat.
//
//   2. sessionDrawer.setViewed(id) — user switches between chats
//      inside the PWA. Switching INTO a chat is functionally a
//      visibility-=-visible event for that chat (the PWA is already
//      foregrounded, but the chat-in-focus just changed).
//
//   3. Heartbeat — every HEARTBEAT_MS while page.visibilityState is
//      'visible' AND a chat is viewed. Without this, sitting on the
//      same chat with no events lets the server-side
//      timestamp age past ENGAGED_WINDOW_MS and the very next reply
//      gets a spurious push banner.
//
// Failures are deliberately swallowed (best-effort): a missed report
// just means the gate falls back to the legacy SSE-attached +
// 30s-idle heuristic. We don't want push-notification quality issues
// blocking the PWA's main thread or spamming the console.

import { log } from '../util/log.ts';
import { apiUrl } from '../apiBase.ts';

type VisibilityState = 'visible' | 'hidden';

// Heartbeat cadence — must be less than the proxy-side
// ENGAGED_WINDOW_MS (currently 10s). 8s keeps foreground engagement
// fresh while avoiding the old 1.5s phone battery/network tax. Hidden
// and blur still report immediately, so background replies still push.
const HEARTBEAT_MS = 8000;

let lastReportedState: VisibilityState | null = null;
let lastReportedChat: string | null = null;
let initialized = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let getViewedRef: (() => string | null) | null = null;

/** Are we on a mobile runtime? On iOS PWAs and Android, `document.hasFocus()`
 *  can return false even when the app is actively foregrounded — it's a
 *  desktop-centric API and not reliable on touch devices (covered by
 *  visibilityState='hidden' already if the user backgrounds the app).
 *  Without this guard, the heartbeat reports state='hidden' on mobile and
 *  the proxy's engagement timestamp ages out, triggering spurious pushes
 *  for the focused chat. */
function isMobileRuntime(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('capacitor-app')) return true;
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

function isEngagedNow(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState !== 'visible') return false;
  // hasFocus() is meaningful on desktop (another app may cover the browser
  // while the page stays "visible"); on mobile it's a false-negative trap.
  if (!isMobileRuntime() && !document.hasFocus()) return false;
  return !!(getViewedRef?.() || '');
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer || !isEngagedNow()) return;
  heartbeatTimer = setInterval(() => {
    if (!isEngagedNow()) {
      stopHeartbeat();
      return;
    }
    const chatId = getViewedRef?.() || '';
    lastReportedState = 'visible';
    lastReportedChat = chatId;
    void postVisibility('visible', chatId);
  }, HEARTBEAT_MS);
}

function syncHeartbeat(): void {
  if (isEngagedNow()) startHeartbeat();
  else stopHeartbeat();
}

async function postVisibility(state: VisibilityState, chatId: string): Promise<void> {
  try {
    await fetch(apiUrl('/api/parley/notifications/visibility'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, chat_id: chatId || undefined }),
    });
  } catch (e: any) {
    // Network drops happen; the next visibilitychange will re-report.
    // Quietly diagnostic-log only — no user-facing surfacing.
    log(`[visibility] report failed (${state}, ${chatId || '-'}): ${e?.message ?? e}`);
  }
}

/** Idempotent. Reports only when state OR chat actually changed —
 *  avoids burning HTTP roundtrips on no-op events. */
function reportVisibility(state: VisibilityState, chatId: string, force = false): void {
  if (!force && state === lastReportedState && chatId === lastReportedChat) {
    syncHeartbeat();
    return;
  }
  lastReportedState = state;
  lastReportedChat = chatId;
  void postVisibility(state, chatId);
  syncHeartbeat();
}

/** Wire the listeners. Called once at boot from main.ts. The
 *  getViewed callback returns the currently-viewed chat id; we read
 *  it lazily so this module doesn't depend on sessionDrawer (avoids
 *  a cycle and keeps the API tiny). */
export function initVisibilityReporting(getViewed: () => string | null): void {
  if (initialized) return;
  initialized = true;
  getViewedRef = getViewed;

  const compute = (): { state: VisibilityState; chatId: string } => {
    // Same mobile carve-out as isEngagedNow: on iOS/Android, trust
    // visibilityState alone. hasFocus() is a desktop signal for the
    // "browser visible but another app on top" case; on mobile, that's
    // already covered by visibilityState='hidden'.
    const visible = typeof document === 'undefined'
      || (document.visibilityState !== 'hidden'
          && (isMobileRuntime() || document.hasFocus()));
    const state: VisibilityState = visible ? 'visible' : 'hidden';
    const chatId = getViewed() || '';
    return { state, chatId };
  };

  // Initial report so the proxy knows the boot-time state without
  // needing to wait for the first visibilitychange.
  const first = compute();
  reportVisibility(first.state, first.chatId);

  // document.visibilitychange covers OS-level PWA background/foreground.
  // window focus/blur covers the desktop case where the browser remains
  // visible to the page but another app is in front of it.
  const reportCurrent = (force = false) => {
    const { state, chatId } = compute();
    reportVisibility(state, chatId, force);
  };
  document.addEventListener('visibilitychange', () => reportCurrent(document.visibilityState === 'hidden'));
  window.addEventListener('focus', () => reportCurrent(false));
  // Force blur reports. Heartbeats intentionally refresh the server-side
  // visible timestamp; if the local dedupe cache still says "hidden" from
  // an earlier transition, a normal deduped report would skip this blur and
  // leave the server incorrectly engaged.
  window.addEventListener('blur', () => reportCurrent(true));

  // Heartbeat — keeps the proxy's engagement timestamp fresh while the
  // user sits on a chat. Without this, the timestamp ages past the server
  // engagement window and any new reply gets a spurious push banner.
  // The timer exists only while the
  // page is foregrounded/focused on a chat; hidden/blur stops it instead
  // of waking phone PWAs to no-op.
  syncHeartbeat();
}

/** Reports the user switched to chat `chatId`. Called from
 *  sessionDrawer.setViewed. Reports state=visible (the only sensible
 *  state if the user just clicked a chat); the proxy times-out the
 *  signal naturally after the engagement window. */
export function reportChatSwitch(chatId: string | null): void {
  if (!initialized) return;
  const id = chatId || '';
  // Same mobile carve-out as compute()/isEngagedNow().
  const state: VisibilityState = typeof document === 'undefined'
    || (document.visibilityState !== 'hidden'
        && (isMobileRuntime() || document.hasFocus()))
      ? 'visible' : 'hidden';
  // Only fire when actually changing chat/state — backbone re-renders
  // (resume() called twice for the same chat) shouldn't burn an HTTP.
  reportVisibility(state, id);
  syncHeartbeat();
}
