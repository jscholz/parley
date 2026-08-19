/**
 * Append-only capture lifecycle audit (2026-08-18 data-loss postmortem,
 * P0 #3). The incident's DELETE caller is UNKNOWABLE because the only
 * record of a capture's lifecycle was the manifest the delete destroyed.
 * This log fixes that: one JSONL line per lifecycle event, written
 * OUTSIDE the per-capture directories (a sibling of index.json), so it
 * survives discard, purge, and hard delete.
 *
 * Deliberately dumb: fs.appendFile of one small line, serialized
 * through a promise chain so concurrent events never interleave.
 * Auditing must never break the operation it describes — append errors
 * are logged and swallowed. The file is never rewritten, truncated, or
 * pruned by any code path in this repo.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface CaptureAuditEvent {
  /** Unique event id (`evt_<epoch-ms>_<hex>`). */
  event_id: string;
  /** Epoch ms, server clock. */
  ts: number;
  capture_id: string;
  /** 'create' | 'activate' | 'abort-start' | 'segment' | 'stop' |
   *  'discard' | 'restore' | 'purge' | 'delete' | 'expire-pending' |
   *  'expire-discarded' | 'stale-heal' — plain string so forks can add. */
  action: string;
  /** Explicit human-readable reason ("user cancel", "getUserMedia
   *  rejected", "retention window elapsed", …). */
  reason?: string;
  /** Caller identity: 'pwa-recorder', 'api', 'sweep', … (from the
   *  x-parley-client header when the caller is HTTP). */
  source?: string;
  user_agent?: string;
  /** Remote address / x-forwarded-for of the HTTP caller. */
  remote?: string;
  prior_status?: string;
  new_status?: string;
  /** Pre-action counts — what was at stake when the action ran. */
  segment_count?: number;
  total_bytes?: number;
  result: 'ok' | 'error';
  error?: string;
  /** Action-specific extras (e.g. { seq } for 'segment'). */
  detail?: Record<string, unknown>;
}

/** Where the log lives — wired by capture.ts (the module that owns the
 *  captures dir resolution) at import time; tests get it via
 *  initCapture()'s dir override transitively. */
let fileResolver: (() => string) | null = null;

export function setAuditFileResolver(fn: () => string): void {
  fileResolver = fn;
}

export function captureAuditPath(): string {
  if (!fileResolver) throw new Error('capture audit not initialized (setAuditFileResolver)');
  return fileResolver();
}

// Serialize appends: concurrent lifecycle events (segment uploads race
// stop, sweep races create) must each land as one intact line.
let tail: Promise<void> = Promise.resolve();

/** Append one event. NEVER throws — the audit is an observer, not a
 *  gate; a full disk must not turn into a failed stop. Returns a
 *  promise so tests can await durability. */
export function recordCaptureEvent(
  evt: Omit<CaptureAuditEvent, 'event_id' | 'ts'> & { ts?: number },
): Promise<void> {
  const full: CaptureAuditEvent = {
    event_id: `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    ts: evt.ts ?? Date.now(),
    ...evt,
  };
  tail = tail.then(async () => {
    try {
      const file = captureAuditPath();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, JSON.stringify(full) + '\n');
    } catch (e) {
      console.error(`[capture-audit] append failed (${full.action} ${full.capture_id}): ${String(e)}`);
    }
  });
  return tail;
}

/** Parsed log, oldest first. Torn tail lines (crash mid-append) are
 *  skipped, never fatal — the log must stay readable after any crash. */
export async function readCaptureAudit(): Promise<CaptureAuditEvent[]> {
  await tail;   // settle in-flight appends first
  let raw = '';
  try {
    raw = await fs.readFile(captureAuditPath(), 'utf8');
  } catch {
    return [];
  }
  const out: CaptureAuditEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as CaptureAuditEvent); } catch { /* torn line */ }
  }
  return out;
}
