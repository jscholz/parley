/**
 * Agent-pushed media — registry + streaming endpoint (2026-08-04,
 * Jonathan's "push multimedia to the client" ask; trigger case was a
 * server-side video edit with no lane into the chat).
 *
 *   POST /api/parley/media/register {path} → {id, url, mime, size}
 *   GET  /api/parley/media/{id}            → bytes (Range/206)
 *
 * Any local agent (hermes plugin session, claude-code backend, openclaw
 * — anything that can curl the sidekick server) registers a file it
 * produced and embeds the returned url in its reply as a markdown image
 * (`![caption](/api/parley/media/<id>)`); the client's card fallback
 * parser classifies by extension into an image or video card. No
 * per-backend envelope plumbing — the reference rides plain reply text.
 *
 * Security posture (tailscale-gated single-user instance, same as the
 * rest of the API — but this route reads the filesystem, so it gets
 * guards the capture-audio route never needed):
 *   - GET serves REGISTERED ids only — never a client-supplied path.
 *   - register resolves symlinks (realpath) BEFORE validating, accepts
 *     only regular files under the allowed roots (default $HOME + /tmp,
 *     override SIDEKICK_MEDIA_ROOTS=path:path), and rejects any path
 *     with a dotfile component (~/.ssh, ~/.hermes/.env stay out of
 *     reach even though they're under $HOME).
 *   - only known media extensions get served — this is a media lane,
 *     not a general file server.
 *
 * Registry persists to ~/.sidekick/media-registry.json so links in old
 * chat transcripts survive a server restart. Entries whose file has
 * vanished answer 410 (the registry intentionally keeps the tombstone —
 * a re-produced file gets a fresh id, never a silent content swap).
 */

import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readEnv } from '../env.mjs';
import { dataHome } from '../dataHome.mjs';

// Env override is the test seam (tests must not touch the real
// data home) and doubles as a deploy knob.
function registryFile(): string {
  return readEnv('PARLEY_MEDIA_REGISTRY')
    || path.join(dataHome(), 'media-registry.json');
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

type MediaEntry = {
  path: string;      // realpath at registration time
  mime: string;
  size: number;
  filename: string;
  registeredAt: number;
};

let registry: Map<string, MediaEntry> | null = null;

function allowedRoots(): string[] {
  const env = readEnv('PARLEY_MEDIA_ROOTS');
  if (env) return env.split(':').map((r) => path.resolve(r)).filter(Boolean);
  return [os.homedir(), '/tmp'];
}

async function loadRegistry(): Promise<Map<string, MediaEntry>> {
  if (registry) return registry;
  registry = new Map();
  try {
    const raw = JSON.parse(await fs.readFile(registryFile(), 'utf8'));
    for (const [id, e] of Object.entries(raw)) {
      if (/^[a-f0-9]{16}$/.test(id) && e && typeof (e as any).path === 'string') {
        registry.set(id, e as MediaEntry);
      }
    }
  } catch { /* first run / corrupt file → start empty */ }
  return registry;
}

async function persistRegistry(): Promise<void> {
  if (!registry) return;
  const obj: Record<string, MediaEntry> = {};
  for (const [id, e] of registry) obj[id] = e;
  const file = registryFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, file);
}

export class MediaError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Validate + register a file; returns the entry id. Exported for the
 *  route handler and for tests. */
export async function registerMedia(rawPath: string): Promise<{ id: string; entry: MediaEntry }> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new MediaError(400, 'path required');
  }
  let real: string;
  try {
    real = await fs.realpath(path.resolve(rawPath.trim()));
  } catch {
    throw new MediaError(404, 'file not found');
  }
  const roots = allowedRoots();
  if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) {
    throw new MediaError(403, `path outside allowed roots (${roots.join(', ')})`);
  }
  // No dotfile path components: keeps ~/.ssh, ~/.hermes, ~/.sidekick &
  // co. unreachable even though $HOME is an allowed root. Checked on
  // the RESOLVED path so a symlink can't launder one in.
  if (real.split(path.sep).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    throw new MediaError(403, 'dotfile path components are not served');
  }
  const st = await fs.stat(real);
  if (!st.isFile()) throw new MediaError(400, 'not a regular file');
  const mime = MIME_BY_EXT[path.extname(real).toLowerCase()];
  if (!mime) {
    throw new MediaError(415, `unsupported extension (known: ${Object.keys(MIME_BY_EXT).join(' ')})`);
  }
  const reg = await loadRegistry();
  // Same path re-registered → same id, refreshed size (idempotent for
  // the common "agent re-runs its script" case; content changes under
  // the same path are the caller's business).
  for (const [id, e] of reg) {
    if (e.path === real) {
      e.size = st.size;
      await persistRegistry();
      return { id, entry: e };
    }
  }
  const id = crypto.randomBytes(8).toString('hex');
  const entry: MediaEntry = {
    path: real,
    mime,
    size: st.size,
    filename: path.basename(real),
    registeredAt: Date.now(),
  };
  reg.set(id, entry);
  await persistRegistry();
  return { id, entry };
}

/** POST /api/parley/media/register — body {path}. */
export async function handleMediaRegister(
  req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw new MediaError(400, 'invalid JSON body'); }
    const { id, entry } = await registerMedia(body?.path);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // The url carries the file's extension (route ignores it; id is
    // the hex prefix) so the client's extension-based card classifier
    // — and WKWebView's type sniffing — see what kind of media it is.
    const ext = path.extname(entry.filename).toLowerCase();
    res.end(JSON.stringify({
      id,
      url: `/api/parley/media/${id}${ext}`,
      mime: entry.mime,
      size: entry.size,
      filename: entry.filename,
    }));
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String((err as Error)?.message || err) }));
  }
}

/** GET /api/parley/media/{id} — full body or 206 partial. Range logic
 *  mirrors captureAudio.ts (scrubbing = Range requests under the hood). */
export async function handleMediaGet(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new MediaError(400, 'malformed media id');
    const entry = (await loadRegistry()).get(id);
    if (!entry) throw new MediaError(404, 'unknown media id');
    let size: number;
    try {
      size = (await fs.stat(entry.path)).size;
    } catch {
      throw new MediaError(410, 'media file no longer exists on disk');
    }
    const range = typeof req.headers.range === 'string'
      ? req.headers.range.match(/^bytes=(\d*)-(\d*)$/) : null;
    const headers: Record<string, string | number> = {
      'Content-Type': entry.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    if (range && (range[1] || range[2])) {
      const start = range[1] ? parseInt(range[1], 10) : Math.max(0, size - parseInt(range[2], 10));
      const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), size - 1) : size - 1;
      if (Number.isNaN(start) || start >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      createReadStream(entry.path, { start, end }).pipe(res);
      return;
    }
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    createReadStream(entry.path).pipe(res);
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String((err as Error)?.message || err) }));
  }
}

/** Test seam — reset module state + point the registry elsewhere. */
export function __resetForTests(): void {
  registry = null;
}
