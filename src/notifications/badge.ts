// App-icon badge + per-chat unread state, server-driven.
//
// SSOT for sidebar badges + app badge + push dispatch is the backend
// plugin's `unread_state` table (see project_hermes_sidekick_parity.md).
// This module is a read-through cache + thin client over those routes:
//   GET  /api/sidekick/notifications/unread     → snapshot
//   POST /api/sidekick/notifications/seen       ← {chat_id}
//   POST /api/sidekick/notifications/mark       ← {chat_id, marked}
//
// Cross-device sync rides the `unread_changed` envelope that
// backendEvents observes on /api/sidekick/stream — when it arrives,
// the listener calls `requestRefresh()` to pull the new state.
//
// Why server-driven: the old IDB-side counter drifted when push
// arrivals + chat focus + the SW's setAppBadge fired on different
// code paths (e.g. badge showed 7 after clicking all chats). With
// one fact-of-record on the server, the three surfaces (sidebar, app
// badge, push eligibility) derive structurally and can't disagree.

import { log } from '../util/log.ts';
import { apiUrl } from '../apiBase.ts';
import * as activityStore from './activityStore.ts';

// Read-through cache. The Map values are the per-chat unread counts
// the server returned at the last refresh. NEVER mutate these
// locally on push arrival — server has the truth, we just re-fetch.
const unreadByChat = new Map<string, number>();
const markedUnread = new Set<string>();
let refreshDebounce: number | null = null;
let hydrated = false;

/** Every chat with any unread state (count > 0 or sticky mark). */
function unreadChatIds(): Set<string> {
  const ids = new Set<string>(markedUnread);
  for (const [id, n] of unreadByChat) if (n > 0) ids.add(id);
  return ids;
}

/** Sum of unread across every chat — the app-icon badge number.
 *  DEFINED as Σ unreadFor(id): the OS badge and the sidebar row chips
 *  read the SAME per-chat accessor, so they cannot disagree by
 *  construction (field bug 2026-07-09: the old total counted
 *  marked-unread chats that unreadFor() ignored — two formulas over
 *  one map, permanently divergent surfaces). */
function totalUnread(): number {
  let total = 0;
  for (const id of unreadChatIds()) total += unreadFor(id);
  return total;
}

/** Push the current unread total to the OS via Badging API. */
async function syncBadge(): Promise<void> {
  const total = totalUnread();
  try {
    if (total > 0) {
      if (typeof navigator.setAppBadge === 'function') await navigator.setAppBadge(total);
    } else {
      if (typeof navigator.clearAppBadge === 'function') await navigator.clearAppBadge();
      await closeAllSwNotifications();
    }
  } catch { /* unsupported / not installed */ }
}

async function closeAllSwNotifications(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const ns = await reg.getNotifications();
    for (const n of ns) { try { n.close(); } catch { /* tab vanished */ } }
    if (ns.length > 0) log(`[badge] closed ${ns.length} SW notification(s)`);
  } catch { /* defensive */ }
}

/** Fetch the canonical state from the plugin's `/v1/unread` via the
 *  proxy and update the cache + badge. Idempotent. Failure swallowed
 *  (badges are decorative).
 *
 *  syncBadge() ALWAYS runs (cheap OS API call) — it reconciles the
 *  app icon badge against the server's truth. Without this, a stale
 *  OS badge from a SW push (set while the PWA was closed) survives
 *  the next foreground refresh: if the fetched list matches the live
 *  empty cache, the diff returns no-change and the previously-stuck
 *  OS badge from the SW push never gets cleared.
 *
 *  notifyChange() (which triggers a sidebar repaint over many rows)
 *  remains diff-gated to avoid repaint storms on large session lists. */
async function refreshFromServer(): Promise<void> {
  try {
    const r = await fetch(apiUrl('/api/sidekick/notifications/unread'));
    if (!r.ok) return;
    const data: any = await r.json();
    const nextCounts = new Map<string, number>();
    const nextMarked = new Set<string>();
    for (const c of (data?.chats ?? [])) {
      if (typeof c?.chat_id !== 'string') continue;
      if (typeof c.unread_count === 'number' && c.unread_count > 0) {
        nextCounts.set(c.chat_id, c.unread_count);
      }
      if (c.marked_unread === true) nextMarked.add(c.chat_id);
    }
    const changed = !mapsEqual(unreadByChat, nextCounts) || !setsEqual(markedUnread, nextMarked);
    if (changed) {
      unreadByChat.clear();
      for (const [k, v] of nextCounts) unreadByChat.set(k, v);
      markedUnread.clear();
      for (const k of nextMarked) markedUnread.add(k);
    }
    await syncBadge();
    if (totalUnread() === 0 && activityStore.unreadActivityCount() > 0) activityStore.markAllRead();
    if (changed) notifyChange();
  } catch { /* swallow — best-effort */ }
}

function mapsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/** Debounced refresh. 1.5s window — long enough that a burst of
 *  envelopes (cron-triggered notifications, multi-chat /seen
 *  cascades) coalesces into one fetch. Was 200ms; bumped to avoid
 *  triggering high repaint frequency on large session lists. */
function requestRefresh(): void {
  if (refreshDebounce != null) return;
  refreshDebounce = (globalThis as any).setTimeout(() => {
    refreshDebounce = null;
    void refreshFromServer();
  }, 1500);
}

/** THE per-chat unread accessor — the single formula every surface
 *  renders from (row chips, the OS badge via totalUnread, future
 *  consumers). A sticky marked-unread chat counts as 1 even with no
 *  new messages: "one thing to look at". */
export function unreadFor(chatId: string): number {
  return Math.max(unreadByChat.get(chatId) ?? 0, markedUnread.has(chatId) ? 1 : 0);
}

export function isMarkedUnread(chatId: string): boolean {
  return markedUnread.has(chatId);
}

/** No-op locally. Kept as a stable hook for callers in
 *  backendEvents (off-screen reply_final, push arrival) — they call
 *  this to signal "something changed for this chat"; we trigger a
 *  server refresh and let the canonical count flow back. */
export function incrementUnread(_chatId: string, _delta: number = 1): void {
  requestRefresh();
}

/** User opened the chat — mark it seen on the server. The server
 *  broadcasts unread_changed, which triggers a fresh fetch via
 *  the SSE listener; we also kick a local refresh so the same
 *  device sees the update without waiting for the round-trip. */
export async function clearUnread(chatId: string): Promise<void> {
  if (!chatId) return;
  try {
    await fetch(apiUrl('/api/sidekick/notifications/seen'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    });
  } catch { /* swallow */ }
  void refreshFromServer();
}

export async function markUnread(chatId: string): Promise<void> {
  if (!chatId || markedUnread.has(chatId)) return;
  try {
    await fetch(apiUrl('/api/sidekick/notifications/mark'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, marked: true }),
    });
  } catch { /* swallow */ }
  void refreshFromServer();
  log(`[badge] markUnread chat=${chatId}`);
}

export async function unmarkUnread(chatId: string): Promise<void> {
  if (!chatId) return;
  try {
    await fetch(apiUrl('/api/sidekick/notifications/mark'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, marked: false }),
    });
  } catch { /* swallow */ }
  void refreshFromServer();
  log(`[badge] unmarkUnread chat=${chatId}`);
}

/** Settings → "Mark all read" — clear seen for every known chat.
 *  No batch endpoint yet; fan out one POST per chat. For typical chat
 *  volumes the round-trip cost is fine; promote to a single POST
 *  /v1/unread/seen-all if this becomes a hot path. */
export async function clearAllUnread(): Promise<void> {
  const seenList = Array.from(unreadByChat.keys());
  const markedList = Array.from(markedUnread);
  const all = new Set([...seenList, ...markedList]);
  await Promise.all(Array.from(all).map((chatId) =>
    fetch(apiUrl('/api/sidekick/notifications/seen'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    }).catch(() => {}),
  ));
  await refreshFromServer();
}

/** Boot-time hydrate. Stable name kept for existing call sites; the
 *  body now refreshes from the server instead of loading IDB
 *  (server holds the marked-unread set too). Idempotent.  */
export async function hydrateMarkedUnread(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  await refreshFromServer();
}

export function totalUnreadCount(): number { return totalUnread(); }

// ── Listeners ─────────────────────────────────────────────────────────

function notifyChange() {
  try {
    window.dispatchEvent(new CustomEvent('sidekick:unread-changed'));
  } catch { /* SSR / non-window environments */ }
}

// Server-pushed change notifications fan in here. backendEvents emits
// `sidekick:server-unread-changed` when it sees an `unread_changed`
// envelope on /api/sidekick/stream — re-fetch immediately.
if (typeof window !== 'undefined') {
  window.addEventListener('sidekick:server-unread-changed', () => requestRefresh());
  // Page visibility heartbeat → refresh on foreground. iOS PWA in
  // particular can come back after long backgrounding; pull fresh.
  document?.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestRefresh();
  });
}
