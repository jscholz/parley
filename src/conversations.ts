/**
 * @fileoverview chat_id-keyed conversation registry, IndexedDB-backed.
 *
 * Owns the canonical PWA-side list of conversations for backends that
 * use chat_ids as their session-routing primitive (hermes-gateway and
 * future peers). Each sidebar row IS one record here; "new chat" mints
 * a fresh UUID locally — the proxy never learns a chat_id exists until
 * the user sends the first message under it.
 *
 * Why a separate module from `keyterms.ts` (the IDB sibling): different
 * shape (collection of records vs. one whole-list record), different
 * lifecycle (conversations grow unboundedly + need delete + need an
 * "active" pointer; keyterms is a single replaced blob). Sharing a DB
 * would couple their schema migrations.
 *
 * Schema is intentionally minimal — the gateway side enriches with
 * title / message_count / last_active_at via /api/parley/sessions,
 * so this store only needs the fields that uniquely belong to the
 * PWA: the chat_id (UUID) + a locally-editable title cache + boot-time
 * timestamps used for sorting before the enrichment fetch resolves.
 */

const DB_NAME = 'parley-conversations'; // server-derived cache — renamed w/o migration, rebuilds
const STORE_CONV = 'conversations';
const STORE_META = 'meta';
const META_ACTIVE = 'active_chat_id';
// v2 (2026-05-03): chat_id format unification. v1 stored BARE chat_ids
// (`<uuid>`); the post-prefix-fix server gateway exposes them as
// `${source}:${chat_id}`. The mismatch caused two data-loss regressions
// this week (bare-id ghost shadowing prefixed sibling →
// cleanupAbandonedChat firing DELETE on the real server-owned row, then
// the plugin's bare-id DELETE fallback wiping it). Bumping schema +
// clearing the store on upgrade forces every client to rehydrate from
// the gateway, guaranteeing IDB rows are stored under the SAME prefixed
// keys the server uses. The server is authoritative for chat metadata;
// the local store is a cache + lazy-create staging area.
const DB_VERSION = 2;

export interface Conversation {
  /** Prefixed chat_id (`${source}:${native_id}`) — the SAME contract-
   *  unique gateway id the server uses. Parley is the only platform
   *  that mints client-side; `mintChatId()` produces `sidekick:<uuid>`.
   *  Cross-device chats hydrated from /api/parley/sessions arrive
   *  already-prefixed (any source). v2 schema invariant: never store
   *  a bare uuid here. */
  chat_id: string;
  /** Display label. Falls back to "New chat" until enrichment lands or
   *  the user renames. */
  title: string;
  /** Unix epoch ms — set on create, never updated. */
  created_at: number;
  /** Unix epoch ms of the most recent send/receive on this chat_id.
   *  Used for drawer sort order before /api/parley/sessions lands. */
  last_message_at: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CONV)) {
        db.createObjectStore(STORE_CONV, { keyPath: 'chat_id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        // Single-record-per-key store. `id` is e.g. 'active_chat_id',
        // `value` is whatever JSON-serializable scalar we want to keep.
        db.createObjectStore(STORE_META, { keyPath: 'id' });
      }
      // v1 → v2: clear bare-chat_id rows (incompatible with the new
      // prefixed-id contract). Future loads rehydrate from the server's
      // /api/parley/sessions response — the gateway returns prefixed
      // ids natively, so the listSessions merge will repopulate IDB
      // for any chat the user touches. Active pointer cleared too →
      // boot picks the most-recent server row instead of dangling at
      // a now-orphaned bare id. WHY this is safe: the server is
      // authoritative for chat metadata; the local store is a cache.
      if (event.oldVersion < 2) {
        const tx = req.transaction;
        if (tx) {
          tx.objectStore(STORE_CONV).clear();
          tx.objectStore(STORE_META).clear();
        }
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

/** Mint a fresh prefixed chat_id. Parley is the only platform that
 *  client-mints; we stamp `sidekick:` so the id matches the gateway's
 *  prefix-encoded contract from the moment it exists. Lets the adapter
 *  lazy-allocate without writing the IDB conversation row (Option B —
 *  drawer never shows empty stubs).
 *
 *  v0.383 unification (2026-05-03): pre-fix this returned a bare uuid,
 *  which mismatched the prefixed id the gateway exposed for the same
 *  chat once the user sent. The bare/prefixed mismatch is the root
 *  cause of the data-loss regression chain — see DB_VERSION comment. */
export function mintChatId(): string {
  return `sidekick:${uuid()}`;
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: Math.random-based v4 — NOT cryptographically secure, but
  // a chat_id only needs to be process-locally unique. We never expose
  // it externally beyond the proxy.
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;  // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80;  // variant
  const b = Array.from(bytes, hex);
  return `${b.slice(0, 4).join('')}-${b.slice(4, 6).join('')}-${b.slice(6, 8).join('')}-${b.slice(8, 10).join('')}-${b.slice(10, 16).join('')}`;
}

// ─── Conversation CRUD ──────────────────────────────────────────────────────

/** All known conversations, most-recent-first. Empty array on a fresh
 *  install — caller decides whether to mint a default chat_id eagerly
 *  or wait for the first send. */
export async function list(): Promise<Conversation[]> {
  const db = await openDB();
  try {
    const rows: Conversation[] = await reqP(
      db.transaction(STORE_CONV, 'readonly').objectStore(STORE_CONV).getAll(),
    );
    rows.sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0));
    return rows;
  } finally {
    db.close();
  }
}

/** Mint a prefixed chat_id + persist. Title defaults to "New chat" —
 *  caller can later updateTitle once the gateway sends `session_changed`
 *  with a compression-derived label.
 *
 *  v0.383 unification: chat_id is now `sidekick:<uuid>` (mintChatId),
 *  matching the gateway's prefix-encoded id. IDB and server agree on
 *  the same key shape end-to-end. */
export async function create(title?: string): Promise<Conversation> {
  const now = Date.now();
  const conv: Conversation = {
    chat_id: mintChatId(),
    title: title || 'New chat',
    created_at: now,
    last_message_at: now,
  };
  const db = await openDB();
  try {
    await reqP(db.transaction(STORE_CONV, 'readwrite').objectStore(STORE_CONV).put(conv));
  } finally {
    db.close();
  }
  return conv;
}

/** Insert a row for a chat_id we learned about externally (e.g. cross-
 *  device sync via server's listSessions). No-op if the row already
 *  exists — this is for filling gaps, not for overwriting local state. */
export async function hydrate(chat_id: string, title?: string): Promise<Conversation> {
  const existing = await get(chat_id);
  if (existing) return existing;
  const now = Date.now();
  const conv: Conversation = {
    chat_id,
    title: title || 'New chat',
    created_at: now,
    last_message_at: now,
  };
  const db = await openDB();
  try {
    await reqP(db.transaction(STORE_CONV, 'readwrite').objectStore(STORE_CONV).put(conv));
  } finally {
    db.close();
  }
  return conv;
}

export async function get(chat_id: string): Promise<Conversation | null> {
  const db = await openDB();
  try {
    const rec: any = await reqP(
      db.transaction(STORE_CONV, 'readonly').objectStore(STORE_CONV).get(chat_id),
    );
    return rec || null;
  } finally {
    db.close();
  }
}

/** Bump last_message_at without touching the rest of the row. Idempotent
 *  no-op when the chat_id is unknown — defensive against backends that
 *  emit envelopes for chat_ids the PWA doesn't have a record for
 *  (cron-triggered sends from a prior install of the app, etc.). */
export async function updateLastMessageAt(chat_id: string, ts: number): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_CONV, 'readwrite');
    const store = tx.objectStore(STORE_CONV);
    const existing: any = await reqP(store.get(chat_id));
    if (!existing) return;
    existing.last_message_at = ts;
    await reqP(store.put(existing));
  } finally {
    db.close();
  }
}

/** Patch the title ONLY when it's still the 'New chat' placeholder
 *  (or empty) AND no userTitle has been set. Used by the send flow to
 *  surface the user's first-message text in the drawer for in-flight
 *  new chats — server-side state.db is empty until hermes' post-turn
 *  append_to_transcript fires, so the drawer's listSessions merge
 *  for a brand-new chat falls back to local IDB; without this, a
 *  20-second tool-using turn would show 'New chat' the whole time.
 *  Idempotent: a row that already has a real title (hermes-generated
 *  or user-renamed) is left alone. */
export async function stampPlaceholderTitle(chat_id: string, title: string): Promise<void> {
  if (!title) return;
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_CONV, 'readwrite');
    const store = tx.objectStore(STORE_CONV);
    const existing: any = await reqP(store.get(chat_id));
    if (!existing) return;
    if (existing.userTitle) return;
    if (existing.title && existing.title !== 'New chat') return;
    existing.title = title;
    await reqP(store.put(existing));
  } finally {
    db.close();
  }
}

/** Same shape as updateLastMessageAt. Used when `session_changed`
 *  arrives with a new title (e.g. compression auto-numbered "My
 *  project" → "My project #2"). */
export async function updateTitle(chat_id: string, title: string): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_CONV, 'readwrite');
    const store = tx.objectStore(STORE_CONV);
    const existing: any = await reqP(store.get(chat_id));
    if (!existing) return;
    existing.title = title;
    await reqP(store.put(existing));
  } finally {
    db.close();
  }
}

/** Same shape but also stamps `userTitle` so the drawer-list merge
 *  prefers it over server-side auto-generated titles. The user
 *  explicitly renamed; stop letting hermes' compression renumber etc.
 *  shadow that. Cleared only by deleting the row. */
export async function setUserTitle(chat_id: string, title: string): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_CONV, 'readwrite');
    const store = tx.objectStore(STORE_CONV);
    const existing: any = await reqP(store.get(chat_id));
    if (!existing) return;
    existing.title = title;
    existing.userTitle = title;
    await reqP(store.put(existing));
  } finally {
    db.close();
  }
}

/** Removes the row. Caller is responsible for any active-pointer
 *  cleanup (call setActive(null) if this was the active chat_id). */
export async function remove(chat_id: string): Promise<void> {
  const db = await openDB();
  try {
    await reqP(db.transaction(STORE_CONV, 'readwrite').objectStore(STORE_CONV).delete(chat_id));
  } finally {
    db.close();
  }
}

// ─── Active-chat pointer ────────────────────────────────────────────────────

/** The chat_id currently shown in the chat pane / used by the next
 *  outgoing message. null on a fresh install or after the user deletes
 *  the active row without picking another. */
export async function getActive(): Promise<string | null> {
  const db = await openDB();
  try {
    const rec: any = await reqP(
      db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(META_ACTIVE),
    );
    return rec?.value || null;
  } finally {
    db.close();
  }
}

/** Pass null to clear the pointer. We don't validate the chat_id
 *  exists in STORE_CONV — race-y to do so under concurrent writes,
 *  and a dangling pointer is harmless (callers should still resolve
 *  the row via get() and handle the null case). */
export async function setActive(chat_id: string | null): Promise<void> {
  const db = await openDB();
  try {
    const store = db.transaction(STORE_META, 'readwrite').objectStore(STORE_META);
    if (chat_id) {
      await reqP(store.put({ id: META_ACTIVE, value: chat_id }));
    } else {
      await reqP(store.delete(META_ACTIVE));
    }
  } finally {
    db.close();
  }
}

/** Convenience: read the active chat_id; if none is set, mint a new
 *  conversation, set it active, and return it. Used by send paths
 *  that need to lazily-allocate a chat_id on first message. */
export async function getOrCreateActive(): Promise<Conversation> {
  const id = await getActive();
  if (id) {
    const existing = await get(id);
    if (existing) return existing;
    // Pointer dangles (row was deleted out-of-band) — fall through to
    // mint a fresh conversation and re-anchor the pointer.
  }
  const conv = await create();
  await setActive(conv.chat_id);
  return conv;
}
