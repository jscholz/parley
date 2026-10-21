// Durable buffer for capture segments — the client half of the
// "IDB-buffer-then-upload-ack" contract (capture plan §3.2): a sealed
// segment is persisted HERE before its first upload attempt and
// deleted only when the server acks, so a reload / crash / network
// outage mid-meeting never loses audio. voiceMemos.ts is the prior
// art for the idiom (IDB blob store + outbox drain).
//
// Since 2026-10-05 the same database also holds the CAPTURE LEDGER: one
// row per capture the client has started, recording what the server
// still has to be told (create / activate / marks / stop). Meeting mode
// became offline-first that day — the recorder mints the capture id
// itself and starts the mic with no network at all; the uploader
// registers the capture upstream when it can, drains the audio, then
// posts the deferred stop. The ledger is what survives a reload between
// those steps (field ask: "record arbitrarily long audio without an
// internet connection that syncs when it's ready").
//
// The storage backend is injectable: production uses IndexedDB
// (db `parley-capture`, stores `segments` + `captures`); tests use the
// in-memory implementation — same interface, no fake-IDB plumbing
// (docStore.test.ts's localStorage-shim philosophy applied to IDB).

export interface PendingSegment {
  /** `${captureId}:${seq}` — primary key, stable across reloads. */
  key: string;
  captureId: string;
  seq: number;
  /** Capture-relative start of this segment (ms). */
  t0Ms: number;
  mime: string;
  blob: Blob;
  createdAt: number;
  /** A segment still being recorded (2026-10-21): the recorder rewrites
   *  this row every few seconds with the chunks so far, so a page the OS
   *  kills mid-segment loses seconds, not the whole 45 s. The uploader
   *  skips partial rows; the seal replaces the row with the final blob
   *  (same key, flag cleared), and boot-time `finalizePartials` promotes
   *  whatever a dead page left behind — it is the only copy. */
  partial?: boolean;
}

/** What the client knows about a capture it started, and what the
 *  server has not yet been told. Keyed by the client-minted capture id. */
export interface CaptureLedgerEntry {
  id: string;
  title: string;
  linkedChat: string | null;
  /** linkedChat was minted for this meeting (titling pipeline hint). */
  mintedSession: boolean;
  diarize: boolean;
  autoIngest?: boolean;
  createdAt: number;
  /** `POST /captures` acked — the server entity exists. */
  registered: boolean;
  /** `POST /activate` acked (best-effort; a first segment implies it). */
  activated: boolean;
  /** The user stopped; `POST /stop` is owed once every segment is acked. */
  stopRequested: boolean;
  /** Marks (capture-relative ms) not yet delivered. */
  marks: number[];
  /** Title changed locally after registration; PATCH owed. */
  titleDirty?: boolean;
  /** Registration was refused for good (4xx other than one-active 409).
   *  Audio stays buffered; the uploader parks the capture's segments. */
  registerFailed?: string;
}

export interface SegmentBackend {
  put(seg: PendingSegment): Promise<void>;
  getAll(): Promise<PendingSegment[]>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  putCapture(entry: CaptureLedgerEntry): Promise<void>;
  getCaptures(): Promise<CaptureLedgerEntry[]>;
  removeCapture(id: string): Promise<void>;
}

// ── IndexedDB backend (production) ────────────────────────────────────

const DB_NAME = 'parley-capture';
const STORE = 'segments';
const LEDGER = 'captures';
// v1: segments only. v2 (2026-10-05): + the capture ledger.
const DB_VERSION = 2;

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(LEDGER)) {
        db.createObjectStore(LEDGER, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The browser took the connection away underneath us. WebKit closes
 *  IndexedDB connections behind a backgrounded PWA / CAP shell (storage
 *  pressure, a long sleep) and the cached handle then throws on every
 *  transaction — field 2026-10-11, "Could not start recording: Failed
 *  to execute 'transaction' on 'IDBDatabase': The database connection
 *  is closing", from a handle opened hours earlier. Reopening is the
 *  whole fix; the error is not about the data. */
export function isClosedConnectionError(e: unknown): boolean {
  const name = String((e as { name?: unknown })?.name || '');
  const msg = String((e as { message?: unknown })?.message || e || '');
  return name === 'InvalidStateError' || /connection is closing|database is closed|closed database/i.test(msg);
}

/** IndexedDB backend. `factory` is a seam for the tests (node has no
 *  IndexedDB); production reads the global lazily on first use. */
export function idbBackend(factory: () => IDBFactory = () => indexedDB): SegmentBackend {
  let dbP: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    if (dbP) return dbP;
    const p: Promise<IDBDatabase> = openDb(factory()).then(
      (d) => {
        // Drop the handle the moment the browser does, so the next call
        // opens a fresh one instead of tripping over a dead connection.
        d.onclose = () => { if (dbP === p) dbP = null; };
        d.onversionchange = () => {
          try { d.close(); } catch { /* already gone */ }
          if (dbP === p) dbP = null;
        };
        return d;
      },
      (err) => { if (dbP === p) dbP = null; throw err; },
    );
    dbP = p;
    return p;
  };
  /** One request on one store, reopening the connection ONCE when the
   *  cached one turns out to be closed (the eviction above fires no
   *  event on every engine). */
  const run = async <T>(store: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      const d = await db();
      try {
        return await reqP(op(d.transaction(store, mode).objectStore(store)));
      } catch (e) {
        if (attempt === 0 && isClosedConnectionError(e)) {
          if (dbP) dbP = null;
          continue;
        }
        throw e;
      }
    }
  };
  return {
    async put(seg) { await run(STORE, 'readwrite', (s) => s.put(seg)); },
    async getAll() { return run(STORE, 'readonly', (s) => s.getAll() as IDBRequest<PendingSegment[]>); },
    async remove(key) { await run(STORE, 'readwrite', (s) => s.delete(key)); },
    async clear() { await run(STORE, 'readwrite', (s) => s.clear()); },
    async putCapture(entry) { await run(LEDGER, 'readwrite', (s) => s.put(entry)); },
    async getCaptures() { return run(LEDGER, 'readonly', (s) => s.getAll() as IDBRequest<CaptureLedgerEntry[]>); },
    async removeCapture(id) { await run(LEDGER, 'readwrite', (s) => s.delete(id)); },
  };
}

/** In-memory backend — tests, and any context without IndexedDB
 *  (durability is lost there, capture still works for the session). */
export function memoryBackend(): SegmentBackend {
  const map = new Map<string, PendingSegment>();
  const ledger = new Map<string, CaptureLedgerEntry>();
  return {
    async put(seg) { map.set(seg.key, seg); },
    async getAll() { return Array.from(map.values()); },
    async remove(key) { map.delete(key); },
    async clear() { map.clear(); ledger.clear(); },
    async putCapture(entry) { ledger.set(entry.id, { ...entry, marks: [...entry.marks] }); },
    async getCaptures() { return Array.from(ledger.values()).map((e) => ({ ...e, marks: [...e.marks] })); },
    async removeCapture(id) { ledger.delete(id); },
  };
}

let backend: SegmentBackend | null = null;

function resolveBackend(): SegmentBackend {
  if (backend) return backend;
  backend = (typeof indexedDB !== 'undefined') ? idbBackend() : memoryBackend();
  return backend;
}

/** Test seam / explicit override. */
export function setBackend(b: SegmentBackend | null): void {
  backend = b;
}

export function segmentKey(captureId: string, seq: number): string {
  return `${captureId}:${seq}`;
}

export async function putSegment(seg: Omit<PendingSegment, 'key' | 'createdAt' | 'partial'>): Promise<PendingSegment> {
  const full: PendingSegment = {
    ...seg,
    key: segmentKey(seg.captureId, seg.seq),
    createdAt: Date.now(),
    partial: false,
  };
  await resolveBackend().put(full);
  return full;
}

/** Durable copy of a segment that is still recording — same key as the
 *  final put, which replaces it. Never uploaded as-is. */
export async function putPartialSegment(seg: Omit<PendingSegment, 'key' | 'createdAt' | 'partial'>): Promise<PendingSegment> {
  const full: PendingSegment = {
    ...seg,
    key: segmentKey(seg.captureId, seg.seq),
    createdAt: Date.now(),
    partial: true,
  };
  await resolveBackend().put(full);
  return full;
}

/** Boot-time: a partial row that survived to the next launch belongs to
 *  a segment whose seal never ran (the page was killed or frozen until
 *  the OS reclaimed it). Promote each to a final segment so the uploader
 *  sends what exists. Returns how many were promoted. */
export async function finalizePartials(): Promise<number> {
  const backend = resolveBackend();
  let n = 0;
  for (const seg of await backend.getAll()) {
    if (!seg.partial) continue;
    if (!seg.blob || !seg.blob.size) { await backend.remove(seg.key); continue; }
    await backend.put({ ...seg, partial: false });
    n += 1;
  }
  return n;
}

/** All un-acked segments, upload order (capture, then seq). Boot-time
 *  resume calls this to re-enqueue whatever a previous session left.
 *  `includePartial: false` hides segments still being recorded (the
 *  uploader's view). */
export async function listPending(opts: { includePartial?: boolean } = {}): Promise<PendingSegment[]> {
  const includePartial = opts.includePartial !== false;
  const all = (await resolveBackend().getAll()).filter((s) => includePartial || !s.partial);
  all.sort((a, b) => a.captureId === b.captureId
    ? a.seq - b.seq
    : a.captureId.localeCompare(b.captureId));
  return all;
}

/** Server acked — the durable copy has done its job. */
export async function removeSegment(key: string): Promise<void> {
  await resolveBackend().remove(key);
}

export async function clearAll(): Promise<void> {
  await resolveBackend().clear();
}

/** Drop every buffered segment for one capture. NOT called by cancel
 *  anymore (2026-08-18 postmortem P0 #2): a canceled capture's
 *  un-uploaded segments are the ONLY copy of that audio, so they stay
 *  buffered (the uploader parks them when the server answers
 *  "frozen") until clearExpired's retention window or a deliberate
 *  purge. Kept for purge-side tooling. */
export async function clearCapture(captureId: string): Promise<void> {
  const backend = resolveBackend();
  for (const seg of await backend.getAll()) {
    if (seg.captureId === captureId) await backend.remove(seg.key);
  }
}

/** Retention janitor: drop buffered segments older than maxAgeMs.
 *  Mirrors the server's Recently-Deleted window — parked segments from
 *  discarded/finalized captures stay recoverable exactly that long,
 *  then stop eating the phone's storage. Returns the number removed.
 *  Ledger rows age out on the same clock: a capture whose create never
 *  landed in a week is not going to. */
export async function clearExpired(maxAgeMs: number): Promise<number> {
  const backend = resolveBackend();
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const seg of await backend.getAll()) {
    if (seg.createdAt < cutoff) {
      await backend.remove(seg.key);
      removed += 1;
    }
  }
  for (const entry of await backend.getCaptures()) {
    if (entry.createdAt < cutoff) await backend.removeCapture(entry.id);
  }
  return removed;
}

// ── capture ledger ────────────────────────────────────────────────────

export async function putLedger(entry: CaptureLedgerEntry): Promise<void> {
  await resolveBackend().putCapture(entry);
}

export async function getLedger(id: string): Promise<CaptureLedgerEntry | null> {
  const all = await resolveBackend().getCaptures();
  return all.find((e) => e.id === id) ?? null;
}

export async function listLedger(): Promise<CaptureLedgerEntry[]> {
  const all = await resolveBackend().getCaptures();
  all.sort((a, b) => a.createdAt - b.createdAt);
  return all;
}

/** Read-modify-write helper; no-op (returns null) for an unknown id. */
export async function updateLedger(
  id: string, patch: Partial<CaptureLedgerEntry> | ((e: CaptureLedgerEntry) => void),
): Promise<CaptureLedgerEntry | null> {
  const entry = await getLedger(id);
  if (!entry) return null;
  if (typeof patch === 'function') patch(entry); else Object.assign(entry, patch);
  await resolveBackend().putCapture(entry);
  return entry;
}

/** Everything the server needed to hear has been said. */
export async function removeLedger(id: string): Promise<void> {
  await resolveBackend().removeCapture(id);
}
