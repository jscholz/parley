// Serial segment uploader — drains the durable segmentStore buffer to
// POST /api/parley/captures/{id}/segments/{seq} (capture plan §3.2),
// and, since meeting mode went offline-first (2026-10-05), everything
// else the server has to be told about a capture that was started with
// no network: the create itself, activation, marks, the deferred stop.
//
// Contract with the server (proxy/parley/capture.ts):
//   * exactly-once by construction: the IDB copy is deleted only on a
//     2xx ack; a re-send after a lost ack gets `duplicate: true` and
//     acks again (same sha) — still safe to delete.
//   * 5xx / 429 / network errors are TRANSIENT → exponential backoff,
//     retry forever (queue.ts idiom — the meeting outlives the outage).
//   * 4xx are PERMANENT (bad request, frozen capture) → drop the segment
//     and keep draining; one poisoned segment must not dam the queue.
//     Exception: 409 may be a corrupt-upload sha mismatch (transient —
//     the body re-reads fine next time), so 409 gets MAX_409_ATTEMPTS
//     retries before it's treated as permanent (divergent content).
//   * 404 on a segment whose capture is in the LEDGER means the server
//     has not met this capture yet (offline start, or the create ack was
//     lost) — the segment is kept and the capture re-registered. Only a
//     capture with no ledger row (pre-ledger client) treats 404 as gone.
//
// Registration gate: before the first segment of a ledgered capture is
// sent, the uploader PUTs the capture upstream — `POST /captures` with
// the client-minted id (idempotent server-side) and a best-effort
// `/activate`. A one-active-rule 409 at create is transient (another
// device is mid-meeting; this one syncs after). Other 4xx are permanent:
// the ledger row records the refusal, its segments are parked (durable
// copy kept) and the UI is told.
//
// Deferred stop: once a ledgered capture has `stopRequested` and no
// segment of it is left in the buffer, `POST /stop` is sent and the row
// is dropped. The server's own stale-heal would complete it eventually,
// but an explicit stop runs the transcription pipeline NOW.
//
// Serial on purpose: segments are ~45s apart, so the queue depth is
// normally 0-1; ordering keeps the server manifest append-mostly and
// makes the rolling transcriber's in-order life easy.

import { apiUrl } from '../apiBase.ts';
import {
  listPending, removeSegment, listLedger, getLedger, updateLedger, removeLedger,
  type PendingSegment, type CaptureLedgerEntry,
} from './segmentStore.ts';
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
  /** The server now knows this capture (create acked). `capture` is the
   *  server's manifest — the recorder reads the linked chat / title the
   *  server settled on. */
  onRegistered?: (entry: CaptureLedgerEntry, capture: any) => void;
  /** Registration refused for good (4xx). Audio stays buffered. */
  onRegisterFailed?: (entry: CaptureLedgerEntry, reason: string) => void;
  /** `POST /stop` acked for a capture the user had stopped offline. */
  onStopped?: (captureId: string) => void;
  /** Network reachability as observed by the last request: false after a
   *  fetch that threw, true after any HTTP answer. Drives the pill's
   *  "offline — saving locally" chip. */
  onNetwork?: (online: boolean) => void;
}

const MAX_409_ATTEMPTS = 3;

export interface Uploader {
  /** Nudge the drain loop (call after every segmentStore.put, ledger
   *  change, or `online` event). Safe to call while a drain is running —
   *  coalesces. */
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

const JSON_HEADERS = { 'content-type': 'application/json', 'x-parley-client': 'pwa-recorder' };

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
  // Captures whose registration the server refused for good — their
  // segments are parked wholesale (see ensureRegistered).
  const parkedCaptures = new Set<string>();
  let lastOnline: boolean | null = null;

  function notifyDrained(): void {
    const rs = drainedResolvers;
    drainedResolvers = [];
    for (const r of rs) r();
    opts.onDrained?.();
  }

  function network(online: boolean): void {
    if (lastOnline === online) return;
    lastOnline = online;
    opts.onNetwork?.(online);
  }

  /** fetch that reports reachability; throws on network failure. */
  async function call(url: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch (e) {
      network(false);
      throw e;
    }
    network(true);
    return res;
  }

  // ── registration (offline-started captures) ──────────────────────

  async function ensureRegistered(captureId: string): Promise<'ready' | 'retry' | 'parked'> {
    const entry = await getLedger(captureId);
    if (!entry) return 'ready';                        // pre-ledger capture: server created it
    if (entry.registerFailed) return 'parked';
    if (!entry.registered) {
      let res: Response;
      try {
        res = await call(apiUrl('/api/parley/captures'), {
          method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({
            id: entry.id,
            title: entry.title || undefined,
            linked_chat: entry.linkedChat || undefined,
            minted_session: entry.mintedSession || undefined,
            diarize: entry.diarize,
            auto_ingest: entry.autoIngest,
          }),
        });
      } catch {
        return 'retry';
      }
      if (res.status === 409 || res.status === 429 || res.status >= 500) {
        // 409 here is the one-active rule: another device is recording
        // right now. This capture syncs when that one stops.
        return 'retry';
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any));
        const reason = String(err?.error || `create refused (${res.status})`);
        await updateLedger(captureId, { registerFailed: reason });
        log(`[capture-upload] ${captureId}: registration refused — ${reason}; audio kept, segments parked`);
        opts.onRegisterFailed?.(entry, reason);
        return 'parked';
      }
      const body = await res.json().catch(() => ({} as any));
      const updated = await updateLedger(captureId, { registered: true });
      opts.onRegistered?.(updated ?? { ...entry, registered: true }, body?.capture ?? null);
    }
    const fresh = (await getLedger(captureId)) ?? entry;
    if (!fresh.activated) {
      // Best effort: a first segment implies activation server-side, and
      // a capture the server already moved on (reopened after a stale
      // heal) answers 409 here — neither is a reason to hold the audio.
      try {
        const res = await call(apiUrl(`/api/parley/captures/${encodeURIComponent(captureId)}/activate`), {
          method: 'POST', headers: JSON_HEADERS,
        });
        if (res.ok || (res.status >= 400 && res.status < 500)) {
          await updateLedger(captureId, { activated: true });
        } else {
          return 'retry';
        }
      } catch {
        return 'retry';
      }
    }
    if (fresh.titleDirty) {
      try {
        const res = await call(apiUrl(`/api/parley/captures/${encodeURIComponent(captureId)}`), {
          method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ title: fresh.title }),
        });
        if (res.ok || (res.status >= 400 && res.status < 500)) await updateLedger(captureId, { titleDirty: false });
      } catch { /* retried with the next kick */ }
    }
    if (fresh.marks.length) {
      // Marks are decorative; deliver what we can, keep the rest.
      const delivered: number[] = [];
      for (const tMs of fresh.marks) {
        try {
          const res = await call(apiUrl(`/api/parley/captures/${encodeURIComponent(captureId)}/marks`), {
            method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ t_ms: tMs }),
          });
          if (res.ok || (res.status >= 400 && res.status < 500)) delivered.push(tMs);
          else break;
        } catch { break; }
      }
      if (delivered.length) {
        await updateLedger(captureId, (e) => { e.marks = e.marks.filter((t) => !delivered.includes(t)); });
      }
    }
    return 'ready';
  }

  // ── segments ────────────────────────────────────────────────────

  async function uploadOne(seg: PendingSegment): Promise<'acked' | 'retry' | 'dropped' | 'parked' | 'unregistered'> {
    const sha = await sha256Hex(seg.blob);
    const headers: Record<string, string> = {
      'content-type': seg.mime || 'application/octet-stream',
      'x-parley-t0-ms': String(seg.t0Ms),
    };
    if (sha) headers['x-parley-sha256'] = sha;
    let res: Response;
    try {
      res = await call(
        apiUrl(`/api/parley/captures/${encodeURIComponent(seg.captureId)}/segments/${seg.seq}`),
        { method: 'POST', headers, body: seg.blob },
      );
    } catch {
      return 'retry';                    // network — transient by definition
    }
    if (res.ok) return 'acked';          // includes duplicate:true re-acks
    if (res.status === 404) {
      // The server has not met this capture: an offline start whose
      // create has not landed, or a lost create ack. Re-register and
      // come back; a capture with no ledger row really is gone.
      const entry = await getLedger(seg.captureId);
      if (!entry) return 'dropped';
      await updateLedger(seg.captureId, { registered: false, activated: false });
      return 'unregistered';
    }
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

  // ── owed registrations ──────────────────────────────────────────

  /** Ledger rows the server has not met yet. Registering does not wait
   *  for the first segment: online, "Recording started" should land in
   *  the chat the moment the mic is live (as it did when create came
   *  first); offline, this is the loop that keeps trying. */
  async function registrationsOwed(): Promise<CaptureLedgerEntry[]> {
    return (await listLedger()).filter((e) => !e.registered && !e.registerFailed && !parkedCaptures.has(e.id));
  }

  // ── deferred stops ──────────────────────────────────────────────

  /** Ledger rows the user has stopped whose audio is fully acked. */
  async function stopsOwed(queue: PendingSegment[]): Promise<CaptureLedgerEntry[]> {
    const withAudio = new Set(queue.map((s) => s.captureId));
    return (await listLedger()).filter((e) =>
      e.stopRequested && !e.registerFailed && !withAudio.has(e.id) && !parkedCaptures.has(e.id));
  }

  async function postStop(entry: CaptureLedgerEntry): Promise<'done' | 'retry'> {
    const reg = await ensureRegistered(entry.id);
    if (reg === 'retry') return 'retry';
    if (reg === 'parked') { parkedCaptures.add(entry.id); return 'done'; }
    try {
      const res = await call(apiUrl(`/api/parley/captures/${encodeURIComponent(entry.id)}/stop`), {
        method: 'POST', headers: JSON_HEADERS,
      });
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        // 4xx = the server already moved this capture on (healed,
        // discarded elsewhere): nothing more we can say about it.
        await removeLedger(entry.id);
        opts.onStopped?.(entry.id);
        return 'done';
      }
      return 'retry';
    } catch {
      return 'retry';
    }
  }

  // ── drain loop ──────────────────────────────────────────────────

  async function backoff(): Promise<void> {
    failures += 1;
    const delay = Math.min(maxDelay, baseDelay * 2 ** Math.min(failures - 1, 10));
    await new Promise((r) => setTimeout(r, delay));
  }

  async function drain(): Promise<void> {
    if (running) { rerun = true; return; }
    running = true;
    try {
      for (;;) {
        const queue = (await listPending()).filter((s) => !parked.has(s.key) && !parkedCaptures.has(s.captureId));
        pending = queue.length;
        if (!queue.length) {
          // Nothing to upload: register captures the server hasn't met…
          const unregistered = await registrationsOwed();
          if (unregistered.length) {
            const reg = await ensureRegistered(unregistered[0].id);
            if (reg === 'retry') { await backoff(); continue; }
            if (reg === 'parked') parkedCaptures.add(unregistered[0].id);
            failures = 0;
            continue;
          }
          // …then settle any stops that were waiting on the audio.
          const owed = await stopsOwed(queue);
          if (owed.length) {
            const outcome = await postStop(owed[0]);
            if (outcome === 'retry') { await backoff(); continue; }
            failures = 0;
            continue;
          }
          notifyDrained();
          if (!rerun) break;
          rerun = false;
          continue;
        }
        const seg = queue[0];
        const reg = await ensureRegistered(seg.captureId);
        if (reg === 'retry') { await backoff(); continue; }
        if (reg === 'parked') {
          parkedCaptures.add(seg.captureId);
          opts.onDropped?.(seg, 'unregistered');
          continue;
        }
        const outcome = await uploadOne(seg);
        if (outcome === 'acked') {
          failures = 0;
          attempts409.delete(seg.key);
          await removeSegment(seg.key);
          pending -= 1;
          continue;
        }
        if (outcome === 'unregistered') { continue; }   // re-registers on the next pass
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
        await backoff();
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
