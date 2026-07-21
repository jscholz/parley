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

// Read-through cache. The Map values are the per-chat unread counts
// the server returned at the last refresh. NEVER mutate these
// locally on push arrival — server has the truth, we just re-fetch.
const unreadByChat = new Map<string, number>();
const markedUnread = new Set<string>();
let refreshDebounce: number | null = null;
let hydrated = false;

/** Injection seam so unit tests can hold GET/POST responses open and
 *  force each stale-snapshot race window deterministically (same seam
 *  shape as util/serverBackedStore.ts's cfg.fetchImpl). null → global
 *  fetch. Never captured into a variable-call (`const f = fetch` is an
 *  Illegal invocation in browsers), always `(fetchImpl ?? fetch)(…)`. */
let fetchImpl: typeof fetch | null = null;

// Stale-snapshot guard, ported from util/serverBackedStore.ts (badge
// state stays on its Map+Set shape rather than migrating onto
// ServerBackedStore: the A4 applyLocal contract needs syncBadge — an OS
// API write — fused into every local flip AND an unconditional
// syncBadge after every applied refresh (the stuck-SW-push-badge
// reconcile above refreshFromServer), while the base store's diff-gated
// notify has no post-refresh hook and models ONE Map<string,T>, not a
// counts-Map + sticky-Set pair). A GET response that raced a local
// mutation is STALE — applying it visibly reverts the optimistic
// chip/badge for a full round trip (measured 2026-07-21; iOS
// foregrounding fires visibilitychange+focus refreshes, so a stale GET
// is nearly always in flight across the user's tap). Three windows,
// same as the base store:
//   - GET issued BEFORE the local flip → mutationEpoch (bumped by
//     applyLocal) differs by response time.
//   - GET still in flight while a seen/mark POST is in flight →
//     pendingWrites > 0 at response time (every POST goes through
//     trackWrite).
//   - GET's snapshot taken before a write applied server-side, but its
//     response arrives AFTER that write already settled →
//     writesSettled changed during the GET's flight.
// Either way refreshFromServer discards the response and reschedules
// (debounced), converging once writes go quiet.
let mutationEpoch = 0;
let pendingWrites = 0;
let writesSettled = 0;

/** Run a seen/mark POST under the pendingWrites counter so a refresh
 *  snapshot that raced it gets discarded (see the guard above). EVERY
 *  server mutation this module makes must go through this. */
async function trackWrite<R>(fn: () => Promise<R>): Promise<R> {
  pendingWrites++;
  try {
    return await fn();
  } finally {
    pendingWrites--;
    writesSettled++;
  }
}

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
  const epochAtFetch = mutationEpoch;
  const settledAtFetch = writesSettled;
  try {
    const r = await (fetchImpl ?? fetch)(apiUrl('/api/sidekick/notifications/unread'));
    if (!r.ok) return;
    const data: any = await r.json();
    if (mutationEpoch !== epochAtFetch || pendingWrites > 0 || writesSettled !== settledAtFetch) {
      // Snapshot raced a local mutation — applying it would revert the
      // optimistic chip/badge. Discard; one debounced trailing refresh
      // reconciles after the writes settle. Local state is untouched so
      // syncBadge/notifyChange are both unnecessary here.
      log(`[badge] refresh discarded: raced a local write (epoch ${epochAtFetch}→${mutationEpoch}, pendingWrites ${pendingWrites}, settled ${settledAtFetch}→${writesSettled})`);
      requestRefresh();
      return;
    }
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
    // (2026-07-20) The auto-markAllRead heuristic that lived here
    // ("totalUnread()===0 → pane must be stale → markAllRead") is gone.
    // The server now keeps pane items consistent with chat unread
    // itself: /v1/unread/seen marks the chat's activity items read
    // (never unresolved approvals), replayed envelopes can't un-read
    // or resurrect items, and items covered by the chat's last_read_at
    // are born read. The heuristic's failure modes were real: it nuked
    // FRESH activity rows during the envelope→state.db flush race, and
    // its markAllRead(all:true) marked blocking unresolved approvals
    // read whenever the badge hit zero.
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

/** LOCAL-FIRST mutation (latency audit A4, 2026-07-13): flip the
 *  in-memory unread state + notify every badge surface NOW; the server
 *  POST settles behind and refreshFromServer reconciles the canonical
 *  truth (including any divergence — the single-accessor architecture
 *  means one notify repaints chips, dock badge, and sort order
 *  together). Before this, both the clear-on-switch AND mark-unread
 *  paths awaited the POST + a full refetch before any repaint — the
 *  chip visibly lagged the interaction (his field addendum). */
function applyLocal(chatId: string, mutate: () => void): void {
  mutationEpoch++;
  mutate();
  void syncBadge();
  notifyChange();
}

/** User opened the chat — clear locally now, mark seen on the server
 *  behind. The server broadcasts unread_changed; refreshFromServer
 *  reconciles this and other devices. */
export async function clearUnread(chatId: string): Promise<void> {
  if (!chatId) return;
  if (unreadFor(chatId) > 0) {
    applyLocal(chatId, () => {
      unreadByChat.delete(chatId);
      markedUnread.delete(chatId);
    });
  }
  try {
    await trackWrite(() => (fetchImpl ?? fetch)(apiUrl('/api/sidekick/notifications/seen'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    }));
  } catch { /* swallow — reconcile heals */ }
  void refreshFromServer();
}

export async function markUnread(chatId: string): Promise<void> {
  if (!chatId || markedUnread.has(chatId)) return;
  applyLocal(chatId, () => { markedUnread.add(chatId); });
  try {
    await trackWrite(() => (fetchImpl ?? fetch)(apiUrl('/api/sidekick/notifications/mark'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, marked: true }),
    }));
  } catch { /* swallow — reconcile heals */ }
  void refreshFromServer();
  log(`[badge] markUnread chat=${chatId}`);
}

export async function unmarkUnread(chatId: string): Promise<void> {
  if (!chatId) return;
  if (markedUnread.has(chatId)) {
    applyLocal(chatId, () => { markedUnread.delete(chatId); });
  }
  try {
    await trackWrite(() => (fetchImpl ?? fetch)(apiUrl('/api/sidekick/notifications/mark'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, marked: false }),
    }));
  } catch { /* swallow — reconcile heals */ }
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
    trackWrite(() => (fetchImpl ?? fetch)(apiUrl('/api/sidekick/notifications/seen'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    })).catch(() => {}),
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
  // NOTE for the stale-snapshot guard: both foreground triggers below
  // funnel through requestRefresh → refreshFromServer, so an iOS
  // foregrounding that fires visibilitychange AND focus while a seen/
  // mark POST is settling rides the same epoch/pendingWrites discard —
  // no separate mechanism.
  // Page visibility heartbeat → refresh on foreground. iOS PWA in
  // particular can come back after long backgrounding; pull fresh.
  document?.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestRefresh();
  });
  // macOS PWA windows can be visible-but-unfocused for hours; refresh
  // on focus so the dock number catches up with reads made elsewhere.
  window.addEventListener('focus', () => requestRefresh());
}

// ── Test seams (node:test, no DOM) ───────────────────────────────────
// Module-singleton state needs explicit reset + fetch injection to unit
// test the refresh/mutation races. Naming follows sessionOps.ts's
// _resetRecentlyDeletedForTests. Never called by product code.

export function _setFetchForTests(f: typeof fetch | null): void {
  fetchImpl = f;
}

/** Direct handle on refreshFromServer so tests can hold a GET open
 *  across a mutation without waiting out the 1500ms debounce. */
export function _refreshForTests(): Promise<void> {
  return refreshFromServer();
}

export function _resetForTests(): void {
  unreadByChat.clear();
  markedUnread.clear();
  hydrated = false;
  fetchImpl = null;
  mutationEpoch = 0;
  pendingWrites = 0;
  writesSettled = 0;
  if (refreshDebounce != null) {
    (globalThis as any).clearTimeout(refreshDebounce);
    refreshDebounce = null;
  }
}

/** Introspection for guard assertions (trailing-refresh scheduled?). */
export function _debugForTests(): { refreshScheduled: boolean } {
  return { refreshScheduled: refreshDebounce != null };
}
