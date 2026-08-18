// Pinned-sessions store — an ordered list of session ids the user has
// pinned to the top of the session drawer.
//
// Persistence: rides the synced `pinnedSessions` setting (see
// src/settings.ts DEFAULTS + proxy/parley/frontend-config.ts). That
// setting is a STRING because the prefs store is scalar-only; this
// module owns the JSON encode/decode. Because prefs is already
// parley.db-backed + cross-device, pins sync across devices for free —
// no dedicated server table (unlike message-pins in src/pins/store.ts,
// which needed one only because IDB couldn't sync).
//
// Order IS meaning: index 0 is the top of the pinned region and the
// cold-open landing default when there's no deep-link target (see
// main.ts landing chain). The user controls landing purely by
// drag-reordering pins — there's no separate "default session" state.
//
// In-memory `order` array is the sync source of truth for renders
// (sessionDrawer's per-row isPinned() check can't await). Mutations
// write through to settings.set() (PUT /api/parley/prefs) and emit a
// `parley:session-pins-changed` event so the drawer repaints.

import * as settings from './settings.ts';
import { log } from './util/log.ts';

const CHANGE_EVENT = 'parley:session-pins-changed';

// Ordered, deduped session ids. index 0 = top = landing default.
let order: string[] = [];

function emitChange(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    }
  } catch { /* non-DOM host (test runner) */ }
}

/** Parse the JSON-string setting into a clean string[]. Tolerates the
 *  empty-string default, malformed JSON, and non-array/non-string
 *  entries — anything unexpected yields []. Dedupes while preserving
 *  first-seen order. */
function parse(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    log(`[sessionPins] ignoring malformed pinnedSessions: ${raw}`);
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== 'string' || v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Serialize + persist the in-memory order to the synced setting, then
 *  notify listeners. Empty list persists as '' (the default) rather than
 *  '[]' so a never-pinned + then-unpinned-to-empty state reads cleanly. */
function persist(): void {
  settings.set('pinnedSessions' as any, order.length ? JSON.stringify(order) : '');
  emitChange();
}

/** Load the in-memory order from settings. Call after settings.load()
 *  has hydrated the synced snapshot on boot. Idempotent — safe to call
 *  again after a settings refresh. Does NOT emit a change event (boot
 *  hydration isn't a user mutation); callers render off the fresh state
 *  directly. */
export function hydrate(): void {
  order = parse(settings.get().pinnedSessions);
}

/** The pinned session ids in landing order (index 0 = top). Returns a
 *  copy so callers can't mutate the store's array in place. */
export function listPinned(): string[] {
  return order.slice();
}

export function isPinned(id: string): boolean {
  return order.includes(id);
}

/** The landing default — the top pinned session, or undefined if none.
 *  main.ts consults this when there's no deep-link / restored target. */
export function topPinned(): string | undefined {
  return order[0];
}

/** Pin a session. New pins land at the BOTTOM of the pinned region so
 *  existing pins keep their placement — index 0 (the landing default)
 *  stays whatever the user put on top; drag-reorder promotes. No-op
 *  (and no event) if already pinned. */
export function pin(id: string): void {
  if (!id || order.includes(id)) return;
  order.push(id);
  persist();
}

/** Unpin a session. No-op if not pinned. */
export function unpin(id: string): void {
  const i = order.indexOf(id);
  if (i === -1) return;
  order.splice(i, 1);
  persist();
}

export function toggle(id: string): void {
  if (isPinned(id)) unpin(id);
  else pin(id);
}

/** Replace the order wholesale — the drag-reorder commit path. The
 *  incoming list is filtered to the currently-pinned set (ignoring
 *  unknown ids) and deduped, so a stale drag payload can't smuggle in or
 *  drop pins. No-op (no event) if the resulting order is unchanged. */
export function setOrder(ids: string[]): void {
  const pinned = new Set(order);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (!pinned.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  // Any currently-pinned id missing from the payload is appended in its
  // existing relative order — a defensive guard so a partial payload
  // never silently drops a pin.
  for (const id of order) {
    if (!seen.has(id)) next.push(id);
  }
  if (next.length === order.length && next.every((v, i) => v === order[i])) return;
  order = next;
  persist();
}
