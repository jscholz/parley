/**
 * @fileoverview POST a Blob and get JSON back, bounded by a STALL timer
 * instead of a wall clock.
 *
 * WHY THIS EXISTS (field bug 2026-09-01, "Stalled — 1 queued (2:28)"):
 * /transcribe used fetchWithTimeout, which can only bound WALL CLOCK.
 * The budget was picked from the blob's SIZE — a proxy for how long the
 * upload takes that only holds while bandwidth is good. On a slow
 * transatlantic link (~20-25 KB/s) a 400KB dictation needs ~17-20s, but
 * a sub-1MB blob was given a flat 15s, so every single attempt was
 * killed mid-upload:
 *
 *     transcribe: request stream error after 17137ms at 400KB: aborted
 *     transcribe: request stream error after 20144ms at 384KB: aborted
 *     transcribe: request stream error after 19575ms at 272KB: aborted
 *
 * The blob never left the queue, so it retried forever — and each retry
 * re-uploaded from byte zero, burning the very bandwidth that was
 * scarce. Note the symmetry: the comment the old ceiling carried
 * documented the SAME wedge for the opposite case (3-minute memos), and
 * was "fixed" by scaling the proxy rather than measuring the quantity.
 *
 * The quantity that actually matters is `size / bandwidth`, and
 * bandwidth is not something the client can know up front. But it does
 * not need to: an upload that is MOVING BYTES is healthy no matter how
 * slow it is, and an upload that has moved nothing for 20s is wedged no
 * matter how fast the link is. So we abort on STALL, not on elapsed
 * time — which is bandwidth-independent by construction.
 *
 * fetch() exposes no upload progress (request streams are not shipped
 * everywhere and are not usable with a Blob body), so this uses
 * XMLHttpRequest, whose `upload.onprogress` does. Three bounds, because
 * a request has three ways to hang:
 *
 *   stallMs    — no upload bytes moved for this long. The fix.
 *   responseMs — body fully sent, server hasn't answered. (Deepgram
 *                batch latency; nothing is "progressing" here, so a
 *                wall clock IS the right instrument for this phase.)
 *   ceilingMs  — absolute cap, so a 1-byte-per-second trickle that
 *                technically never stalls still terminates.
 *
 * Environments without XMLHttpRequest (node unit tests, SSR) fall back
 * to fetchWithTimeout. That branch is bandwidth-blind, but it never
 * runs in a browser, which is the only place the field bug lives.
 */

import { fetchWithTimeout, TimeoutError } from './fetchWithTimeout.ts';

/** The three bounds on a single upload attempt. See file header. */
export interface AttemptBudget {
  /** Abort if the request body moves no bytes for this long. */
  stallMs: number;
  /** After the body is fully sent, how long to wait for the response. */
  responseMs: number;
  /** Absolute wall-clock cap for the whole attempt. */
  ceilingMs: number;
}

/** Timeout subclass raised when the UPLOAD stalled (as opposed to the
 *  server being slow to answer). Extends TimeoutError so every existing
 *  `instanceof TimeoutError` retry path keeps working unchanged; callers
 *  that want to narrate "slow link" specifically can check for this. */
export class StallTimeoutError extends TimeoutError {
  /** Bytes that had been sent when we gave up. */
  readonly sentBytes: number;
  /** Total bytes the request body was going to be (0 if unknown). */
  readonly totalBytes: number;
  constructor(url: string, ms: number, sentBytes: number, totalBytes: number) {
    super(url, ms, `upload stalled: no bytes sent for ${ms}ms `
      + `(${Math.round(sentBytes / 1024)}KB of ${Math.round(totalBytes / 1024)}KB): ${url}`);
    this.name = 'StallTimeoutError';
    this.sentBytes = sentBytes;
    this.totalBytes = totalBytes;
  }
}

/** Bytes-sent notification, fired on every upload progress tick. Lets
 *  the caller surface a MOVING counter — the difference between "this
 *  is uploading slowly" and "this is frozen", which the old
 *  indeterminate "Uploading audio (400 KB)…" line could not express. */
export type ProgressFn = (sentBytes: number, totalBytes: number) => void;

export interface JsonResponse { status: number; data: any; }

/** POST `body` to `url` and parse the JSON response, bounded by
 *  `budget`. Rejects with StallTimeoutError / TimeoutError on the three
 *  timeout paths, and with a plain Error on transport or parse failure —
 *  all transient by the caller's classification, i.e. "retry later",
 *  never "the user's audio is gone". */
export async function postJsonWithStallTimeout(
  url: string,
  body: Blob,
  contentType: string,
  budget: AttemptBudget,
  onProgress?: ProgressFn,
): Promise<JsonResponse> {
  const XHR = (globalThis as any).XMLHttpRequest;
  if (typeof XHR !== 'function') {
    // No upload-progress instrument available. Use the most generous of
    // the three bounds that still respects the ceiling — better a slow
    // attempt than the guaranteed-too-short loop we are fixing.
    const timeoutMs = Math.min(budget.ceilingMs, Math.max(budget.stallMs, budget.responseMs));
    const res = await fetchWithTimeout(url, {
      method: 'POST', headers: { 'Content-Type': contentType }, body, timeoutMs,
    });
    return { status: res.status, data: await res.json() };
  }

  return await new Promise<JsonResponse>((resolve, reject) => {
    const xhr = new XHR();
    const total = body.size;
    let sent = 0;
    let uploadDone = false;
    let settled = false;
    // One re-armable timer for the CURRENT phase (stall while
    // uploading, response once the body is out), one absolute ceiling,
    // and one fallback for environments that never report upload
    // progress at all (see clearFallback).
    let phaseTimer: any = null;
    let ceilingTimer: any = null;
    let fallbackTimer: any = null;

    const cleanup = () => {
      if (phaseTimer !== null) { clearTimeout(phaseTimer); phaseTimer = null; }
      if (ceilingTimer !== null) { clearTimeout(ceilingTimer); ceilingTimer = null; }
      if (fallbackTimer !== null) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    };
    /** The stall instrument only works if SOMETHING reports upload
     *  progress. Until the first upload event proves it does, keep a
     *  plain wall clock running — otherwise an environment with no
     *  upload instrumentation would be governed solely by the (long)
     *  stall window, which is strictly worse than the behaviour we are
     *  replacing. Cleared the moment any upload event arrives, which is
     *  the whole point: evidence of observable progress is what earns
     *  the request the bandwidth-independent budget. */
    const clearFallback = () => {
      if (fallbackTimer !== null) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // abort() fires onabort/onerror; `settled` swallows the echo.
      try { xhr.abort(); } catch { /* already dead */ }
      reject(err);
    };
    const succeed = (v: JsonResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };
    /** (Re)arm the phase deadline. Called on every progress tick while
     *  uploading — this is the whole mechanism: bytes moving pushes the
     *  deadline out, so a slow-but-alive upload is never killed. */
    const armPhase = (ms: number, mkErr: () => Error) => {
      if (phaseTimer !== null) clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => fail(mkErr()), ms);
    };
    const armStall = () => armPhase(budget.stallMs,
      () => new StallTimeoutError(url, budget.stallMs, sent, total));

    try {
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', contentType);
    } catch (e) {
      reject(e as Error);
      return;
    }

    // Upload progress must be wired BEFORE send() or the early ticks are
    // lost. `total` from the event is the on-the-wire size; fall back to
    // the blob size when the length is not computable.
    if (xhr.upload) {
      xhr.upload.onprogress = (e: any) => {
        if (settled || uploadDone) return;
        clearFallback();
        sent = e && typeof e.loaded === 'number' ? e.loaded : sent;
        const t = e && e.lengthComputable && e.total ? e.total : total;
        try { onProgress?.(sent, t); } catch { /* narration must not break the upload */ }
        armStall();
      };
      xhr.upload.onload = () => {
        if (settled || uploadDone) return;
        clearFallback();
        uploadDone = true;
        sent = total;
        try { onProgress?.(total, total); } catch { /* ignore */ }
        // Body is out; nothing will "progress" until the server answers,
        // so switch from the stall instrument to a wall clock.
        armPhase(budget.responseMs, () => new TimeoutError(url, budget.responseMs,
          `no response ${budget.responseMs}ms after upload completed: ${url}`));
      };
    }

    xhr.onload = () => {
      if (settled) return;
      const status = xhr.status;
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      let data: any;
      try {
        data = JSON.parse(text || 'null');
      } catch {
        // Not JSON (HTML error page, truncated body). Transient by
        // classification — but say WHICH status, so a misconfigured
        // route is debuggable from a field log instead of showing up as
        // a bare SyntaxError.
        fail(new Error(`transcribe: unparseable response (HTTP ${status})`));
        return;
      }
      succeed({ status, data });
    };
    xhr.onerror = () => fail(new Error(`transcribe: network error (HTTP ${xhr.status || 0})`));
    xhr.onabort = () => fail(new Error('transcribe: request aborted'));

    ceilingTimer = setTimeout(() => fail(new TimeoutError(url, budget.ceilingMs,
      `attempt exceeded ${budget.ceilingMs}ms ceiling `
      + `(${Math.round(sent / 1024)}KB of ${Math.round(total / 1024)}KB sent): ${url}`)),
    budget.ceilingMs);

    // Arm the stall deadline from send(), not from the first progress
    // tick — an upload that never emits a single tick is exactly the
    // "dead link" case this is supposed to catch.
    armStall();
    // …and the no-instrumentation fallback alongside it, until an upload
    // event proves progress is observable.
    fallbackTimer = setTimeout(() => fail(new TimeoutError(url, budget.responseMs,
      `no response ${budget.responseMs}ms after request (no upload progress reported): ${url}`)),
    budget.responseMs);
    try {
      xhr.send(body);
    } catch (e) {
      fail(e as Error);
    }
  });
}
