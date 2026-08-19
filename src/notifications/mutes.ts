// Per-chat mute state — client side.
//
// Mirror of the proxy's mutes.ts cache. Loaded once at boot from
// /api/parley/notifications/mutes, kept in sync on every toggle.
// Used by sessionDrawer.openMenu to label the menu entry ("Mute
// notifications" vs "Unmute notifications") per chat, and by future
// drawer-row decorations (small bell icon, etc).
//
// Single source of truth for mute lives server-side (the proxy's
// dispatch gate consults it before sending push). This module is a
// UX-driven cache + write-through.

import { log } from '../util/log.ts';
import { apiUrl } from '../apiBase.ts';

const muted = new Set<string>();
let loaded = false;
let loadPromise: Promise<void> | null = null;

/** Fetch the current muted set from the proxy. Idempotent — repeat
 *  calls share the in-flight promise. Soft-fails on network error
 *  (returns an empty set + leaves `loaded=true` so we don't retry
 *  forever; user can toggle to recover). */
export function loadMutes(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const r = await fetch(apiUrl('/api/parley/notifications/mutes'));
      if (r.ok) {
        const body = await r.json();
        const arr: string[] = Array.isArray(body?.muted_chats) ? body.muted_chats : [];
        muted.clear();
        for (const id of arr) muted.add(id);
        log(`[mutes] loaded ${muted.size} muted chat(s)`);
      } else if (r.status === 503) {
        // VAPID unconfigured — push isn't usable, mute is irrelevant.
        // Quiet exit, no log spam.
      } else {
        log(`[mutes] load failed: HTTP ${r.status}`);
      }
    } catch (e: any) {
      log(`[mutes] load error: ${e?.message ?? e}`);
    }
    loaded = true;
    loadPromise = null;
  })();
  return loadPromise;
}

/** Synchronous lookup. Reflects last successful load or toggle.
 *  Returns false (not "unknown") when state hasn't been loaded yet —
 *  callers should ensure loadMutes() has resolved before relying on
 *  this for UI decisions. */
export function isMuted(chatId: string): boolean {
  return muted.has(chatId);
}

/** Toggle a chat's mute state. Optimistic update + write-through to
 *  the proxy. On HTTP failure, rolls back the local state and surfaces
 *  the error to the caller for toast/UX handling. */
export async function setMuted(chatId: string, nextMuted: boolean): Promise<void> {
  if (!chatId) throw new Error('chat_id required');
  const wasMuted = muted.has(chatId);
  // Optimistic local update.
  if (nextMuted) muted.add(chatId); else muted.delete(chatId);
  try {
    const r = await fetch(apiUrl('/api/parley/notifications/mute'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, muted: nextMuted }),
    });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    }
    log(`[mutes] ${chatId.slice(-12)} → ${nextMuted ? 'muted' : 'unmuted'}`);
  } catch (e) {
    // Rollback on failure so the cache matches the server.
    if (wasMuted) muted.add(chatId); else muted.delete(chatId);
    throw e;
  }
}
