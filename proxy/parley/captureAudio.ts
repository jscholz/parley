/**
 * Capture playback endpoint — GET /api/parley/captures/{id}/audio
 * (capture plan §3.6: the player strip's backend, and the artifact
 * "Download audio" serves).
 *
 * Lazily stitches the capture's sealed segments into ONE mono m4a on
 * first request (cached on disk as audio.play.m4a — ~10× smaller than
 * the diarize pass's wav and it streams/seeks well in <audio>), then
 * serves it with HTTP Range support — scrubbing and tap-line-to-seek
 * are Range requests under the hood.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { getCapture, segmentPath, captureDirPath, CaptureError } from './capture.ts';
import { ffmpegStitch, type StitchFormat } from './captureStitch.ts';

let stitchOverride: ((files: string[], out: string, format: StitchFormat) => Promise<string>) | null = null;

/** Test seam — replaces ffmpeg. */
export function setStitchForTests(fn: typeof stitchOverride): void {
  stitchOverride = fn;
}

/** The cached playback file for a capture — keyed by segment COUNT so a
 *  retro-arriving segment (or retro re-anything) invalidates by pointing
 *  at a new name. Shared with the diarize pass, which pre-warms this
 *  exact file. */
export function playbackFileFor(id: string, segmentCount: number): string {
  return path.join(captureDirPath(id), `audio.play.${segmentCount}.m4a`);
}

/** Top-level MP4 box walk: where does `moov` sit relative to `mdat`?
 *  'faststart' = index first (streams and seeks on WebKit without the
 *  whole file); 'moov-late' = data first (ffmpeg's default before we
 *  passed -movflags +faststart); 'unknown' = not parseable as boxes
 *  (test fixtures, torn files) — left alone, never re-stitched. */
export async function mp4Layout(file: string): Promise<'faststart' | 'moov-late' | 'unknown'> {
  const fh = await fs.open(file, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    let off = 0;
    for (let i = 0; i < 64 && off + 8 <= fileSize; i++) {
      const hdr = Buffer.alloc(16);
      const { bytesRead } = await fh.read(hdr, 0, 16, off);
      if (bytesRead < 8) return 'unknown';
      let size = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      if (!/^[\x20-\x7e]{4}$/.test(type)) return 'unknown';
      if (size === 1) {
        if (bytesRead < 16) return 'unknown';
        size = Number(hdr.readBigUInt64BE(8));
      } else if (size === 0) {
        size = fileSize - off;
      }
      if (type === 'moov') return 'faststart';
      if (type === 'mdat') return 'moov-late';
      if (size < 8) return 'unknown';
      off += size;
    }
    return 'unknown';
  } finally {
    await fh.close();
  }
}

// Files whose layout this process has already vetted — one box walk per
// path per process, not per Range request.
const layoutChecked = new Set<string>();

/** Is the cached file present AND streamable? A legacy index-at-end
 *  file is removed here so the caller re-stitches it (once). */
async function isServable(out: string): Promise<boolean> {
  try {
    await fs.access(out);
  } catch {
    return false;
  }
  if (layoutChecked.has(out)) return true;
  if ((await mp4Layout(out)) === 'moov-late') {
    await fs.unlink(out).catch(() => { /* raced with a re-stitch */ });
    return false;
  }
  layoutChecked.add(out);
  return true;
}

// One stitch at a time per capture — concurrent first-plays must not
// race two ffmpeg runs onto the same output file.
const inflight = new Map<string, Promise<string>>();

async function ensurePlaybackFile(id: string): Promise<string> {
  const m = await getCapture(id);
  if (!m.segments.length) throw new CaptureError(404, 'capture has no audio segments');
  if (m.audio_purged) throw new CaptureError(410, 'audio was purged for this capture (transcript retained)');
  // Terminal captures only (audit 2026-07-09): a stitch taken while
  // recording/transcribing — or before post-stop tail segments land —
  // would cache a TRUNCATED file forever. The live meeting's playback
  // story is the live transcript, not audio scrubbing.
  if (m.status !== 'complete' && m.status !== 'failed') {
    throw new CaptureError(409, `capture is ${m.status}; playback is available once it completes`);
  }
  const out = playbackFileFor(id, m.segments.length);
  if (await isServable(out)) return out;   // cached from a previous request
  let p = inflight.get(id);
  if (!p) {
    const stitch = stitchOverride ?? ffmpegStitch;
    p = stitch(m.segments.map((s) => segmentPath(id, s)), out, 'm4a')
      .then((file) => { layoutChecked.add(file); return file; })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

/** GET/HEAD /api/parley/captures/{id}/audio — full body or 206 partial.
 *  HEAD answers the same headers with no body (media loaders and
 *  download managers probe with it; a 405 there reads as "no audio"). */
export async function handleCaptureAudio(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  const headOnly = req.method === 'HEAD';
  try {
    const file = await ensurePlaybackFile(id);
    const { size, mtimeMs } = await fs.stat(file);
    // Validator so a browser may KEEP the bytes it already pulled: the
    // media element re-created on every reader render used to refetch
    // from zero (field 2026-09-19: "switch meetings and back, the cache
    // seems to get discarded"). `no-cache` = store, but revalidate —
    // one 304 per element instead of the whole file again. The tag
    // moves whenever the file does (re-stitch, retro segment).
    const etag = `"${size}-${Math.floor(mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' });
      res.end();
      return;
    }
    const range = typeof req.headers.range === 'string'
      ? req.headers.range.match(/^bytes=(\d*)-(\d*)$/) : null;
    const headers: Record<string, string | number> = {
      'Content-Type': 'audio/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-cache',
      ETag: etag,
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
      if (headOnly) { res.end(); return; }
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    if (headOnly) { res.end(); return; }
    createReadStream(file).pipe(res);
  } catch (err) {
    const status = err instanceof CaptureError ? err.status : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String((err as Error)?.message || err) }));
  }
}
