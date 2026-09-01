/**
 * IndexedDB-backed outbox queue for offline message reliability.
 * Stores text messages and audio blobs, flushes in order when connected.
 */

const DB_NAME = 'parley-outbox';
const STORE = 'messages';
const DB_VERSION = 1;

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

function tx(db: IDBDatabase, mode: IDBTransactionMode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function reqP<T = any>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * Enqueue a message or audio blob for later delivery.
 * @param {({ type: 'text', text: string, source: string } | { type: 'audio', blob: Blob, mimeType: string, durationMs?: number }) & { id?: string }} item
 */
export async function enqueue(item) {
  const db = await openDB();
  const record = {
    id: item.id || crypto.randomUUID(),
    timestamp: Date.now(),
    status: 'pending',
    ...item,
  };
  await reqP(tx(db, 'readwrite').put(record));
  db.close();
  return record.id;
}

/** Escalation stops mattering past this many recorded failures (see
 *  transcribeBudget.MAX_ESCALATION_FACTOR), so stop writing the row
 *  back — each write re-serializes the audio Blob, and a wedged 20MB
 *  memo must not pay that every 30s forever. */
export const MAX_TRACKED_ATTEMPTS = 4;

/** Record that one delivery attempt for `id` failed, and return the new
 *  count. Returns 0 if the row is gone (already drained).
 *
 *  WHY THIS IS PERSISTED rather than kept in a Map: the /transcribe
 *  budget escalates with the attempt count, and the wedge being fixed
 *  (field 2026-09-01) is a permanent retry loop on a slow link. An
 *  in-memory counter resets on every reload, so a user who reloads to
 *  "unstick" the app would reset the escalation and re-enter the exact
 *  same loop — the reload is the most likely thing they'll try.
 *
 *  Read-then-write in two transactions on purpose: awaiting between a
 *  get and a put inside ONE IndexedDB transaction can hit the
 *  auto-commit footgun (TransactionInactiveError) on WebKit. The flush
 *  mutex means there is no concurrent writer to race, and a lost
 *  increment would only mean one extra retry at the old budget. */
export async function bumpAttempts(id: string): Promise<number> {
  if (!id) return 0;
  const db = await openDB();
  try {
    const rec: any = await reqP(tx(db, 'readonly').get(id));
    if (!rec) return 0;
    const prior = Number(rec.attempts) || 0;
    if (prior >= MAX_TRACKED_ATTEMPTS) return prior;
    const next = prior + 1;
    rec.attempts = next;
    await reqP(tx(db, 'readwrite').put(rec));
    return next;
  } catch {
    // A failed counter write must never fail the flush — worst case the
    // item retries at the same budget it just used.
    return 0;
  } finally {
    db.close();
  }
}

/** In-process mutex — two concurrent flush() calls would each read the
 *  same pending list and each try to send-then-delete every item,
 *  producing duplicate server-side sends. Real-world race seen on mobile:
 *  a memo completion fires flushOutbox() while a gateway reconnect fires
 *  it 2s later, both flushing the same queued blob. Lock keeps flush
 *  serial; second caller gets {skipped: true} back and can retry later.
 *  Lock is in-memory only so it resets on page reload (no stuck "sending"
 *  rows in IndexedDB to clean up). */
let isFlushing = false;

/**
 * Flush pending items in order. Stops on first failure to preserve ordering.
 * Concurrent calls skip (second caller returns skipped=true); the in-flight
 * flush will cover whatever was pending when it started.
 * @param {(text: string, source: string, item?: any) => Promise<void>} sendTextFn
 * @param {(blob: Blob, mimeType: string, id: string, autoSend: boolean, toComposer: boolean, durationMs?: number, item?: any) => Promise<void>} transcribeAndSendFn
 *   autoSend is the per-memo flag captured at record time — true means
 *   transcribe-then-dispatch as a chat message, false means land in the
 *   composer for review. toComposer marks a batch-DICTATION item: the
 *   transcript lands in the composer with NO chat bubble / memo card (the
 *   blob still rides this durable queue so a bad-connection upload retries
 *   instead of evaporating). Both flags are stored on the queue item so a
 *   periodic retry long after recording still routes the way the user chose.
 *   The raw item is passed last for routes with richer state (listen turns
 *   carry listenTurn/commitReason/chatId — see memoOutbox.transcribeListenTurn).
 * @returns {Promise<{ sent: number, remaining: number, skipped?: boolean }>}
 */
export async function flush(sendTextFn, transcribeAndSendFn) {
  if (isFlushing) return { sent: 0, remaining: 0, skipped: true };
  isFlushing = true;
  const db = await openDB();
  let sent = 0;
  let remaining = 0;
  try {
    // Loop until queue is empty OR a send fails. Re-reading the pending
    // list each pass catches items that got enqueued DURING the previous
    // pass — e.g. rapid-fire memos: memo 1's handleMemoResult fires
    // flushOutbox which locks the mutex, but memos 2/3 arrive while
    // memo 1 is mid-/transcribe. Their handleMemoResult-triggered
    // flushOutbox calls skip (mutex held), so without re-reading here
    // they'd wait until the 30s periodic retry. With re-read they get
    // picked up on this same flush pass.
    while (true) {
      const all = await reqP(tx(db, 'readonly').getAll());
      const items = all.filter(i => i.status === 'pending').sort((a, b) => a.timestamp - b.timestamp);
      if (items.length === 0) break;
      let processed = false;
      let failed = false;
      for (const item of items) {
        try {
          if (item.type === 'text') await sendTextFn(item.text, item.source, item);
          else if (item.type === 'audio') await transcribeAndSendFn(item.blob, item.mimeType, item.id, !!item.autoSend, !!item.toComposer, item.durationMs, item);
          await reqP(tx(db, 'readwrite').delete(item.id));
          sent++;
          processed = true;
        } catch {
          // stop on first failure — preserve ordering
          failed = true;
          remaining = items.length - sent;
          break;
        }
      }
      if (failed || !processed) break;
    }
    db.close();
    return { sent, remaining };
  } finally {
    isFlushing = false;
  }
}

/** Return count of pending items. */
/** Remove a single item by id. Called from the live memo path
 *  (transcribeAndRoute) once /transcribe succeeds, so the periodic
 *  outbox flush doesn't later find + re-transcribe the same blob
 *  and produce a duplicate composer append / chat send. */
export async function remove(id) {
  const db = await openDB();
  try { await reqP(tx(db, 'readwrite').delete(id)); } catch {}
  db.close();
}

export async function pending() {
  const db = await openDB();
  const all = await reqP(tx(db, 'readonly').getAll());
  db.close();
  return all.filter(i => i.status === 'pending').length;
}

/** Richer pending view — count + total audio duration. Used by status
 *  bar to show "N queued (M:SS audio)" so the user can reason about
 *  what's stuck. durationMs comes from the memo record itself (set at
 *  recording stop); text items contribute 0. */
export async function summary() {
  const db = await openDB();
  const all = await reqP(tx(db, 'readonly').getAll());
  db.close();
  const pending = all.filter(i => i.status === 'pending');
  const count = pending.length;
  const totalAudioMs = pending.reduce((s, i) => s + (i.durationMs || 0), 0);
  return { count, totalAudioMs };
}

/** Delete all items. */
export async function clear() {
  const db = await openDB();
  await reqP(tx(db, 'readwrite').clear());
  db.close();
}
