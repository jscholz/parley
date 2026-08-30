/**
 * @fileoverview Turn-taking guard for realtime calls — the client-side
 * answer to "whose turn is it, actually?"
 *
 * Two jobs, one per-call 50 ms loop:
 *
 *   1. VOICE SOURCE for the end-of-turn countdown. Reads mic peak off an
 *      AnalyserNode and calls `dictation.noteVoice()`. Before this, the
 *      countdown was armed on TRANSCRIPTS, so an STT hole or a run of
 *      empty finals (Phase 1's Deepgram bug, ~30% of utterances on
 *      2026-08-28) was indistinguishable from the user falling silent
 *      and committed a half-utterance under him.
 *
 *   2. NEWEST INPUT WINS. If the user starts speaking again while a
 *      reply he did not want is in flight, that reply is stale. Rather
 *      than let it play and then answer the fragment it was replying
 *      to, we halt it through the EXISTING barge path.
 *
 * ── Why the trigger is what it is ────────────────────────────────────
 *
 * The obvious trigger — "mic is loud while a reply is happening" — is
 * the exact bug the 2026-08-28 walk test caught: bridge-side Silero
 * fired at p=0.993 on the AGENT'S OWN VOICE bleeding out of the
 * speaker at |amp| 0.61, with no client barge anywhere. See the "Why
 * there is no barge-window audio replay" block in
 * audio-bridge/stt_bridge.py. No amplitude or VAD verdict taken while
 * TTS is audible can tell the user from the agent.
 *
 * So this module NEVER looks at the mic while TTS is playing. It works
 * a window the existing BargeDetector structurally cannot see: the
 * GENERATING window, between the dispatch leaving the client and the
 * first TTS audio arriving. BargeDetector's whole tick is gated on
 * `isPlayingCb()`; in that window there is nothing playing, so it is
 * silent by construction — yet in a high-latency regime that window is
 * seconds long, and it is precisely where Jonathan resumed talking:
 *
 *   "I was in the middle of a dictation, and I paused to think. And for
 *    some reason, it sent the message, and the agent fired a reply. I
 *    hadn't realized this, so I continued to talk."
 *
 * In that window there is no agent audio in the room, so mic voice
 * cannot be echo — self-bleed is impossible, not merely unlikely. That
 * is what makes the trigger safe, and it is why the gate is
 * `!isTtsPlaying()` rather than a threshold.
 *
 * Confirmation is belt-and-braces: sustained mic voice
 * (CONFIRM_VOICE_MS of it, so a door slam doesn't count) OR a non-empty
 * user transcript from the bridge, which is Deepgram agreeing that what
 * it heard was words.
 *
 * When it fires we LATCH rather than act: there is nothing to halt yet.
 * The halt runs on the next `{type:'tts-playing', active:true}` — the
 * bridge telling us the stale reply just started speaking — and it runs
 * through the caller's halt callback, which is wired to the same
 * sendBarge + cancelRemotePlayback + suppress.onBarge sequence a real
 * barge uses. One halt path, not two.
 *
 * Intentional barge is untouched: BargeDetector still owns the
 * TTS-is-playing case exactly as before. The two windows TILE, which is
 * what makes the cover complete: `suppress.isTtsPlaying()` arms on the
 * FIRST assistant delta (suppress.ts onAssistantDelta), so
 *
 *   [dispatch → first assistant delta]  ← this module (latch + halt)
 *   [first delta → playback end]        ← BargeDetector (unchanged)
 *
 * with no gap and no overlap. In the high-latency regime Jonathan hit,
 * the first half is the long one — which is why nothing owned it.
 */

import { log, diag } from '../../util/log.ts';
import * as audioPlatform from '../shared/platform.ts';
import { getBargeThreshold } from '../../voiceTuning.ts';

/** Loop cadence. Matches turn-based's SILENCE_FRAME_MS — same job. */
const FRAME_MS = 50;
/** Sustained mic voice required before we call it a confirmed new
 *  utterance. 200 ms is long enough to reject transients (a door, a
 *  cough, a bump on the handlebars) and short enough that the stale
 *  reply is cut at its first syllable. */
const CONFIRM_VOICE_MS = 200;
/** Belt to the `listening` brace: a stale latch older than this is
 *  discarded rather than applied. Nothing should ever hold a latch this
 *  long — but a latch that outlives its turn halts a reply the user
 *  DID want, which is a worse failure than the one it was guarding. */
const STALE_LATCH_MAX_MS = 15_000;

export interface TurnGuardOpts {
  /** The call's mic stream. */
  micStream: MediaStream;
  /** True while agent TTS audio is playing (suppress.isTtsPlaying()). */
  isTtsPlayingCb: () => boolean;
  /** Called on every frame the mic is carrying voice AND no TTS is
   *  playing. Wired to dictation.noteVoice(). */
  onVoice: () => void;
  /** Called when a stale in-flight reply must be abandoned. Wired to
   *  the existing barge halt sequence. */
  onStaleReply: (why: string) => void;
  /** Subscribe to inbound bridge envelopes; returns an unsubscribe.
   *  Injected for testability (production: realtime.tapEnvelopes). */
  subscribeEnvelopes: (cb: (ev: any) => void) => () => void;
  /** Override the mic voice threshold (0..1 peak). Defaults to the
   *  device-aware value turn-based's silence detector uses. */
  voiceThreshold?: number;
  /** Test seam: supply a peak reader instead of an AnalyserNode. */
  readPeak?: () => number;
  /** Test seam: loop cadence. */
  frameMs?: number;
}

let opts: TurnGuardOpts | null = null;
let loop: ReturnType<typeof setInterval> | null = null;
let analyser: AnalyserNode | null = null;
let peakBuf: Uint8Array<ArrayBuffer> | null = null;
let unsubscribe: (() => void) | null = null;

/** Wall-clock ms at which the current run of mic voice began, or 0. */
let voiceRunStart = 0;
/** True from dispatch until the resulting reply's audio has finished. */
let replyInFlight = false;
/** True once confirmed new user speech has landed during an in-flight
 *  reply — the reply is stale and must not be allowed to speak. */
let staleLatched = false;
/** Why the latch was set — carried into the halt log so the journal
 *  says which confirmation fired. */
let staleReason = '';
/** When the latch was set (Date.now()), for STALE_LATCH_MAX_MS. */
let staleAt = 0;

function clearStale(): void {
  staleLatched = false;
  staleReason = '';
  staleAt = 0;
}

// Module-level peak override for integration smokes, which drive the
// PRODUCTION wiring (controls.ts builds the guard itself, so they have
// no handle on its opts) and have no real microphone. Same shape and
// same rationale as bargeDetector.setSpeechActiveOverrideForTests.
// Unit tests should prefer injecting `readPeak` via start().
let peakOverride: (() => number) | null = null;

/** Test hook — when set, replaces the AnalyserNode peak read. */
export function setPeakOverrideForTests(fn: (() => number) | null): void {
  peakOverride = fn;
}

export function start(o: TurnGuardOpts): void {
  stop();
  opts = o;
  voiceRunStart = 0;
  replyInFlight = false;
  clearStale();

  if (!o.readPeak) {
    analyser = audioPlatform.getMicAnalyser(o.micStream, 512);
    if (analyser) {
      peakBuf = new Uint8Array(new ArrayBuffer(analyser.fftSize)) as Uint8Array<ArrayBuffer>;
    } else {
      // iOS Safari can bind a WebRTC mic stream exclusively to the peer
      // connection, in which case the analyser reads zeros forever.
      // Degrade to the pre-2026-08-30 behaviour (transcript-armed
      // countdown) rather than to "never commits": noteVoice simply
      // never fires and armSilenceTimer's own noteVoice on each final
      // is the only evidence. Loud in the log because it means the fix
      // is inert on this device.
      log('[turn-guard] no mic analyser — voice-gated end-of-turn INERT on this device');
    }
  }

  unsubscribe = o.subscribeEnvelopes((ev) => onEnvelope(ev));
  loop = setInterval(tick, o.frameMs ?? FRAME_MS);
  log('[turn-guard] started',
    `voiceThreshold=${o.voiceThreshold ?? getBargeThreshold()}`,
    `analyser=${analyser || o.readPeak ? 'yes' : 'no'}`);
}

export function stop(): void {
  if (loop) { clearInterval(loop); loop = null; }
  if (unsubscribe) { try { unsubscribe(); } catch { /* noop */ } unsubscribe = null; }
  analyser = null;
  peakBuf = null;
  opts = null;
  voiceRunStart = 0;
  replyInFlight = false;
  clearStale();
}

/** The client just handed an utterance to the bridge — a reply is now
 *  in flight. Also clears any stale latch: this dispatch IS the newest
 *  input, so whatever we were about to abandon is now moot. */
export function onDispatch(): void {
  replyInFlight = true;
  clearStale();
  voiceRunStart = 0;
}

/** True while a reply is generating or playing. */
export function isReplyInFlight(): boolean { return replyInFlight; }

/** Test-only introspection. */
export function __stateForTests(): { replyInFlight: boolean; staleLatched: boolean } {
  return { replyInFlight, staleLatched };
}

function onEnvelope(ev: any): void {
  if (!ev || !opts) return;
  if (ev.type === 'listening') {
    // Turn boundary. The bridge announces this at call start and after
    // every TTS-end — including the case a latch would otherwise leak
    // through: a reply that sanitized to nothing and produced NO TTS
    // round at all, so no `tts-playing` pair ever arrives to close the
    // turn. Without this the latch would survive into the NEXT turn and
    // halt a reply the user actually wanted.
    replyInFlight = false;
    clearStale();
    return;
  }
  if (ev.type === 'tts-playing') {
    if (ev.active) {
      if (staleLatched && (Date.now() - staleAt) <= STALE_LATCH_MAX_MS) {
        // The stale reply just started speaking. Cut it at the first
        // syllable through the ordinary barge halt.
        const why = staleReason || 'new-utterance-during-generation';
        clearStale();
        log('[turn-guard] stale reply began speaking after the user resumed — halting it:', why);
        try { opts.onStaleReply(why); }
        catch (e: any) { diag('[turn-guard] onStaleReply threw', e?.message); }
      }
      return;
    }
    // Playback finished — the turn is over, nothing left to abandon.
    replyInFlight = false;
    clearStale();
    return;
  }
  if (ev.type === 'transcript' && ev.role === 'user' && ev.is_final
      && typeof ev.text === 'string' && ev.text.trim()) {
    // Deepgram agreeing that what the mic carried was WORDS. Only
    // trusted outside a playback window, same reason as the peak read:
    // inside one it could be our own speaker.
    if (replyInFlight && !opts.isTtsPlayingCb()) {
      confirmNewUtterance('user-transcript-during-generation');
    }
  }
}

function confirmNewUtterance(why: string): void {
  if (staleLatched) return;
  staleLatched = true;
  staleReason = why;
  staleAt = Date.now();
  log(`[turn-guard] newest input wins — reply in flight is stale (${why})`);
}

function readPeakFromAnalyser(): number {
  if (!analyser || !peakBuf) return 0;
  analyser.getByteTimeDomainData(peakBuf);
  let maxAbs = 0;
  for (let i = 0; i < peakBuf.length; i++) {
    const v = Math.abs(peakBuf[i] - 128);
    if (v > maxAbs) maxAbs = v;
  }
  return maxAbs / 128;
}

function tick(): void {
  const o = opts;
  if (!o) return;
  // NEVER read the mic while the agent is audible. This is the round-0
  // false-barge guard: on 2026-08-28 the agent's own speaker bleed read
  // |amp| 0.61 and p=0.993. Any verdict taken here would be a coin flip
  // on whose voice it is, and the wrong side of that flip is the "1 2 3
  // … zero" feedback loop.
  if (o.isTtsPlayingCb()) {
    voiceRunStart = 0;
    return;
  }
  const peak = o.readPeak ? o.readPeak()
    : peakOverride ? peakOverride()
    : readPeakFromAnalyser();
  const threshold = o.voiceThreshold ?? getBargeThreshold();
  if (peak <= threshold) {
    voiceRunStart = 0;
    return;
  }
  // Voice.
  try { o.onVoice(); } catch (e: any) { diag('[turn-guard] onVoice threw', e?.message); }
  const now = Date.now();
  if (voiceRunStart === 0) voiceRunStart = now;
  if (replyInFlight && !staleLatched && (now - voiceRunStart) >= CONFIRM_VOICE_MS) {
    confirmNewUtterance('sustained-mic-voice-during-generation');
  }
}
