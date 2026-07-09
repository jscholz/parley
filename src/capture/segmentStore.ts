// Durable buffer for capture segments — the client half of the
// "IDB-buffer-then-upload-ack" contract (capture plan §3.2): a sealed
// segment is persisted HERE before its first upload attempt and
// deleted only when the server acks, so a reload / crash / network
// outage mid-meeting never loses audio. voiceMemos.ts is the prior
// art for the idiom (IDB blob store + outbox drain).
//
// The storage backend is injectable: production uses IndexedDB
// (db `sidekick-capture`, store `segments`, keyPath `key`); tests use
// the in-memory implementation — same interface, no fake-IDB plumbing
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
}

export interface SegmentBackend {
  put(seg: PendingSegment): Promise<void>;
  getAll(): Promise<PendingSegment[]>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

// ── IndexedDB backend (production) ─────────────────────────────────────

const DB_NAME = 'sidekick-capture';
const STORE = 'segments';

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase> {
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

function idbBackend(): SegmentBackend {
  let dbP: Promise<IDBDatabase> | null = null;
  const db = () => (dbP ??= openDb());
  return {
    async put(seg) {
      await reqP((await db()).transaction(STORE, 'readwrite').objectStore(STORE).put(seg));
    },
    async getAll() {
      return reqP((await db()).transaction(STORE, 'readonly').objectStore(STORE).getAll());
    },
    async remove(key) {
      await reqP((await db()).transaction(STORE, 'readwrite').objectStore(STORE).delete(key));
    },
    async clear() {
      await reqP((await db()).transaction(STORE, 'readwrite').objectStore(STORE).clear());
    },
  };
}

/** In-memory backend — tests, and any context without IndexedDB
 *  (durability is lost there, capture still works for the session). */
export function memoryBackend(): SegmentBackend {
  const map = new Map<string, PendingSegment>();
  return {
    async put(seg) { map.set(seg.key, seg); },
    async getAll() { return Array.from(map.values()); },
    async remove(key) { map.delete(key); },
    async clear() { map.clear(); },
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

export async function putSegment(seg: Omit<PendingSegment, 'key' | 'createdAt'>): Promise<PendingSegment> {
  const full: PendingSegment = {
    ...seg,
    key: segmentKey(seg.captureId, seg.seq),
    createdAt: Date.now(),
  };
  await resolveBackend().put(full);
  return full;
}

/** All un-acked segments, upload order (capture, then seq). Boot-time
 *  resume calls this to re-enqueue whatever a previous session left. */
export async function listPending(): Promise<PendingSegment[]> {
  const all = await resolveBackend().getAll();
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

/** Drop every buffered segment for one capture — the cancel path
 *  (discard-without-ingest): un-uploaded audio must not drain to a
 *  server capture that no longer exists. */
export async function clearCapture(captureId: string): Promise<void> {
  const backend = resolveBackend();
  for (const seg of await backend.getAll()) {
    if (seg.captureId === captureId) await backend.remove(seg.key);
  }
}
