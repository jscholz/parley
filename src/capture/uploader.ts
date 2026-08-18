// Serial segment uploader — drains the durable segmentStore buffer to
// POST /api/parley/captures/{id}/segments/{seq} (capture plan §3.2).
//
// Contract with the server (proxy/parley/capture.ts):
//   * exactly-once by construction: the IDB copy is deleted only on a
//     2xx ack; a re-send after a lost ack gets `duplicate: true` and
//     acks again (same sha) — still safe to delete.
//   * 5xx / 429 / network errors are TRANSIENT → exponential backoff,
//     retry forever (queue.ts idiom — the meeting outlives the outage).
//   * 4xx are PERMANENT (bad request, unknown capture, frozen capture)
//     → drop the segment and keep draining; one poisoned segment must
//     not dam the queue. Exception: 409 may be a corrupt-upload sha
//     mismatch (transient — the body re-reads fine next time), so 409
//     gets MAX_409_ATTEMPTS retries before it's treated as permanent
//     (divergent content).
//
// Serial on purpose: segments are ~45s apart, so the queue depth is
// normally 0-1; ordering keeps the server manifest append-mostly and
// makes the rolling transcriber's in-order life easy.

import { apiUrl } from '../apiBase.ts';
import { listPending, removeSegment, type PendingSegment } from './segmentStore.ts';
import { log } from '../util/log.ts';

export interface UploaderOpts {
  fetchFn?: typeof fetch;
  /** First-retry delay; doubles per consecutive failure. Tests shrink it. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called when the queue fully drains (pill "all uploaded" state). */
  onDrained?: () => void;
  /** Called when a segment is dropped as permanent-failure. */
  onDropped?: (seg: PendingSegment, reason: string) => void;
}

const MAX_409_ATTEMPTS = 3;

export interface Uploader {
  /** Nudge the drain loop (call after every segmentStore.put). Safe to
   *  call while a drain is running — coalesces. */
  kick(): void;
  /** Un-acked segments at last check (UI hint, not authoritative). */
  pendingCount(): number;
  /** Resolve when the current queue is empty (stop-flow waits on this
   *  before showing "uploaded"). */
  drained(): Promise<void>;
}

async function sha256Hex(blob: Blob): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;   // no subtle crypto (http origin) → server hashes anyway
  }
}

export function createUploader(opts: UploaderOpts = {}): Uploader {
  const fetchFn = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const baseDelay = opts.baseDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 60_000;

  let running = false;
  let rerun = false;
  let failures = 0;
  let pending = 0;
  let drainedResolvers: (() => void)[] = [];
  const attempts409 = new Map<string, number>();
  // Frozen-capture segments: durable copy KEPT in IDB, skipped for the
  // rest of this session so they can't dam the queue. Recoverable
  // later (retro re-upload tooling / manual).
  const parked = new Set<string>();

  function notifyDrained(): void {
    const rs = drainedResolvers;
    drainedResolvers = [];
    for (const r of rs) r();
    opts.onDrained?.();
  }

  async function uploadOne(seg: PendingSegment): Promise<'acked' | 'retry' | 'dropped' | 'parked'> {
    const sha = await sha256Hex(seg.blob);
    const headers: Record<string, string> = {
      'content-type': seg.mime || 'application/octet-stream',
      'x-parley-t0-ms': String(seg.t0Ms),
    };
    if (sha) headers['x-parley-sha256'] = sha;
    let res: Response;
    try {
      res = await fetchFn(
        apiUrl(`/api/parley/captures/${encodeURIComponent(seg.captureId)}/segments/${seg.seq}`),
        { method: 'POST', headers, body: seg.blob },
      );
    } catch {
      return 'retry';                    // network — transient by definition
    }
    if (res.ok) return 'acked';          // includes duplicate:true re-acks
    if (res.status === 409) {
      // Two very different 409s (audit 2026-07-09 P0#1): a FROZEN
      // capture (finalized before this segment landed — outage at
      // stop, stale-heal, another device) must NOT delete the durable
      // copy; the audio exists and is recoverable. Park it instead.
      // Corrupt-upload/divergent 409s keep the bounded-retry-then-drop
      // policy.
      const err = await res.json().catch(() => ({} as any));
      if (/frozen/i.test(String(err?.error ?? ''))) return 'parked';
      const n = (attempts409.get(seg.key) ?? 0) + 1;
      attempts409.set(seg.key, n);
      return n < MAX_409_ATTEMPTS ? 'retry' : 'dropped';
    }
    if (res.status === 429 || res.status >= 500) return 'retry';
    return 'dropped';                    // other 4xx — permanent
  }

  async function drain(): Promise<void> {
    if (running) { rerun = true; return; }
    running = true;
    try {
      for (;;) {
        const queue = (await listPending()).filter((s) => !parked.has(s.key));
        pending = queue.length;
        if (!queue.length) { notifyDrained(); if (!rerun) break; rerun = false; continue; }
        const seg = queue[0];
        const outcome = await uploadOne(seg);
        if (outcome === 'acked') {
          failures = 0;
          attempts409.delete(seg.key);
          await removeSegment(seg.key);
          pending -= 1;
          continue;
        }
        if (outcome === 'dropped') {
          log(`[capture-upload] dropping segment ${seg.key} (permanent failure)`);
          attempts409.delete(seg.key);
          await removeSegment(seg.key);
          opts.onDropped?.(seg, 'permanent');
          continue;
        }
        if (outcome === 'parked') {
          log(`[capture-upload] parking segment ${seg.key} (capture frozen — durable copy kept)`);
          parked.add(seg.key);
          opts.onDropped?.(seg, 'frozen');
          continue;
        }
        // retry: back off, then loop re-lists (picks up new segments too)
        failures += 1;
        const delay = Math.min(maxDelay, baseDelay * 2 ** Math.min(failures - 1, 10));
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      running = false;
    }
  }

  return {
    kick() { void drain(); },
    pendingCount() { return pending; },
    drained() {
      return new Promise<void>((resolve) => {
        drainedResolvers.push(resolve);
        void drain();
      });
    },
  };
}
