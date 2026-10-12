/**
 * @fileoverview Sendword detector — fires onMatch when the user's mic
 * stream contains the configured commit phrase.
 *
 * Two source modes:
 *
 *   1. FED (preferred when caller already runs an STTProvider).
 *      Caller passes `feed: true`, the detector opens NO SR session,
 *      and the caller drives matching by calling `feedTranscript(ev)`
 *      on each transcript event from its own provider. Avoids racing
 *      a second Web Speech instance against the caller's, and respects
 *      the STTProvider contract (single listener — see stt-provider.ts
 *      docstring; "callers that need fan-out should multiplex above
 *      this layer"). Used by Listen mode when streamingEngine='local'.
 *
 *   2. STANDALONE (when `feed` is omitted). We construct our own
 *      `webkitSpeechRecognition` / `SpeechRecognition` instance in
 *      continuous + interim mode. Used when Listen runs against a
 *      server-side body transcription pipeline (streamingEngine='server')
 *      — the MediaRecorder blob → /transcribe path doesn't expose
 *      realtime transcript events to feed.
 *
 * Auto-restart loop (standalone path): Safari kills the SR session every
 * ~30s + on every server round trip. The `onend` handler restarts unless
 * stop() was explicitly invoked, so the detector survives long Listen
 * sessions. Fed path inherits whatever restart logic the caller's
 * provider implements (BrowserSttProvider has its own).
 *
 * Fail-soft: if `SpeechRecognition` is undefined OR `start()` throws
 * (Firefox without WebSpeech, browser quotas exceeded), the detector
 * silently no-ops in standalone mode. Listen falls back to silence-only
 * via its own timer; this module never throws past start().
 *
 * Phrase matching: caller resolves the phrase via getHandsfreeConfig().
 * Match on word boundary, case-insensitive, end-of-segment. The canonical
 * matcher lives in src/audio/shared/handsfree.ts (matchSendword) — this
 * module just plumbs the audio source.
 */

import { log, diag } from '../../util/log.ts';
import { continuesPastSendword } from '../shared/handsfree.ts';
import type { TranscriptEvent } from '../shared/stt-provider.ts';

export type SendwordOpts = {
  /** Phrase to match on. Empty string disables matching. Caller resolves
   *  the canonical phrase via getHandsfreeConfig(); this module just
   *  looks for whatever string it's given. */
  phrase: string;
  /** Fired when the phrase is detected in an interim or final result.
   *  This is a CANDIDATE: the caller arms a confirm window and commits
   *  when it elapses, unless `onUnmatch` fires first. */
  onMatch: () => void;
  /** Fired when speech continues past a matched phrase (it was
   *  mid-sentence — "it fell over because…"). Caller cancels the
   *  pending commit. Field 2026-10-12. */
  onUnmatch?: () => void;
  /** When true, this module opens NO SR session — caller will drive
   *  matching by calling `feedTranscript(ev)` on each transcript event
   *  from its own STTProvider. Use when the caller already runs Web
   *  Speech for body transcription (Listen mode + streamingEngine=local).
   *  When omitted, the standalone Web Speech path takes over. */
  feed?: boolean;
};

type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: any) => void) | null;
  onend: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onstart: ((ev: any) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

let sr: SR | null = null;
let opts: SendwordOpts | null = null;
let stopRequested = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
/** True when start() ran in FED mode — feedTranscript() is live, no SR
 *  was constructed, and stop() just clears state. */
let fedMode = false;
/** A match is pending confirmation. `pendingSegment` identifies the
 *  segment that matched (standalone: SR result index; fed: a counter
 *  bumped on every final) so a later transcript can be told apart as a
 *  revision of that segment or new speech. */
let pending = false;
let pendingSegment = -1;
let fedSegment = 0;

function clearPending(): void { pending = false; pendingSegment = -1; }

/** Route one transcript through the pending-match state machine.
 *  Returns true when it produced a (new) match. */
function consider(transcript: string, segment: number): boolean {
  if (!opts || !opts.phrase) return false;
  if (pending) {
    const same = segment === pendingSegment;
    if (continuesPastSendword(transcript, opts.phrase, same)) {
      diag(`[sendword] speech continued past "${opts.phrase}" — cancelling the pending commit: "${transcript.slice(-80)}"`);
      clearPending();
      try { opts.onUnmatch?.(); } catch (e: any) { diag(`[sendword] onUnmatch threw: ${e?.message || e}`); }
      return false;
    }
    // A revision of the matched segment that still ends in the phrase,
    // or a truncated final: the candidate stands. Don't re-fire.
    if (same) return false;
  }
  if (checkTranscript(transcript)) {
    pending = true;
    pendingSegment = segment;
    return true;
  }
  return false;
}

export function isSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  return typeof Ctor === 'function';
}

/** Build a fresh SR instance + wire handlers. Returns null if SR is
 *  unsupported OR construction throws. */
function build(): SR | null {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (typeof Ctor !== 'function') {
    diag('[sendword] build: no SpeechRecognition constructor available');
    return null;
  }
  let inst: SR;
  try {
    inst = new Ctor() as SR;
  } catch (e: any) {
    diag('[sendword] build: construct failed', e?.message);
    return null;
  }
  inst.continuous = true;
  inst.interimResults = true;
  inst.lang = 'en-US';
  inst.onresult = handleResult;
  inst.onend = handleEnd;
  inst.onerror = handleError;
  inst.onstart = () => diag('[sendword] SR onstart — session alive');
  return inst;
}

/** Run the phrase regex against a single transcript string. Shared
 *  between the standalone-SR onresult walker and the external-source
 *  TranscriptEvent listener. Returns true when a match fired (so the
 *  external listener can short-circuit). */
function checkTranscript(transcript: string): boolean {
  if (!opts || !opts.phrase) return false;
  const phrase = opts.phrase.trim().toLowerCase();
  if (!phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Same regex shape as test/commit-word.test.ts — word boundary,
  // optional trailing punctuation, END of the segment. A hit is a
  // candidate only (see consider()).
  const re = new RegExp(`\\b${escaped}\\b[\\s.,!?]*$`, 'i');
  if (!transcript) return false;
  const hit = re.test(transcript);
  // Diag every check so a "didn't fire" repro reveals whether checks
  // are happening at all (no transcripts arriving) vs happening but
  // not matching (regex / trailing-punctuation issue) vs matching but
  // onMatch failing.
  diag(`[sendword] check phrase="${phrase}" hit=${hit} transcript="${transcript}"`);
  if (hit) {
    log(`sendword: matched "${phrase}" in "${transcript}"`);
    try { opts.onMatch(); } catch (e: any) {
      diag(`[sendword] onMatch threw: ${e?.message || e}`);
    }
    return true;
  }
  return false;
}

function handleResult(ev: any): void {
  if (!opts || !opts.phrase) return;
  // Walk the new results in this event (resultIndex .. results.length-1)
  // and check each segment for the phrase.
  try {
    const start = ev.resultIndex || 0;
    const total = ev.results?.length ?? 0;
    diag(`[sendword] handleResult resultIndex=${start} total=${total}`);
    for (let i = start; i < total; i++) {
      const result = ev.results[i];
      const transcript = String(result?.[0]?.transcript || '');
      if (consider(transcript, i)) return;
    }
  } catch (e: any) {
    diag('[sendword] handleResult threw', e?.message);
  }
}

function handleEnd(_ev: any): void {
  diag(`[sendword] SR onend stopRequested=${stopRequested}`);
  // Auto-restart loop — Safari kills the session ~30s. Skip if stop()
  // was explicitly requested.
  if (stopRequested) return;
  if (restartTimer) clearTimeout(restartTimer);
  // Tiny delay so we don't tight-loop if the engine itself is in a
  // permanent error state.
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (stopRequested) return;
    sr = build();
    if (!sr) return;
    try { sr.start(); } catch (e: any) { diag('sendword: restart start() threw', e?.message); }
  }, 200);
}

function handleError(ev: any): void {
  const err = ev?.error || ev?.message || String(ev);
  diag('[sendword] SR onerror', err);
  // Some errors are fatal — don't auto-restart. `service-not-allowed`
  // is what WKWebView returns when the Web Speech API is gated entirely
  // (the standalone-SR path is essentially unavailable in Capacitor).
  // Without this guard, handleEnd would loop-restart forever, each restart
  // erroring immediately. The user falls back to silence-only
  // commit on Cap, which is a valid mode.
  //
  // Other fatal errors: `not-allowed` (mic permission denied),
  // `language-not-supported` (lang misconfigured). The transient
  // `network` and `aborted` errors should still auto-restart.
  if (err === 'service-not-allowed' || err === 'not-allowed' || err === 'language-not-supported') {
    diag(`[sendword] fatal error (${err}) — disabling auto-restart for this session`);
    stopRequested = true;
  }
}

/** Begin listening. Two paths:
 *
 *   - FED: `o.feed === true` → no SR session opened. Caller drives
 *     matching by calling `feedTranscript(ev)` on each transcript event
 *     from its own STTProvider. Returns true unconditionally — the
 *     "is matching live" question is the caller's responsibility.
 *
 *   - STANDALONE: `o.feed` omitted → construct our own SR. Fails soft on
 *     unsupported / construction errors and returns false so the
 *     caller knows to expect no matches.
 */
export function start(o: SendwordOpts): boolean {
  if (sr || fedMode) {
    diag(`[sendword] start: already running (sr=${!!sr} fed=${fedMode})`);
    return true;  // already running
  }
  opts = o;
  stopRequested = false;
  clearPending();
  fedSegment = 0;
  const supported = isSupported();
  diag(`[sendword] start phrase="${o.phrase}" mode=${o.feed ? 'fed' : 'standalone'} supported=${supported}`);
  if (o.feed) {
    fedMode = true;
    return true;
  }
  // Standalone mode: open our own SR session.
  sr = build();
  if (!sr) {
    diag('[sendword] start: build() returned null — Web Speech API unavailable in this WebView');
    return false;
  }
  try {
    sr.start();
    diag('[sendword] start: SR.start() invoked (waiting for onstart)');
  } catch (e: any) {
    diag('[sendword] start() threw', e?.message);
    sr = null;
    return false;
  }
  return true;
}

/** Caller-driven match check (FED mode). No-op when fedMode is false or
 *  the event isn't a user transcript. Caller invokes this from their own
 *  STTProvider.onTranscript listener so a single listener does both body
 *  accumulation and sendword matching — STTProvider only supports one
 *  listener (see stt-provider.ts contract). */
export function feedTranscript(ev: TranscriptEvent): void {
  if (!fedMode || !opts) {
    // Skip silently — feedTranscript is called from a hot path
    // (per-event listener), don't log every drop. start() logs the
    // mode at startup; if mode is wrong, that's where to see it.
    return;
  }
  if (ev.role !== 'user') return;
  const seg = fedSegment;
  // A final closes its segment: whatever arrives next is new speech.
  if (ev.is_final) fedSegment += 1;
  if (!ev.text) return;
  consider(ev.text, seg);
}

/** Stop + release. Idempotent. In FED mode just clears state (the
 *  caller's provider lifecycle is unaffected). */
export function stop(): void {
  stopRequested = true;
  clearPending();
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  fedMode = false;
  // Clear opts BEFORE sr.stop(): unlike abort(), a graceful stop can
  // flush pending results through onresult — a sendword in that flush
  // must not fire onMatch after the caller asked us to stop.
  opts = null;
  if (sr) {
    // stop() (graceful) instead of abort(): on iOS, starting a new SR
    // session ~2s after abort() froze the WebView main thread for ~8s
    // while the native speech service recovered (device log
    // 2026-06-11T22-18-40, listen toggle). A wound-down session leaves
    // the service ready for an instant restart.
    try { sr.stop(); } catch { /* noop */ }
    sr = null;
  }
}

/** Update the phrase on the fly without restarting the SR session.
 *  Used when the user changes commitPhrase in settings mid-session. */
export function setPhrase(phrase: string): void {
  if (opts) opts.phrase = phrase;
}
