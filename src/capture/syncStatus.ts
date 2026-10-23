// Capture sync transparency (field report 2026-10-23, after a 2-hour
// meeting recorded offline and drained in a 14 s burst nobody saw):
//
//   "I had no indication that there was any locally buffered content
//    in the app that was entirely invisible. And when it was pushing
//    it, I couldn't see that it was pushing it. And when it was
//    thinking and processing just now, I couldn't see that."
//
// This module is the single source of truth for everything that
// happens to a meeting's audio AFTER the mic — on this device and on
// the server — so the pill can keep saying something true while no
// recording is live:
//
//   pending > 0, online === false  →  "Saved on this phone — waiting for network"
//   pending > 0, online            →  "Uploading k of N"
//   processing                     →  "Transcribing…"   (server status 'transcribing')
//   ready                          →  "Transcript ready — tap to open"
//
// Inputs: the uploader's drain loop (every list + every ack), the
// network verdict of its last request, the deferred /stop landing, and
// the server's capture_changed envelopes. Envelopes can be missed (the
// app was backgrounded, the SSE ring evicted it), so after a stop the
// server is also POLLED until the capture settles — the pill must not
// say "Transcribing…" forever because one event never arrived.

import { apiUrl } from '../apiBase.ts';
import { getLedger } from './segmentStore.ts';
import { log } from '../util/log.ts';

export interface CaptureSyncState {
  /** Sealed segments on this device the server has not acked yet. */
  pending: number;
  /** Size of the backlog being drained; resets once pending hits 0.
   *  "Uploading 57 of 132" is (batch - pending + 1) of batch. */
  batch: number;
  /** Network as seen by the uploader's last request (null = unknown). */
  online: boolean | null;
  /** Titles of the captures that still have buffered audio here. */
  titles: string[];
  /** The server is building a transcript for this capture. */
  processing: { id: string; title: string } | null;
  /** A transcript just finished (cleared after READY_MS). */
  ready: { id: string; title: string; at: number } | null;
}

/** How long "Transcript ready" stays up. */
export const READY_MS = 12_000;
/** Post-stop status polling: fast at first (a short meeting finalizes
 *  in seconds), then relaxed; bounded so a lost capture can't be polled
 *  forever. */
const POLL_FAST_MS = 4_000;
const POLL_SLOW_MS = 15_000;
const POLL_FAST_FOR_MS = 90_000;
const POLL_MAX_MS = 20 * 60_000;

let state: CaptureSyncState = {
  pending: 0, batch: 0, online: null, titles: [], processing: null, ready: null,
};
/** Captures this device has uploaded for or stopped — the only ones
 *  whose server status is ours to report. */
const touched = new Set<string>();
let pollTimer: number | null = null;
let pollStartedAt = 0;
let readyTimer: number | null = null;
let wired = false;

export function getSyncState(): CaptureSyncState {
  return { ...state, titles: [...state.titles] };
}

function emit(): void {
  try {
    window.dispatchEvent(new CustomEvent('parley:capture-sync', { detail: getSyncState() }));
  } catch { /* non-browser */ }
}

/** Uploader drain loop: called on every queue listing and every ack. */
export function reportUploader(info: { pending: number; captureIds: string[] }): void {
  const pending = Math.max(0, info.pending);
  state.batch = pending === 0 ? 0 : Math.max(state.batch, pending);
  state.pending = pending;
  for (const id of info.captureIds) touched.add(id);
  if (pending === 0 && state.titles.length) state.titles = [];
  emit();
  if (pending > 0) void resolveTitles(info.captureIds);
}

async function resolveTitles(ids: string[]): Promise<void> {
  const titles: string[] = [];
  for (const id of Array.from(new Set(ids))) {
    try {
      const e = await getLedger(id);
      if (e?.title) titles.push(e.title);
    } catch { /* ledger unavailable — the count still shows */ }
  }
  if (state.pending === 0) return;              // drained while we looked
  if (titles.join('\u0000') === state.titles.join('\u0000')) return;
  state.titles = titles;
  emit();
}

/** The uploader's last request reached the server (true) or threw (false). */
export function reportNetwork(online: boolean): void {
  if (state.online === online) return;
  state.online = online;
  emit();
}

/** The deferred /stop landed: the server now owns the meeting and is
 *  (or is about to be) transcribing it. */
export function reportStopped(id: string, title: string): void {
  touched.add(id);
  state.processing = { id, title: title || 'Meeting' };
  state.ready = null;
  emit();
  startPolling(id);
}

/** capture_changed envelope (any device) — only ours are reported. */
export function reportCaptureChanged(capture: { id?: string; title?: string; status?: string } | null | undefined): void {
  if (!capture?.id || !touched.has(capture.id)) return;
  applyStatus(capture as { id: string; title?: string; status?: string });
}

function applyStatus(c: { id: string; title?: string; status?: string }): void {
  const title = c.title || state.processing?.title || 'Meeting';
  if (c.status === 'transcribing' || c.status === 'recording') {
    // 'recording' after our stop = the server reopened it for a late
    // backlog (the 2026-10-23 drain) — still in progress from here.
    if (!state.processing || state.processing.id !== c.id) {
      state.processing = { id: c.id, title };
      state.ready = null;
      emit();
    }
    if (pollTimer == null) startPolling(c.id);
    return;
  }
  if (c.status === 'complete' || c.status === 'failed' || c.status === 'discarded') {
    if (state.processing?.id !== c.id) return;
    state.processing = null;
    stopPolling();
    if (c.status === 'complete') {
      state.ready = { id: c.id, title, at: Date.now() };
      if (readyTimer != null) window.clearTimeout(readyTimer);
      readyTimer = window.setTimeout(() => {
        readyTimer = null;
        if (state.ready?.id === c.id) { state.ready = null; emit(); }
      }, READY_MS);
    }
    emit();
  }
}

function startPolling(id: string): void {
  stopPolling();
  pollStartedAt = Date.now();
  const tick = async () => {
    pollTimer = null;
    if (!state.processing || state.processing.id !== id) return;
    const elapsed = Date.now() - pollStartedAt;
    if (elapsed > POLL_MAX_MS) {
      log(`[capture-sync] gave up polling ${id} after ${Math.round(elapsed / 60000)} min`);
      state.processing = null;
      emit();
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/parley/captures/${encodeURIComponent(id)}`));
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const cap = body?.capture ?? body;
        if (cap?.id) applyStatus(cap);
      } else if (res.status === 404) {
        state.processing = null;
        emit();
        return;
      }
    } catch { /* offline — keep polling */ }
    if (state.processing?.id === id) {
      pollTimer = window.setTimeout(tick, elapsed < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS);
    }
  };
  pollTimer = window.setTimeout(tick, POLL_FAST_MS);
}

function stopPolling(): void {
  if (pollTimer != null) { window.clearTimeout(pollTimer); pollTimer = null; }
}

/** Wire the cross-device envelope listener once. Idempotent. */
export function initSyncStatus(): void {
  if (wired) return;
  wired = true;
  try {
    window.addEventListener('parley:capture-changed-remote', (ev) => {
      const detail = (ev as CustomEvent).detail || {};
      reportCaptureChanged(detail?.capture);
    });
  } catch { /* non-browser */ }
}

/** Test seam. */
export function __resetSyncStatusForTest(): void {
  stopPolling();
  if (readyTimer != null) { window.clearTimeout(readyTimer); readyTimer = null; }
  touched.clear();
  state = { pending: 0, batch: 0, online: null, titles: [], processing: null, ready: null };
}
