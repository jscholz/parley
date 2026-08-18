# Barge-in

Parley lets you interrupt the agent mid-sentence by speaking — same way you'd interrupt a person on a call. This doc covers the user-facing model, the detection algorithm, the tunable knobs, and the file layout for engineers debugging false-fires or missed-fires.

> **Status convention**: the *Current behaviour* table at the bottom is updated as we ship fixes. Defaults change over time; the table is the source of truth. Anything in the body that contradicts the table is stale.

---

## What "barge" does

When the agent is speaking (TTS playback in progress) and you start speaking, parley:

1. **Halts the agent's reply** — playback stops, no completion of the current sentence.
2. **Plays a short chime** — audible feedback that the interrupt was registered.
3. **Re-arms for your turn** — your speech is captured as the next user input.

Barge fires once per detected speech onset, then mutes itself for a cooldown window so a single utterance can't trigger 12 fires.

## Two modes

Parley has two voice modes; barge works the same way conceptually but routes through different transports:

| Mode | When active | TTS playback | Barge halts via |
|---|---|---|---|
| **Turn-based** | Call button with Realtime toggle OFF | Local `<audio>` element after each agent reply | `cancelReplyTts()` + caller's `onBarge` re-arms the listener |
| **Realtime** | Call button with Realtime toggle ON | Remote audio track over the WebRTC peer | Client sends `{type:'barge'}` over the data channel; bridge calls `tts_track.halt()` |

Both modes use the **same** detector (`src/audio/shared/bargeDetector.ts`) — that's the point of the unified module.

## When barge is NOT available

The detector only arms when these conditions all hold:

- **Headphones (or some isolation)** in turn-based mode. With phone speaker + open mic, speaker-bleed of the agent's own voice would self-trigger barge with no useful signal. Speaker-mode in turn-based **disables** barge entirely. See `src/audio/shared/headphones.ts`.
- **TTS is actually playing** (`isPlayingCb()` returns true). Outside playback there's nothing to interrupt.
- **User toggle is on** (`isEnabledCb()` returns true). Settings → call-mode menu → Barge sensitivity slider; leftmost position = OFF.
- **Past the warmup window** (default 500 ms after TTS starts). Absorbs the worst transient as the platform's AEC locks on.
- **Past the cooldown** (default 2 s after the last fire). Stops "12 fires in 9 seconds" cascades during sustained speech.

Realtime mode bypasses the headphones gate — WebRTC's AEC handles speaker-bleed well enough that barge works on the phone speaker.

## How detection works

The detector reads from the live mic stream every 50 ms and asks one question:

> Is the user speaking *right now*?

Answered by **Silero VAD** (a small ONNX neural net). The same model can run in two places, abstracted behind a pluggable `VadSource` (see `src/audio/shared/vadSource.ts`):

- **`ClientSideVadSource`** — Silero runs in the browser via [@ricky0123/vad-web](https://github.com/ricky0123/vad-web), reading the local mic stream.
- **`BridgeVadSource`** — Silero runs on the audio-bridge (`audio-bridge/barge_policy.py`, onnxruntime by default), which streams `{type:'speech-active', active}` envelopes over the data channel; the client reads those instead of running its own model.

Either way the *decision* stays client-side: the `BargeDetector` fires when the active `VadSource` reports speech AND every gate above passes, then the client sends `{type:'barge'}` upstream to halt TTS. The bridge's role (when bridge VAD is active) is only to supply the speech signal, not to halt playback.

**Which source runs where** (`src/audio/shared/vadRouting.ts`):

- **Turn-based** uses `ClientSideVadSource` — there's no live WebRTC peer to stream server envelopes.
- **Realtime** uses `FallbackVadSource`: it prefers the bridge (offloads Silero from the phone, ~couple-hundred-ms cost) but performs a capability handshake at call start — the client sends `{type:'barge-vad-query'}` and the bridge replies `{type:'barge-vad', available}`. If the bridge reports VAD unavailable (no onnxruntime/torch in its venv) or doesn't answer by the deadline, the source transparently falls back to `ClientSideVadSource`. This is why realtime barge keeps working even against a bridge with no server-side VAD installed.

## Knobs

The user-facing slider in the call-mode chevron menu maps to **Silero `positiveSpeechThreshold`** (0..1) — stored as `settings.bargeVadThreshold`. Slider 0..100% maps inversely to threshold 1.0..0.0: higher slider = more sensitive = lower threshold = fires more easily.

- **0% (off)** — sets `bargeIn=false`. The barge detector is never instantiated AND the 14.7 MB Silero asset prefetch is skipped on page load. Use this when you don't want barge at all.
- **1-99%** — `positiveSpeechThreshold = (100 - slider) / 100`.
- **50% (default)** — threshold 0.5 (slightly stricter than Silero library default 0.3; absorbs environmental noise).
- **100%** — threshold 0.0 (max sensitivity; fires on any frame the model can grade).

Other knobs (set in `bargeDetector.ts` defaults, override per-call via `BargeDetectorOpts`):

| Knob | Default | Effect |
|---|---|---|
| `warmupMs` | 500 ms | Grace period after TTS starts before the detector arms. Absorbs the start-of-playback transient. |
| `cooldownMs` | 2000 ms | Mute the detector for this long after firing. Prevents repeat-fires from one sustained utterance. |
| `frameMs` | 50 ms | How often the detector polls Silero. Lower = snappier but more CPU. |
| `positiveSpeechThreshold` | 0.5 | Silero confidence above which the frame counts as speech-active. Driven by the slider (`settings.bargeVadThreshold`). |
| `minSpeechMs` | 400 ms | How long speech must sustain before `onSpeechStart` fires. **Bumped from 150→400 ms (2026-05-05)** to suppress wind/breathing/road-rumble on bike rides. Trade: ~250 ms slower perceived response, false-fires gone. |

The detector itself is initialised via `BargeDetector.start({ micStream, isPlayingCb, isEnabledCb, onFire, ... })`; cleanup is `await det.stop()`. Multiple detectors can coexist (e.g. a realtime call + a Listen session both armed); each holds one ref on the shared `speechVad` module.

## File layout

| File | Owns |
|---|---|
| [`src/audio/shared/bargeDetector.ts`](../src/audio/shared/bargeDetector.ts) | Unified detector — fire condition, warmup/cooldown, lifecycle, fire chime. |
| [`src/audio/shared/speechVad/index.ts`](../src/audio/shared/speechVad/index.ts) | Silero VAD wrapper — MicVAD lifecycle, `isSpeechActive()` readout, refcount. |
| [`src/audio/shared/vadSource.ts`](../src/audio/shared/vadSource.ts) | `VadSource` abstraction — `ClientSideVadSource`, `BridgeVadSource`, `FallbackVadSource` (bridge-preferred with client fallback), `FakeVadSource` (tests). |
| [`src/audio/shared/vadRouting.ts`](../src/audio/shared/vadRouting.ts) | Picks the `VadSource` per mode/strategy (`makeVadSource`) + effective-threshold helpers. |
| [`src/audio/shared/headphones.ts`](../src/audio/shared/headphones.ts) | SSOT for "is barge physically possible" — checks audio routing on iOS via `navigator.audioSession.type`. |
| [`src/audio/realtime/realtime.ts`](../src/audio/realtime/realtime.ts) | WebRTC offer body, `client_owns_barge` flag, upstream `{type:'barge'}` envelope. |
| [`src/audio/realtime/realtimeBarge.ts`](../src/audio/realtime/realtimeBarge.ts) | Realtime-mode wiring of `BargeDetector` — `isPlayingCb` reads `suppress.isTtsPlaying()`. |
| [`src/audio/realtime/suppress.ts`](../src/audio/realtime/suppress.ts) | Tracks whether agent audio is currently playing (driven by `assistant_delta` events + `listening` envelope from bridge). |
| [`src/audio/turn-based/turnbased.ts`](../src/audio/turn-based/turnbased.ts) | Turn-based wiring of `BargeDetector` — `isPlayingCb` reads Listen state machine. |
| [`src/voiceTuning.ts`](../src/voiceTuning.ts) | Per-device RMS-amplitude defaults — used by turnbased's silence-end detector only; not the barge VAD slider. |
| [`src/audio/shared/feedback.ts`](../src/audio/shared/feedback.ts) | The barge fire chime (and other system chimes). |

## Tests

| Test | What it pins |
|---|---|
| [`test/barge-detector.test.ts`](../test/barge-detector.test.ts) | Warmup mute, cooldown enforcement, re-arm on TTS end, multi-detector refcount, exception isolation in `onFire()`. Drives synthetic speech via `setSpeechActiveOverrideForTests`. |
| [`test/speech-vad.test.ts`](../test/speech-vad.test.ts) | MicVAD lifecycle, tuning-knob plumbing, `isSpeechActive` state machine, stream-identity check (one bug-fix anchor per release). |
| [`test/realtime-suppress-tts-playback.test.ts`](../test/realtime-suppress-tts-playback.test.ts) | The `suppress.isTtsPlaying()` state machine that gates realtime barge. |
| `scripts/smoke/realtime-barge-client-side.mjs` | End-to-end: client fires, upstream sends, bridge halts, no bridge-side VAD. |
| `scripts/smoke/turnbased-barge.mjs` | Turn-based fire path. |
| `scripts/smoke/realtime-barge-multi-connect.mjs` | Detector re-arms cleanly across connect/disconnect cycles. |
| `scripts/smoke/realtime-barge-hangup-before-reply.mjs` | Hangup during MicVAD warmup doesn't leak refs. |
| `scripts/smoke/vad-warm-after-prefetch.mjs` + `vad-init-real.mjs` | Silero asset prefetch + first-call latency budgets. |

Heavier real-audio rig at `scripts/smoke-barge/` (run via `npm run smoke:barge`). Boots stub agent + audio-bridge with fixture TTS + parley proxy on isolated ports; chromium drives a real WebRTC call with mic-injected fixture WAVs. Catches end-to-end pipeline regressions:

| Scenario | What it pins |
|---|---|
| `silence-no-self-fire` | Silent mic during agent TTS yields zero fires (regression baseline). |
| `agent-voice-in-mic` | Agent's voice in mic (no AEC) DOES fire — pins the field-bug class on Pi5 until a fix flips this assertion. |
| `user-speech-fires-barge` | Real user speech fires barge (catches over-correction where a fix goes too deaf). |
| `threshold-affects-fires` | `bargeVadThreshold=1.0` produces 0 fires; `0.05` fires on agent voice. Pins the slider plumbing. |

---

## Current behaviour

This table is updated as we ship fixes. The dates are when each value last changed.

| | Value | Set in | Since |
|---|---|---|---|
| Detection model | Silero VAD only (RMS retired) | `bargeDetector.ts` | 2026-05-04 |
| Warmup window | 500 ms after TTS start | `DEFAULT_WARMUP_MS` | original |
| Post-fire cooldown | 2000 ms | `DEFAULT_COOLDOWN_MS` | original |
| Loop cadence | 50 ms | `DEFAULT_FRAME_MS` | original |
| Silero `positiveSpeechThreshold` | 0.5 default; user slider drives `settings.bargeVadThreshold`, mapped 0..100% → 1.0..0.0 inversely | `settings.ts:sensitivityToVadThreshold` | 2026-05-06 |
| Silero `minSpeechMs` | 400 ms | `DEFAULT_MIN_SPEECH_MS` | 2026-05-05 (was 150) |
| Silero MicVAD warmup watchdog | 15 s | `speechVad/index.ts` | 2026-05-04 (was 10) |
| Realtime VAD source | bridge-preferred via `FallbackVadSource` (capability handshake; falls back to client-side Silero if bridge VAD unavailable). Halt decision stays client-side (`{type:'barge'}`). | `vadRouting.ts` / `vadSource.ts` | 2026-05-31 |
| Turn-based VAD source | client-side Silero (`ClientSideVadSource`) | `vadRouting.ts` | 2026-05-31 |
| Server-side VAD backend | onnxruntime (CPU, vendored `silero_vad.onnx`) by default; torch/silero-vad optional | `barge_policy.py` | 2026-05-31 |
| Turn-based + speaker | Barge **disabled** entirely | `headphones.ts` | original |
| Turn-based + headphones | Barge enabled | `headphones.ts` | original |
| Realtime + speaker | Barge enabled (relies on WebRTC AEC) | `realtime.ts` | original |

## Known issues being investigated

- **Self-barge mid-call on mobile.** Reproduced on iPhone PWA standalone — barge fires within ~10 s of TTS playback as the agent speaks, with VAD flipping from silent to speech. Indicates the mic stream feeding Silero is hearing the agent's voice (speaker bleed not removed by AEC, or AEC not engaged for the path Silero reads from). The slider plumbing (separate bug, fixed 2026-05-06) is no longer a contributor.
- **Silero `MicVAD.new` 15 s timeout on Mac Chrome cold start.** Model fetch hangs; no VAD warm; barge silently disabled for the call. Likely network/cache flakiness on first-call asset load. Separate from the self-barge issue.

(Add new entries here as they surface; remove when fixed and verified.)
