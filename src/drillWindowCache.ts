// Keyed deep-jump window cache (#214 TFC-C) — IDB store for the bounded
// `around` windows fetched by pin-drawer / cmdk drills.
//
// The boot snapshot (chatSnapshot.ts) is tail-anchored BY INVARIANT — it
// must never contain a floating mid-session window (TFC-A). But drill
// windows are expensive on a slow link (the ?around= round trip is the
// bulk of a deep jump's wait), and users revisit the same pinned
// messages repeatedly. So floating windows get their OWN keyed store:
// one record per (chatId, anchorMsgId), rendered ONLY on an explicit
// drill to that exact anchor — never at boot — which is what makes
// caching windowed state safe here.
//
// Eviction: LRU capped at MAX_WINDOWS. Records whose anchor is a
// currently-pinned message are protected — pins are the user's "I'll
// come back to this" signal, so their windows must not churn out under
// search-drill pressure.

import { diag } from './util/log.ts';
import { isPinned } from './pins/store.ts';

const DB_NAME = 'parley-windows'; // server-derived cache — renamed w/o migration, rebuilds
const STORE = 'windows';
const MAX_WINDOWS = 30;

const SCHEMA_VERSION = '2026-06-12-keyed-drill-windows';
const SCHEMA_VERSION_KEY = 'parley.windows-schema-version'; // fresh with the renamed DB

export interface WindowPagination {
  firstId: number | null;
  hasMore: boolean;
  lastId: number | null;
  hasMoreNewer: boolean;
}

export interface WindowRecord {
  key: string;
  chatId: string;
  anchorMsgId: string;
  messages: any[];
  pagination: WindowPagination;
  at: number;
}

const keyFor = (chatId: string, anchorMsgId: string) => `${chatId}::${anchorMsgId}`;

/** Same boot-time nuke pattern as chatSnapshot.ensureSchemaFresh, but
 *  lazy (memoized before the first open) so no boot wiring is needed. */
let schemaReady: Promise<void> | null = null;
function ensureSchemaFresh(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(SCHEMA_VERSION_KEY); } catch { /* private mode */ }
    if (stored === SCHEMA_VERSION) return;
    diag(`[windows] IDB schema ${stored ?? '(none)'} → ${SCHEMA_VERSION}: wiping drill-window cache`);
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    try { localStorage.setItem(SCHEMA_VERSION_KEY, SCHEMA_VERSION); } catch { /* private mode */ }
  })();
  return schemaReady;
}

function dbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqP<T = any>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Cached window for an anchor, or null. Touches the record's `at` so a
 *  re-drilled anchor counts as recently used for eviction. */
export async function getWindow(chatId: string, anchorMsgId: string): Promise<WindowRecord | null> {
  try {
    await ensureSchemaFresh();
    const db = await dbOpen();
    const store = () => db.transaction(STORE, 'readwrite').objectStore(STORE);
    const rec = await reqP(store().get(keyFor(chatId, anchorMsgId)));
    if (rec && Array.isArray(rec.messages) && rec.messages.length > 0 && rec.pagination) {
      rec.at = Date.now();
      await reqP(store().put(rec));
      db.close();
      return rec as WindowRecord;
    }
    db.close();
  } catch {}
  return null;
}

/** Store (or refresh) the window for an anchor, then trim LRU. */
export async function putWindow(
  chatId: string,
  anchorMsgId: string,
  messages: any[],
  pagination: WindowPagination,
): Promise<void> {
  if (!Array.isArray(messages) || messages.length === 0) return;
  try {
    await ensureSchemaFresh();
    const db = await dbOpen();
    const store = () => db.transaction(STORE, 'readwrite').objectStore(STORE);
    const rec: WindowRecord = {
      key: keyFor(chatId, anchorMsgId),
      chatId, anchorMsgId, messages, pagination,
      at: Date.now(),
    };
    await reqP(store().put(rec));
    const all: WindowRecord[] = await reqP(store().getAll());
    if (all.length > MAX_WINDOWS) {
      // Oldest-first among the evictable (anchor not currently pinned).
      const evictable = all
        .filter((r) => !isPinned(r.chatId, r.anchorMsgId))
        .sort((a, b) => (a.at || 0) - (b.at || 0));
      let excess = all.length - MAX_WINDOWS;
      for (const victim of evictable) {
        if (excess <= 0) break;
        if (victim.key === rec.key) continue;
        await reqP(store().delete(victim.key));
        excess--;
      }
    }
    db.close();
  } catch {}
}

/** Test/diagnostic helper: number of cached windows. */
export async function countWindows(): Promise<number> {
  try {
    await ensureSchemaFresh();
    const db = await dbOpen();
    const n = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).count());
    db.close();
    return n;
  } catch { return 0; }
}
