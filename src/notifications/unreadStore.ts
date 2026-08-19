// IDB-backed persistence for the `markedUnread` set in badge.ts.
//
// Why only mark-unread state and not the full unreadByChat counter:
// natural unreads (push arrivals, off-screen reply_finals) are ephemeral
// signals tied to the user's current attention window — losing them on
// reload is fine because the OS app-badge cache + state.db replay
// already cover that flow. Mark-unread is a USER-INVOKED sticky state
// ("I want to come back to this") and must survive reload, otherwise
// the feature evaporates the moment the PWA reloads or the SW updates.
//
// Sibling DB to the cmdk filter store and the chat snapshots, on the
// same isolation principle: a malformed write here can't corrupt
// transcript data.

const DB_NAME = 'parley.unread'; // server-owned mirror — renamed w/o migration, rebuilds (SSOT is the plugin)
const STORE = 'kv';
const MARKED_KEY = 'marked-set';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Read the persisted set of chat ids the user has marked as unread.
 *  Returns an empty array if no record exists or IDB is unavailable.
 *  Defensive — never throws. */
export async function loadMarkedUnread(): Promise<string[]> {
  try {
    const db = await open();
    const v = await reqP<any>(
      db.transaction(STORE, 'readonly').objectStore(STORE).get(MARKED_KEY),
    );
    db.close();
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Atomically write the full marked-unread set. The caller (badge.ts)
 *  owns the in-memory Set; this just snapshots it to disk on every
 *  mutation. Best-effort: a failed write logs nothing and continues —
 *  worst case the user loses their marks on the next reload, which
 *  matches the rest of the unread system's degradation profile. */
export async function saveMarkedUnread(ids: Set<string> | string[]): Promise<void> {
  try {
    const arr = Array.from(ids);
    const db = await open();
    await reqP(
      db.transaction(STORE, 'readwrite').objectStore(STORE).put(arr, MARKED_KEY),
    );
    db.close();
  } catch { /* best-effort */ }
}
