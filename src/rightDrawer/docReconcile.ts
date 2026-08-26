// Stale live-doc reconcile — "Meeting 2026-08-24 (live)" field report
// 2026-08-26: a meeting doc stayed live-titled TWO DAYS after the
// meeting ended, body still "_Live transcript — recording in
// progress_", player strip hidden (isLiveCaptureDoc gates it on the
// title's "(live)" suffix).
//
// Why it happens: the pipeline's FINISHED doc_show push (terminal
// status, re-titled, full transcript) is a one-shot SSE envelope. If
// no client is connected when the meeting ends, the envelope is missed
// — the 128-entry replay ring churns fast (every reply_delta rides it)
// — and the localStorage-persisted shelf doc (parley.docs.v2) keeps
// its mid-meeting snapshot forever. Same missed-envelope class as the
// answered-question replay bug fixed 2026-08-25. Only connected
// clients heal; every other device is stuck.
//
// The fix: docs are PERSISTED state pointing at server truth (the
// capture manifest), so persisted state must be reconciled against
// that truth — on boot after hydrate, and on every doc-panel open.
// Push stays the fast path; this is the catch-up path.

import { apiUrl } from '../apiBase.ts';
import { listDocs, removeDoc, setDoc, type DocState } from './docStore.ts';
import { isLiveCaptureDoc } from './modules/doc.ts';

/** Statuses under which the "(live)" title is HONEST — the meeting (or
 *  its transcription tail) is genuinely still running server-side.
 *  'pending' can't have pushed a doc, but treat it as live for the
 *  same reason: the capture may still become one. */
const LIVE_STATUSES = new Set(['pending', 'recording', 'transcribing']);

/** In-flight sweep — concurrent triggers (boot + a fast panel open)
 *  coalesce into one instead of racing duplicate fetches. */
let sweeping: Promise<void> | null = null;

/** Reconcile every persisted still-live-titled capture doc against the
 *  capture manifest. Fire-and-forget (never blocks rendering); network
 *  failures silently keep the doc — the next panel open retries.
 *
 *  Zero-cost when healthy: with no live-titled capture docs on the
 *  shelf (the overwhelmingly common state) this makes no requests. */
export function reconcileStaleCaptureDocs(): Promise<void> {
  if (sweeping) return sweeping;
  const candidates = listDocs().filter(
    (d) => d.source === 'capture' && !!d.captureId && isLiveCaptureDoc(d),
  );
  if (!candidates.length) return Promise.resolve();
  sweeping = (async () => {
    for (const doc of candidates) await reconcileOne(doc);
  })().finally(() => { sweeping = null; });
  return sweeping;
}

async function reconcileOne(doc: DocState): Promise<void> {
  const capId = encodeURIComponent(doc.captureId!);
  try {
    const res = await fetch(apiUrl(`/api/parley/captures/${capId}`));
    if (res.status === 404) {
      // The capture is GONE (purged/hard-deleted) — a shelf entry
      // pointing at nothing is litter.
      removeDoc(doc.id);
      return;
    }
    if (!res.ok) return;   // server oddity — keep the doc, retry next open
    const status = (await res.json())?.capture?.status;
    if (LIVE_STATUSES.has(status)) return;   // genuinely live — leave it
    if (status === 'discarded') { removeDoc(doc.id); return; }

    // Terminal (complete/failed): pull the final transcript and heal
    // the doc in place — endpoint title (no "(live)" suffix), final
    // body, same path/captureId, so the title, meta line, body AND the
    // player strip (gated on the suffix) all recover together.
    const tr = await fetch(apiUrl(`/api/parley/captures/${capId}/transcript`));
    if (tr.status === 404) { removeDoc(doc.id); return; }   // no transcript ever landed
    if (!tr.ok) return;
    const data = await tr.json();
    if (typeof data?.content !== 'string') { removeDoc(doc.id); return; }
    // setDoc add-or-replaces by path identity and re-renders — an open
    // reader repaints mid-read. Accepted: the healed content is
    // strictly better than a two-day-old "recording in progress" lie.
    setDoc({
      title: typeof data.title === 'string' && data.title
        ? data.title
        : doc.title.replace(/\s*\(live\)\s*$/, ''),
      content: data.content,
      format: typeof data.format === 'string' && data.format ? data.format : 'markdown',
      path: doc.path,
      chatId: doc.chatId,
      source: 'capture',
      captureId: doc.captureId,
    }, { autoOpen: false });
  } catch { /* network failure — keep the doc; the next open retries */ }
}
