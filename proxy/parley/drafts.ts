// Composer drafts — cross-device (2026-11-03). Field: "can you make it
// so drafts sync across devices?"
//
// One proxy-owned record per tenant at <dataHome>/drafts.json: for each
// chat, the text in the composer that has not been sent, when it was
// last edited, and by which device. Every device PUTs a chat's draft
// after a local change (debounced client-side) and refetches when a
// `drafts_changed` envelope names a chat it did not write itself.
//
// Merge rule, per chat: the NEWER EDIT wins (the client's edit stamp,
// clamped to the proxy clock). An empty draft is a tombstone, not a
// deletion — a send on the phone must beat the laptop's older copy of
// the same text, otherwise the laptop would resurrect what was already
// said. Tombstones age out after 30 days.
//
// Concurrent typing in the same chat on two devices is a real conflict
// with no right answer; newest-edit-wins is what every chat app does,
// and the client never overwrites text the user is typing with an
// OLDER copy (src/draftSync.ts resolveRemote).
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dataHome } from '../dataHome.mjs';
import { pushEnvelope } from './stream.ts';

export interface DraftRow { text: string; updatedAt: number; by: string }
export interface DraftsState { version: number; drafts: Record<string, DraftRow> }

export const MAX_TEXT = 64 * 1024;
export const MAX_ROWS = 300;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Fan-out chat id for the envelope: not a conversation, a sync channel. */
export const DRAFTS_CHAT_ID = 'parley:drafts';

let rootResolver: () => string = () => dataHome();
export function setDraftsRootForTests(fn: () => string): void { rootResolver = fn; }
const filePath = () => path.join(rootResolver(), 'drafts.json');

export async function readDrafts(): Promise<DraftsState> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath(), 'utf8'));
    if (raw && typeof raw.version === 'number' && raw.drafts && typeof raw.drafts === 'object') {
      const drafts: Record<string, DraftRow> = {};
      for (const [id, r] of Object.entries<any>(raw.drafts)) {
        if (r && typeof r.text === 'string' && Number.isFinite(Number(r.updatedAt))) {
          drafts[id] = { text: r.text, updatedAt: Number(r.updatedAt), by: String(r.by || '') };
        }
      }
      return { version: raw.version, drafts };
    }
  } catch { /* first run */ }
  return { version: 0, drafts: {} };
}

async function writeDrafts(s: DraftsState): Promise<void> {
  await fs.mkdir(rootResolver(), { recursive: true });
  const tmp = `${filePath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s));
  await fs.rename(tmp, filePath());
}

export function validChatId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\s/]/.test(id);
}

/** Pure merge for one chat. Returns the state (same object when nothing
 *  changed), the row that now stands, and whether the incoming edit won. */
export function mergeDraft(
  current: DraftsState,
  chatId: string,
  incoming: { text?: unknown; updatedAt?: unknown; by?: unknown },
  now = Date.now(),
): { state: DraftsState; row: DraftRow; applied: boolean; changed: boolean } {
  const text = typeof incoming.text === 'string' ? incoming.text.slice(0, MAX_TEXT) : '';
  const claimed = Number(incoming.updatedAt);
  // A client clock a minute ahead is tolerated; further than that it
  // would hold the chat hostage against every honest edit.
  const updatedAt = Number.isFinite(claimed) && claimed > 0 ? Math.min(claimed, now + 60_000) : now;
  const by = typeof incoming.by === 'string' ? incoming.by.slice(0, 64) : '';
  const row: DraftRow = { text, updatedAt, by };
  const prev = current.drafts[chatId];
  if (prev && prev.updatedAt > updatedAt) {
    return { state: current, row: prev, applied: false, changed: false };
  }
  if (prev && prev.updatedAt === updatedAt && prev.text === text) {
    return { state: current, row: prev, applied: true, changed: false };
  }
  const drafts: Record<string, DraftRow> = { ...current.drafts, [chatId]: row };
  // Housekeeping: expired tombstones go; beyond the cap, oldest rows go.
  for (const [id, r] of Object.entries(drafts)) {
    if (id !== chatId && !r.text && now - r.updatedAt > TOMBSTONE_TTL_MS) delete drafts[id];
  }
  const ids = Object.keys(drafts);
  if (ids.length > MAX_ROWS) {
    const drop = ids.filter((id) => id !== chatId).sort((a, b) => drafts[a].updatedAt - drafts[b].updatedAt).slice(0, ids.length - MAX_ROWS);
    for (const id of drop) delete drafts[id];
  }
  return { state: { version: current.version + 1, drafts }, row, applied: true, changed: true };
}

/** Serialized writer: two devices' PUTs in the same tick must not both
 *  read version N and both write N+1. */
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

export async function updateDraft(chatId: string, incoming: { text?: unknown; updatedAt?: unknown; by?: unknown }) {
  return serialized(async () => {
    const current = await readDrafts();
    const m = mergeDraft(current, chatId, incoming);
    if (m.changed) {
      await writeDrafts(m.state);
      try {
        pushEnvelope({ type: 'drafts_changed', chat_id: DRAFTS_CHAT_ID, draft_chat_id: chatId, version: m.state.version, by: m.row.by, updated_at: m.row.updatedAt } as any);
      } catch { /* fanout unavailable (unit tests) */ }
    }
    return { version: m.state.version, chat_id: chatId, draft: m.row, applied: m.applied };
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(buf.length), 'cache-control': 'no-store' });
  res.end(buf);
}

function readJson(req: IncomingMessage, maxBytes = MAX_TEXT + 4096): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0;
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

export async function handleDraftsGet(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, await readDrafts());
}

export async function handleDraftPut(req: IncomingMessage, res: ServerResponse, chatId: string): Promise<void> {
  if (!validChatId(chatId)) return sendJson(res, 400, { error: 'bad_chat_id' });
  let body: any;
  try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { error: 'bad_body', detail: String((e as Error)?.message || e) }); }
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad_body' });
  sendJson(res, 200, await updateDraft(chatId, body));
}
