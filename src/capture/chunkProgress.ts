/**
 * @fileoverview What the recording pill shows about the chunk in flight.
 *
 * Field 2026-11-02: "when I start recording on laptop I should get a
 * transcript immediately, and an indicator that shows the status of the
 * chunk coming in (eg a pie icon filling out). I don't see anything."
 *
 * The recorder seals a chunk every SEGMENT_MS, uploads it, and the proxy
 * transcribes it and pushes the transcript doc. Three things the user can
 * see about that, computed here from recorder state so the pill stays a
 * renderer and this stays unit-testable:
 *
 *   fraction  how far the CURRENT chunk has filled (the pie)
 *   previous  what happened to the LAST sealed chunk: 'sending' (still
 *             uploading), 'transcribing' (uploaded, no transcript push
 *             yet), 'landed' (its words reached the Docs shelf), or
 *             'none' before anything was sealed
 *   label     the tooltip / aria text saying the same in words
 */

export type ChunkState = 'none' | 'sending' | 'transcribing' | 'landed';

export interface ChunkInputs {
  phase: string;
  /** epoch ms when the running chunk started; 0 when none is running. */
  segmentStartedAt: number;
  segmentMs: number;
  sealedSegments: number;
  uploadedSegments: number;
  landedSegments: number;
}

export interface ChunkProgress {
  /** 0..1 of the running chunk; 0 when no chunk is running. */
  fraction: number;
  /** Whole seconds of the running chunk so far. */
  elapsedSec: number;
  chunkMs: number;
  previous: ChunkState;
  /** 1-based number of the running chunk. */
  chunkNo: number;
  label: string;
}

export function chunkProgress(s: ChunkInputs, now: number = Date.now()): ChunkProgress {
  const running = s.phase === 'recording' && s.segmentStartedAt > 0;
  const elapsed = running ? Math.max(0, now - s.segmentStartedAt) : 0;
  const fraction = running && s.segmentMs > 0 ? Math.min(1, elapsed / s.segmentMs) : 0;
  const previous: ChunkState = s.sealedSegments === 0 ? 'none'
    : s.landedSegments >= s.sealedSegments ? 'landed'
      : s.uploadedSegments >= s.sealedSegments ? 'transcribing'
        : 'sending';
  const chunkNo = s.sealedSegments + 1;
  const secs = Math.floor(elapsed / 1000);
  const total = Math.round(s.segmentMs / 1000);
  const prevWords = previous === 'none' ? 'first chunk'
    : previous === 'landed' ? 'last chunk transcribed'
      : previous === 'transcribing' ? 'last chunk transcribing'
        : 'last chunk uploading';
  const label = running
    ? `Chunk ${chunkNo}: ${secs} s of ${total} s · ${prevWords}`
    : prevWords;
  return { fraction, elapsedSec: secs, chunkMs: s.segmentMs, previous, chunkNo, label };
}
