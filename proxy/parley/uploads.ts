/**
 * User-upload lane — GET /api/parley/uploads/<user_message_id>/<idx>
 *
 * Serves the durable copy of a file the USER attached to a message
 * (written by the hermes plugin under `<dataHome>/uploads/<umsg>/<idx>-<name>`,
 * indexed in parley.db; see backends/hermes/plugin/parley_user_uploads.py).
 * The transcript's user bubbles reference these URLs after any rebuild,
 * so thumbnails survive reloads and a Download works (2026-10-11).
 *
 * Deliberately NOT the media registry: that lane refuses dotfile path
 * components (~/.parley) and needs a registration mint. This lane is
 * scoped to exactly one directory, validates both path segments against
 * a strict shape, resolves symlinks, and refuses anything outside.
 * Images/video are served inline (own-origin, nosniff); everything else
 * as a download. Range supported for video scrubbing.
 */
import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import * as path from 'node:path';
import { dataHome } from '../dataHome.mjs';

const UMSG_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const IDX_RE = /^\d{1,4}$/;
const INLINE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  // Inline so the in-app viewer can frame it (2026-10-15); the viewer's
  // Download button still saves it (<a download>).
  '.pdf': 'application/pdf',
};

let rootResolver: () => string = () => path.join(dataHome(), 'uploads');
export function setUploadsRootForTests(fn: () => string): void { rootResolver = fn; }
export function uploadsRoot(): string { return rootResolver(); }

export async function resolveUpload(umsg: string, idx: string): Promise<{ file: string; name: string } | null> {
  if (!UMSG_RE.test(umsg) || !IDX_RE.test(idx)) return null;
  const root = path.resolve(uploadsRoot());
  const dir = path.join(root, umsg);
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return null; }
  const prefix = `${Number(idx)}-`;
  const hit = names.find((n) => n.startsWith(prefix));
  if (!hit) return null;
  const file = path.join(dir, hit);
  let real: string;
  try { real = await fs.realpath(file); } catch { return null; }
  if (real !== root && !real.startsWith(root + path.sep)) return null;   // symlink escape
  const st = await fs.stat(real).catch(() => null);
  if (!st || !st.isFile()) return null;
  return { file: real, name: hit.slice(prefix.length) || 'attachment' };
}

export async function handleUploadGet(req: http.IncomingMessage, res: http.ServerResponse, umsg: string, idx: string): Promise<void> {
  const hit = await resolveUpload(umsg, idx);
  if (!hit) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  const st = await fs.stat(hit.file);
  const ext = path.extname(hit.name).toLowerCase();
  const inline = INLINE_MIME[ext];
  const ascii = hit.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
  const headers: Record<string, string | number> = {
    'Content-Type': inline || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(hit.name)}`,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && inline) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(hit.file, { start, end }).pipe(res);
    return;
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(hit.file).pipe(res);
}
