// Transcript snapshot persistence — IDB facade for chat.ts. Extracted
// 2026-05-11 for the Phase 1 / pre-notifications refactor.
//
// Pure storage layer. No DOM access, no chat-state state. chat.ts
// owns the in-memory `viewedSessionIdRef` + `restoredViewedSessionId`
// and passes the session id into saveSnapshot() when persisting.
//
// Why split from chat.ts: the file was approaching 700 LOC with two
// orthogonal responsibilities — DOM rendering (line bubbles, speaker
// labels, copy buttons, scroll pinning) vs IDB snapshot serialization.
// Lifting the storage half keeps each file focused and lets the
// schema-fingerprint smoke (idb-schema-fingerprint.mjs) cover this
// module without dragging in the DOM half.
//
// Why IndexedDB rather than sessionStorage:
//   (a) sessionStorage caps at ~5MB on Safari — base64 attachments
//       push a busy chat over the limit and persist() silently
//       rolls back to the stale snapshot.
//   (b) sessionStorage vanishes when iOS evicts the PWA.
//   (c) sessionStorage doesn't survive a hard app-kill.
// IDB has GB-scale quota, survives tab close, and keeps the
// "reload always restores everything" invariant the user expects.

import { diag } from './util/log.ts';

const DB_NAME = 'parley-chat'; // server-derived cache — renamed w/o migration, rebuilds
const STORE = 'transcripts';
const SNAPSHOT_KEY = 'current';

// Schema fingerprint. Bump SCHEMA_VERSION any time the on-disk format of
// snapshots, bubble dedup keys, or the dom-shape persisted via persist()
// would diverge between an older PWA bundle's writes and the current
// reader. On boot, a mismatch between the stored fingerprint and this
// constant triggers a one-shot IDB delete + reload-from-server. NO
// migration path — fresh state is correct. Clients on the old version
// get a single blank-transcript first paint (~200ms) then full server-
// driven rebuild.
//
// History:
//   2026-05-11 — parley_id-keyed dedup + state.db-driven control envelopes.
//   2026-05-25 — virt-aware snapshot: persist transcriptStore state
//                (`durable`, `pagination`, `sessionId`) instead of serialized
//                DOM HTML. Under virt the DOM contains only the visible
//                window (~30 bubbles + spacers), so an HTML snapshot would
//                freeze a partial view that's wrong on reload. Persisting
//                the store state lets cold-load restore via the projection
//                + reconciler pipeline — same path as a normal resume,
//                rendered through the virtualizer.
//   2026-06-12 — tail invariant (#214): persist() now refuses to snapshot
//                a floating deep-jump window (hasMoreNewer=true). Bump
//                wipes any windowed snapshot already on disk — boot would
//                innerHTML-restore the mid-session slice, then the resume
//                upsert would graft the tail onto it with a silently
//                missing middle. No shape change; the bump is the purge.
const SCHEMA_VERSION = '2026-06-12-tail-anchored-snapshot';
const SCHEMA_VERSION_KEY = 'parley.idb-schema-version'; // fresh with the renamed cache DB

/** Snapshot record persisted to IDB.
 *
 *  Two shapes coexist for backwards compatibility:
 *    - `state` (preferred, virt-aware): the transcriptStore's durable +
 *      pagination for the active chat. Cold-load injects it into the
 *      store and the projection renders via the normal pipeline.
 *    - `html` (legacy, default-path): serialized transcript DOM. Used
 *      when the virtualizer is off; cold-load does `innerHTML = html`.
 *  Readers may see either. `sessionId` identifies the active chat. */
export interface SnapshotRecord {
  /** Legacy default-path: serialized DOM. Absent under virt. */
  html?: string;
  /** Virt-path: store state for projection-driven cold-load. */
  state?: {
    durable: any[];
    pagination: { firstId: number | null; hasMore: boolean };
  };
  sessionId?: string;
}

/** Detect a stale-schema IDB and nuke it. Runs once per page load,
 *  BEFORE the first dbOpen(). LocalStorage holds the last-known-good
 *  fingerprint; mismatch → indexedDB.deleteDatabase + write the new
 *  fingerprint. On the next dbOpen the fresh database is created
 *  cleanly. The reader path stays simple — no onupgradeneeded
 *  branches, no version-juggling logic to maintain.
 *
 *  Why localStorage for the fingerprint: synchronous read at boot
 *  means we can decide whether to nuke BEFORE any open(), avoiding
 *  the race where an in-flight tx blocks the delete. Browsers that
 *  evict localStorage (rare; Safari's 7-day inactivity case) will
 *  read undefined → trigger one extra nuke. Acceptable. */
export async function ensureSchemaFresh(): Promise<void> {
  let stored: string | null = null;
  try { stored = localStorage.getItem(SCHEMA_VERSION_KEY); } catch { /* private mode */ }
  if (stored === SCHEMA_VERSION) return;
  diag(`[chat] IDB schema ${stored ?? '(none)'} → ${SCHEMA_VERSION}: wiping cached transcript`);
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();        // best-effort; ignore failures
    req.onblocked = () => resolve();      // some other tab holds it open
  });
  try { localStorage.setItem(SCHEMA_VERSION_KEY, SCHEMA_VERSION); } catch { /* private mode */ }
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

/** Read the current snapshot from IDB. Returns null on any error or
 *  missing record — callers fall through to a fresh server-driven
 *  rebuild. */
export async function loadSnapshot(): Promise<SnapshotRecord | null> {
  try {
    const db = await dbOpen();
    const rec = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(SNAPSHOT_KEY));
    db.close();
    if (!rec) return null;
    if (rec.state && Array.isArray(rec.state.durable)) {
      return { state: rec.state, sessionId: rec.sessionId };
    }
    if (rec.html) return { html: rec.html, sessionId: rec.sessionId };
  } catch {}
  return null;
}

/** Persist a fresh snapshot. Idempotent overwrite — the IDB store
 *  has a fixed-key schema (`current`) so there's only ever one
 *  record. Caller passes the session id explicitly; this module
 *  doesn't track which chat is on screen. Throws are NOT caught here;
 *  the caller (chat.persist) attaches a .catch to log + swallow. */
export async function saveSnapshot(
  payload: { html: string } | { state: { durable: any[]; pagination: { firstId: number | null; hasMore: boolean } } },
  sessionId: string | null,
): Promise<void> {
  try {
    const db = await dbOpen();
    const row: any = {
      key: SNAPSHOT_KEY,
      sessionId: sessionId ?? undefined,
      at: Date.now(),
    };
    if ('html' in payload) row.html = payload.html;
    else row.state = payload.state;
    await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).put(row));
    db.close();
  } catch {}
}

/** Delete the snapshot (used by chat.clear during a New chat
 *  rotation). Best-effort; failures are swallowed. */
export async function clearSnapshot(): Promise<void> {
  try {
    const db = await dbOpen();
    await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(SNAPSHOT_KEY));
    db.close();
  } catch {}
}
