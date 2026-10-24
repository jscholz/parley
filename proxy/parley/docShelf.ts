// Docs shelf — cross-device state for the right-drawer Docs panel
// (2026-10-24). Field: "it confuses me to have different write panel
// documents and meetings open between my laptop and CAP, and having
// them synchronized would be useful."
//
// Two proxy-owned pieces:
//   1. The SHELF: which docs are open and in what tab order — metadata
//      only, one record per tenant at <dataHome>/doc-shelf.json. Every
//      device PUTs its shelf after a local change (debounced) and
//      applies the merged result when a `doc_shelf_changed` envelope
//      names a newer version. Merge rule: a writer that saw the current
//      version replaces it; a writer that did not gets a union (newest
//      updatedAt per doc wins, its order first, unknown ids appended).
//      The ACTIVE doc stays per device on purpose — two people reading
//      different pages of the same shelf is the normal case.
//   2. The CONTENT cache: every `doc_show` the proxy fans out is also
//      written to <dataHome>/docs/<id>.json, keyed by the client's own
//      doc id (djb2 of path, else title — identical algorithm to
//      src/rightDrawer/docStore.ts docIdFor, unit-tested for parity), so
//      a device that was asleep when the agent pushed a doc can still
//      open it from the shelf. Capture transcripts are rebuilt from
//      GET /captures/{id}/transcript instead (the client already knows how).
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dataHome } from '../dataHome.mjs';
import { pushEnvelope } from './stream.ts';

export interface ShelfDoc {
  id: string;
  title: string;
  path?: string;
  format: string;
  source?: string;
  captureId?: string;
  chatId?: string;
  updatedAt: number;
}

export interface ShelfState {
  version: number;
  updatedAt: number;
  by: string;
  order: string[];
  docs: Record<string, ShelfDoc>;
}

export interface CachedDoc {
  id: string;
  title: string;
  content: string;
  format: string;
  path?: string;
  chat_id?: string;
  source?: string;
  capture_id?: string;
  displayed_at?: number;
  duration_ms?: number;
}

/** Sentinel chat id for the shelf envelope: stream.broadcast drops
 *  envelopes without a chat_id, and the shelf is tenant-wide. */
export const SHELF_CHAT_ID = 'parley:docs';
const MAX_SHELF_DOCS = 12;             // mirrors docStore.MAX_DOCS
const MAX_CACHED_DOC_BYTES = 1_500_000; // plugin caps doc_show at 1 MB

let rootResolver: () => string = () => dataHome();
export function setDocShelfRootForTests(fn: () => string): void { rootResolver = fn; }
const shelfPath = () => path.join(rootResolver(), 'doc-shelf.json');
const docsDir = () => path.join(rootResolver(), 'docs');

/** Same djb2 the client uses (docStore.docIdFor) — keep byte-identical. */
export function docIdFor(p: string | undefined, title: string): string {
  const key = (p && p.trim()) || `title:${(title || '').trim().toLowerCase()}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

const EMPTY: ShelfState = { version: 0, updatedAt: 0, by: '', order: [], docs: {} };

export async function readShelf(): Promise<ShelfState> {
  try {
    const raw = JSON.parse(await fs.readFile(shelfPath(), 'utf8'));
    if (raw && typeof raw.version === 'number' && Array.isArray(raw.order) && raw.docs && typeof raw.docs === 'object') {
      return { version: raw.version, updatedAt: Number(raw.updatedAt) || 0, by: String(raw.by || ''), order: raw.order.filter((x: any) => typeof x === 'string'), docs: raw.docs };
    }
  } catch { /* first run */ }
  return { ...EMPTY, order: [], docs: {} };
}

async function writeShelf(s: ShelfState): Promise<void> {
  await fs.mkdir(rootResolver(), { recursive: true });
  const tmp = `${shelfPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s));
  await fs.rename(tmp, shelfPath());
}

function sanitizeDoc(d: any): ShelfDoc | null {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id) return null;
  return {
    id: d.id,
    title: typeof d.title === 'string' && d.title ? d.title.slice(0, 300) : 'Document',
    ...(typeof d.path === 'string' && d.path ? { path: d.path.slice(0, 1000) } : {}),
    format: typeof d.format === 'string' && d.format ? d.format : 'text',
    ...(typeof d.source === 'string' && d.source ? { source: d.source } : {}),
    ...(typeof d.captureId === 'string' && d.captureId ? { captureId: d.captureId } : {}),
    ...(typeof d.chatId === 'string' && d.chatId ? { chatId: d.chatId } : {}),
    updatedAt: Number.isFinite(Number(d.updatedAt)) ? Number(d.updatedAt) : Date.now(),
  };
}

/** Pure merge — the unit-tested heart. `incoming` is one device's view. */
export function mergeShelf(
  current: ShelfState,
  incoming: { base_version?: number; by?: string; order?: string[]; docs?: Record<string, any> | ShelfDoc[] },
  now = Date.now(),
): ShelfState {
  const by = typeof incoming.by === 'string' ? incoming.by.slice(0, 64) : '';
  const list: ShelfDoc[] = (Array.isArray(incoming.docs) ? incoming.docs : Object.values(incoming.docs || {}))
    .map(sanitizeDoc).filter((d): d is ShelfDoc => !!d);
  const incomingDocs: Record<string, ShelfDoc> = {};
  for (const d of list) incomingDocs[d.id] = d;
  const incomingOrder = (Array.isArray(incoming.order) ? incoming.order : [])
    .filter((id) => typeof id === 'string' && incomingDocs[id]);
  for (const id of Object.keys(incomingDocs)) if (!incomingOrder.includes(id)) incomingOrder.push(id);

  let docs: Record<string, ShelfDoc>;
  let order: string[];
  if (incoming.base_version === current.version) {
    // The writer saw what it replaced: its view IS the shelf (this is how
    // a close propagates).
    docs = incomingDocs;
    order = incomingOrder;
  } else {
    // Concurrent writers: keep everything either knows, newest copy per doc.
    docs = { ...current.docs };
    for (const d of list) {
      const prev = docs[d.id];
      if (!prev || d.updatedAt >= prev.updatedAt) docs[d.id] = d;
    }
    order = [...incomingOrder];
    for (const id of current.order) if (docs[id] && !order.includes(id)) order.push(id);
    for (const id of Object.keys(docs)) if (!order.includes(id)) order.push(id);
  }
  // Shelf cap (newest-updated survive), same ceiling as the client.
  if (order.length > MAX_SHELF_DOCS) {
    const keep = new Set(Object.values(docs).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SHELF_DOCS).map((d) => d.id));
    order = order.filter((id) => keep.has(id));
    docs = Object.fromEntries(Object.entries(docs).filter(([id]) => keep.has(id)));
  }
  return { version: current.version + 1, updatedAt: now, by, order, docs };
}

/** Serialized writer: PUTs from two devices in the same tick must not
 *  both read version N and both write N+1. */
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

export async function updateShelf(incoming: Parameters<typeof mergeShelf>[1]): Promise<ShelfState> {
  return serialized(async () => {
    const current = await readShelf();
    const next = mergeShelf(current, incoming);
    await writeShelf(next);
    try {
      pushEnvelope({ type: 'doc_shelf_changed', chat_id: SHELF_CHAT_ID, version: next.version, by: next.by } as any);
    } catch { /* fanout unavailable (unit tests) */ }
    return next;
  });
}

// ── Content cache ─────────────────────────────────────────────────────

function cachePath(id: string): string | null {
  if (!/^[0-9a-f]{1,8}$/.test(id)) return null;
  return path.join(docsDir(), `${id}.json`);
}

/** Called by stream.pushEnvelope for every doc_show it fans out. */
export function cacheDocShow(env: any): void {
  if (!env || env.type !== 'doc_show' || typeof env.content !== 'string') return;
  const title = typeof env.title === 'string' && env.title ? env.title : 'Document';
  const id = docIdFor(typeof env.path === 'string' ? env.path : undefined, title);
  const file = cachePath(id);
  if (!file) return;
  const doc: CachedDoc = {
    id, title, content: env.content,
    format: typeof env.format === 'string' && env.format ? env.format : 'text',
    ...(typeof env.path === 'string' ? { path: env.path } : {}),
    ...(typeof env.chat_id === 'string' ? { chat_id: env.chat_id } : {}),
    ...(typeof env.source === 'string' ? { source: env.source } : {}),
    ...(typeof env.capture_id === 'string' ? { capture_id: env.capture_id } : {}),
    ...(typeof env.displayed_at === 'number' ? { displayed_at: env.displayed_at } : {}),
    ...(typeof env.duration_ms === 'number' ? { duration_ms: env.duration_ms } : {}),
  };
  const raw = JSON.stringify(doc);
  if (raw.length > MAX_CACHED_DOC_BYTES) return;
  void fs.mkdir(docsDir(), { recursive: true })
    .then(() => fs.writeFile(`${file}.tmp`, raw))
    .then(() => fs.rename(`${file}.tmp`, file))
    .catch((e) => console.warn(`[parley] doc cache write failed for ${id}: ${String((e as Error)?.message || e)}`));
}

export async function readCachedDoc(id: string): Promise<CachedDoc | null> {
  const file = cachePath(id);
  if (!file) return null;
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

// ── HTTP ──────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, maxBytes = 512 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export async function handleShelfGet(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, await readShelf());
}

export async function handleShelfPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { error: 'bad_body', detail: String((e as Error)?.message || e) }); }
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad_body' });
  const next = await updateShelf(body);
  sendJson(res, 200, next);
}

export async function handleDocGet(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const doc = await readCachedDoc(id);
  if (!doc) return sendJson(res, 404, { error: 'not_cached' });
  sendJson(res, 200, doc);
}
