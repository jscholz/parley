/**
 * Per-user STT keyterm storage. Server-backed (sidekick.db
 * `user_settings`, key `stt_keyterms`) so the list syncs across devices.
 * IndexedDB is kept as a write-through cache so reads still work offline
 * and so existing device-local lists migrate forward automatically.
 *
 * The list seeds itself ONCE on first load by fetching `/api/keyterms`
 * (which the server reads from `default_stt_keyterms.txt`). After that
 * fetch, the seed file is irrelevant — all reads/writes are the synced
 * `user_settings` row, mirrored locally.
 *
 * Schema (IDB mirror): one record, `{ id: 'list', terms: string[] }`
 * plus the sync-state fields documented on KeytermsRecord below
 * (dirty / lastSynced / serverUpdatedAt). No per-term ids; the chip UI
 * mutates the whole list.
 *
 * SYNC SAFETY (2026-07-31 clobber incident): the server read is
 * tri-state (ok / affirmatively-missing / error) — only an affirmative
 * "no row" ever triggers an upload of the local mirror; failures fall
 * back read-only. Writes are compare-and-swap on the row's updated_at
 * with a single 409 merge-retry, and a failed write marks the mirror
 * dirty so the next successful read 3-way merges it back instead of
 * losing it (or clobbering the other device's edit).
 */

import { apiUrl } from './apiBase.ts';

const DB_NAME = 'sidekick-keyterms';
const STORE = 'keyterms';
const DB_VERSION = 1;
const RECORD_ID = 'list';

// Synced settings key on the server (sidekick.db user_settings).
const PREFS_KEY = 'stt_keyterms';
const PREFS_URL = `/api/parley/prefs/${PREFS_KEY}`;

/** Shape of the single IDB record. Sync-state fields (added after the
 *  2026-07-31 cross-device clobber incident):
 *    - dirty       — local terms are NOT known to be on the server
 *                    (a PUT failed silently); a later successful read
 *                    3-way-merges and re-uploads instead of dropping
 *                    the edit or clobbering the server.
 *    - lastSynced  — the last list KNOWN to be on the server; the merge
 *                    base (base−mine = my deletions, mine−base = my adds).
 *    - serverUpdatedAt — the server row's updated_at last seen; sent as
 *                    the compare-and-swap base on PUT. `null` means the
 *                    server affirmatively had NO row; the field ABSENT
 *                    means a legacy record that predates CAS (write
 *                    without a base — old LWW — until the first
 *                    successful sync upgrades it). */
export type KeytermsRecord = {
  id: typeof RECORD_ID;
  terms: string[];
  updatedAt: number;
  dirty?: boolean;
  lastSynced?: string[];
  serverUpdatedAt?: number | null;
};

// ── Test seams (node:test — no IDB, no network) ────────────────────────
// Same pattern as notifications/badge.ts's _setFetchForTests. Never
// called by product code.

type FetchLike = (url: string, opts: RequestInit & { timeoutMs: number }) => Promise<Response>;
let fetchForTests: FetchLike | null = null;
let idbForTests: {
  read(): Promise<KeytermsRecord | null>;
  write(rec: KeytermsRecord): Promise<void>;
} | null = null;

export function _setFetchForTests(f: FetchLike | null): void { fetchForTests = f; }
export function _setIdbForTests(i: typeof idbForTests): void { idbForTests = i; }

async function keytermsFetch(url: string, opts: RequestInit & { timeoutMs: number }): Promise<Response> {
  if (fetchForTests) return fetchForTests(url, opts);
  const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
  return fetchWithTimeout(url, opts);
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
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

/** Parse the seed file format — newline + comma delimited, '#' comments
 *  stripped, dedup case-insensitive. Same shape the server emits and the
 *  chip-UI commit accepts, so editing the seed file by hand or pasting
 *  comma-separated lists into the input both round-trip correctly. */
function parseSeedBody(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const nocomment = line.replace(/#.*$/, '');
    for (const part of nocomment.split(',')) {
      const t = part.trim();
      if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    }
  }
  return out;
}

/** 3-way SET merge for keyterm lists: base = the last list known to be
 *  on the server, mine = the local list, theirs = the server's current
 *  list. Result = (theirs − (base − mine)) ∪ (mine − base):
 *    - a term I deleted (in base, not in mine) stays deleted even if
 *      theirs still has it — merging never resurrects deletions;
 *    - a term I added (in mine, not in base) survives even though
 *      theirs doesn't know it yet;
 *    - a term THEY deleted (in base+mine, not in theirs) stays deleted
 *      — it isn't a local add, so mine−base doesn't re-introduce it.
 *  Order: theirs' order first, then new local adds in mine's order.
 *  Identity is case-insensitive (same as the chip UI's dedup); theirs'
 *  casing wins when both sides hold the same term. */
export function mergeKeytermLists(base: string[], mine: string[], theirs: string[]): string[] {
  const keysOf = (l: string[]) => new Set(l.map((t) => t.toLowerCase()));
  const baseKeys = keysOf(base);
  const mineKeys = keysOf(mine);
  const deletedByMe = new Set([...baseKeys].filter((k) => !mineKeys.has(k)));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of theirs) {
    const k = t.toLowerCase();
    if (deletedByMe.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  for (const t of mine) {
    const k = t.toLowerCase();
    if (baseKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Case-insensitive list equality (order-sensitive — the chip UI
 *  preserves order, so a pure reorder still counts as a change). */
function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t.toLowerCase() === b[i].toLowerCase());
}

// ── IDB mirror (offline cache + legacy device-local store) ────────────

/** Read the full mirror record. null = nothing cached locally. Legacy
 *  records (pre-incident: just {id, terms, updatedAt}) surface with the
 *  sync-state fields absent — writeList treats those as "no CAS base
 *  known" until the first successful sync upgrades them. */
async function idbReadRecord(): Promise<KeytermsRecord | null> {
  if (idbForTests) return idbForTests.read();
  try {
    const db = await openDB();
    const rec: any = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_ID));
    db.close();
    if (!rec || !Array.isArray(rec.terms)) return null;
    return {
      id: RECORD_ID,
      terms: rec.terms.map((v: any) => String(v)),
      updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
      ...(typeof rec.dirty === 'boolean' ? { dirty: rec.dirty } : {}),
      ...(Array.isArray(rec.lastSynced) ? { lastSynced: rec.lastSynced.map((v: any) => String(v)) } : {}),
      ...('serverUpdatedAt' in rec ? { serverUpdatedAt: rec.serverUpdatedAt } : {}),
    };
  } catch {
    return null;
  }
}

/** Read the locally-mirrored list. null = nothing cached locally. */
async function idbRead(): Promise<string[] | null> {
  const rec = await idbReadRecord();
  return rec ? rec.terms : null;
}

/** Persist the full mirror record (best-effort; quota/private-mode
 *  failures are swallowed so the UI never breaks on a cache write). */
async function idbWriteRecord(rec: Omit<KeytermsRecord, 'id' | 'updatedAt'>): Promise<void> {
  const full: KeytermsRecord = {
    id: RECORD_ID,
    updatedAt: Date.now(),
    ...rec,
    terms: rec.terms.slice(),
  };
  if (idbForTests) { await idbForTests.write(full); return; }
  try {
    const db = await openDB();
    await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).put(full));
    db.close();
  } catch (e) {
    console.warn('[keyterms] idb mirror write failed:', e);
  }
}

// ── Server (synced source of truth) ───────────────────────────────────

/** Tri-state read result. `missing` and `error` MUST stay distinct:
 *  collapsing them to one null was the root cause of the 2026-07-31
 *  clobber — a transient failure on flaky cellular looked identical to
 *  "no row yet", so the legacy-adoption path re-uploaded a stale
 *  mirror over newer server state. Only an affirmative `missing`
 *  authorizes a write; `error` is strictly read-only. */
type ServerRead =
  | { state: 'ok'; value: string[]; updatedAt: number | null }
  | { state: 'missing' }
  | { state: 'error' };

/** Write result. `conflict` carries the row's CURRENT state from the
 *  409 body so the caller can 3-way-merge and retry with the new
 *  base. */
type ServerWrite =
  | { state: 'ok'; updatedAt: number | null }
  | { state: 'conflict'; value: string[] | null; updatedAt: number | null }
  | { state: 'error' };

/** GET the synced list. Maps the proxy's single-key shape
 *  `{key, value, missing, updated_at}`. An old proxy that omits the
 *  `missing` flag and answers `value: null` is treated as `error`, not
 *  `missing` — on an ambiguous answer the client must never write. */
async function serverGet(): Promise<ServerRead> {
  try {
    const r = await keytermsFetch(apiUrl(PREFS_URL), { timeoutMs: 5_000 });
    if (!r.ok) return { state: 'error' };
    const body: any = await r.json();
    if (body?.missing === true) return { state: 'missing' };
    if (Array.isArray(body?.value)) {
      return {
        state: 'ok',
        value: body.value.map((v: any) => String(v)),
        updatedAt: typeof body.updated_at === 'number' ? body.updated_at : null,
      };
    }
    return { state: 'error' };
  } catch (e) {
    console.warn('[keyterms] server read failed:', e);
    return { state: 'error' };
  }
}

/** PUT the synced list. `base` is the compare-and-swap token:
 *    - undefined → don't send one (unconditional last-write-wins; the
 *      pre-CAS legacy-mirror case where no base is known)
 *    - null      → "I believe the server has NO row" (first adoption)
 *    - number    → the row's updated_at last seen by this device
 *  A mismatched base comes back as `conflict` with the row's current
 *  {value, updated_at} instead of clobbering it. */
async function serverPut(terms: string[], base?: number | null): Promise<ServerWrite> {
  try {
    const payload: any = { value: terms.slice() };
    if (base !== undefined) payload.base_updated_at = base;
    const r = await keytermsFetch(apiUrl(PREFS_URL), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 5_000,
    });
    if (r.status === 409) {
      const body: any = await r.json().catch(() => null);
      return {
        state: 'conflict',
        value: Array.isArray(body?.value) ? body.value.map((v: any) => String(v)) : null,
        updatedAt: typeof body?.updated_at === 'number' ? body.updated_at : null,
      };
    }
    if (!r.ok) return { state: 'error' };
    const body: any = await r.json().catch(() => null);
    return {
      state: 'ok',
      updatedAt: typeof body?.updated_at === 'number' ? body.updated_at : null,
    };
  } catch (e) {
    console.warn('[keyterms] server write failed:', e);
    return { state: 'error' };
  }
}

// ── Sync core (write path shared by writeList / recovery / adoption) ──

/** PUT `terms` with one 409 merge-retry, persisting the mirror record
 *  to match the outcome:
 *    - success        → clean record (dirty=false, lastSynced=terms,
 *                       serverUpdatedAt=the row's new updated_at)
 *    - conflict       → 3-way merge (base=`mergeBase`, mine=terms,
 *                       theirs=the 409 body) and retry ONCE with the
 *                       returned updated_at as the new base
 *    - error / second conflict → dirty record; `prior` supplies the
 *                       lastSynced/serverUpdatedAt to carry forward
 *                       (a 409 upgrades them to the row state it
 *                       returned — that much IS known to be on the
 *                       server, so the next sync merges against
 *                       reality).
 *  Returns the list that ended up locally (merged on conflict). */
async function putWithMergeRetry(
  terms: string[],
  base: number | null | undefined,
  mergeBase: string[],
  prior: { lastSynced?: string[]; serverUpdatedAt?: number | null },
): Promise<{ terms: string[]; synced: boolean }> {
  let attemptTerms = terms;
  let attemptBase = base;
  for (let attempt = 0; attempt < 2; attempt++) {
    const w = await serverPut(attemptTerms, attemptBase);
    if (w.state === 'ok') {
      await idbWriteRecord({
        terms: attemptTerms, dirty: false,
        lastSynced: attemptTerms, serverUpdatedAt: w.updatedAt,
      });
      return { terms: attemptTerms, synced: true };
    }
    if (w.state === 'error') break;
    // Conflict: another device wrote since our base. Merge and retry.
    const theirs = w.value ?? [];
    prior = { lastSynced: theirs, serverUpdatedAt: w.updatedAt };
    const merged = mergeKeytermLists(mergeBase, attemptTerms, theirs);
    if (sameList(merged, theirs)) {
      // Everything we had is already in the newer row — adopt it.
      await idbWriteRecord({
        terms: theirs, dirty: false,
        lastSynced: theirs, serverUpdatedAt: w.updatedAt,
      });
      return { terms: theirs, synced: true };
    }
    console.log(`[keyterms] write conflict: merged ${attemptTerms.length}+${theirs.length}→${merged.length}, retrying`);
    attemptTerms = merged;
    attemptBase = w.updatedAt;
  }
  // Transient failure or two conflicts in a row: keep the local (or
  // merged) list DIRTY so the next successful read recovers it via the
  // 3-way merge instead of silently diverging this device forever.
  await idbWriteRecord({
    terms: attemptTerms, dirty: true,
    ...(prior.lastSynced !== undefined ? { lastSynced: prior.lastSynced } : {}),
    ...(prior.serverUpdatedAt !== undefined ? { serverUpdatedAt: prior.serverUpdatedAt } : {}),
  });
  return { terms: attemptTerms, synced: false };
}

/** Full read-side sync. Returns the effective list plus which of the
 *  three server states produced it, so loadOrSeed can tell "seed and
 *  persist" (affirmative missing) from "seed render-only" (error). */
async function syncRead(): Promise<{ terms: string[] | null; server: ServerRead['state'] }> {
  const fromServer = await serverGet();
  const local = await idbReadRecord();
  if (fromServer.state === 'ok') {
    if (local?.dirty) {
      // A previous PUT failed silently. Recover: 3-way merge and
      // re-upload, instead of letting the server value overwrite the
      // unsynced local edit (or vice versa).
      const mergeBase = local.lastSynced ?? [];
      const merged = mergeKeytermLists(mergeBase, local.terms, fromServer.value);
      if (sameList(merged, fromServer.value)) {
        // Local edits already landed (or resolved to the server list).
        await idbWriteRecord({
          terms: fromServer.value, dirty: false,
          lastSynced: fromServer.value, serverUpdatedAt: fromServer.updatedAt,
        });
        return { terms: fromServer.value, server: 'ok' };
      }
      console.log(`[keyterms] recovering unsynced local edits: merge ${local.terms.length}∪${fromServer.value.length}→${merged.length}`);
      const r = await putWithMergeRetry(merged, fromServer.updatedAt, mergeBase,
        { lastSynced: fromServer.value, serverUpdatedAt: fromServer.updatedAt });
      return { terms: r.terms, server: 'ok' };
    }
    await idbWriteRecord({
      terms: fromServer.value, dirty: false,
      lastSynced: fromServer.value, serverUpdatedAt: fromServer.updatedAt,
    });
    return { terms: fromServer.value, server: 'ok' };
  }
  if (fromServer.state === 'missing') {
    if (local !== null) {
      // Server AFFIRMATIVELY has no row: adopt the device-local list so
      // it starts syncing. base=null makes the adoption itself CAS-safe
      // — if another device wins the first-write race we 409-merge
      // instead of clobbering it.
      const r = await putWithMergeRetry(local.terms, null, [],
        { lastSynced: [], serverUpdatedAt: null });
      if (r.synced) console.log(`[keyterms] migrated ${local.terms.length} legacy term(s) to server`);
      return { terms: r.terms, server: 'missing' };
    }
    return { terms: null, server: 'missing' };
  }
  // Server unreachable (timeout / 5xx / ambiguous old-proxy shape):
  // READ-ONLY fallback to the mirror. This branch used to be
  // indistinguishable from 'missing', which made the adoption path
  // re-upload a stale mirror over newer server state — the 2026-07-31
  // clobber incident. A transient failure must never mutate the server.
  return { terms: local ? local.terms : null, server: 'error' };
}

// ── Public API (stable across the IDB→server migration) ───────────────

/** Read the saved list. Server is the source of truth; the IDB mirror is
 *  consulted when the server is unreachable (read-only fallback) and to
 *  migrate a legacy device-local list forward when the server
 *  affirmatively has no row. A dirty mirror (silently-failed write) is
 *  3-way merged and re-uploaded. Returns null when this user has never
 *  saved a list anywhere (caller should seed from the server file).
 *  Returns [] when the user has explicitly cleared the list. */
export async function readList(): Promise<string[] | null> {
  return (await syncRead()).terms;
}

/** Persist the given list. Writes the synced server row (compare-and-
 *  swap against the last-seen updated_at, one 409 merge-retry), then
 *  mirrors to IDB so offline reads stay correct. On failure the mirror
 *  is marked dirty and the next successful read re-uploads via the
 *  3-way merge. Returns the list as persisted locally — identical to
 *  the input unless a conflict merged in another device's edits. Logs
 *  success/failure so the chip-UI commit path is observable from
 *  DevTools. */
export async function writeList(terms: string[]): Promise<string[]> {
  const local = await idbReadRecord();
  // Legacy mirror (field absent) → undefined → no CAS base sent (plain
  // LWW, same as old clients); first successful sync upgrades it.
  const base = local ? local.serverUpdatedAt : undefined;
  const r = await putWithMergeRetry(terms, base, local?.lastSynced ?? [],
    { lastSynced: local?.lastSynced, serverUpdatedAt: local?.serverUpdatedAt });
  console.log(`[keyterms] writeList ${r.synced ? 'ok' : 'cached-only (dirty; re-syncs on next read)'}: ${r.terms.length} term(s)`,
    r.terms.length ? r.terms.slice(0, 5).join(', ') + (r.terms.length > 5 ? ` (+${r.terms.length - 5})` : '') : '(empty)');
  return r.terms;
}

/** Latency-sensitive read for voice paths (WebRTC offer, transcribe
 *  flush): returns the IDB mirror immediately when present and
 *  revalidates from the server in the background so the NEXT read sees
 *  fresh terms. STT bias terms tolerate staleness, but the network-first
 *  readList() blocks up to its 5s fetch timeout on a slow link — paid
 *  serially BEFORE the offer/transcribe POST it decorates. Falls back to
 *  the full loadOrSeed() only when no mirror exists yet (very first boot,
 *  before settings init has seeded it). */
export async function readListFast(): Promise<string[]> {
  const cached = await idbRead();
  if (cached !== null) {
    void readList().catch(() => {});
    return cached;
  }
  return loadOrSeed();
}

/** First-boot seed: returns the saved list, or fetches the server seed
 *  file and persists it once. The fetched list is then returned so the
 *  caller can render chips immediately. Failures (offline, server down)
 *  surface as an empty list — the user can still type new chips.
 *
 *  Persisting the seed requires an AFFIRMATIVE "no row" from the
 *  server: when the prefs read merely FAILED, the seed is rendered but
 *  NOT saved — a PUT here could overwrite a synced row we couldn't
 *  see (same clobber family as the legacy-adoption path). */
export async function loadOrSeed(): Promise<string[]> {
  const { terms: saved, server } = await syncRead();
  if (saved !== null) {
    console.log(`[keyterms] loadOrSeed: ${saved.length} saved`,
      saved.length ? saved.slice(0, 5).join(', ') + (saved.length > 5 ? ` (+${saved.length - 5})` : '') : '(empty)');
    return saved;
  }
  let seeded: string[] = [];
  try {
    const r = await keytermsFetch(apiUrl('/api/keyterms'), { timeoutMs: 5_000 });
    if (r.ok) seeded = parseSeedBody(await r.text());
  } catch (e) {
    console.warn('[keyterms] seed fetch failed:', e);
  }
  if (server === 'error') {
    console.log(`[keyterms] loadOrSeed: seeded ${seeded.length} render-only (server unreachable; retrying next load)`);
    return seeded;
  }
  console.log(`[keyterms] loadOrSeed: seeded ${seeded.length} from /api/keyterms`);
  // Pre-stage the record with a null CAS base ("server affirmatively
  // had no row") so the writeList below 409s instead of clobbering if
  // another device seeds first.
  await idbWriteRecord({ terms: seeded, dirty: true, lastSynced: [], serverUpdatedAt: null });
  return writeList(seeded);
}

/** Re-fetch the server seed and merge any NEW entries into the saved
 *  list. User-added chips (entries not in the server list) are preserved.
 *  Removals on the server side are NOT mirrored — once a term is saved,
 *  only an explicit chip-x click removes it. Returns the merged list, or
 *  the existing list if the seed fetch fails (offline, server down). */
export async function rehydrateFromSeed(): Promise<string[]> {
  const existing = (await readList()) ?? [];
  let serverSeed: string[] = [];
  try {
    const r = await keytermsFetch(apiUrl('/api/keyterms'), { timeoutMs: 5_000 });
    if (!r.ok) return existing;
    serverSeed = parseSeedBody(await r.text());
  } catch (e) {
    console.warn('[keyterms] rehydrate fetch failed:', e);
    return existing;
  }
  const seen = new Set(existing.map((t) => t.toLowerCase()));
  const added: string[] = [];
  for (const t of serverSeed) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    added.push(t);
  }
  if (added.length === 0) {
    console.log('[keyterms] rehydrate: no new entries from server');
    return existing;
  }
  const merged = [...existing, ...added];
  const persisted = await writeList(merged);
  console.log(`[keyterms] rehydrate: +${added.length} new entries`,
    added.slice(0, 5).join(', ') + (added.length > 5 ? ` (+${added.length - 5})` : ''));
  return persisted;
}
