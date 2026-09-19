/**
 * Segment stitching — ffmpeg concat-demuxer over a capture's sealed
 * segments (all one codec: a single recorder config produced them).
 * Shared by the diarize pass (16k mono WAV — what batch STT wants) and
 * the playback endpoint (mono AAC/m4a — ~10× smaller, streams + seeks
 * well in <audio>). Extracted from captureTranscribe.ts when the
 * player strip needed the same primitive (capture plan §3.6).
 */

import { promises as fs } from 'node:fs';

export type StitchFormat = 'wav16k' | 'm4a';

/** Concat + transcode `segmentFiles` (in order) into `outFile`.
 *  Returns outFile. Throws with ffmpeg's stderr tail on failure. */
export async function ffmpegStitch(
  segmentFiles: string[],
  outFile: string,
  format: StitchFormat = 'wav16k',
): Promise<string> {
  const { execFile } = await import('node:child_process');
  const listFile = `${outFile}.list.txt`;
  await fs.writeFile(
    listFile,
    segmentFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
  );
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];
  if (format === 'wav16k') args.push('-ac', '1', '-ar', '16000');
  // +faststart moves the moov index to the FRONT of the file. ffmpeg's
  // default writes it last; Chrome copes by range-reading the tail
  // first, WebKit/AVFoundation (iOS, Safari, the CAP shell) is far less
  // forgiving of index-at-end MP4 over HTTP. Playback files stitched
  // before 2026-09-19 lack this — captureAudio.ts re-stitches them.
  else args.push('-ac', '1', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart');
  args.push(outFile);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', args, { timeout: 600_000 }, (err, _out, stderr) => {
        if (err) reject(new Error(`ffmpeg: ${String(stderr).slice(-400)}`));
        else resolve();
      });
    });
  } catch (err) {
    // A killed/failed ffmpeg leaves a PARTIAL outFile — existence is
    // the playback endpoint's cache key, so a torn file would be
    // served forever (audit 2026-07-09 #8). Remove both artifacts.
    await fs.unlink(outFile).catch(() => { /* never written */ });
    await fs.unlink(listFile).catch(() => { /* best-effort */ });
    throw err;
  }
  await fs.unlink(listFile).catch(() => { /* best-effort */ });
  return outFile;
}
