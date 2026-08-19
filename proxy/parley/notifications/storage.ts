// Push subscription store — JSON-file backed.
//
// The data volume here is tiny (a personal parley has 1-5 device
// subscriptions over its lifetime), so a flat JSON file with atomic
// tempfile+rename writes is the right tool. Promote to SQLite only if
// subscription churn ever makes the linear scan a hot path (it won't
// — push dispatch already performs a network round-trip per
// subscription).
//
// Schema:
//   { endpoint: string,             // PushSubscription.endpoint URL
//     keys: { p256dh, auth },       // PushSubscription.toJSON().keys
//     userAgent: string,            // self-reported, for debugging
//     createdAt: string,            // ISO timestamp
//     lastUsedAt: string | null,    // null until first dispatch attempt
//     // optional per-subscription filters surface later in 3b/3c
//   }
//
// Endpoint URLs are the natural primary key — the browser guarantees
// uniqueness per (user-agent, VAPID-public-key) and rotates them on
// subscription renewal. Re-subscribe with the same endpoint overwrites
// the existing row (refresh of keys / userAgent).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string;
  createdAt: string;
  lastUsedAt: string | null;
}

let storePath: string = '';
let cache: PushSubscriptionRecord[] | null = null;

/** Resolve the storage file path + ensure the parent directory exists.
 *  Called once from notifications.init(). The default location lives
 *  beside the proxy module so it's host-scoped (not in cwd, not in
 *  /tmp). */
export async function initStorage(opts: { dataDir: string }): Promise<void> {
  storePath = path.join(opts.dataDir, 'push-subscriptions.json');
  await fs.mkdir(opts.dataDir, { recursive: true });
  // Prime the cache from disk so the first read doesn't pay an fs hit
  // inside a request handler.
  try {
    const buf = await fs.readFile(storePath, 'utf8');
    cache = JSON.parse(buf) as PushSubscriptionRecord[];
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      cache = [];
    } else {
      console.warn('[notifications] subscription store read failed:', e.message);
      cache = [];
    }
  }
}

async function persist(): Promise<void> {
  if (!storePath) throw new Error('[notifications] storage not initialized');
  // Atomic write: tempfile in the same dir, then rename. Avoids torn
  // reads if the proxy is SIGKILLed mid-flush.
  //
  // Random suffix in tmp name — two concurrent persist() calls
  // (e.g. parallel push dispatches both calling markUsed) within
  // the same ms can collide on tmp filename; the second rename then
  // fails ENOENT because the first already moved the shared tmp.
  const rand = Math.random().toString(36).slice(2, 8);
  const tmp = `${storePath}.tmp-${process.pid}-${Date.now()}-${rand}`;
  await fs.writeFile(tmp, JSON.stringify(cache ?? [], null, 2), 'utf8');
  await fs.rename(tmp, storePath);
}

/** Upsert a subscription by endpoint URL. Returns true if a new row
 *  was created, false on update of an existing row. */
export async function upsertSubscription(
  record: Omit<PushSubscriptionRecord, 'createdAt' | 'lastUsedAt'>,
): Promise<{ created: boolean; total: number }> {
  if (!cache) throw new Error('[notifications] storage not initialized');
  const existingIdx = cache.findIndex(r => r.endpoint === record.endpoint);
  if (existingIdx >= 0) {
    // Keep createdAt; refresh keys + userAgent in case the user rotated
    // browsers under the same endpoint (rare, but cheap to handle).
    const prev = cache[existingIdx];
    cache[existingIdx] = { ...prev, keys: record.keys, userAgent: record.userAgent };
    await persist();
    return { created: false, total: cache.length };
  }
  cache.push({
    ...record,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  await persist();
  return { created: true, total: cache.length };
}

/** Remove a subscription by endpoint URL. Returns true if a row was
 *  removed. Idempotent — unsubscribe-without-prior-subscribe is fine. */
export async function removeSubscription(endpoint: string): Promise<boolean> {
  if (!cache) throw new Error('[notifications] storage not initialized');
  const before = cache.length;
  cache = cache.filter(r => r.endpoint !== endpoint);
  if (cache.length !== before) {
    await persist();
    return true;
  }
  return false;
}

/** Snapshot of every stored subscription. Returns a fresh copy so
 *  callers can iterate without worrying about concurrent mutation. */
export function listSubscriptions(): PushSubscriptionRecord[] {
  if (!cache) return [];
  return cache.slice();
}

/** Stamp lastUsedAt on a subscription after a successful dispatch.
 *  Best-effort — failure to persist isn't a dispatch failure. Used by
 *  proxy/parley/notifications/dispatch.ts (Phase 3c). */
export async function markUsed(endpoint: string): Promise<void> {
  if (!cache) return;
  const row = cache.find(r => r.endpoint === endpoint);
  if (!row) return;
  row.lastUsedAt = new Date().toISOString();
  try {
    await persist();
  } catch (e: any) {
    console.warn('[notifications] markUsed persist failed:', e.message);
  }
}
