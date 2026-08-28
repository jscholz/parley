/**
 * @fileoverview WebRTC peer connection — the new full-duplex voice
 * transport replacing the classic WS+PCM pipeline.
 *
 * Two modes are supported via the same code path; the difference is just
 * whether the server adds an outbound TTS track to the answer SDP:
 *
 *   stream  — mic in, transcripts via SSE/data channel, no TTS audio.
 *             (Equivalent to today's "live mode.")
 *   talk    — mic in + TTS out on the same peer connection.  iOS sees a
 *             real call session: lockscreen UI, BT routing, no
 *             background-audio gymnastics.
 *
 * Lifecycle:
 *
 *   open(mode)
 *     1. getUserMedia({ audio: true })  — kicked off, NOT awaited (#197)
 *     2. new RTCPeerConnection + addTransceiver('audio', sendrecv)
 *     3. ontrack -> bind to <audio> sink for talk mode
 *     4. createOffer / setLocalDescription
 *     5. POST /api/rtc/offer { sdp, type, mode } -> answer
 *     6. setRemoteDescription(answer)
 *     7. trickle ICE: onicecandidate -> POST /api/rtc/ice
 *     ∥. mic resolves in parallel → sender.replaceTrack(micTrack)
 *
 *   close()
 *     - close PC, stop tracks, POST /api/rtc/close
 *
 * Initial narrowness: no data channel, no client-side STT. Captions
 * (interim transcripts) come back via the existing chat SSE — the
 * server pushes them through the same agent-input channel.
 */

import { log, diag } from '../../util/log.ts';
import { apiUrl } from '../../apiBase.ts';
import { logAudioState } from '../shared/headphones.ts';
import { playFeedback, haptic } from '../shared/feedback.ts';
import * as audioPlatform from '../shared/platform.ts';
import * as settings from '../../settings.ts';
import type {
  STTProvider,
  TranscriptEvent as STTTranscriptEvent,
  Unsubscribe,
} from '../shared/stt-provider.ts';

export type CallMode = 'stream' | 'talk';

/**
 * Why a call's peer connection was torn down. Threaded into close() and
 * logged in `[webrtc-close]` so a "what happened to my call" report is one
 * grep away (see hosts/cortex/call-resilience-plan.md).
 *
 *   user-hangup   the user tapped hang up (or a mode-switch closed+reopened)
 *   net-failed    a CONNECTED call's PC went `failed`/`closed` unexpectedly
 *   net-disconnect a CONNECTED call's PC went `disconnected` (triggers reconnect)
 *   setup-failed  the call never reached `connected` (mic/offer/answer error)
 */
export type CloseReason =
  | 'user-hangup'
  | 'net-failed'
  | 'net-disconnect'
  | 'setup-failed';

export type CallState =
  | 'idle'
  | 'requesting-mic'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closing'
  | 'failed';

interface CallSession {
  pc: RTCPeerConnection;
  mode: CallMode;
  /** Live mic stream. Null while getUserMedia is still in flight — mic
   *  acquisition runs in parallel with signaling/ICE (#197), so the
   *  session can briefly exist (even reach 'connected') before the mic
   *  lands. Consumers (controls barge loop, fakeLock meter) handle null. */
  micStream: MediaStream | null;
  peerId: string | null;
  /** Hidden <audio> element playing the remote (TTS) audio track —
   *  fallback only. Used when Web Audio routing is unavailable. */
  remoteAudio: HTMLAudioElement | null;
  /** MediaStreamAudioSourceNode → audioContext.destination — the
   *  primary playback path. Routing remote audio through Web Audio's
   *  destination puts it on the AVAudioSession playback channel that
   *  iOS's WebRTC AEC samples for its reference signal, so AEC can
   *  actually subtract the agent's voice from the mic capture.
   *  Held on the session so close() can disconnect cleanly. */
  remoteSourceNode: MediaStreamAudioSourceNode | null;
  /** Outbound data channel for transcript + reply text events. */
  dataChannel: RTCDataChannel | null;
  state: CallState;
  /**
   * Pending ICE candidates collected by onicecandidate before the
   * server returned an answer.  We drain them once we have a peer_id.
   */
  pendingCandidates: RTCIceCandidate[];
}

/**
 * Wire-format envelopes from the server's data channel.
 *
 *   - `transcript` — user/assistant text, both interim and final.
 *   - `barge`      — server-side VAD detected user voice during TTS;
 *                    client should cancel local playback.
 *   - `listening`  — STT pipe is hot; bridge is now accepting mic
 *                    frames into the speech-to-text service. Fires at
 *                    call-start AND after every TTS-end transition.
 *                    PWA chimes "your turn." See
 *                    docs/PARLEY_AUDIO_PROTOCOL.md.
 */
interface TranscriptEvent {
  type: 'transcript';
  text: string;
  is_final: boolean;
  role: 'user' | 'assistant';
}
interface BargeEvent {
  type: 'barge';
}
interface ListeningEvent {
  type: 'listening';
}
/**
 * Bridge-side VAD fired a sustained speech-active state change. The
 * client's BridgeVadSource consumes these to drive the unified
 * BargeDetector when per-route policy selects bridge VAD. Transitions
 * only — bridge sends one envelope per state change, not per frame.
 */
interface SpeechActiveEvent {
  type: 'speech-active';
  active: boolean;
}
/**
 * Capability reply: whether the bridge has server-side VAD live for this
 * peer (silero-vad/torch loaded, barge_policy attached). Sent in response
 * to a client {type:'barge-vad-query'}. The client's FallbackVadSource
 * uses it to decide between bridge VAD and client-side Silero — when the
 * bridge reports unavailable (e.g. a fresh install with no torch), the
 * client falls back to client-side detection so barge still fires.
 */
interface BargeVadEvent {
  type: 'barge-vad';
  available: boolean;
}
/**
 * Playback LEVEL signal — the bridge publishing its own
 * `PCMTrack.is_active()`, i.e. the exact flag it uses to decide
 * whether inbound mic audio reaches the STT provider. On every change
 * plus ~1/s while active, and once on the first mic frame of the call
 * (that first envelope is also the capability announcement — a bridge
 * predating this protocol sends none, and the client keeps its older
 * unbounded suppression behavior rather than risk unsuppressing
 * mid-playback). Consumed by suppress.onPlaybackState; it is what
 * bounds `ttsPlaying`, which `listening` alone could not because
 * `listening` is edge-triggered and fires at most once per turn.
 */
interface TtsPlayingEvent {
  type: 'tts-playing';
  active: boolean;
}
type DataChannelEvent =
  | TranscriptEvent
  | BargeEvent
  | ListeningEvent
  | SpeechActiveEvent
  | BargeVadEvent
  | TtsPlayingEvent;

let onDataChannelEvent: ((ev: DataChannelEvent) => void) | null = null;

/**
 * Internal envelope tap for in-module subscribers (currently
 * BridgeVadSource). Independent of the single-slot
 * setDataChannelListener registry, which is reserved for app-level
 * handlers that swap save-and-restore (dictate, STTProvider, main.ts).
 *
 * Multiple taps fan out concurrently. Each tap sees the full envelope
 * stream after JSON parse; filtering by `type` is the tap's
 * responsibility. Returns an unsubscribe.
 */
const internalEnvelopeTaps = new Set<(ev: any) => void>();

export function tapEnvelopes(cb: (ev: any) => void): () => void {
  internalEnvelopeTaps.add(cb);
  return () => { internalEnvelopeTaps.delete(cb); };
}

/** Register a single global handler for data-channel events from the
 *  active peer connection.  Replaces any prior handler. */
export function setDataChannelListener(cb: (ev: DataChannelEvent) => void) {
  onDataChannelEvent = cb;
}

/** Read the currently-registered data-channel listener (or null if
 *  none).  Used by dictate.ts to save+restore the call-mode listener
 *  across a dictate session — the registry is single-slot, so a
 *  module that wants to temporarily override needs to remember what
 *  it replaced. */
export function getDataChannelListener(): ((ev: DataChannelEvent) => void) | null {
  return onDataChannelEvent;
}

let active: CallSession | null = null;
let onStateChange: ((s: CallState, mode: CallMode | null) => void) | null = null;
/** Hold-over when ontrack fires before `active` is populated. */
let pendingRemoteAudio: HTMLAudioElement | null = null;

export function setStateListener(cb: (state: CallState, mode: CallMode | null) => void) {
  onStateChange = cb;
}

/** Fired only when a CONNECTED call is torn down by the network (not by a
 *  user hangup). The UI uses this to raise a distinct "Call dropped —
 *  network unstable" banner with a Reconnect affordance, so the user knows
 *  it wasn't them. State-listener `failed`→`idle` transitions are too
 *  transient (close() runs immediately) to drive that banner on their own. */
let onDropped: ((reason: CloseReason) => void) | null = null;

export function setDroppedListener(cb: (reason: CloseReason) => void) {
  onDropped = cb;
}

// ── Reconnect ──────────────────────────────────────────────────────────
// WhatsApp-class soft recovery. When a CONNECTED call's PC drops
// (disconnected/failed), we DON'T tear the call down — we hold a
// `reconnecting` state and re-open a fresh peer connection on the same
// chat, retrying within an escalation window before finally giving up.
//
// Why re-open instead of pc.restartIce(): the bridge mints a brand-new
// peer per /v1/rtc/offer and evicts the server-side PC the moment its
// connection state hits failed/closed (audio-bridge/signaling.py). There's
// no renegotiation endpoint for an existing peer_id, so a client ICE
// restart has nothing to re-offer to. A full re-open with the same chatId
// continues the same conversation (dispatch routes by chat_id, not
// peer_id) and survives today's bridge unchanged. True ICE restart is a
// future optimization gated on bridge-side support.
let RECONNECT_WINDOW_MS = 75_000;     // 60-90s escalation window (overrides
                                      // Chromium's ~10s disconnected→failed)
let RECONNECT_MAX_ATTEMPTS = 8;       // bound retries within the window
let reconnecting = false;
let reconnectAttempts = 0;
let reconnectStartedAt = 0;
let lastOpenArgs: { mode: CallMode; opts: { sessionId?: string | null; chatId?: string | null } } | null = null;
let reconnectGiveUpTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectRetryTimer: ReturnType<typeof setTimeout> | null = null;
// Settled-tracking for the in-flight mic acquire (parallelized with
// signaling since #197). close() must await this before the next open()
// re-acquires, or capture's pendingOwner reservation makes the reconnect
// reopen throw "already held by webrtc" and burn the retry budget.
let activeMicAcquire: Promise<void> | null = null;

export function isReconnecting(): boolean {
  return reconnecting;
}

/** Test-only: shrink the escalation window / attempt budget so the
 *  recovery-exhausted path is exercisable in a smoke without a 75s wait.
 *  Pass null to restore production defaults. */
export function setReconnectParamsForTests(
  p: { windowMs?: number; maxAttempts?: number } | null,
): void {
  RECONNECT_WINDOW_MS = p?.windowMs ?? 75_000;
  RECONNECT_MAX_ATTEMPTS = p?.maxAttempts ?? 8;
}

function notify(s: CallState, mode: CallMode | null) {
  if (onStateChange) {
    try { onStateChange(s, mode); } catch (e) { diag('webrtc state listener err', e); }
  }
}

function setState(s: CallState) {
  // While a reconnect sequence is in flight, the transient setup states of
  // each re-open attempt (requesting-mic / connecting) are surfaced to the
  // UI as one continuous `reconnecting` rather than flashing the fresh-call
  // sequence on every retry. The REAL internal state is still recorded on
  // active.state so isOpen()/wasConnected logic stays accurate.
  // While reconnecting, every transient state of a re-open attempt
  // (requesting-mic / connecting / closing / a signaling failure) is
  // surfaced as one continuous `reconnecting`. We only ever emit a real
  // terminal state once endReconnect() has cleared the flag (success →
  // connected, give-up → closing→idle).
  const emit: CallState =
    (reconnecting && s !== 'connected' && s !== 'idle')
      ? 'reconnecting'
      : s;
  if (active) active.state = s;
  notify(emit, active ? active.mode : null);
}

// ── Reconnect helpers ───────────────────────────────────────────────────

/** Clear all reconnect bookkeeping + timers. Idempotent. */
function endReconnect(): void {
  reconnecting = false;
  reconnectAttempts = 0;
  if (reconnectGiveUpTimer != null) { clearTimeout(reconnectGiveUpTimer); reconnectGiveUpTimer = null; }
  if (reconnectRetryTimer != null) { clearTimeout(reconnectRetryTimer); reconnectRetryTimer = null; }
}

/** Enter the reconnecting state for a connected call that just dropped.
 *  Starts the escalation backstop and fires the first re-open attempt. */
function beginReconnect(reason: CloseReason): void {
  if (reconnecting) return;
  reconnecting = true;
  reconnectAttempts = 0;
  reconnectStartedAt = performance.now();
  log(`[webrtc-recovery] connected → reconnecting (reason=${reason})`);
  notify('reconnecting', active ? active.mode : null);
  reconnectGiveUpTimer = setTimeout(() => giveUpReconnect(), RECONNECT_WINDOW_MS);
  scheduleReconnectAttempt(0);
}

/** Schedule the next re-open attempt with backoff, unless the window /
 *  attempt budget is exhausted (the give-up timer is the backstop). */
function scheduleReconnectAttempt(delayMs?: number): void {
  if (!reconnecting) return;
  if (reconnectRetryTimer != null) { clearTimeout(reconnectRetryTimer); reconnectRetryTimer = null; }
  if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    // Burned the attempt budget — the network is genuinely down, no point
    // idling until the window timer. Give up now. (The window timer is
    // still the backstop for the slow case where each attempt hangs.)
    log(`[webrtc-recovery] retry budget exhausted (${reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})`);
    giveUpReconnect();
    return;
  }
  const wait = delayMs ?? Math.min(800 * Math.max(1, reconnectAttempts), 4000);
  reconnectRetryTimer = setTimeout(() => { void attemptReopen(); }, wait);
}

/** One re-open attempt: quietly tear down the dead PC (keeping the UI on
 *  `reconnecting`) and open a fresh one with the original call args. The
 *  new PC's connectionstatechange handler decides success (→ connected) or
 *  another retry (→ failed). */
async function attemptReopen(): Promise<void> {
  if (!reconnecting) return;
  reconnectAttempts++;
  log(`[webrtc-recovery] reconnect attempt ${reconnectAttempts}`);
  const args = lastOpenArgs;
  if (!args) { giveUpReconnect(); return; }
  try { await close('net-failed', { silent: true, source: 'reconnect-reopen' }); } catch { /* ignore */ }
  if (!reconnecting) return;  // gave up (or user hung up) during teardown
  try {
    await open(args.mode, args.opts);
    // Signaling succeeded; whether we actually CONNECT is reported by the
    // new PC's connectionstatechange handler. If it never connects, that
    // handler schedules the next attempt.
  } catch (e: any) {
    diag('[webrtc-recovery] re-open signaling failed:', e?.message);
    scheduleReconnectAttempt();  // back off, try again within the window
  }
}

/** Escalation expired (or no args to retry with): give up for real. Fires
 *  the call-dropped cue and tears the call all the way down to idle. */
function giveUpReconnect(): void {
  if (!reconnecting) return;
  const elapsed = Math.round(performance.now() - reconnectStartedAt);
  log(`[webrtc-recovery] reconnecting → idle (give up after ${elapsed}ms, ${reconnectAttempts} attempts, reason=escalation-timeout)`);
  endReconnect();
  playFeedback('call-dropped');
  haptic([100, 50, 100]);
  if (onDropped) { try { onDropped('net-failed'); } catch (e) { diag('webrtc dropped listener err', e); } }
  void close('net-failed', { source: 'reconnect-giveup' });  // reconnecting now false → notify('idle') fires
}

// Coming back to the foreground while reconnecting is a strong signal the
// network is probably back too (phone out of pocket / screen on). Skip the
// backoff and retry immediately. Installed once at module load.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && reconnecting) {
      log('[webrtc-recovery] foreground while reconnecting — immediate retry');
      if (reconnectRetryTimer != null) { clearTimeout(reconnectRetryTimer); reconnectRetryTimer = null; }
      void attemptReopen();
    }
  });
}

export function isOpen(): boolean {
  return active !== null && active.state === 'connected';
}

export function currentMode(): CallMode | null {
  return active ? active.mode : null;
}

/**
 * Send a {type:'dispatch', text} envelope to the audio bridge over the
 * data channel.  The bridge POSTs the text to /api/hermes/responses
 * via the proxy and streams the agent reply back as assistant
 * transcript envelopes.
 *
 * Returns true on success, false if no channel is open or the payload
 * couldn't be serialized.  The dictation module owns the decision of
 * WHEN to call this — silence-timer fire, commit-phrase match, or any
 * future trigger.
 */
/** Read-only access to the live mic MediaStream. Currently unused by
 *  application code (preserved as a small public surface in case a
 *  future feature wants a tap on the local mic — e.g. mic-meter).
 *  Returns null when no call is open. */
export function getMicStream(): MediaStream | null {
  return active?.micStream ?? null;
}

// ── Post-listening transport diagnostic (field bug 2026-08-26) ─────────
// The bridge's `listening` envelope only proves ITS side resumed. These
// two bounded log lines capture the client half of the story the field
// report couldn't answer: was the peer still healthy, and did outbound
// mic RTP actually keep flowing after TTS ended? One snapshot + one 5s
// bytesSent delta per `listening` envelope — cheap enough to leave on
// permanently. See docs/bugs/2026-08-26-realtime-talk-post-reply-audio-
// failures.md ("client checks at TTS end").
let listeningStatsTimer: ReturnType<typeof setTimeout> | null = null;

export function logListeningTransport(): void {
  const session = active;
  if (!session) return;
  const pc = session.pc;
  let trackDesc = 'none';
  try {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
    const t = sender?.track ?? null;
    if (t) trackDesc = `enabled=${t.enabled} muted=${t.muted} readyState=${t.readyState}`;
  } catch (e: any) {
    trackDesc = `err:${e?.message}`;
  }
  log(
    `[webrtc-diag] listening: pc=${pc.connectionState}/${pc.iceConnectionState}/` +
    `${pc.signalingState} dc=${session.dataChannel?.readyState ?? 'none'} ` +
    `micTrack={${trackDesc}}`,
  );
  const readBytesSent = async (): Promise<number | null> => {
    try {
      const report = await pc.getStats();
      let total: number | null = null;
      report.forEach((s: any) => {
        if (s && s.type === 'outbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
          total = (total ?? 0) + (Number(s.bytesSent) || 0);
        }
      });
      return total;
    } catch { return null; }
  };
  // One sampler at a time — a new `listening` supersedes the pending one.
  if (listeningStatsTimer != null) { clearTimeout(listeningStatsTimer); listeningStatsTimer = null; }
  void readBytesSent().then((t0Bytes) => {
    if (!active || active.pc !== pc) return;  // call cycled meanwhile
    listeningStatsTimer = setTimeout(() => {
      listeningStatsTimer = null;
      void readBytesSent().then((t5Bytes) => {
        if (!active || active.pc !== pc) return;
        if (t0Bytes == null || t5Bytes == null) {
          log('[webrtc-diag] outbound RTP sample unavailable (getStats)');
          return;
        }
        const delta = t5Bytes - t0Bytes;
        log(
          `[webrtc-diag] outbound RTP bytesSent +5s: ${t0Bytes} → ${t5Bytes} ` +
          `(Δ=${delta}${delta > 0 ? ', increasing' : ' — FLAT: mic RTP stalled after TTS end'})`,
        );
      });
    }, 5000);
  });
}

// ─── Remote-playback duck: the audible cut at barge ────────────────────
//
// Jonathan, 2026-08-28: "It might be better from a user standpoint if
// the audio was clipped to synchronize with the barge time that the user
// hears. So the user understands that everything before the barge is
// detected will be discarded, but everything immediately afterwards will
// be captured."
//
// For that contract to be honest the cut must be AUDIBLE. This function
// used to be a deliberate no-op, so 100-300 ms of already-buffered TTS
// kept coming out of the speaker after every barge — and the bridge had
// to hold its mic gate shut across all of it (HALT_TAIL_GRACE_S was
// 400 ms), which is what made the barge-replay ring look necessary. That
// ring is what replayed 1.74 s of the agent's own voice into Deepgram on
// 2026-08-28 11:20:38. Muting here is what let all of it go away.
//
// MUTE, NEVER UNBIND. The previous non-no-op implementation (de5b48f)
// paused the <audio> element and nulled its srcObject. ontrack fires
// once per session and nothing rebinds, so one false barge silenced TTS
// for the rest of the call. scripts/smoke/webrtc-barge-keeps-srcobject.mjs
// pins that srcObject and paused are never touched. A gain/volume value
// is fully reversible and cannot break the binding.
//
// THE OUTPUT CAN NEVER BE LEFT MUTED. That is the safety property, and
// it has three independent guarantors:
//   1. the bridge's {type:'tts-playing', active:false} envelope, which
//      lands one mic frame after the halt tail ends (the normal path);
//   2. DUCK_WATCHDOG_MS, for when that envelope never arrives at all
//      (older bridge, dropped data channel, teardown race);
//   3. resetRemotePlaybackForTeardown() on close(), so no call can
//      inherit a ducked output from its predecessor.
// Pinned by test/realtime-barge-duck.test.ts.

/** Fade length for the duck. An instantaneous 1→0 step on a live audio
 *  stream is a click; 25 ms is under the perceptual "instant" threshold
 *  and long enough to avoid the discontinuity. The bridge budgets for
 *  this number — see tts_bridge.HALT_TAIL_GRACE_S's derivation. */
const DUCK_RAMP_MS = 25;
/** Backstop for guarantor 2 above. Generous next to the real restore
 *  latency (halt tail 200 ms + one 20 ms frame), tight enough that a
 *  wedged duck can never swallow a whole reply. */
let duckWatchdogMs = 3000;

/** iOS Web Audio path: source → THIS → destination. Null elsewhere. */
let remoteGain: GainNode | null = null;
/** <audio> fallback path. Null when the Web Audio path is in use. */
let remoteAudioEl: HTMLAudioElement | null = null;
let duckRampTimer: ReturnType<typeof setInterval> | null = null;
let duckWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
let remoteDucked = false;

/** Current audible level of the remote (TTS) output, 0..1. Diagnostic —
 *  "is the agent audible right now" is otherwise unobservable. */
export function getRemotePlaybackLevel(): number {
  if (remoteGain) { try { return remoteGain.gain.value; } catch { return 1; } }
  if (remoteAudioEl) { try { return remoteAudioEl.volume; } catch { return 1; } }
  return 1;
}

function clearDuckRamp(): void {
  if (duckRampTimer != null) { clearInterval(duckRampTimer); duckRampTimer = null; }
}

/** Fade the remote output to `target` over DUCK_RAMP_MS.
 *
 *  Web Audio gets a scheduled AudioParam ramp (sample-accurate, and the
 *  right tool on the platform that has it). The <audio> element has no
 *  scheduling, so its `volume` is stepped from a short timer. */
function rampRemoteTo(target: number): void {
  clearDuckRamp();
  const g = remoteGain;
  if (g) {
    try {
      const ctx: any = (g as any).context;
      const now = typeof ctx?.currentTime === 'number' ? ctx.currentTime : 0;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(target, now + DUCK_RAMP_MS / 1000);
      return;
    } catch (e: any) {
      diag('[webrtc] remote gain ramp failed, falling back to element volume:', e?.message);
    }
  }
  const el = remoteAudioEl;
  if (!el) return;
  let from = 1;
  try { if (typeof el.volume === 'number') from = el.volume; } catch { return; }
  const t0 = Date.now();
  duckRampTimer = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / DUCK_RAMP_MS);
    const v = from + (target - from) * k;
    try { el.volume = v < 0 ? 0 : v > 1 ? 1 : v; } catch { /* ignore */ }
    if (k >= 1) clearDuckRamp();
  }, 5);
}

/** Silence the agent at the barge. Idempotent; a no-op when no playback
 *  path is bound (no call up, or stream mode, which has no TTS track). */
export function cancelRemotePlayback(): void {
  if (remoteDucked) return;
  if (!remoteGain && !remoteAudioEl) return;
  remoteDucked = true;
  rampRemoteTo(0);
  // Deliberately NOT re-armed by a repeat barge: the guard must not be
  // starvable by the very event it guards against.
  if (duckWatchdogTimer == null) {
    duckWatchdogTimer = setTimeout(() => {
      duckWatchdogTimer = null;
      if (!remoteDucked) return;
      diag('[webrtc] duck watchdog fired — no tts-playing:false arrived, restoring');
      restoreRemotePlayback('watchdog');
    }, duckWatchdogMs);
  }
  log(`[webrtc] barge: remote TTS output muted over ${DUCK_RAMP_MS}ms — this is the cut the user hears`);
}

/** Make the agent audible again. Safe to call unconditionally. */
export function restoreRemotePlayback(why: string): void {
  if (duckWatchdogTimer != null) { clearTimeout(duckWatchdogTimer); duckWatchdogTimer = null; }
  if (!remoteDucked) return;
  remoteDucked = false;
  rampRemoteTo(1);
  log(`[webrtc] remote TTS output restored (${why})`);
}

/** Guarantor 1. Called for every inbound data-channel envelope.
 *
 *  Only `active:false` restores. The bridge keeps publishing
 *  `active:true` heartbeats through the post-halt tail, and honouring
 *  those would put the drained tail straight back into the room — and
 *  back into the mic. */
export function handleRemotePlaybackEnvelope(ev: any): void {
  if (!ev || ev.type !== 'tts-playing') return;
  if (ev.active === false) restoreRemotePlayback('tts-playing:false');
}

/** Guarantor 3. Hard reset — no ramp, no conditions. Runs on close() so
 *  a call torn down mid-barge cannot hand a ducked element or gain node
 *  to the reconnect that reuses it. */
export function resetRemotePlaybackForTeardown(): void {
  clearDuckRamp();
  if (duckWatchdogTimer != null) { clearTimeout(duckWatchdogTimer); duckWatchdogTimer = null; }
  remoteDucked = false;
  if (remoteGain) {
    try {
      const ctx: any = (remoteGain as any).context;
      const now = typeof ctx?.currentTime === 'number' ? ctx.currentTime : 0;
      remoteGain.gain.cancelScheduledValues(now);
      remoteGain.gain.setValueAtTime(1, now);
    } catch { /* ignore */ }
  }
  if (remoteAudioEl) {
    try { remoteAudioEl.volume = 1; } catch { /* ignore */ }
  }
}

/** Bind the playback path the duck operates on. Called from ontrack once
 *  the route (Web Audio gain vs. <audio> element) is known. Always lands
 *  unducked at level 1, on both the outgoing and incoming targets. */
function bindRemotePlaybackTargets(
  el: HTMLAudioElement | null,
  gain: GainNode | null,
): void {
  resetRemotePlaybackForTeardown();   // un-duck whatever we're dropping
  remoteAudioEl = el;
  remoteGain = gain;
  resetRemotePlaybackForTeardown();   // …and normalise what we picked up
}

/** Test seam: exercise the duck without a live peer connection.
 *  Mirrors setReconnectParamsForTests. */
export function setRemotePlaybackTargetsForTests(
  el: HTMLAudioElement | null,
  gain: GainNode | null,
  watchdogMs?: number,
): void {
  bindRemotePlaybackTargets(el, gain);
  if (typeof watchdogMs === 'number') duckWatchdogMs = watchdogMs;
}

export function dispatch(text: string, userMessageId?: string): boolean {
  if (!active || !active.dataChannel) return false;
  if (active.dataChannel.readyState !== 'open') return false;
  try {
    const env: Record<string, unknown> = { type: 'dispatch', text };
    if (userMessageId) env.user_message_id = userMessageId;
    active.dataChannel.send(JSON.stringify(env));
    return true;
  } catch (e: any) {
    diag('[webrtc] dispatch send failed', e?.message);
    return false;
  }
}

/** Send a {type:'barge'} envelope upstream over the data channel. The
 *  bridge's dispatch_listener calls tts_track.halt() on receipt — the
 *  same halt sequence the (now-retired) bridge-side VAD ran. Returns
 *  true on successful enqueue, false if no channel is open. */
export function sendBarge(): boolean {
  if (!active || !active.dataChannel) return false;
  if (active.dataChannel.readyState !== 'open') return false;
  try {
    active.dataChannel.send(JSON.stringify({ type: 'barge' }));
    return true;
  } catch (e: any) {
    diag('[webrtc] barge send failed', e?.message);
    return false;
  }
}

/** Ask the bridge whether server-side VAD is live for this peer. The
 *  bridge replies with a {type:'barge-vad', available} envelope, consumed
 *  by FallbackVadSource to choose bridge vs client-side detection.
 *  Returns true on successful enqueue, false if no channel is open yet —
 *  the caller retries until the channel opens or a deadline passes. */
export function queryBargeVad(): boolean {
  if (!active || !active.dataChannel) return false;
  if (active.dataChannel.readyState !== 'open') return false;
  try {
    active.dataChannel.send(JSON.stringify({ type: 'barge-vad-query' }));
    return true;
  } catch (e: any) {
    diag('[webrtc] barge-vad-query send failed', e?.message);
    return false;
  }
}

/** Warm the iOS AEC reference path with 1 s of silence so the WebRTC
 *  adaptive filter converges before TTS arrives on the peer track.
 *  Web Audio output (ctx.destination) is the AVAudioSession playback
 *  channel that Apple's AEC samples for its reference signal — feeding
 *  it actual frames (even silent ones) for ~1 s gives the filter the
 *  stable-output epoch it needs to lock on. Without this, the first
 *  ~500 ms of each call's TTS leaks into the mic at full level
 *  (residual peak ~0.6) until AEC converges,
 *  which is a self-barge trigger source.
 *
 *  Fire-and-forget — runs in parallel with ICE/signaling so the
 *  silent buffer overlaps the ~500 ms-2 s SDP exchange. No-op on
 *  non-iOS or when the audio context isn't running yet (primeAudio
 *  in the user-gesture handler should have left it 'running'). */
// ── Call-open phase timing (2026-08-28) ──────────────────────────────
// He: "took a while to start the call… makes the app feel flakey and
// immature", benchmarked against WhatsApp memo (chime instant, waveform
// ~0.5s). Field measurement put tap→connected at ~2.3s, of which the
// SERVER is only 361ms (offer POST → connected). The rest is client-side
// and, at 1-second log granularity, unattributable — which is exactly
// how you end up optimising the wrong thing.
//
// These marks split the client half into phases that map to real code:
// mic acquisition (incl. the iOS session prime, which does a whole
// throwaway getUserMedia + a 200ms settle sleep BEFORE the real one),
// SDP creation, the offer round-trip, and ICE/DTLS to connected. One
// summary line per call open; costs nothing when no call is opening.
const openMarks: Array<{ label: string; at: number }> = [];
let openT0 = 0;

function markOpen(label: string): void {
  if (!openT0) return;
  openMarks.push({ label, at: performance.now() });
}

export function beginOpenTiming(): void {
  openT0 = performance.now();
  openMarks.length = 0;
}

/** Emit the phase breakdown. Called once the call is usable (first
 *  `listening` envelope) — that is the moment that matters to him, not
 *  `connectionstate=connected`. */
export function logOpenTiming(reason: string): void {
  if (!openT0) return;
  const total = Math.round(performance.now() - openT0);
  let prev = openT0;
  const parts = openMarks.map((m) => {
    const d = Math.round(m.at - prev);
    prev = m.at;
    return `${m.label}=${d}ms`;
  });
  log(`[call-open] ${reason} total=${total}ms ${parts.join(' ')}`);
  openT0 = 0;
  openMarks.length = 0;
}

function warmAecReferencePathIOS(): void {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1);
  if (!isIOS) return;
  const ctx = audioPlatform.getSharedAudioCtx();
  if (!ctx || ctx.state !== 'running') {
    log('[webrtc] AEC warmup skipped — audio context not running');
    return;
  }
  try {
    const frameCount = Math.floor(ctx.sampleRate * 1.0);
    const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.addEventListener('ended', () => {
      try { source.disconnect(); } catch { /* noop */ }
    });
    source.start();
    log('[webrtc] AEC warmup started — 1s silence to ctx.destination');
  } catch (e: any) {
    diag('[webrtc] AEC warmup failed', e?.message);
  }
}

export async function open(
  mode: CallMode,
  opts?: { sessionId?: string | null; chatId?: string | null },
): Promise<void> {
  if (active) {
    log('[webrtc] open() called but session already active; closing first');
    await close('user-hangup', { source: 'open-replace' });
  }

  // Remember the call args so a reconnect can re-open the same chat with
  // the same mode (reused by attemptReopen).
  lastOpenArgs = { mode, opts: { sessionId: opts?.sessionId ?? null, chatId: opts?.chatId ?? null } };

  // Phase timing — emitted on every state transition so a "5s+ to
  // connect" complaint is debuggable from the chat log alone. Phases:
  // mic, signal (offer→answer), ice (answer→connected). Each line
  // shows ms-since-call-start AND ms-since-prev-phase.
  const callT0 = performance.now();
  let phaseT = callT0;
  const phase = (label: string) => {
    const now = performance.now();
    log(`[webrtc-timing] ${label} +${Math.round(now - phaseT)}ms (total ${Math.round(now - callT0)}ms)`);
    phaseT = now;
  };

  setState('requesting-mic');
  // Fast warmup (#197): mic acquisition (iOS AVAudioSession prime +
  // getUserMedia, ~200-700ms) runs CONCURRENTLY with the offer/
  // signaling/ICE chain instead of serially before it. The offer
  // advertises a sendrecv audio transceiver with no track; the live
  // track is attached via sender.replaceTrack() when the mic lands
  // (handler installed after `active` is created, below). Net effect:
  // tap→listening ≈ max(mic, signal+ice) instead of mic+signal+ice.
  //
  // DSP constraints:
  //   - talk mode:   AEC ON (suppress speaker→mic bleed of TTS),
  //                  NS off, AGC off (both can defeat barge).
  //   - stream mode: AEC OFF (no peer-track TTS to bleed),
  //                  NS off, AGC off.
  const useAec = (mode === 'talk');
  // [audio-state] checkpoint before mic acquisition. iOS audio-
  // session category SHOULD be playAndRecord by here for AEC to
  // engage. If it's still 'playback' we'll see it in the trace.
  logAudioState('pre-getUserMedia');
  beginOpenTiming();
  const micPromise = audioPlatform.getMicStream('webrtc', {
    echoCancellation: useAec,
    noiseSuppression: false,
    autoGainControl: false,
  });
  activeMicAcquire = micPromise.then(() => undefined, () => undefined);

  setState('connecting');

  // Empty iceServers — Tailscale provides reachability between phone and
  // Pi without STUN/TURN. Adding STUN actually generated more unreachable
  // srflx pairs (bridge-side aioice retransmits STUN checks to
  // srflx-public addresses) and worsened Mac Chrome ICE cold-start time.
  // Omitting STUN keeps the ICE candidate set minimal.
  const pc = new RTCPeerConnection({ iceServers: [] });

  // Mic audio uplink — addTransceiver (not addTrack) so the m=audio
  // sendrecv section is in the offer before the mic stream exists.
  // micPromise's handler below attaches the real track.
  const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });

  // For talk mode the server adds an outbound track; in stream mode
  // we tell the server "recvonly" by adding a recvonly transceiver.
  // Practically, aiortc's answer will include or omit a sending track
  // based on the mode parameter we POST, so we simply bind ontrack.
  //
  // Playback path — TWO routes, audio-session-prime → Web Audio
  // preferred:
  //
  //   PRIMARY (Web Audio destination): route the remote MediaStream
  //   through MediaStreamAudioSourceNode → audioContext.destination.
  //   Critical for iOS AEC: Apple's WebRTC AEC samples its reference
  //   signal from the AVAudioSession's playback channel, which is the
  //   path Web Audio destination uses. The plain <audio srcObject>
  //   path bypasses this channel, so AEC has no reference signal and
  //   can't subtract — agent voice arrives in the mic at full volume,
  //   which is the iOS self-barge bug class (agent voice leaks into
  //   mic at full level, peak ~0.6, confirms no AEC attenuation).
  //
  //   FALLBACK (<audio srcObject>): if the shared AudioContext isn't
  //   available, or MediaStreamAudioSourceNode construction throws,
  //   fall back to <audio> playback. Keeps audio playing on platforms
  //   where Web Audio routing fails for any reason; barge will still
  //   be over-eager on those platforms but at least the user hears
  //   the agent.
  //
  //   The audio-session-prime step (see top of openCall) already
  //   resumed the shared AudioContext synchronously inside the call-
  //   button click handler, so by ontrack time we have a `running`
  //   context — no autoplay-policy issue. (An older iteration of this
  //   file ran into ctx-suspended at ontrack time and used <audio>
  //   exclusively as a workaround; the priming step fixes the timing.)
  // Web Audio routing is iOS-only — see comment block above. On Mac
  // Chrome, connecting the WebRTC remote stream to
  // audioContext.destination silenced the user's speakers entirely
  // (Chrome's AEC consumed the destination as its reference channel
  // without also routing to system audio). iOS PWA standalone is the
  // platform that NEEDS the Web Audio path for AEC to engage; every
  // other platform's <audio srcObject> already gets working AEC via
  // the browser's WebRTC stack.
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1);

  let remoteAudio: HTMLAudioElement | null = null;
  let remoteSourceNode: MediaStreamAudioSourceNode | null = null;
  pc.addEventListener('track', (ev: RTCTrackEvent) => {
    log('[webrtc] ontrack kind=', ev.track.kind);
    if (ev.track.kind !== 'audio') return;
    // Bump the receiver's playout-delay hint above the browser default
    // (~50ms "interactive"). On cellular / weak wifi the default buffer
    // is too thin to absorb jitter and the user hears chunks drop. 300ms
    // is roughly where WhatsApp-class voice calls sit — perceptually
    // still real-time, with enough headroom to ride through ~250ms
    // network burps. A too-small buffer is the smoking gun for call
    // dropouts on cellular networks. Hint is best-effort —
    // browsers may not honor it exactly, but Chromium + WebKit both
    // respect it within the 0-3s range. Set via `(ev.receiver as any)`
    // because the typed DOM lib lags the actual implementation.
    try {
      const receiver = ev.receiver as any;
      if (receiver && typeof receiver === 'object') receiver.playoutDelayHint = 0.3;
    } catch (e: any) {
      diag('[webrtc] playoutDelayHint set failed:', e?.message);
    }
    const stream = ev.streams && ev.streams[0]
      ? ev.streams[0]
      : (() => { const ms = new MediaStream(); ms.addTrack(ev.track); return ms; })();

    // Try Web Audio destination ONLY on iOS — see Mac regression note above.
    let webAudioOk = false;
    if (isIOS) {
      try {
        const ctx = audioPlatform.getSharedAudioCtx();
        if (ctx && ctx.state === 'running') {
          // Detach any prior source from a previous track flip.
          try { remoteSourceNode?.disconnect(); } catch { /* ignore */ }
          try { remoteGain?.disconnect(); } catch { /* ignore */ }
          remoteSourceNode = ctx.createMediaStreamSource(stream);
          // source → gain → destination. The gain node exists solely so
          // a barge can silence the agent mid-sentence (see the
          // remote-playback duck block above); it sits at unity
          // otherwise and does not change the AEC reference path, which
          // is still ctx.destination.
          let gainNode: GainNode | null = null;
          try {
            gainNode = ctx.createGain();
            gainNode.gain.value = 1;
            remoteSourceNode.connect(gainNode);
            gainNode.connect(ctx.destination);
          } catch (e: any) {
            // Never let the duck cost us playback — fall back to the
            // direct connection and simply have no client-side mute.
            diag('[webrtc] remote gain node unavailable, connecting direct:', e?.message);
            gainNode = null;
            remoteSourceNode.connect(ctx.destination);
          }
          bindRemotePlaybackTargets(null, gainNode);
          if (active) active.remoteSourceNode = remoteSourceNode;
          webAudioOk = true;
          log('[webrtc] remote audio routed via Web Audio destination (iOS AEC reference path)'
            + (gainNode ? ' with barge-duck gain' : ' — NO duck gain'));
        } else {
          diag('[webrtc] shared audioCtx unavailable or not running, falling back to <audio>',
            'state=' + (ctx?.state ?? 'null'));
        }
      } catch (e: any) {
        diag('[webrtc] Web Audio routing failed, falling back to <audio>:', e?.message);
      }
    }

    if (!webAudioOk) {
      if (!remoteAudio) {
        remoteAudio = document.createElement('audio');
        remoteAudio.autoplay = true;
        remoteAudio.setAttribute('playsinline', '');
        (remoteAudio as any).playsInline = true;
        remoteAudio.style.position = 'absolute';
        remoteAudio.style.left = '-9999px';
        remoteAudio.style.width = '1px';
        remoteAudio.style.height = '1px';
        document.body.appendChild(remoteAudio);
        if (active) {
          active.remoteAudio = remoteAudio;
        } else {
          pendingRemoteAudio = remoteAudio;
        }
      }
      remoteAudio.srcObject = stream;
      remoteAudio.play().catch((e) => diag('[webrtc] remoteAudio.play err', e?.message));
      bindRemotePlaybackTargets(remoteAudio, null);
    }
  });

  // Open a data channel BEFORE createOffer so the SDP includes the
  // m=application section. Server stashes the matching channel via
  // RTCPeerConnection.ondatachannel; messages are JSON envelopes
  // (transcript / reply-delta) routed through onDataChannelEvent.
  const dataChannel = pc.createDataChannel('events', { ordered: true });
  dataChannel.addEventListener('open', () => {
    log('[webrtc] data channel open');
  });
  dataChannel.addEventListener('close', () => {
    log('[webrtc] data channel close');
  });
  // Envelope delivery is held until the mic track is attached. Normally
  // the mic resolves long before the data channel opens, so nothing
  // queues — the guard matters when ICE wins the race (e.g. the user is
  // staring at a first-run permission prompt): without it the bridge's
  // 'listening' envelope would chime "your turn" while the mic is still
  // ungranted, and anything said would be silently lost.
  let micAttached = false;
  const heldDcMessages: string[] = [];
  const deliverDcMessage = (data: string) => {
    let parsed: any;
    try { parsed = JSON.parse(data); }
    catch (e: any) { diag('[webrtc] dc bad json:', e?.message); return; }
    if (!parsed || typeof parsed.type !== 'string') return;
    // Before any listener: the un-duck must not be hostage to a
    // subscriber that throws. A stuck mute is silence for the rest of
    // the call; nothing else here is that expensive.
    handleRemotePlaybackEnvelope(parsed);
    for (const tap of internalEnvelopeTaps) {
      try { tap(parsed); }
      catch (e: any) { diag('[webrtc] dc tap threw:', e?.message); }
    }
    if (onDataChannelEvent) {
      try { onDataChannelEvent(parsed as DataChannelEvent); }
      catch (e: any) { diag('[webrtc] dc listener threw:', e?.message); }
    }
  };
  dataChannel.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return;
    if (!micAttached) { heldDcMessages.push(ev.data); return; }
    deliverDcMessage(ev.data);
  });

  active = {
    pc,
    mode,
    micStream: null,
    peerId: null,
    remoteAudio: pendingRemoteAudio ?? remoteAudio,
    remoteSourceNode,
    dataChannel,
    state: 'connecting',
    pendingCandidates: [],
  };
  pendingRemoteAudio = null;

  // Mic landing/failure — concurrent with the signaling chain below.
  void micPromise.then(async (micStream) => {
    // [audio-state] post-acquisition. The track.getSettings() readout
    // tells us whether the OS honored the echoCancellation constraint.
    // iOS Safari can silently drop AEC if the audio-session category
    // isn't right at acquisition time — we want to catch that here.
    try {
      const tracks = micStream.getAudioTracks();
      if (tracks.length > 0) {
        const s = tracks[0].getSettings ? tracks[0].getSettings() : {};
        log('[audio-state] track.getSettings()',
          `aec=${(s as any).echoCancellation}`,
          `ns=${(s as any).noiseSuppression}`,
          `agc=${(s as any).autoGainControl}`,
          `rate=${(s as any).sampleRate}`,
          `channelCount=${(s as any).channelCount}`,
          `deviceId=${((s as any).deviceId || '').slice(0, 8)}`);
      }
    } catch (e: any) { diag('[audio-state] track.getSettings threw', e?.message); }
    logAudioState('post-getUserMedia');
    // Standalone line (not phase()) — mic runs parallel to the
    // signal/ice chain, so it must not reset phaseT for those lines.
    log(`[webrtc-timing] mic +${Math.round(performance.now() - callT0)}ms (parallel)`);
    if (!active || active.pc !== pc) {
      // Call torn down while the mic prompt was pending. close()'s
      // releaseMicStream no-op'd (nothing was held yet) — release here
      // so the live mic track doesn't leak.
      try { audioPlatform.releaseMicStream('webrtc'); } catch { /* ignore */ }
      return;
    }
    active.micStream = micStream;
    try {
      markOpen('mic');
      await audioTransceiver.sender.replaceTrack(micStream.getAudioTracks()[0] ?? null);
    } catch (e: any) {
      log('[webrtc] replaceTrack failed',
        `name=${e?.name ?? 'Unknown'}`,
        `message=${e?.message ?? '(none)'}`);
      setState('failed');
      void close('setup-failed', { source: 'setup' });
      return;
    }
    // T3 — warm AEC reference path with silence on iOS, talk mode only.
    // Stream mode runs AEC=off so there's nothing to converge.
    if (mode === 'talk') warmAecReferencePathIOS();
    micAttached = true;
    for (const d of heldDcMessages.splice(0)) deliverDcMessage(d);
    // If ICE won the race, 'connected' was emitted while getMicStream()
    // was still null and controls skipped starting the barge loop.
    // Re-emit so it attaches now (realtimeBarge.start() is stop-first,
    // so the common mic-first order sees no double loop).
    if (active.state === 'connected') setState('connected');
  }, (e: any) => {
    log('[webrtc] getUserMedia failed',
      `name=${e?.name ?? 'Unknown'}`,
      `message=${e?.message ?? '(none)'}`);
    logAudioState('on-getUserMedia-failed');
    if (!active || active.pc !== pc) return;
    if (reconnecting) {
      // Mirror attemptReopen's signaling-failure path: tear this attempt
      // down quietly and retry within the reconnect window.
      void close('net-failed', { silent: true, source: 'reconnect-mic-failed' }).then(() => scheduleReconnectAttempt());
      return;
    }
    setState('failed');
    void close('setup-failed', { source: 'setup' });
  });

  // Trickle ICE: queue candidates until we have a peer_id, then POST each.
  pc.addEventListener('icecandidate', (ev) => {
    if (!ev.candidate) return;
    // Stale-handler guard: a reconnect attempt swaps `active` to a new
    // session; candidates from a torn-down PC must not post under the new
    // peer_id (see attemptReopen).
    if (!active || active.pc !== pc) return;
    if (active.peerId) {
      void postIce(active.peerId, ev.candidate);
    } else {
      active.pendingCandidates.push(ev.candidate);
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    // Stale-handler guard: during a reconnect, prior (dead) PCs keep firing
    // state changes after `active` has moved on to a fresh PC. Only the
    // current active PC drives the state machine.
    if (!active || active.pc !== pc) return;
    log('[webrtc] connectionstate=', pc.connectionState);
    const cs = pc.connectionState;
    if (cs === 'connected') {
      markOpen('connect');
      phase('ice→connected');
      if (reconnecting) {
        const elapsed = Math.round(performance.now() - reconnectStartedAt);
        log(`[webrtc-recovery] reconnecting → connected (after ${elapsed}ms, attempt ${reconnectAttempts}, reason=success)`);
        endReconnect();
      }
      setState('connected');
      // No chime here. The 'listening' chime is now driven by the
      // bridge sending {type: 'listening'} over the data channel
      // whenever it actually accepts mic frames into the STT
      // provider — call-start AND every TTS-end transition. Bridge is the source
      // of truth for "STT is hot"; chiming on connectionstatechange
      // would be a half-second early (data channel + STT pipe init
      // happens after peer is "connected") AND would double up at
      // call-start with the bridge's first-frame envelope. See
      // docs/PARLEY_AUDIO_PROTOCOL.md.
    } else if (cs === 'disconnected') {
      // Transient connectivity loss (cellular/wifi handoff). For a live
      // call this is the earliest, best moment to start recovering —
      // Chromium won't declare `failed` for ~10s, but we don't want to
      // wait. Never-connected calls ignore this (handled at `failed`).
      if (active.state === 'connected' && !reconnecting) {
        beginReconnect('net-disconnect');
      }
    } else if (cs === 'failed' || cs === 'closed') {
      if (reconnecting) {
        // A reconnect attempt's fresh PC failed too — try again within the
        // escalation window (the give-up timer is the hard backstop).
        log('[webrtc-recovery] reconnect attempt PC failed; scheduling retry');
        scheduleReconnectAttempt();
        return;
      }
      const wasConnected = active.state === 'connected';
      log(`[webrtc] connection state -> ${cs}; (wasConnected=${wasConnected})`);
      if (wasConnected) {
        // A live call dropped without passing through `disconnected`
        // first (or we missed it). Recover rather than tear down — the
        // call-dropped cue + banner now fire only when reconnect gives up.
        beginReconnect('net-failed');
        return;
      }
      // Never connected → genuine setup failure. Surface as failed + tear
      // down (the open() error path also logs the specific cause).
      setState('failed');
      void close('setup-failed', { source: 'setup' });
    }
  });

  // Build offer + signal.
  // Per-step timing inside `signal` — localizes slow SDP exchange on
  // Mac Chrome. The aggregate `phase('signal')` line fires below;
  // these sub-phases split it further.
  let offer: RTCSessionDescriptionInit;
  try {
    const tCreateOffer = performance.now();
    markOpen('pre-sdp');
    offer = await pc.createOffer();
    const tCreateOfferDone = performance.now();
    await pc.setLocalDescription(offer);
    markOpen('sdp');
    const tSetLocalDone = performance.now();
    log(
      `[webrtc-signal] createOffer +${Math.round(tCreateOfferDone - tCreateOffer)}ms ` +
      `setLocalDescription +${Math.round(tSetLocalDone - tCreateOfferDone)}ms`,
    );
  } catch (e: any) {
    log('[webrtc] createOffer/setLocalDescription failed',
      `name=${e?.name ?? 'Unknown'}`,
      `message=${e?.message ?? '(none)'}`);
    setState('failed');
    await close('setup-failed', { source: 'setup' });
    throw e;
  }

  // POST the offer. Two routing identifiers, mutually exclusive in
  // practice but both fields are forwarded so the bridge can pick:
  //
  //   conv_name — parley's legacy conversation slug (parley-<…>),
  //               used when the active backend is the /v1/responses
  //               path. Bridge passes it as body.conversation when
  //               dispatching to /api/<backend>/responses.
  //   chat_id   — hermes-gateway path, opaque PWA-minted UUID per
  //               conversation. When present, bridge dispatches to
  //               /api/parley/messages with {chat_id, text}. Set
  //               only when the active backend is hermes-gateway.
  //
  // keyterms: per-user STT vocabulary biasing, sourced from the PWA's
  // IDB-backed list (src/keyterms.ts). The bridge merges this into the
  // STT provider's options at peer setup so this user's terms reach
  // Deepgram for THIS connection only — no shared server-side state.
  // Fetched best-effort: an IDB error or empty list yields [] and the
  // bridge falls back to its own defaults.
  //
  // No silence_sec / commit_phrase here: those decisions are PWA-side
  // now (see dictation.ts). The bridge stays a thin transcript pipe
  // and dispatches only when the PWA sends {type:'dispatch', text}
  // over the data channel.
  // readListFast: IDB-mirror-first so a slow link can't stall call setup
  // behind a keyterms GET (network-first readList blocked up to 5s here,
  // serially before the offer POST). Bias terms tolerate staleness; the
  // background revalidate freshens the mirror for the next call. Still
  // seeds via loadOrSeed when no mirror exists (call before settings ever
  // loaded), so a first-boot offer doesn't ship keyterms=[].
  let keyterms: string[] = [];
  const tKt = performance.now();
  try {
    const { readListFast } = await import('../../keyterms.ts');
    keyterms = (await readListFast()) || [];
  } catch {}
  log('[webrtc] offer keyterms=', keyterms.length,
    keyterms.length ? `(first: ${keyterms[0]})` : '',
    `+${Math.round(performance.now() - tKt)}ms`);
  // Barge detection runs client-side (BargeWindow over the mic
  // AnalyserNode). The user's `bargeIn` toggle + sensitivity are read
  // locally by realtimeBarge.ts on every frame.
  // Per-connection TTS voice, same precedence as listen-mode replies
  // (backendEventHandlers: session-assigned voice, else the global
  // "Voice output" setting). Forwarded like keyterms — the bridge's
  // static YAML default is only the last resort. Before this the offer
  // omitted voice entirely, so realtime calls IGNORED the picker
  // (decorative-settings audit 2026-08-04).
  let voice = '';
  try {
    const si = await import('../../sessionIdentity.ts');
    voice = (opts?.sessionId ? si.voiceFor(opts.sessionId) : undefined)
      ?? settings.get().voice ?? '';
  } catch { voice = settings.get().voice ?? ''; }
  const offerPayload: Record<string, unknown> = {
    sdp: pc.localDescription?.sdp ?? '',
    type: pc.localDescription?.type ?? 'offer',
    mode,
    conv_name: opts?.sessionId || null,
    keyterms,
  };
  if (voice) offerPayload.voice = voice;
  if (opts?.chatId) offerPayload.chat_id = opts.chatId;
  // #2/#3 diag: a null conv_name here means the bridge mints its own
  // session id → the reply comes back tagged with an id that won't match
  // the on-screen chat → handleReplyFinal diverts it to a notification
  // instead of the transcript. Correlate with [reply-diag] below.
  diag('[rtc-diag] offer conv_name=', offerPayload.conv_name ?? '∅',
    'chat_id=', offerPayload.chat_id ?? '∅',
    'sessionId=', opts?.sessionId ?? '∅', 'mode=', mode);

  let answer: { peer_id: string; sdp: string; type: string } | null = null;
  try {
    const tPostStart = performance.now();
    const res = await fetch(apiUrl('/api/rtc/offer'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(offerPayload),
    });
    const tPostHeaders = performance.now();
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`offer ${res.status}: ${txt.slice(0, 200)}`);
    }
    answer = await res.json();
    markOpen('offer-rtt');
    const tPostJson = performance.now();
    log(
      `[webrtc-signal] POST-offer headers +${Math.round(tPostHeaders - tPostStart)}ms ` +
      `json +${Math.round(tPostJson - tPostHeaders)}ms ` +
      `status=${res.status}`,
    );
  } catch (e: any) {
    log('[webrtc] offer POST failed',
      `name=${e?.name ?? 'Unknown'}`,
      `message=${e?.message ?? '(none)'}`);
    setState('failed');
    await close('setup-failed', { source: 'setup' });
    throw e;
  }
  phase('signal');

  if (!answer || !answer.peer_id) {
    log('[webrtc] answer payload missing peer_id');
    setState('failed');
    await close('setup-failed', { source: 'setup' });
    throw new Error('answer payload missing peer_id');
  }

  if (active) active.peerId = answer.peer_id;

  try {
    const tSetRemote = performance.now();
    await pc.setRemoteDescription({ sdp: answer.sdp, type: answer.type as RTCSdpType });
    markOpen('remote-sdp');
    const tSetRemoteDone = performance.now();
    log(`[webrtc-signal] setRemoteDescription +${Math.round(tSetRemoteDone - tSetRemote)}ms`);
  } catch (e: any) {
    log('[webrtc] setRemoteDescription failed',
      `name=${e?.name ?? 'Unknown'}`,
      `message=${e?.message ?? '(none)'}`);
    setState('failed');
    await close('setup-failed', { source: 'setup' });
    throw e;
  }

  // Drain queued candidates.
  if (active && active.pendingCandidates.length > 0) {
    const drained = active.pendingCandidates.splice(0, active.pendingCandidates.length);
    for (const c of drained) {
      void postIce(answer.peer_id, c);
    }
  }
}

async function postIce(peerId: string, candidate: RTCIceCandidate) {
  try {
    const body = JSON.stringify({
      peer_id: peerId,
      candidate: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      },
    });
    const res = await fetch(apiUrl('/api/rtc/ice'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      diag('[webrtc] ice POST', res.status, txt.slice(0, 150));
    }
  } catch (e: any) {
    diag('[webrtc] ice POST err', e?.message);
  }
}

export async function close(
  reason: CloseReason = 'user-hangup',
  opts?: { silent?: boolean; source?: string },
): Promise<void> {
  // A user-initiated hangup cancels any in-flight reconnect. (Internal
  // reconnect teardown passes 'net-failed' + silent, so it won't trip
  // this — only an actual hangup or a give-up, which clears reconnect
  // state itself before calling close.)
  if (reason === 'user-hangup') endReconnect();
  if (!active) return;
  // Suppress the terminal `idle` notify when we're tearing the dead PC
  // down mid-reconnect — the UI must stay on `reconnecting`, not flash
  // idle between attempts.
  const silent = opts?.silent === true || reconnecting;
  const closeT0 = performance.now();
  setState('closing');
  const session = active;
  active = null;
  // Per-step timing inside `local` — surfaces any unexpectedly slow
  // sync close step (dataChannel.close, pc.close, etc.).
  const tStart = performance.now();
  try { audioPlatform.releaseMicStream('webrtc'); } catch { /* ignore */ }
  // If the mic acquire is still in flight (capture holds a pendingOwner
  // reservation), the release above no-oped. Wait for it to settle, then
  // release defensively — otherwise a reconnect reopen's getMicStream
  // throws "already held by webrtc". The stale-mic handler in open()
  // usually releases first (active is already null here), so this is a
  // belt-and-braces second release; release() is idempotent.
  if (activeMicAcquire) {
    await activeMicAcquire;
    activeMicAcquire = null;
    try { audioPlatform.releaseMicStream('webrtc'); } catch { /* ignore */ }
  }
  const tMicReleased = performance.now();
  if (session.dataChannel) {
    try { session.dataChannel.close(); } catch { /* ignore */ }
  }
  const tDataChClose = performance.now();
  try { session.pc.close(); } catch { /* ignore */ }
  const tPcClose = performance.now();
  // Un-duck BEFORE dropping the references, so a call closed mid-barge
  // can't strand its element/gain node at volume 0 for a reconnect that
  // reuses them. bindRemotePlaybackTargets(null, null) resets the
  // outgoing targets on the way out.
  try { remoteGain?.disconnect(); } catch { /* ignore */ }
  bindRemotePlaybackTargets(null, null);
  if (session.remoteSourceNode) {
    try { session.remoteSourceNode.disconnect(); } catch { /* ignore */ }
  }
  if (session.remoteAudio) {
    try {
      session.remoteAudio.pause();
      session.remoteAudio.srcObject = null;
      session.remoteAudio.remove();
    } catch { /* ignore */ }
  }
  const tLocalClose = performance.now();
  log(
    // `source` names the CALLER of close() — reason alone can't
    // distinguish a real hang-up tap from e.g. a media-session pause
    // handler, and field bug 2026-08-26 needed exactly that
    // attribution for closes the user says he didn't request.
    `[webrtc-close] reason=${reason} source=${opts?.source ?? '(internal)'} ` +
    `local-steps mic=${Math.round(tMicReleased - tStart)}ms ` +
    `dc=${Math.round(tDataChClose - tMicReleased)}ms ` +
    `pc=${Math.round(tPcClose - tDataChClose)}ms ` +
    `audio=${Math.round(tLocalClose - tPcClose)}ms`,
  );
  if (session.peerId) {
    try {
      const tPostStart = performance.now();
      const res = await fetch(apiUrl('/api/rtc/close'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peer_id: session.peerId }),
      });
      const tPostDone = performance.now();
      log(`[webrtc-close] POST-close +${Math.round(tPostDone - tPostStart)}ms status=${res.status}`);
    } catch (e: any) {
      diag('[webrtc] close POST err', e?.message);
    }
  }
  const tRemoteClose = performance.now();
  log(`[webrtc-timing] close local=${Math.round(tLocalClose - closeT0)}ms remote=${Math.round(tRemoteClose - tLocalClose)}ms total=${Math.round(tRemoteClose - closeT0)}ms`);
  if (!silent) notify('idle', null);
}

// ─── STTProvider implementation ────────────────────────────────────────
//
// The WebRTC stack above predates the STTProvider abstraction. Rather
// than rewrite the module, we wrap it: WebRTCSTTProvider is a thin
// shim around `open` / `close` / `getDataChannelListener` that
// satisfies the vendor-neutral interface in `src/audio/stt-provider.ts`.
// Tests that need a synthetic transcript stream can ship a
// MockSTTProvider against the same interface without touching WebRTC.
//
// Caveat: the data-channel listener registry is single-slot (see
// `setDataChannelListener` above) — the provider preserves the
// long-standing save-and-restore pattern that `dictate.ts` already
// used, so existing wiring (main.ts's call-mode listener) survives a
// dictate session unchanged.

/** WebRTC-backed STT provider. Wraps the existing peer-connection +
 *  data-channel pipeline. Concrete implementation behind the
 *  vendor-neutral STTProvider interface. */
export class WebRTCSTTProvider implements STTProvider {
  private listener: ((ev: STTTranscriptEvent) => void) | null = null;
  private savedListener: ((ev: any) => void) | null = null;
  private started = false;

  async start(opts?: { sessionId?: string | null; chatId?: string | null }): Promise<void> {
    if (this.started) return;
    // Save whatever data-channel listener was wired (e.g. main.ts's
    // call-mode listener) so we can restore it on stop. The registry
    // is single-slot; the wrapper has to remember what it replaced.
    this.savedListener = getDataChannelListener();
    setDataChannelListener((ev) => this.dispatch(ev));
    try {
      await open('stream', {
        sessionId: opts?.sessionId ?? null,
        chatId: opts?.chatId ?? null,
      });
      this.started = true;
    } catch (e) {
      // Restore listener on failure so the host page isn't left with a
      // dangling provider listener that won't see any future events.
      if (this.savedListener) setDataChannelListener(this.savedListener);
      this.savedListener = null;
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      // Even if we never finished start(), any in-flight save needs
      // unwinding. Idempotent.
      if (this.savedListener) {
        setDataChannelListener(this.savedListener);
        this.savedListener = null;
      }
      return;
    }
    this.started = false;
    try { await close('user-hangup', { source: 'stt-provider-stop' }); } catch (e: any) { diag('[webrtc-stt] close err', e?.message); }
    if (this.savedListener) {
      setDataChannelListener(this.savedListener);
      this.savedListener = null;
    }
  }

  onTranscript(cb: (ev: STTTranscriptEvent) => void): Unsubscribe {
    this.listener = cb;
    return () => {
      if (this.listener === cb) this.listener = null;
    };
  }

  /** Filter raw data-channel events down to transcript events for the
   *  registered STTProvider listener. Non-transcript envelopes (barge,
   *  listening, etc.) are dropped — they're transport concerns of the
   *  WebRTC impl, not part of the STT contract. */
  private dispatch(ev: any): void {
    if (!this.listener) return;
    if (!ev || ev.type !== 'transcript' || typeof ev.text !== 'string') return;
    if (ev.role !== 'user' && ev.role !== 'assistant') return;
    try {
      this.listener({
        type: 'transcript',
        text: ev.text,
        is_final: !!ev.is_final,
        role: ev.role,
      });
    } catch (e: any) {
      diag('[webrtc-stt] listener threw:', e?.message);
    }
  }
}

/** Default WebRTC STT provider instance — sufficient for the single-
 *  active-session reality of the PWA. Tests can construct a fresh
 *  `WebRTCSTTProvider` or substitute a mock implementing the same
 *  interface. */
export const defaultWebRTCSTTProvider = new WebRTCSTTProvider();
