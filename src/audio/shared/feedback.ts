/**
 * @fileoverview Subtle audio feedback sounds — tiny clicks for send/receive.
 *
 * Switched from live Web Audio oscillators to pre-rendered WAV blobs played
 * via HTMLAudioElement. Reason: chimes that fired while the iOS
 * AVAudioSession category was 'play-and-record' (mic mode) routed to the
 * iPhone speaker, while chimes during TTS playback ('playback' category)
 * routed to BT correctly. Root cause: the shared AudioContext binds to the
 * iOS hardware route AT CREATION TIME — later setSessionType() hints don't
 * migrate existing oscillator destinations.
 *
 * Fix: HTMLAudioElement.play() inherits whatever AVAudioSession category
 * is current at play() time, identically to TTS (which uses the same
 * mechanism — see tts.ts). Same proven pattern as the silent-keepalive
 * element in ios-specific.ts. One audio mechanism for chimes + TTS +
 * keepalive, no AudioContext-binding-time race.
 *
 * The chime designs (oscillator + gain envelopes) are preserved verbatim;
 * scheduleChime() runs them on an OfflineAudioContext to render PCM, then
 * audioBufferToWav() encodes for HTMLAudioElement consumption. First call
 * per chime pays the render cost (~few ms), subsequent calls reuse the
 * cached blob URL.
 *
 * ── Cue catalogue (single source of truth) ──────────────────────────────
 * Every named cue, what fires it, and what it means. Per-cue oscillator
 * design notes live on scheduleChime() below.
 *
 *   send         outbound message shipped to backend       (rising click)
 *   receive      inbound message/reply arrived             (descending pop)
 *   error        a transactional failure (send/queue)      (2 low desc tones)
 *   start        local mic capture began (memo/streaming)  (very short tick)
 *   commit       commit-word ("over") detected pre-send    (high rising tick)
 *   connect      WebRTC peer connection established         (asc two-tone)
 *   listening    STT pipe hot, "your turn" (call-start +    (soft two-tone
 *                every TTS-end transition)                   fade-in)
 *   barge        user voice cut in over TTS                 (short sine ping)
 *   call-dropped a CONNECTED call ended unexpectedly        (slow descending
 *                (network drop / ICE failure), NOT a         two-note, lower
 *                user-initiated hangup. Distinct, lower      + longer than
 *                and slower than `error` so a backgrounded   error)
 *                user reads it as "the call died" not "a
 *                message failed". Pairs with haptic() for
 *                the suspended-AudioContext case.
 *   reconnect-tick gentle recurring cue fired every ~3s     (soft mid-pitch
 *                while the call is in 'reconnecting'         sine ping)
 *                state (yellow indicator). Signals "we're
 *                still trying — keep talking, your buffer
 *                is being preserved". Distinct from
 *                'listening' (lower pitch, single tone) and
 *                'call-dropped' (the recurring tick stops
 *                when the call actually gives up). Jonathan
 *                field bug 2026-06-23: bike-ride reconnect
 *                gaps were silently wiping the dictation
 *                buffer; chime + buffer preservation
 *                together make the recovery transparent.
 *   link-degraded  the CALL is still up but his uplink has  (descending
 *                stalled — the bridge is receiving no mic     perfect fifth,
 *                RTP at all, so everything he says is         A5→D5, two
 *                going nowhere. Fires ONCE per episode        discrete notes)
 *                (edge, never repeated), driven by the
 *                bridge's {type:'link-quality'} envelope.
 *                Means "stop talking and wait".
 *   link-restored the same link came back                    (ascending
 *                (Jonathan 2026-08-27: "it will               perfect fifth,
 *                eventually come back, and I get a chime      D5→A5 — the
 *                to that effect"). Only ever fires if         exact inverse)
 *                link-degraded actually sounded, so the
 *                two are always heard as a pair.
 *
 * ── iOS-PWA constraints ─────────────────────────────────────────────────
 *  - The AudioContext suspends on `visibilitychange=hidden` and resumes on
 *    `=visible`; cues that fire while backgrounded may not play, which is
 *    why some flows defer the cue to return-to-foreground.
 *  - When the context is suspended (backgrounded device), audio won't play
 *    at all — use haptic() alongside the chime so a pocketed phone still
 *    signals (call-dropped does this).
 *  - HTMLAudioElement.play() inherits the current AVAudioSession category
 *    at play() time, so chimes route to the same output as TTS (BT when
 *    'playback', earpiece when 'play-and-record').
 *
 * ── Volume convention ───────────────────────────────────────────────────
 *  Per-cue baked gains are pre-scaled by RENDER_SCALE; el.volume is set to
 *  the user's `audioFeedbackVolume` (0..1, default 0.5) at play time. A
 *  volume of 0 suppresses all cues (logged, not a bug). "Attention" cues
 *  (error, barge, call-dropped) are baked louder to cut through wind
 *  and traffic.
 */

import * as settings from '../../settings.ts';
import { diag } from '../../util/log.ts';

/**
 * The catalogue, in ONE place. `ChimeName`, the iOS prime list and the
 * suites all derive from this array, so they cannot drift apart.
 *
 * They used to be three hand-maintained copies. Adding `link-degraded`
 * / `link-restored` broke primeFeedback's idempotence — the prime loop
 * never saw a complete set, so `primed` never latched and every gesture
 * re-played the whole catalogue. That was caught by a suite, but the
 * shape of the bug (a new async-fired cue silently not unlocked on iOS,
 * i.e. silent in exactly the field conditions it exists for) is one
 * that deserves to be impossible rather than tested for.
 */
export const ALL_CHIMES = [
  'send', 'receive', 'error', 'start',
  'commit', 'connect', 'listening', 'barge',
  'call-dropped', 'reconnect-tick',
  'link-degraded', 'link-restored',
] as const;

export type ChimeName = typeof ALL_CHIMES[number];

// Pre-render at scale=4 so el.volume=userVolume reproduces the legacy
// oscillator path's amplitude curve.
// Bumped 4 → 8: the commit ("over") chime was missing or inaudible in
// outdoor scenarios with BT headsets and wind noise. At scale=4 the
// loudest baked gain (commit) was 0.05*4*0.5 = 0.10 at default volume.
// At scale=8 it's 0.05*8*0.5 = 0.20 (~2x louder). Headroom remains
// before clipping (loudest pre-scale gain is barge at 0.18; 0.18*8 =
// 1.44 — clamped to 1.0 by the WAV encoder, slight clipping on the
// barge attack which is desirable for "I heard you" punch).
const RENDER_SCALE = 8;
const SAMPLE_RATE = 44100;

/** Must cover every osc.stop() in scheduleChime so render doesn't truncate. */
function chimeDuration(name: ChimeName): number {
  switch (name) {
    case 'send':      return 0.10;
    case 'receive':   return 0.12;
    case 'start':     return 0.04;
    case 'commit':    return 0.07;
    case 'connect':   return 0.25;
    case 'listening': return 0.18;
    case 'barge':     return 0.14;
    case 'error':     return 0.36;
    case 'call-dropped': return 0.46;
    case 'reconnect-tick': return 0.16;
    case 'link-degraded': return 0.34;
    case 'link-restored': return 0.34;
  }
}

/**
 * Schedule a chime program on a BaseAudioContext (real or offline) starting
 * at t0. Pure scheduling — no playback semantics. Each chime's design notes
 * live here as the source of truth.
 *
 *   - send:    short rising click, confirms outbound
 *   - receive: soft descending pop, confirms inbound
 *   - error:   two low descending tones — distinct from send/receive so
 *              users hear a failure without watching the screen.
 *              Plays at ~1.5x the gain of send/receive because its whole
 *              job is to be noticed over wind/traffic.
 *   - start:   single very short high-pitched tick, ~half the gain of send.
 *              Fires when local audio capture begins (memo or streaming).
 *              Intended as a "seatbelt click": the brain tunes it out as
 *              background, only notices if it's absent — signalling the
 *              mic isn't actually recording.
 *   - commit:  higher rising tick than 'send' — fires the moment the
 *              commit-word ("over") is detected, BEFORE the message is
 *              sent. Pairs with 'send' which fires when the message
 *              actually ships to the backend.
 *   - connect: ascending two-tone chime (C5 → E5) over ~200ms — fires
 *              when a WebRTC peer connection establishes. The two-note
 *              arc reads unmistakably as "circuit closed, channel open".
 *   - listening: subtle two-tone fade-in (~150ms) — "system is ready
 *              for your voice". Sine wave (smoother than triangle) at
 *              low gain so it doesn't compete with the user starting to
 *              speak. Distinct from 'connect' which is louder.
 *   - barge:   single short sine ping (~80ms, ~600Hz) — "I heard you,
 *              stopping". Fires the moment the BargeWindow detector
 *              triggers, BEFORE the upstream halt round-trip.
 *   - call-dropped: slow descending two-note (G4→D4, then D4→G3) over
 *              ~420ms — fires when a CONNECTED call ends unexpectedly
 *              (network drop / ICE failure), never on a user hangup.
 *              Deliberately lower, slower and longer than `error` so a
 *              user on a bike with the phone pocketed reads it as "the
 *              call just died" rather than "a message failed". Triangle
 *              for wind audibility; baked at error-class gain.
 */
function scheduleChime(name: ChimeName, ctx: BaseAudioContext, t0: number): void {
  const scale = RENDER_SCALE;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);

  if (name === 'send') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, t0);
    osc.frequency.linearRampToValueAtTime(1200, t0 + 0.04);
    gain.gain.setValueAtTime(0.08 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
    osc.start(t0);
    osc.stop(t0 + 0.08);
  } else if (name === 'receive') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, t0);
    osc.frequency.linearRampToValueAtTime(400, t0 + 0.06);
    gain.gain.setValueAtTime(0.06 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.10);
    osc.start(t0);
    osc.stop(t0 + 0.10);
  } else if (name === 'start') {
    // Triangle wave carries better over wind than sine; 30ms is below
    // the conscious-attention threshold but clearly audible.
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1000, t0);
    osc.frequency.linearRampToValueAtTime(1200, t0 + 0.02);
    gain.gain.setValueAtTime(0.04 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.03);
    osc.start(t0);
    osc.stop(t0 + 0.03);
  } else if (name === 'commit') {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1600, t0);
    osc.frequency.linearRampToValueAtTime(2200, t0 + 0.03);
    gain.gain.setValueAtTime(0.05 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
    osc.start(t0);
    osc.stop(t0 + 0.05);
  } else if (name === 'connect') {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(523, t0);
    gain.gain.setValueAtTime(0.09 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.10);
    osc.start(t0);
    osc.stop(t0 + 0.10);
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'triangle';
    const t2 = t0 + 0.11;
    osc2.frequency.setValueAtTime(659, t2);
    gain2.gain.setValueAtTime(0.09 * scale, t2);
    gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.12);
    osc2.start(t2);
    osc2.stop(t2 + 0.12);
  } else if (name === 'listening') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, t0);
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.exponentialRampToValueAtTime(0.05 * scale, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
    osc.start(t0);
    osc.stop(t0 + 0.07);
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'sine';
    const t2 = t0 + 0.08;
    osc2.frequency.setValueAtTime(523, t2);
    gain2.gain.setValueAtTime(0.001, t2);
    gain2.gain.exponentialRampToValueAtTime(0.06 * scale, t2 + 0.03);
    gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.08);
    osc2.start(t2);
    osc2.stop(t2 + 0.08);
  } else if (name === 'barge') {
    // Louder and longer than the original 0.06 gain, which was hard to
    // hear over agent TTS. Sine kept (vs triangle) so it stays
    // non-jangly when it cuts off TTS mid-syllable.
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, t0);
    gain.gain.setValueAtTime(0.18 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
    osc.start(t0);
    osc.stop(t0 + 0.12);
  } else if (name === 'error') {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, t0);
    osc.frequency.linearRampToValueAtTime(330, t0 + 0.12);
    gain.gain.setValueAtTime(0.12 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
    osc.start(t0);
    osc.stop(t0 + 0.14);
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'triangle';
    const t2 = t0 + 0.20;
    osc2.frequency.setValueAtTime(330, t2);
    osc2.frequency.linearRampToValueAtTime(260, t2 + 0.12);
    gain2.gain.setValueAtTime(0.12 * scale, t2);
    gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.14);
    osc2.start(t2);
    osc2.stop(t2 + 0.14);
  } else if (name === 'reconnect-tick') {
    // Recurring ~3s cue while the call is in 'reconnecting' state.
    // Single soft sine ping at 700Hz (between 'listening' 440/523 and
    // 'barge' 600) for ~140ms — distinctly NOT either of those, gentle
    // enough to fire every 3s without being annoying. Low baked gain
    // (0.05) so it doesn't bury whatever the user is still saying — the
    // mic captures locally even though the bridge is dead, and we don't
    // want the chime audible-back into their own dictation flow.
    osc.type = 'sine';
    osc.frequency.setValueAtTime(700, t0);
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.exponentialRampToValueAtTime(0.05 * scale, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
    osc.start(t0);
    osc.stop(t0 + 0.14);
  } else if (name === 'link-degraded' || name === 'link-restored') {
    // A matched pair: descending perfect fifth for "your uplink stalled",
    // the same fifth ascending for "it's back". The falling/rising pair
    // is the universal telephony idiom for lost/regained service, so it
    // needs no learning — which matters, because the whole point is that
    // he is on a bike and cannot look at the phone.
    //
    // Distinguishing them from the rest of the catalogue by EAR (the
    // requirement, since he'll usually hear these blind):
    //   - register: 587/880 Hz. `error` (440/330/260) and `call-dropped`
    //     (392/294/196) both live an octave lower. Nothing else reaches
    //     880 Hz except `commit`/`start`, which are ticks, not tones.
    //   - interval: a perfect fifth. Every other two-note cue is a third
    //     (`connect` 523→659, `listening` 440→523) or a glide.
    //   - articulation: two DISCRETE steady notes. `error` and
    //     `call-dropped` are portamento glides; the difference between a
    //     leap and a slide is obvious even through wind.
    // Triangle for wind audibility, baked at attention-cue gain (0.12,
    // same as error/call-dropped) — this has to cut through traffic.
    const down = name === 'link-degraded';
    const hi = 880;   // A5
    const lo = 587;   // D5
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(down ? hi : lo, t0);
    gain.gain.setValueAtTime(0.12 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
    osc.start(t0);
    osc.stop(t0 + 0.14);
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'triangle';
    // 40 ms of silence between the notes — enough that they read as two
    // deliberate pitches rather than one warbling tone.
    const t2 = t0 + 0.18;
    osc2.frequency.setValueAtTime(down ? lo : hi, t2);
    gain2.gain.setValueAtTime(0.12 * scale, t2);
    gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.14);
    osc2.start(t2);
    osc2.stop(t2 + 0.14);
  } else if (name === 'call-dropped') {
    // Two slow descending notes (G4→D4, then D4→G3), lower/longer than
    // `error`. Reads as a "call ended" disconnect tone, not a
    // transactional failure.
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(392, t0);
    osc.frequency.linearRampToValueAtTime(294, t0 + 0.16);
    gain.gain.setValueAtTime(0.12 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
    osc.start(t0);
    osc.stop(t0 + 0.18);
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'triangle';
    const t2 = t0 + 0.24;
    osc2.frequency.setValueAtTime(294, t2);
    osc2.frequency.linearRampToValueAtTime(196, t2 + 0.16);
    gain2.gain.setValueAtTime(0.12 * scale, t2);
    gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.20);
    osc2.start(t2);
    osc2.stop(t2 + 0.20);
  }
}

/** Encode an AudioBuffer as a 16-bit PCM WAV Blob. Mono in, mono out
 *  (offline ctx is created with numberOfChannels=1). Standard RIFF header
 *  followed by interleaved samples. */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * numChannels * bytesPerSample;
  const arrBuf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrBuf);
  const writeStr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const ch = buffer.getChannelData(c);
      let s = Math.max(-1, Math.min(1, ch[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(offset, s | 0, true);
      offset += 2;
    }
  }
  return new Blob([arrBuf], { type: 'audio/wav' });
}

const players = new Map<ChimeName, HTMLAudioElement>();
const renderPromises = new Map<ChimeName, Promise<HTMLAudioElement>>();

/** Every chime that can fire OUTSIDE the originating user gesture and so
 *  must be unlocked ahead of time on iOS (see primeFeedback). Deliberately
 *  the WHOLE catalogue rather than a hand-picked subset — they're tiny,
 *  and a future async-fired cue (the link-quality pair are exactly that:
 *  they fire from a bridge envelope mid-call, long past the opening
 *  gesture's activation window) then can't silently regress. */
const PRIME_CHIMES: readonly ChimeName[] = ALL_CHIMES;

let primed = false;

async function renderPlayer(name: ChimeName): Promise<HTMLAudioElement> {
  const dur = chimeDuration(name);
  const Ctx = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  const offline: OfflineAudioContext = new Ctx(1, Math.ceil(SAMPLE_RATE * dur), SAMPLE_RATE);
  scheduleChime(name, offline, 0);
  const buffer = await offline.startRendering();
  const blob = audioBufferToWav(buffer);
  const el = new Audio(URL.createObjectURL(blob));
  el.preload = 'auto';
  return el;
}

async function getPlayer(name: ChimeName): Promise<HTMLAudioElement> {
  const existing = players.get(name);
  if (existing) return existing;
  const inflight = renderPromises.get(name);
  if (inflight) return inflight;
  const p = renderPlayer(name);
  renderPromises.set(name, p);
  try {
    const el = await p;
    players.set(name, el);
    return el;
  } finally {
    renderPromises.delete(name);
  }
}

/**
 * Play a short feedback chime. See scheduleChime() for design notes per
 * chime. Cached per name — first call renders, subsequent calls reuse.
 *
 * Why HTMLAudioElement instead of Web Audio: the chime needs to inherit
 * the current iOS AVAudioSession category at play() time, so it routes
 * through the same speaker as TTS (BT when 'playback', phone earpiece
 * when 'play-and-record'). Web Audio binds the route at AudioContext
 * creation time and the route doesn't migrate when the category hint
 * changes — that was the v0.446-and-prior bug where some chimes routed
 * to phone and others to BT.
 */
export function playFeedback(name: ChimeName): void {
  // Test instrumentation hook — Playwright smokes use this to assert
  // chime invariants ("'send' fires exactly once per assistant turn", etc.)
  // without needing to actually decode audio. Production never sees it.
  try {
    const w = (typeof window !== 'undefined') ? window : null;
    const log = w && (w as any).__TEST_FEEDBACK_LOG__;
    if (Array.isArray(log)) log.push({ type: name, t: Date.now() });
  } catch { /* best-effort */ }

  const volume = settings.get().audioFeedbackVolume ?? 0.5;
  if (volume <= 0) {
    // Volume slider zeroed — log the suppression so a "no chime fired"
    // report can be ruled out as a config issue rather than a bug.
    diag(`[feedback] suppressed (${name}): user volume = 0`);
    return;
  }
  const userVolume = Math.max(0, Math.min(1, volume));
  // Per-fire log for diagnosing missing/quiet chimes. Catches three
  // classes: chime never fired, chime fired at low volume, chime fired
  // but play() rejected.
  diag(`[feedback] play (${name}) vol=${userVolume.toFixed(2)}`);

  // Fire-and-forget. First-call render is async; subsequent calls resolve
  // synchronously off the cache. Errors are logged (not swallowed silently)
  // so dev-mode can catch missing chimes — without logging we'd never know
  // which side failed (render vs play). Failures don't throw into the hot path.
  void (async () => {
    let el: HTMLAudioElement;
    try {
      el = await getPlayer(name);
    } catch (err: any) {
      diag(`[feedback] render failed (${name}): ${err?.message ?? err}`);
      return;
    }
    el.volume = userVolume;
    try { el.currentTime = 0; } catch { /* ignore — element may still be loading */ }
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err: any) => {
        // Most common cause on iOS: AVAudioSession not yet activated by
        // a user gesture, or the WebView's audio output path is wedged.
        // Log for diagnostics; the keepalive engine + interruption
        // handlers should reduce the second class.
        diag(`[feedback] play failed (${name}): ${err?.message ?? err}`);
      });
    }
  })();
}

/**
 * Eagerly render every chime's WAV blob + HTMLAudioElement so that
 * primeFeedback() can play them SYNCHRONOUSLY inside a user gesture.
 * Offline rendering needs no gesture, so this is safe to call at app
 * boot — and it doubles as a warm cache so the first real chime never
 * pays the render cost. Idempotent (getPlayer dedups in-flight renders).
 */
export function warmFeedback(): void {
  for (const name of PRIME_CHIMES) getPlayer(name).catch(() => { /* warm best-effort */ });
}

/**
 * iOS chime unlock. Call SYNCHRONOUSLY inside the user gesture that opens
 * a call / starts dictate (the same gesture that calls primeAudio).
 *
 * Why: iOS gates HTMLAudioElement.play() per-element behind user
 * activation — unlock() (audio-unlock.ts) only unlocks the shared TTS
 * `player`, never the separately-created chime elements. The call-start
 * 'listening' cue fires async from the bridge's {type:'listening'}
 * envelope, which arrives AFTER WebRTC negotiation — often past the ~5s
 * transient-activation window — so the chime element's first-ever play()
 * happens outside any gesture and iOS blocks it. (Dictate's 'listening'
 * fires fast enough to land inside the window, which is why toggling
 * dictate first "fixes" the call chime — it unlocks the shared element.)
 *
 * Playing each cached element muted inside the gesture marks it
 * user-activated up front, so the later async fire plays normally.
 * Requires warmFeedback() to have rendered the elements first; any not
 * yet cached are kicked to render and retried on the next gesture.
 * Idempotent once the full set is unlocked.
 */
export function primeFeedback(): void {
  if (primed) return;
  try {
    const w = (typeof window !== 'undefined') ? window : null;
    const log = w && (w as any).__TEST_FEEDBACK_LOG__;
    if (Array.isArray(log)) log.push({ type: 'prime', t: Date.now() });
  } catch { /* best-effort */ }

  let allReady = true;
  for (const name of PRIME_CHIMES) {
    const el = players.get(name);
    if (!el) { getPlayer(name).catch(() => { /* retried next gesture */ }); allReady = false; continue; }
    try {
      el.muted = true;
      try { el.currentTime = 0; } catch { /* may still be loading */ }
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* unlock only */ });
      setTimeout(() => {
        try { el.pause(); el.currentTime = 0; el.muted = false; } catch { /* ignore */ }
      }, 60);
    } catch {
      allReady = false;
    }
  }
  if (allReady) primed = true;
}

/** Test hooks — inject fake players + reset prime state deterministically
 *  without OfflineAudioContext/Audio (unavailable under node:test). */
export function __setPlayerForTests(name: ChimeName, el: HTMLAudioElement): void {
  players.set(name, el);
}
export function __resetFeedbackForTests(): void {
  players.clear();
  renderPromises.clear();
  primed = false;
}

/**
 * Fire a vibration pattern via the Vibration API. Best-effort: silently
 * no-ops where unsupported (notably iOS Safari/PWA does not implement
 * navigator.vibrate today). Used as a fallback signal alongside a chime
 * for events that can fire while the AudioContext is suspended on a
 * backgrounded device (e.g. call-dropped) — if the audio can't play, at
 * least the phone buzzes. `pattern` follows the Vibration API contract:
 * a single duration in ms, or an array of [vibrate, pause, vibrate, …].
 */
export function haptic(pattern: number | number[] = [100, 50, 100]): void {
  try {
    (navigator as any)?.vibrate?.(pattern);
  } catch { /* best-effort — unsupported or blocked */ }
}
