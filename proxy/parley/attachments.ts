/**
 * Agent-pushed ATTACHMENTS — the general-file sibling of the media lane
 * (2026-10-08, Jonathan's ask after a corrected .pptx came back as
 * "⚠️ Couldn't deliver the file attachment": the media registry is a
 * media lane on purpose and refuses documents).
 *
 *   POST /api/parley/attachments/register {path}        → {id, url, mime, size, filename}
 *   GET  /api/parley/attachments/{id}[/{filename}]     → bytes, DOWNLOAD ONLY
 *
 * Same guard as media.ts (resolveServablePath: realpath, allowed roots,
 * no dotfile components, regular files). What differs is the serving
 * posture: every GET answers `Content-Disposition: attachment` and
 * `X-Content-Type-Options: nosniff`, and anything we don't positively
 * know is `application/octet-stream`. Nothing from this lane is ever
 * rendered inline — that is what lets it carry .pptx/.pdf/.html/.svg/
 * .zip/anything without the scripting worry that kept them out of the
 * media lane. The client renders a card with a Download button; under
 * the CAP shell the button hands the URL to the OS browser, because
 * WKWebView cannot save a download itself.
 *
 * Registry persists to ~/.parley/attachment-registry.json (env seam
 * PARLEY_ATTACHMENT_REGISTRY for tests). Vanished files answer 410;
 * the tombstone stays so a re-produced file gets a fresh id.
 */

import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readEnv } from '../env.mjs';
import { dataHome } from '../dataHome.mjs';
import { MediaError, resolveServablePath } from './media.ts';

function registryFile(): string {
  return readEnv('PARLEY_ATTACHMENT_REGISTRY')
    || path.join(dataHome(), 'attachment-registry.json');
}

/** Files larger than this are refused at registration — the lane is for
 *  deliverables, not disk images. Override with PARLEY_ATTACHMENT_MAX_MB. */
function maxBytes(): number {
  const mb = Number(readEnv('PARLEY_ATTACHMENT_MAX_MB') || 500);
  return (Number.isFinite(mb) && mb > 0 ? mb : 500) * 1024 * 1024;
}

/** Positive list for a useful Content-Type on download; everything else
 *  is octet-stream. Download-only, so a mime here never means "render". */
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.key': 'application/vnd.apple.keynote',
  '.numbers': 'application/vnd.apple.numbers',
  '.pages': 'application/vnd.apple.pages',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export type AttachmentEntry = {
  path: string;      // realpath at registration time
  mime: string;
  size: number;
  filename: string;
  registeredAt: number;
};

let registry: Map<string, AttachmentEntry> | null = null;

async function loadRegistry(): Promise<Map<string, AttachmentEntry>> {
  if (registry) return registry;
  registry = new Map();
  try {
    const raw = JSON.parse(await fs.readFile(registryFile(), 'utf8'));
    for (const [id, e] of Object.entries(raw)) {
      if (/^[a-f0-9]{16}$/.test(id) && e && typeof (e as any).path === 'string') {
        registry.set(id, e as AttachmentEntry);
      }
    }
  } catch { /* first run / corrupt file → start empty */ }
  return registry;
}

async function persistRegistry(): Promise<void> {
  if (!registry) return;
  const obj: Record<string, AttachmentEntry> = {};
  for (const [id, e] of registry) obj[id] = e;
  const file = registryFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, file);
}

/** A filename that is safe in a URL path segment and a Content-Disposition
 *  (no separators, no control chars, bounded length). */
export function safeFilename(name: string): string {
  const base = path.basename(name || '').replace(/[\\/\u0000-\u001f"]/g, '_').trim();
  return (base || 'file').slice(0, 120);
}

export async function registerAttachment(rawPath: string): Promise<{ id: string; entry: AttachmentEntry }> {
  const { real, size } = await resolveServablePath(rawPath);
  if (size > maxBytes()) {
    throw new MediaError(413, `file too large (${size} bytes; max ${maxBytes()})`);
  }
  const reg = await loadRegistry();
  for (const [id, e] of reg) {
    if (e.path === real) {
      e.size = size;
      await persistRegistry();
      return { id, entry: e };
    }
  }
  const id = crypto.randomBytes(8).toString('hex');
  const entry: AttachmentEntry = {
    path: real,
    mime: MIME_BY_EXT[path.extname(real).toLowerCase()] || 'application/octet-stream',
    size,
    filename: safeFilename(path.basename(real)),
    registeredAt: Date.now(),
  };
  reg.set(id, entry);
  await persistRegistry();
  return { id, entry };
}

export function attachmentUrl(id: string, entry: AttachmentEntry): string {
  return `/api/parley/attachments/${id}/${encodeURIComponent(entry.filename)}`;
}

/** POST /api/parley/attachments/register — body {path}. */
export async function handleAttachmentRegister(
  req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw new MediaError(400, 'invalid JSON body'); }
    const { id, entry } = await registerAttachment(body?.path);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id, url: attachmentUrl(id, entry), mime: entry.mime, size: entry.size, filename: entry.filename,
    }));
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String((err as Error)?.message || err) }));
  }
}

/** GET/HEAD /api/parley/attachments/{id}[/{filename}] — download only. */
export async function handleAttachmentGet(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  const reg = await loadRegistry();
  const entry = reg.get(id);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown attachment' }));
    return;
  }
  let st;
  try {
    st = await fs.stat(entry.path);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'file no longer exists on the server' }));
    return;
  }
  // RFC 6266/5987: ASCII fallback + UTF-8 form so non-ASCII names survive.
  const ascii = entry.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const headers: Record<string, string | number> = {
    'Content-Type': entry.mime,
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=0',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  createReadStream(entry.path).pipe(res);
}

/** Test-only: drop the in-memory registry so the next call re-reads the file. */
export function __resetAttachmentsForTests(): void {
  registry = null;
}
