// Per-chat mute store — flat JSON-backed list of chat_ids whose push
// notifications the user has explicitly silenced.
//
// Mirrors the storage.ts shape (atomic tempfile+rename writes,
// in-process cache primed at init) but is intentionally separate:
// subscriptions and mutes have independent lifecycles. A user can
// rotate devices (= drop a subscription + add a new one) without
// affecting their mute preferences, and conversely can mute/unmute
// chats without touching subscription state.
//
// Storage: `<dataDir>/push-mutes.json` (same dataDir as
// push-subscriptions.json — host-scoped, not in cwd).
//
// Scope (v1, 2026-05-12): GLOBAL across all subscriptions. Muting a
// chat suppresses pushes to every device. Trade-off: phone mute also
// silences Mac. Acceptable for single-user/few-device setups.
//
// Future evolution (NOT this commit):
//   v2 — per-(subscription, chat_id) keying so a phone mute leaves
//        the Mac alone. Same JSON file, wider key.
//   v3 — bridge to hermes config.yaml `parley.push.muted_chats:`
//        for cross-host sync (matches whatsapp.group_muted pattern).
//
// Both upgrades are storage-schema changes only; the gate API
// (isMuted(chatId)) stays the same.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

let storePath: string = '';
let cache: Set<string> | null = null;

/** Resolve the storage file path + prime the cache from disk. Called
 *  from notifications/init() after the dataDir is known. */
export async function initMutes(opts: { dataDir: string }): Promise<void> {
  storePath = path.join(opts.dataDir, 'push-mutes.json');
  // dataDir was already created by initStorage; no re-mkdir needed.
  try {
    const buf = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(buf);
    const arr = Array.isArray(parsed?.muted_chats) ? parsed.muted_chats : [];
    cache = new Set(arr.filter((x: any): x is string => typeof x === 'string'));
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      cache = new Set();
    } else {
      console.warn('[notifications] mute store read failed:', e.message);
      cache = new Set();
    }
  }
}

async function persist(): Promise<void> {
  if (!storePath) throw new Error('[notifications] mute store not initialized');
  const payload = { muted_chats: cache ? Array.from(cache).sort() : [] };
  // Random suffix — see storage.ts persist() for the same fix:
  // two concurrent calls in the same ms collide on tmp filename.
  const rand = Math.random().toString(36).slice(2, 8);
  const tmp = `${storePath}.tmp-${process.pid}-${Date.now()}-${rand}`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmp, storePath);
}

/** O(1) gate check. Used by maybeDispatchPush in stream.ts. */
export function isMuted(chatId: string): boolean {
  if (!cache || !chatId) return false;
  return cache.has(chatId);
}

/** Toggle a chat's mute state. Returns the new state. Idempotent on
 *  both directions (muting an already-muted chat is a no-op write-side
 *  but still returns `muted:true`). */
export async function setMuted(chatId: string, muted: boolean): Promise<{
  muted: boolean;
  total: number;
}> {
  if (!cache) throw new Error('[notifications] mute store not initialized');
  if (!chatId) throw new Error('chat_id required');
  const wasMuted = cache.has(chatId);
  if (muted && !wasMuted) {
    cache.add(chatId);
    await persist();
  } else if (!muted && wasMuted) {
    cache.delete(chatId);
    await persist();
  }
  return { muted, total: cache.size };
}

/** Snapshot of every currently-muted chat_id. Returns a fresh copy. */
export function listMutedChats(): string[] {
  if (!cache) return [];
  return Array.from(cache).sort();
}

/** Test-only seam: reset the in-process cache + storePath. Mirrors
 *  storage.ts's pattern. */
export function __resetMutesForTest(): void {
  cache = null;
  storePath = '';
}
