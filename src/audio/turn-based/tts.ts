/**
 * @fileoverview HTTP TTS playback for text-typed agent replies.
 *
 * Wired from `main.ts:handleReplyFinal` whenever `settings.tts` is on AND
 * a WebRTC call is NOT in progress (call mode owns audio end-to-end via
 * its own peer-track TTS). Fetches Deepgram Aura via the server's
 * `/tts` proxy and plays the returned mp3 through the shared `#player`
 * audio element. Cancellation is "last reply wins" — a fresh
 * `playReplyTts()` cancels any in-flight playback before starting.
 *
 * iOS gesture binding: the playback path needs a primed AudioContext to
 * actually emit sound on Mobile Safari. The send button handler already
 * touches mic/audio (via memo / dictate / call paths), and the global
 * pointerdown/keydown unlock at boot covers all other entry points.
 *
 * Text cleaning: re-implements the regex set from
 * `test/tts-clean.test.ts` (whose `cleanForTts` was once exported from
 * `src/pipelines/classic/tts.ts` — file is gone, regex set lives on in
 * the test as the canonical reference). Keep these in sync.
 *
 * Event emitter: classic ported pattern. Public events carry replyId in
 * payload so the per-bubble UX (replyPlayer.ts) can route updates by
 * bubble identity instead of relying on a shared global. Critical for
 * keeping the bubble's loading bar / playhead / glyph swap honest under
 * cancel/replay/skip operations. Subscribers register via on() and
 * unsubscribe via off(); call once at boot.
 */

import { log, diag } from '../../util/log.ts';
import { apiUrl } from '../../apiBase.ts';
import * as replyCache from './replyCache.ts';
import * as settings from '../../settings.ts';
import * as audioSession from '../shared/session.ts';

// ── Public state machine + event surface ─────────────────────────────

export type TtsState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended';

export type TtsEventName =
  | 'synth-start'      // fetch beginning (or cache-hit imminent); { replyId }
  | 'load-progress'    // buffer/synth ratio update; { replyId, ratio }
  | 'duration-known'   // metadata loaded, duration available; { replyId, duration }
  | 'play-start'       // audio begins playing (or resumes from idle); { replyId }
  | 'progress'         // playback position update; { replyId, position, duration }
  | 'seek'             // user scrubbed; { replyId, position, duration }
  | 'paused'           // mid-stream pause; { replyId }
  | 'resumed'          // resume from paused; { replyId }
  | 'ended'            // natural end-of-stream; { replyId }
  | 'stopped';         // canceled (replay, mode-switch, user); { replyId, reason }

type Handler = (payload: any) => void;
const handlers: Record<TtsEventName, Set<Handler>> = {
  'synth-start': new Set(),
  'load-progress': new Set(),
  'duration-known': new Set(),
  'play-start': new Set(),
  'progress': new Set(),
  'seek': new Set(),
  'paused': new Set(),
  'resumed': new Set(),
  'ended': new Set(),
  'stopped': new Set(),
};

export function on(name: TtsEventName, fn: Handler): void {
  handlers[name].add(fn);
}
export function off(name: TtsEventName, fn: Handler): void {
  handlers[name].delete(fn);
}
function emit(name: TtsEventName, payload: any): void {
  for (const fn of handlers[name]) {
    try { fn(payload); } catch (e: any) {
      diag(`[text-tts] subscriber to '${name}' threw:`, e?.message);
    }
  }
}

// ── State accessors ──────────────────────────────────────────────────

let activeReplyId: string | null = null;
let state: TtsState = 'idle';

/** Who paused the current reply, and when. A SYSTEM 'play' (AirPods
 *  connecting, an interruption ending, CarPlay, Control Center — iOS
 *  routes all of those to the last now-playing app) may only resume a
 *  pause the USER made recently. A barge pause is the user talking over
 *  the agent: resuming that minutes later on a headset connect is
 *  exactly the "it just started talking" he has reported three times. */
export type PauseReason = 'user' | 'remote' | 'barge' | 'system';
let pauseReason: PauseReason | null = null;
let pausedAt = 0;
let remoteResumeWindowMs = 10 * 60 * 1000;

/** Identifier of the reply currently being driven by playReplyTts. */
export function getActiveReplyId(): string | null { return activeReplyId; }

/** Current playback state. Drives the per-bubble UX glyph + bar
 *  decisions WITHOUT relying on the audio element's derived flags
 *  (audio.paused races audio.ended on natural end). */
export function getState(): TtsState { return state; }

/** Whether the active player is currently paused (vs idle vs playing). */
export function isPaused(): boolean { return state === 'paused'; }

function setState(next: TtsState): void {
  if (state === next) return;
  state = next;
}

// ── Active session bookkeeping ───────────────────────────────────────

/** Per-chunk synthesis slot for the streamed (multi-chunk) server path.
 *  One slot per sentence-ish chunk of the reply, in playback order.
 *    - `blob` is null until the fetch resolves (or stays null on error).
 *    - `done` flips true once the fetch settles (success OR failure) so
 *      the play queue knows whether to wait or skip.
 *    - `waiters` are resolve-callbacks parked by the play queue when it
 *      reached a chunk whose fetch hasn't landed yet — settled in arrival
 *      order so playback resumes the instant the awaited chunk arrives. */
interface ChunkSlot {
  text: string;
  /** Char count of `text` — the unit the loaded (grey) bar fills against,
   *  and the basis for the pre-synthesis duration estimate. */
  chars: number;
  blob: Blob | null;
  done: boolean;
  error: boolean;
  /** Real playback duration in seconds, learned from #player metadata the
   *  first time this chunk is bound. null until then; the virtual timeline
   *  uses a char-proportional estimate in the meantime. */
  durationSec: number | null;
  waiters: Array<() => void>;
}

/** Streamed-playback bookkeeping carried on the active server session
 *  when the reply was split into >1 chunk. `playIndex` is the chunk
 *  currently bound to #player; the `ended` listener advances it. */
interface ChunkPlayback {
  slots: ChunkSlot[];
  playIndex: number;
  /** Whole-reply cleaned text + voice — the cache key we backfill once
   *  every chunk has synthesized, so a replay is an instant cache hit. */
  fullText: string;
  voice: string;
  /** Object URL bound to #player for the currently-playing chunk, so we
   *  can revoke it before swapping in the next. */
  currentUrl: string | null;
  /** Seconds-per-char used to ESTIMATE the duration of chunks that haven't
   *  been played yet (so the playhead + scrub have a continuous timeline
   *  before every chunk's real duration is known). Seeded from a speech-
   *  rate default, then recalibrated from the first real chunk duration.
   *  Estimates only ever apply to chunks AT OR AFTER the playhead — played
   *  chunks carry their real durationSec — so the green bar never rewinds. */
  secPerChar: number;
}

/** Default speech rate for the pre-synthesis duration estimate: Aura runs
 *  ~18 chars/sec of synthesized speech. Recalibrated per-reply from the
 *  first chunk whose real duration we learn. */
const DEFAULT_SEC_PER_CHAR = 1 / 18;

/** Effective duration of a chunk: its real (metadata) duration once known,
 *  else a char-proportional estimate. */
function chunkDuration(cp: ChunkPlayback, slot: ChunkSlot): number {
  if (slot.durationSec != null && Number.isFinite(slot.durationSec)) return slot.durationSec;
  return slot.chars * cp.secPerChar;
}

/** Sum of chunk durations before `idx` — the global-timeline offset at
 *  which chunk `idx` begins. */
function offsetBefore(cp: ChunkPlayback, idx: number): number {
  let acc = 0;
  for (let i = 0; i < idx && i < cp.slots.length; i++) acc += chunkDuration(cp, cp.slots[i]);
  return acc;
}

/** Whole-reply duration across all chunks (real where known, estimated
 *  for the not-yet-played tail). */
function totalDuration(cp: ChunkPlayback): number {
  let acc = 0;
  for (const s of cp.slots) acc += chunkDuration(cp, s);
  return acc;
}

/** Tracks the active fetch + playback so a follow-up reply can cancel
 *  it. Module-level singleton — only one text-mode TTS plays at a time
 *  per page (call-mode TTS is owned separately by the WebRTC peer
 *  track).
 *
 *  Two branches:
 *    - HTTP /tts (server engine): `audio` is the shared #player element,
 *      `abort` cancels the fetch(es). `chunks` is present when the reply
 *      was streamed as multiple sentence chunks (see playReplyTts); a
 *      single-chunk reply leaves it null and behaves exactly like the
 *      pre-streaming path.
 *    - speechSynthesis (local engine): `utterance` is the live
 *      SpeechSynthesisUtterance. `audio`/`abort` are absent. */
let active:
  | { kind: 'server'; audio: HTMLAudioElement; abort: AbortController; chunks: ChunkPlayback | null }
  | { kind: 'local'; utterance: SpeechSynthesisUtterance }
  | null = null;

/** Player-element listeners are attached ONCE for the lifetime of the
 *  page. Each event re-emits as a typed event with the active replyId
 *  baked in, so subscribers (replyPlayer) don't have to chase the
 *  global. */
let playerListenersAttached = false;
function ensurePlayerListenersAttached(player: HTMLAudioElement): void {
  if (playerListenersAttached) return;
  playerListenersAttached = true;

  // Experiment #1 (v0.417): tried createMediaElementSource(player)
  // routing through the shared AudioContext to make Chrome's AEC see
  // the TTS output as part of the same graph as the Silero mic input.
  // RESULT: catastrophic — MicVAD.new() started taking ~40 seconds
  // instead of <1s when the player was wired into the same context,
  // breaking barge for BOTH realtime and turnbased modes. Reverted in
  // v0.418. The AEC + AudioContext interaction is not safely
  // composable with our AudioWorklet-based VAD load. See backlog.

  player.addEventListener('loadedmetadata', () => {
    if (!activeReplyId) return;
    const dur = player.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    // Multi-chunk: #player only holds the CURRENT chunk, so its metadata
    // duration is this chunk's real duration — record it and recalibrate
    // the estimate for the not-yet-played tail. The scrub timeline scale
    // is the WHOLE reply's (estimated) total, not this chunk's. The loaded
    // (grey) bar is driven separately by per-chunk load-progress, so we do
    // NOT emit load-progress here (that would jump it to full on chunk 0).
    if (active && active.kind === 'server' && active.audio === player && active.chunks) {
      const cp = active.chunks;
      const slot = cp.slots[cp.playIndex];
      if (slot) {
        slot.durationSec = dur;
        if (slot.chars > 0) cp.secPerChar = dur / slot.chars;
      }
      emit('duration-known', { replyId: activeReplyId, duration: totalDuration(cp) });
      return;
    }
    // Single blob / cache hit: metadata duration IS the whole reply, and a
    // local blob URL is fully loadable the instant metadata lands.
    emit('duration-known', { replyId: activeReplyId, duration: dur });
    emit('load-progress', { replyId: activeReplyId, ratio: 1 });
  });
  player.addEventListener('play', () => {
    if (!activeReplyId) return;
    if (state === 'paused') {
      setState('playing');
      emit('resumed', { replyId: activeReplyId });
    } else {
      setState('playing');
      emit('play-start', { replyId: activeReplyId });
    }
  });
  player.addEventListener('pause', () => {
    if (!activeReplyId) return;
    // Distinguish a real pause from end-of-stream: 'ended' fires AFTER
    // 'pause' on natural completion. The 'ended' listener handles the
    // ended branch; here we only flip to 'paused' if not actually ended.
    if (player.ended) return;
    if (state === 'playing') {
      setState('paused');
      emit('paused', { replyId: activeReplyId });
    }
  });
  player.addEventListener('ended', () => {
    if (!activeReplyId) return;
    // Multi-chunk reply: a chunk ending is NOT the end of the reply —
    // advance to the next chunk instead of tearing down. Only the LAST
    // chunk's `ended` falls through to the real end-of-reply handling.
    if (active && active.kind === 'server' && active.audio === player && active.chunks) {
      const cp = active.chunks;
      if (cp.playIndex < cp.slots.length - 1) {
        cp.playIndex += 1;
        void playChunkAt(cp);
        return;
      }
    }
    setState('ended');
    const id = activeReplyId;
    // Auto-clear active session so the next click on the same bubble
    // starts a fresh playback (not a resume-already-finished no-op).
    if (active && active.kind === 'server' && active.audio === player) {
      if (active.chunks?.currentUrl) {
        try { URL.revokeObjectURL(active.chunks.currentUrl); } catch { /* noop */ }
      }
      active = null;
      activeReplyId = null;
    }
    emit('ended', { replyId: id });
    setState('idle');
  });
  player.addEventListener('timeupdate', () => {
    if (!activeReplyId) return;
    // Multi-chunk: report position on the WHOLE-reply timeline (offset of
    // the current chunk + position within it) so the played bar is one
    // continuous fill instead of resetting to 0 at every chunk boundary.
    if (active && active.kind === 'server' && active.audio === player && active.chunks) {
      const cp = active.chunks;
      const slot = cp.slots[cp.playIndex];
      const within = slot ? Math.min(player.currentTime, chunkDuration(cp, slot)) : player.currentTime;
      const pos = offsetBefore(cp, cp.playIndex) + within;
      const total = totalDuration(cp);
      if (total > 0) emit('progress', { replyId: activeReplyId, position: pos, duration: total });
      return;
    }
    const dur = player.duration;
    const pos = player.currentTime;
    if (!Number.isFinite(dur) || dur <= 0) return;
    emit('progress', { replyId: activeReplyId, position: pos, duration: dur });
  });
}

// ── Public lifecycle API ─────────────────────────────────────────────

/** Pause the in-flight playback without tearing down the blob URL. */
export function pauseReplyTts(reason: PauseReason = 'user'): void {
  if (!active) return;
  pauseReason = reason;
  pausedAt = Date.now();
  if (active.kind === 'server') {
    try { active.audio.pause(); } catch { /* noop */ }
    return;
  }
  // Local engine: speechSynthesis.pause(). iOS Safari support is
  // patchy (some versions return immediately or treat pause as
  // cancel) — best-effort, no error surfacing if it fails to honor.
  try { speechSynthesis.pause(); } catch { /* noop */ }
  // Manually fire `paused` since speechSynthesis doesn't have a
  // separate "pause-fired" event we can lean on (utterance only
  // fires start/end/error/boundary). State drives the UI here.
  if (state === 'playing' && activeReplyId) {
    setState('paused');
    emit('paused', { replyId: activeReplyId });
  }
}

/** Resume previously-paused playback. */
/** Whether a system/headset 'play' is allowed to resume right now: a
 *  reply must be PAUSED (never ended/idle/loading — nothing restarts
 *  from a cold state), the pause must have been deliberate ('user' from
 *  the bubble, 'remote' from a headset/lock-screen pause button) and
 *  recent. Everything else is ignored, loudly, by the caller. */
export function remoteResumeDecision(now: number = Date.now()): { ok: boolean; why: string } {
  if (state !== 'paused' || !active) return { ok: false, why: `state=${state}` };
  if (pauseReason !== 'user' && pauseReason !== 'remote') return { ok: false, why: `paused by ${pauseReason ?? 'unknown'}` };
  const age = now - pausedAt;
  if (age > remoteResumeWindowMs) return { ok: false, why: `paused ${Math.round(age / 60000)} min ago` };
  return { ok: true, why: `paused by ${pauseReason} ${Math.round(age / 1000)}s ago` };
}

/** Test seam: shrink the window so a smoke can age a pause out. */
export function __setRemoteResumeWindowForTests(ms: number): void { remoteResumeWindowMs = ms; }

export async function resumeReplyTts(): Promise<void> {
  if (!active) return;
  if (active.kind === 'server') {
    try { await active.audio.play(); } catch { /* noop */ }
    return;
  }
  try { speechSynthesis.resume(); } catch { /* noop */ }
  if (state === 'paused' && activeReplyId) {
    setState('playing');
    emit('resumed', { replyId: activeReplyId });
  }
}

/** Replay the current reply from the start. Returns false if there's
 *  no active session (caller falls back to a fresh playReplyTts). */
export async function replay(): Promise<boolean> {
  if (!active) return false;
  if (active.kind === 'server') {
    // Multi-chunk: rewind the queue to chunk 0 and rebind #player to it.
    // All chunks have already synthesized by replay time (replay is only
    // reachable from state 'ended'), so this is an instant local replay.
    if (active.chunks) {
      try {
        active.chunks.playIndex = 0;
        setState('playing');
        await playChunkAt(active.chunks);
        return true;
      } catch {
        return false;
      }
    }
    try {
      active.audio.currentTime = 0;
      setState('playing');
      await active.audio.play();
      if (activeReplyId) emit('play-start', { replyId: activeReplyId });
      return true;
    } catch {
      return false;
    }
  }
  // Local engine has no rewind primitive — caller should re-invoke
  // playReplyTts with the same text. Returning false signals that.
  return false;
}

/** Seek to a fractional position [0, 1] within the current reply.
 *  No-op when nothing's loaded. Emits 'seek' so the played-ratio bar
 *  jumps in lockstep. */
export function seekTo(ratio: number): void {
  if (!active) return;
  // Local engine has no seek — speechSynthesis is monolithic. No-op.
  if (active.kind !== 'server') return;
  const r = Math.max(0, Math.min(1, ratio));

  // Multi-chunk: the scrub ratio is over the WHOLE reply, but #player only
  // holds one chunk. Map the global position to (chunk index, offset within
  // chunk); seek in place if it's the current chunk, else swap chunks and
  // resume at the offset. Lets the user scrub across chunk boundaries as if
  // it were one continuous track.
  if (active.chunks) {
    const cp = active.chunks;
    const total = totalDuration(cp);
    if (total <= 0) return;
    const globalPos = r * total;
    let idx = 0;
    let acc = 0;
    while (idx < cp.slots.length - 1 && acc + chunkDuration(cp, cp.slots[idx]) <= globalPos) {
      acc += chunkDuration(cp, cp.slots[idx]);
      idx += 1;
    }
    const within = Math.max(0, globalPos - acc);
    // Jump the bar immediately on the global timeline.
    if (activeReplyId) emit('seek', { replyId: activeReplyId, position: globalPos, duration: total });
    if (idx === cp.playIndex) {
      try { active.audio.currentTime = within; } catch { /* noop */ }
    } else {
      cp.playIndex = idx;
      void playChunkAt(cp, within);
    }
    return;
  }

  const dur = active.audio.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  const pos = r * dur;
  try { active.audio.currentTime = pos; } catch { /* noop */ }
  if (activeReplyId) {
    emit('seek', { replyId: activeReplyId, position: pos, duration: dur });
  }
}

/** Strip markdown / URLs / emoji that don't read well when synthesized.
 *  Kept in lock-step with `test/tts-clean.test.ts`. */
function cleanForTts(text: string): string {
  let t = text;
  t = t.replace(/^\[[A-Za-z0-9_\- ]+\]\s*/, '');
  t = t.replace(/```[\s\S]*?```/g, '[code block]');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1$2');
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1$2');
  t = t.replace(/^[\s]*[-*•]\s+/gm, '');
  t = t.replace(/^#+\s+/gm, '');
  t = t.replace(/https?:\/\/[^\s<)\]"']+/g, '(link in canvas)');
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
  t = t.replace(/\*/g, '');
  t = t.replace(/^[#\-\s]+$/gm, '');
  t = t.replace(/\s+/g, ' ').trim();
  // Overall sanity bound on the whole reply. Pre-streaming this was 1800
  // (one /tts POST, server caps each request ~2000). Now the reply is
  // split into ~CHUNK_TARGET-char chunks fetched independently, so the
  // per-request cap no longer gates the whole reply — raise the overall
  // ceiling to ~6000 chars (≈ a few long paragraphs of speech) so most
  // replies play in full while still bounding a pathological wall of text.
  return t.slice(0, MAX_REPLY_CHARS);
}

// ── Sentence chunking (streamed playback) ────────────────────────────

/** Target chunk size in chars. ~260 keeps each /tts request small enough
 *  that chunk 0 synthesizes in ~1-2s (vs ~30s for a whole multi-paragraph
 *  reply), while staying large enough that we don't fan out into dozens
 *  of tiny requests with audible seams between them. */
const CHUNK_TARGET = 260;
/** Hard ceiling for a single chunk — only hit when ONE sentence is longer
 *  than this, in which case we hard-split mid-sentence on a space. */
const CHUNK_MAX = 360;
/** Capped in-flight /tts fetches. Small enough to be polite to the proxy
 *  + Deepgram, large enough that later chunks synthesize while earlier
 *  ones play, hiding their latency behind chunk-0 playback. */
const FETCH_CONCURRENCY = 3;
/** Overall whole-reply char bound (see cleanForTts). */
const MAX_REPLY_CHARS = 6000;

/** Split cleaned reply text into ordered, sentence-boundary chunks of
 *  roughly CHUNK_TARGET chars. Never splits mid-word; a single sentence
 *  longer than CHUNK_MAX is hard-split on the nearest space. Exported for
 *  the unit test. */
export function chunkForTts(text: string): string[] {
  const t = (text || '').trim();
  if (!t) return [];
  // Split on sentence-final punctuation followed by whitespace, KEEPING
  // the punctuation attached to the preceding sentence.
  const sentences = t.match(/[^.!?]+[.!?]+(?:["')\]]+)?\s*|[^.!?]+$/g) || [t];
  const chunks: string[] = [];
  let buf = '';
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };

  for (const raw of sentences) {
    let s = raw;
    // Over-long single sentence: hard-split on spaces into <=CHUNK_MAX
    // pieces so no single /tts request blows the server cap.
    while (s.length > CHUNK_MAX) {
      let cut = s.lastIndexOf(' ', CHUNK_MAX);
      if (cut <= 0) cut = CHUNK_MAX; // no space — split mid-word as last resort
      flush();
      chunks.push(s.slice(0, cut).trim());
      s = s.slice(cut);
    }
    // Adding this sentence would overflow the target — flush first.
    if (buf && (buf.length + s.length) > CHUNK_TARGET) flush();
    buf += s;
  }
  flush();
  return chunks.filter(Boolean);
}

/** Cancel any in-flight TTS fetch + playback. Safe to call when idle. */
export function cancelReplyTts(reason: string = 'cancel'): void {
  if (!active) {
    diag(`[reply-tts] cancel skip (idle, reason=${reason})`);
    return;
  }
  const id = activeReplyId;
  diag(`[reply-tts] cancel reason=${reason} prevReplyId=${id} prevState=${state} kind=${active.kind}`);
  if (active.kind === 'server') {
    // Abort halts ALL in-flight chunk fetches at once (they share one
    // controller) and unblocks any parked play-queue waiters via the
    // fetch's catch → settleChunk path.
    try { active.abort.abort(); } catch { /* noop */ }
    // Wake any play-queue waiter still parked on an unsettled chunk so
    // the queue loop sees the aborted signal and bails (no orphaned
    // promise pinning the cancelled session).
    if (active.chunks) {
      for (const slot of active.chunks.slots) {
        const w = slot.waiters; slot.waiters = [];
        for (const fn of w) { try { fn(); } catch { /* noop */ } }
      }
      if (active.chunks.currentUrl) {
        try { URL.revokeObjectURL(active.chunks.currentUrl); } catch { /* noop */ }
      }
    }
    try {
      active.audio.pause();
      if (active.audio.src) {
        try { URL.revokeObjectURL(active.audio.src); } catch { /* noop */ }
        active.audio.removeAttribute('src');
        active.audio.load();
      }
    } catch { /* noop */ }
  } else {
    // Local engine — speechSynthesis.cancel() flushes the queue and
    // stops the current utterance. Triggers `onend` on the active
    // utterance which we've already nulled out via our reason guard
    // below; that's fine, the listener checks active === this entry.
    try { speechSynthesis.cancel(); } catch { /* noop */ }
  }
  active = null;
  activeReplyId = null;
  setState('idle');
  if (id) emit('stopped', { replyId: id, reason });
}

/** Synthesize + play `text` through the page's `#player` element.
 *  Best-effort: returns a resolved Promise on success or after a
 *  cancellation; rejects only on hard errors the caller may want to
 *  log. */
export async function playReplyTts(
  rawText: string,
  voice: string,
  replyId?: string,
): Promise<void> {
  const engine = settings.get().ttsEngine || 'server';
  const text = cleanForTts(rawText || '');
  diag(`[reply-tts] enter replyId=${replyId} rawLen=${(rawText || '').length} cleanLen=${text.length} voice=${voice} engine=${engine}`);
  if (!text) {
    diag('[reply-tts] skip (clean text empty)');
    return;
  }

  // Engine selector. Local = speechSynthesis (on-device, no /tts hop).
  // Server = HTTP /tts (Deepgram Aura, default). Both fan in to the
  // same event surface so subscribers (replyPlayer.ts) don't care which
  // engine is active.
  if (settings.get().ttsEngine === 'local') {
    return playLocalTts(text, replyId);
  }

  cancelReplyTts('superseded');

  const player = document.getElementById('player') as HTMLAudioElement | null;
  if (!player) {
    diag('[text-tts] no #player element — skipping');
    return;
  }
  ensurePlayerListenersAttached(player);

  const abort = new AbortController();
  active = { kind: 'server', audio: player, abort, chunks: null };
  activeReplyId = replyId || null;
  setState('loading');

  if (activeReplyId) emit('synth-start', { replyId: activeReplyId });

  try {
    // Fast path: whole-reply cache hit (e.g. a prior streamed playback
    // backfilled the concatenated blob). Play it as one blob — identical
    // to the pre-streaming behavior, so replay stays instant.
    const cached = replyCache.get(text, voice);
    if (cached) {
      await playSingleBlob(player, cached);
      log(`[text-tts] playing ${text.length} chars (cache hit)`);
      return;
    }

    const chunks = chunkForTts(text);
    // Single chunk (a short reply): behave EXACTLY like the pre-streaming
    // path — one /tts POST, await the blob, cache it, play it.
    if (chunks.length <= 1) {
      const one = chunks[0] || text;
      const res = await fetch(apiUrl('/tts'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: one, model: voice }),
        signal: abort.signal,
      });
      if (!res.ok) {
        diag(`[text-tts] /tts ${res.status}`);
        // Reset state so the user can retry. Pre-fix the error path only
        // emitted 'stopped' but left state='loading' + active set, which
        // wedged the play-btn: replyPlayer.ts's loading-guard dropped
        // every subsequent tap with "[reply-player] click ignored
        // (loading)." Without this fix, a /tts error leaves the play-btn dead.
        cancelReplyTts('tts-http-error');
        return;
      }
      const blob = await res.blob();
      if (abort.signal.aborted) return;
      replyCache.set(text, voice, blob);
      await playSingleBlob(player, blob);
      log(`[text-tts] playing ${text.length} chars`);
      return;
    }

    // Multi-chunk path: fan out capped-concurrency /tts fetches and start
    // playing chunk 0 the instant it lands — first-audio latency drops
    // from "whole-reply synth" to "one-chunk synth" (~1-3s).
    const cp: ChunkPlayback = {
      slots: chunks.map((c) => ({
        text: c, chars: c.length, blob: null, done: false, error: false,
        durationSec: null, waiters: [],
      })),
      playIndex: 0,
      fullText: text,
      voice,
      currentUrl: null,
      secPerChar: DEFAULT_SEC_PER_CHAR,
    };
    // Stash on the active session so cancel/replay/ended can reach it.
    if (active && active.kind === 'server') active.chunks = cp;

    startChunkFetches(cp, voice, abort);
    // Kick playback of chunk 0; awaits its arrival, then the 'ended'
    // listener chains the rest in order.
    await playChunkAt(cp);
    log(`[text-tts] streaming ${chunks.length} chunks (${text.length} chars)`);
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    diag(`[text-tts] failed: ${e?.message || e}`);
    // Same reason as the !res.ok branch — reset state so retry works.
    cancelReplyTts('play-error');
  }
  // NOTE: do NOT clear `active` in a finally block. play() resolves
  // when audio STARTS, not when it ends. The 'ended' listener clears
  // active + activeReplyId on natural end.
}

/** Bind a finished blob to #player and start it — the shared tail of the
 *  cache-hit and single-chunk paths. */
async function playSingleBlob(player: HTMLAudioElement, blob: Blob): Promise<void> {
  const blobUrl = URL.createObjectURL(blob);
  player.src = blobUrl;
  // Drop any prior peer-track binding so the blob takes over.
  player.srcObject = null;
  // iOS: HTMLAudioElement.play() inherits the AVAudioSession category at
  // play() time. Turn-mode TTS fires while the session is still
  // 'play-and-record' (from the listen-mode mic capture), which routes
  // output to the iPhone earpiece instead of connected BT — inaudible
  // on a headset. Hint 'playback' first so it routes to BT A2DP. iOS
  // keeps mic capture alive since the session started in play-and-record.
  audioSession.prepareForPlayback();
  await player.play();
}

/** Fire the per-chunk /tts POSTs with a small in-flight cap. Resolves
 *  each slot in arrival order (waking any parked play-queue waiter).
 *  Once EVERY chunk has synthesized successfully, concatenate the blobs
 *  and backfill the whole-reply cache key so a later replay is a single-
 *  blob cache hit (preserving the instant-replay invariant). */
function startChunkFetches(cp: ChunkPlayback, voice: string, abort: AbortController): void {
  let next = 0;
  let inFlight = 0;

  const settleChunk = (slot: ChunkSlot, blob: Blob | null, error: boolean) => {
    slot.blob = blob;
    slot.error = error;
    slot.done = true;
    const waiters = slot.waiters; slot.waiters = [];
    for (const fn of waiters) { try { fn(); } catch { /* noop */ } }
    // Grow the loaded (grey) bar by synthesized fraction so it fills
    // chunk-by-chunk as fetches land, instead of jumping to full on chunk
    // 0. Char-weighted so a long chunk advances the bar more than a short
    // one. Reaches 1 once every chunk has settled (success OR error), which
    // is what flips the bubble out of the streaming/shimmer state.
    if (activeReplyId && active && active.kind === 'server' && active.chunks === cp) {
      const totalChars = cp.slots.reduce((a, s) => a + s.chars, 0) || 1;
      const doneChars = cp.slots.reduce((a, s) => a + (s.done ? s.chars : 0), 0);
      emit('load-progress', { replyId: activeReplyId, ratio: doneChars / totalChars });
    }
  };

  const pump = () => {
    while (inFlight < FETCH_CONCURRENCY && next < cp.slots.length) {
      const idx = next++;
      const slot = cp.slots[idx];
      inFlight += 1;
      fetch(apiUrl('/tts'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: slot.text, model: voice }),
        signal: abort.signal,
      })
        .then(async (res) => {
          if (!res.ok) { settleChunk(slot, null, true); return; }
          const blob = await res.blob();
          if (abort.signal.aborted) { settleChunk(slot, null, true); return; }
          settleChunk(slot, blob, false);
        })
        .catch(() => { settleChunk(slot, null, true); })
        .finally(() => {
          inFlight -= 1;
          if (!abort.signal.aborted) pump();
          maybeBackfillCache(cp);
        });
    }
  };
  pump();
}

/** Once every slot is done AND none errored, concatenate the chunk blobs
 *  in order and cache them under the whole-reply key so replay is a hit. */
function maybeBackfillCache(cp: ChunkPlayback): void {
  if (!cp.slots.every((s) => s.done)) return;
  if (cp.slots.some((s) => s.error || !s.blob)) return;
  // Already backfilled? has() probe avoids re-concatenating on every
  // finally callback after the last chunk lands.
  if (replyCache.has(cp.fullText, cp.voice)) return;
  try {
    const whole = new Blob(cp.slots.map((s) => s.blob as Blob), { type: cp.slots[0].blob!.type || 'audio/mpeg' });
    replyCache.set(cp.fullText, cp.voice, whole);
  } catch { /* noop — replay just re-fetches */ }
}

/** Play the chunk at cp.playIndex on #player. Waits for that chunk's
 *  fetch to land (parking a waiter if it hasn't), then binds + plays it.
 *  Skips a chunk whose fetch errored so one bad chunk doesn't wedge the
 *  whole reply. The 'ended' listener calls back here to advance. */
async function playChunkAt(cp: ChunkPlayback, seekWithinSec?: number): Promise<void> {
  // Bail if this session was cancelled/superseded out from under us.
  if (!active || active.kind !== 'server' || active.chunks !== cp) return;
  const player = active.audio;
  const abort = active.abort;

  // Skip over errored chunks (and trailing empties) so a single failed
  // synth doesn't stall the rest of the reply.
  while (cp.playIndex < cp.slots.length) {
    const slot = cp.slots[cp.playIndex];
    if (!slot.done) {
      // Park until this chunk's fetch settles (success or error).
      await new Promise<void>((resolve) => {
        if (slot.done) { resolve(); return; }
        slot.waiters.push(resolve);
      });
    }
    if (abort.signal.aborted) return;
    if (!active || active.kind !== 'server' || active.chunks !== cp) return;
    if (slot.error || !slot.blob) { cp.playIndex += 1; continue; }
    break;
  }

  // Ran off the end skipping errors → treat as natural end of reply.
  if (cp.playIndex >= cp.slots.length) {
    const id = activeReplyId;
    if (cp.currentUrl) { try { URL.revokeObjectURL(cp.currentUrl); } catch { /* noop */ } }
    active = null;
    activeReplyId = null;
    setState('ended');
    if (id) emit('ended', { replyId: id });
    setState('idle');
    return;
  }

  const slot = cp.slots[cp.playIndex];
  // Revoke the previous chunk's URL before swapping in the new one.
  if (cp.currentUrl) { try { URL.revokeObjectURL(cp.currentUrl); } catch { /* noop */ } }
  const url = URL.createObjectURL(slot.blob as Blob);
  cp.currentUrl = url;
  player.src = url;
  player.srcObject = null;
  audioSession.prepareForPlayback();
  try {
    await player.play();
    // Honor an intra-chunk start offset from a cross-chunk seek. Applied
    // after play() resolves so the freshly-bound blob has loaded enough to
    // accept a currentTime set.
    if (seekWithinSec != null && Number.isFinite(seekWithinSec) && seekWithinSec > 0) {
      try { player.currentTime = seekWithinSec; } catch { /* noop */ }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    diag(`[text-tts] chunk ${cp.playIndex} play failed: ${e?.message || e}`);
  }
}

/** Local TTS via speechSynthesis. Runs entirely in-browser — no /tts
 *  HTTP hop, no Deepgram, no server. Useful when the bridge isn't
 *  reachable (offline, dev without bridge running) but the agent text
 *  reply is still arriving over HTTP.
 *
 *  iOS gotchas (documented inline so future readers don't relearn):
 *    - speechSynthesis.pause() is unreliable on iOS Safari (some
 *      versions ignore it; some treat it as cancel). UI offers the
 *      pause button anyway because cancel-and-replay is a viable
 *      fallback.
 *    - speechSynthesis.cancel() is required as the FIRST line of
 *      every fresh speak — iOS Safari's queue isn't auto-cleared on
 *      a new utterance and old ones can stall the new one indefinitely.
 *    - The voice list (speechSynthesis.getVoices) often arrives
 *      asynchronously after `voiceschanged` fires. settings.ts already
 *      handles this for the picker; here we accept whatever's loaded
 *      at speak time and fall back to system default if the chosen
 *      voice has been GC'd.
 *    - Some iOS versions silently drop utterances ≥ ~32k chars; cleaned
 *      text is already capped at 1800 chars by cleanForTts so we're
 *      safe. */
function playLocalTts(text: string, replyId?: string): Promise<void> {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
    diag('[text-tts] local engine selected but speechSynthesis unavailable');
    if (replyId) emit('stopped', { replyId, reason: 'tts-unsupported' });
    return Promise.resolve();
  }

  cancelReplyTts('superseded');

  const utt = new SpeechSynthesisUtterance(text);
  // Voice picker (settings.ttsVoiceLocal) selects by `name`. Empty
  // string = "system default" — leave utt.voice null so the engine
  // picks. Filter the voice list at speak time so a freshly-loaded
  // voice catalog after the picker rendered still works.
  const wantedName = String((settings.get() as any).ttsVoiceLocal || '').trim();
  if (wantedName) {
    try {
      const voices = speechSynthesis.getVoices() || [];
      const match = voices.find(v => v.name === wantedName);
      if (match) utt.voice = match;
    } catch { /* getVoices can throw on cold-load in some browsers; default voice is fine */ }
  }

  active = { kind: 'local', utterance: utt };
  activeReplyId = replyId || null;
  setState('loading');
  if (activeReplyId) emit('synth-start', { replyId: activeReplyId });

  utt.onstart = () => {
    if (!activeReplyId || active?.kind !== 'local' || active.utterance !== utt) return;
    setState('playing');
    emit('play-start', { replyId: activeReplyId });
  };
  utt.onend = () => {
    // Guard: if this utterance was cancelled and superseded, the new
    // session already cleared `active`. Don't double-fire `ended`.
    if (active?.kind !== 'local' || active.utterance !== utt) return;
    setState('ended');
    const id = activeReplyId;
    active = null;
    activeReplyId = null;
    if (id) emit('ended', { replyId: id });
    setState('idle');
  };
  utt.onerror = (e: any) => {
    if (active?.kind !== 'local' || active.utterance !== utt) return;
    diag('[text-tts] local utterance error:', e?.error || e?.message);
    const id = activeReplyId;
    active = null;
    activeReplyId = null;
    setState('idle');
    if (id) emit('stopped', { replyId: id, reason: 'tts-error' });
  };

  try {
    // Belt-and-braces: cancel any orphaned utterances in the queue
    // before queueing the new one. iOS Safari occasionally strands
    // utterances on visibility flips; this clears the slate.
    speechSynthesis.cancel();
    speechSynthesis.speak(utt);
    log(`[text-tts] local speak ${text.length} chars (voice=${utt.voice?.name || 'default'})`);
  } catch (e: any) {
    diag(`[text-tts] local speak threw: ${e?.message || e}`);
    if (activeReplyId) emit('stopped', { replyId: activeReplyId, reason: 'tts-error' });
    active = null;
    activeReplyId = null;
    setState('idle');
  }
  return Promise.resolve();
}
