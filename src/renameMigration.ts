/**
 * @fileoverview One-time client-side persisted-state migration for the
 * Sidekick → Parley rename (2026-08).
 *
 * Runs FIRST in boot(), before any module opens its (new-name) stores.
 *
 * localStorage: each renamed key is copied old → new ONLY when the new
 * key is absent. Old keys are left in place (rollback safety); once the
 * new key exists it is never overwritten from the old one again.
 *
 * IndexedDB: user data that isn't server-recoverable (outbox, drafts,
 * voice memos, pending capture segments, the keyterms sync mirror) is
 * copied database-by-database into the new-name DB — full structure
 * clone (stores, keyPaths, autoIncrement, indexes) plus all records.
 * Server-derived caches (sessions, conversations, chat snapshots,
 * drill windows, unread mirror, scroll positions, cmdk filters) are
 * NOT migrated: they rebuild from the server, which is strictly safer
 * (the 2026-07 keyterms incident was a stale client mirror clobbering
 * newer server state).
 *
 * Never-readopt guarantees (per DB):
 *   - a done-flag in localStorage short-circuits every later boot;
 *   - if the new-name DB already exists, the old one is never read;
 *   - a failed half-copy DELETES the new-name DB so a partial store
 *     can never be adopted as truth (retry next boot).
 *
 * Removal condition: delete this module (and its boot() call) once no
 * installed client still carries sidekick-* stores.
 */

const MIGRATION_FLAG_PREFIX = 'parley.idb-migrated.';

/** localStorage keys copied old → new (new absent ⇒ copy). */
export const LS_COPY_KEYS: Array<[string, string]> = [
  ['sidekick_server_url', 'parley_server_url'],
  ['sidekick_config_cache', 'parley_config_cache'],
  ['sidekick.settings.v2', 'parley.settings.v2'],
  ['sidekick.synced.cache.v1', 'parley.synced.cache.v1'],
  ['sidekick.docs.v2', 'parley.docs.v2'],
  ['sidekick.sidebarWidth', 'parley.sidebarWidth'],
  ['sidekick.viewed-session-id', 'parley.viewed-session-id'],
  ['sidekick.ambient.expanded', 'parley.ambient.expanded'],
  ['sidekick.capture.consentHintShown', 'parley.capture.consentHintShown'],
  ['sidekick.sidebar.expanded', 'parley.sidebar.expanded'],
  ['sidekick.sidebarWidth.v3', 'parley.sidebarWidth.v3'],
  ['sidekick_vad_override', 'parley_vad_override'],
];

/** IndexedDB databases copied old → new (user data, not rebuildable). */
export const IDB_COPY_DBS: Array<[string, string]> = [
  ['sidekick-outbox', 'parley-outbox'],
  ['sidekick-drafts', 'parley-drafts'],
  ['sidekick-voice-memos', 'parley-voice-memos'],
  ['sidekick-capture', 'parley-capture'],
  ['sidekick-keyterms', 'parley-keyterms'],
];

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Copy each renamed localStorage key when the new name is absent.
 *  Returns the number of keys copied. Injectable storage for tests. */
export function migrateLocalStorageKeys(storage: StorageLike): number {
  let copied = 0;
  for (const [oldKey, newKey] of LS_COPY_KEYS) {
    try {
      if (storage.getItem(newKey) !== null) continue; // new exists — never re-adopt old
      const val = storage.getItem(oldKey);
      if (val === null) continue;
      storage.setItem(newKey, val);
      copied++;
    } catch { /* private mode / quota — non-fatal */ }
  }
  return copied;
}

interface StoreShape {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: Array<{ name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }>;
}

function openRaw(
  name: string,
  version?: number,
  onUpgrade?: (db: IDBDatabase) => void,
): Promise<{ db: IDBDatabase; created: boolean }> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    let created = false;
    req.onupgradeneeded = (ev) => {
      created = ev.oldVersion === 0;
      if (onUpgrade) onUpgrade(req.result);
    };
    req.onsuccess = () => resolve({ db: req.result, created });
    req.onerror = () => reject(req.error ?? new Error(`open ${name} failed`));
    req.onblocked = () => reject(new Error(`open ${name} blocked`));
  });
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve(); // best-effort
    req.onblocked = () => resolve();
  });
}

function readStructure(db: IDBDatabase): StoreShape[] {
  const names = Array.from(db.objectStoreNames);
  if (names.length === 0) return [];
  const tx = db.transaction(names, 'readonly');
  return names.map((n) => {
    const st = tx.objectStore(n);
    return {
      name: n,
      keyPath: st.keyPath as string | string[] | null,
      autoIncrement: st.autoIncrement,
      indexes: Array.from(st.indexNames).map((ix) => {
        const i = st.index(ix);
        return {
          name: i.name,
          keyPath: i.keyPath as string | string[],
          unique: i.unique,
          multiEntry: i.multiEntry,
        };
      }),
    };
  });
}

function copyStore(oldDb: IDBDatabase, newDb: IDBDatabase, shape: StoreShape): Promise<void> {
  return new Promise((resolve, reject) => {
    const rtx = oldDb.transaction(shape.name, 'readonly');
    const rst = rtx.objectStore(shape.name);
    const valuesReq = rst.getAll();
    const keysReq = rst.getAllKeys();
    rtx.onerror = () => reject(rtx.error ?? new Error(`read ${shape.name} failed`));
    rtx.oncomplete = () => {
      const values = valuesReq.result || [];
      const keys = keysReq.result || [];
      const wtx = newDb.transaction(shape.name, 'readwrite');
      const wst = wtx.objectStore(shape.name);
      for (let i = 0; i < values.length; i++) {
        // Out-of-line keys (no keyPath) must be carried explicitly so
        // autoIncrement ids survive the copy.
        if (shape.keyPath == null) wst.put(values[i], keys[i]);
        else wst.put(values[i]);
      }
      wtx.oncomplete = () => resolve();
      wtx.onerror = () => reject(wtx.error ?? new Error(`write ${shape.name} failed`));
    };
  });
}

/** Copy one database old → new. Returns a status string for logging. */
async function copyDatabase(oldName: string, newName: string): Promise<string> {
  // Probe the new name. If it pre-existed with real stores, never touch
  // it again. An empty version-1 DB can only be a probe artifact from a
  // crashed earlier run (every real store is created in its own v1
  // upgrade), so treat it like our own probe-create and clear it.
  const probeNew = await openRaw(newName);
  const newPreExisted = !probeNew.created
    && !(probeNew.db.version === 1 && probeNew.db.objectStoreNames.length === 0);
  probeNew.db.close();
  if (newPreExisted) return 'new-exists';
  await deleteDb(newName); // remove the empty probe-created DB

  // Probe the old name. If the probe created it, there is nothing to
  // migrate — clean up the accidental empty DB.
  const probeOld = await openRaw(oldName);
  if (probeOld.created) {
    probeOld.db.close();
    await deleteDb(oldName);
    return 'no-old';
  }
  const oldDb = probeOld.db;
  try {
    const structure = readStructure(oldDb);
    const { db: newDb } = await openRaw(newName, oldDb.version, (db) => {
      for (const s of structure) {
        const st = db.createObjectStore(s.name, {
          keyPath: s.keyPath ?? undefined,
          autoIncrement: s.autoIncrement,
        });
        for (const ix of s.indexes) {
          st.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
        }
      }
    });
    try {
      for (const s of structure) await copyStore(oldDb, newDb, s);
    } finally {
      newDb.close();
    }
    return 'copied';
  } catch (e) {
    // A half-written new store must never be adoptable as truth —
    // delete it and retry on the next boot (flag stays unset).
    await deleteDb(newName);
    throw e;
  } finally {
    oldDb.close();
  }
}

/** Migrate all renamed IndexedDB databases (old DBs left in place). */
export async function migrateIndexedDbDatabases(storage: StorageLike): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  for (const [oldName, newName] of IDB_COPY_DBS) {
    const flag = MIGRATION_FLAG_PREFIX + newName;
    try {
      if (storage.getItem(flag) !== null) continue;
    } catch { /* private mode */ }
    try {
      const status = await copyDatabase(oldName, newName);
      try { storage.setItem(flag, status); } catch { /* private mode */ }
      if (status === 'copied') {
        console.info(`[parley] migrated IndexedDB ${oldName} -> ${newName}`);
      }
    } catch (e) {
      console.warn(`[parley] IndexedDB migration ${oldName} -> ${newName} failed (will retry next boot):`, e);
    }
  }
}

/** Entry point — called first thing in boot(). */
export async function runRenameMigrations(): Promise<void> {
  let storage: StorageLike;
  try {
    storage = localStorage;
  } catch {
    return; // no storage — nothing persisted to migrate
  }
  const copied = migrateLocalStorageKeys(storage);
  if (copied > 0) console.info(`[parley] migrated ${copied} localStorage keys`);
  await migrateIndexedDbDatabases(storage);
}
