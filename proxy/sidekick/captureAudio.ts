/**
 * Capture playback endpoint — GET /api/sidekick/captures/{id}/audio
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

// One stitch at a time per capture — concurrent first-plays must not
// race two ffmpeg runs onto the same output file.
const inflight = new Map<string, Promise<string>>();

async function ensurePlaybackFile(id: string): Promise<string> {
  const m = await getCapture(id);
  if (!m.segments.length) throw new CaptureError(404, 'capture has no audio segments');
  const out = path.join(captureDirPath(id), 'audio.play.m4a');
  try {
    await fs.access(out);
    return out;                       // cached from a previous request
  } catch { /* stitch below */ }
  let p = inflight.get(id);
  if (!p) {
    const stitch = stitchOverride ?? ffmpegStitch;
    p = stitch(m.segments.map((s) => segmentPath(id, s)), out, 'm4a')
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

/** GET /api/sidekick/captures/{id}/audio — full body or 206 partial. */
export async function handleCaptureAudio(
  req: IncomingMessage, res: ServerResponse, id: string,
): Promise<void> {
  try {
    const file = await ensurePlaybackFile(id);
    const { size } = await fs.stat(file);
    const range = typeof req.headers.range === 'string'
      ? req.headers.range.match(/^bytes=(\d*)-(\d*)$/) : null;
    const headers: Record<string, string | number> = {
      'Content-Type': 'audio/mp4',
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
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  } catch (err) {
    const status = err instanceof CaptureError ? err.status : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String((err as Error)?.message || err) }));
  }
}
