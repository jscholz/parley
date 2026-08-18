# Audio subsystem

PWA-side voice I/O. Two **transports** (turn-based vs. realtime / WebRTC) are surfaced through two **buttons** on the composer (mic vs. call); each button routes to a transport based on a single setting in its menu.

## The composer surface (two buttons, four modes)

Since the 2026-05 two-button-split refactor, the composer has a dedicated **mic** button on the right and a dedicated **call** button on the left. Each button has its own chevron menu:

| Button | Default action | Menu toggle | Toggle ON behavior |
|---|---|---|---|
| **Mic** (right) | Voice memo (record blob → /transcribe → composer) | `streaming` | Live STT into composer cursor (cursor-aware dictation) |
| **Mic** | (independent) | `micAutoSend` | Skip composer review on end-of-utterance |
| **Call** (left) | Turn-based Listen (record + commit on silence/sendword) | `realtime` | WebRTC duplex (low-latency talk/stream) |
| **Call** | (independent) | `tts` | Speak replies (talk-mode WebRTC; turn-based plays /tts blob) |

`speak-replies` (`tts`) is **call-only** — outside a call the user reads replies on screen and the per-bubble play button (`turn-based/replyPlayer.ts`) handles on-demand replay. Inside a call the toggle picks talk vs. stream WebRTC mode.

## The two transports

Both transports are **handsfree call-mode** — mic open, no tap-to-talk, the agent answers automatically. They differ in what they optimise for:

| | **Realtime** | **Turn-based** |
|---|---|---|
| Optimises for | **Latency** (sub-second TTS start) | **Fidelity** (full-quality audio in both directions) |
| Mic capture | Bridge taps the WebRTC peer track | `MediaRecorder` writes a full blob locally |
| Audio in transport | WebRTC duplex to `audio-bridge/` (lossy codec, jitter recovery) | HTTP POST `/transcribe` (full webm/opus blob) |
| Audio out transport | Streamed back over the WebRTC peer | mp3 blob fetched from `/tts`, played in `<audio>` |
| STT | Live, streaming, on the bridge | One-shot per utterance, served by the bridge over HTTP |
| Resilience | Sensitive to flaky networks (peer rebuilds) | Survives drops; retries the HTTP call |

The user picks the call's transport with `settings.realtime` (call-menu chevron → "Realtime"). Default OFF (turn-based). The mic button has its own picker (`settings.streaming`) for memo vs. dictation but doesn't open a call — that's the call button's job.

**Both modes ride the same agent contract**: `POST /api/parley/messages` for the user turn, `GET /api/parley/stream` for the agent's reply. Realtime mode just has the bridge make those calls instead of the PWA. The text/agent path is identical; only audio in/out differ. (See "What changes for a duplex model" below — this stops being true the day a duplex-native backend lands.)

For the wire-protocol view (which proxy + agent endpoints each mode hits), see the top-level `README.md` "Two voice modes" section.

## Handsfree mechanisms (shared)

Both modes answer the same question — "is this user utterance done?" — using the same two triggers:

- **Silence timeout** — N seconds of silence after the last detected speech ends the utterance and dispatches it. Configured by `settings.silenceSec` (0 = sendword-only).
- **Sendword** — user says a configured phrase ("over" by default) and the utterance dispatches immediately, with the phrase stripped from the transcript. Configured by `settings.commitPhrase`.

Both triggers live in `shared/handsfree.ts`:

- `matchSendword(text, phrase)` — the captured-prefix regex (anchored, word-boundary, case-insensitive). Used by both turn-based (`turnbased.ts` + `sendwordDetector.ts`) and realtime (`dictation.ts`).
- `SilenceWindow` class — `lastVoiceAt` + threshold tracker. Modes drive it differently (turn-based polls expired() in its 50ms analyser loop; realtime arms a setTimeout on each `is_final` from the bridge) but share the policy.
- `getHandsfreeConfig()` — single resolver for the two settings keys.

The **mechanism** for detecting speech stays per-mode (turn-based reads analyser peaks; realtime gets discrete `is_final` events from the bridge). Different inputs, same policy.

**Barge-in** has the same shape: same algorithm in both modes (sliding N-of-K hot frames above a peak threshold), different runtimes. The PWA-side detector lives in `shared/barge.ts` (`BargeWindow` class, used by `turnbased.ts:tickBarge`); the bridge runs the Python equivalent. No code share is possible across language, but the algorithm is identical.

## The `AudioMode` interface

Both modes implement a contract so `main.ts` can dispatch without branching everywhere:

```ts
export interface AudioMode {
  /** Acquire mic, run mode-specific setup. Returns false if the mic
   *  was unavailable. Multiple calls while active are no-ops. */
  start(opts?: AudioModeStartOpts): Promise<boolean>;

  /** Release mic + tear down. Idempotent. */
  stop(): Promise<void>;

  /** Is this mode currently running? Used by main.ts as a guard
   *  before flipping the other mode on. */
  isActive(): boolean;

  /** Lifecycle/status sub-state for the UI (mic icon, status pill).
   *  States are common across both modes — both go armed → recording
   *  → sending → playing → cooldown → armed. The names are a
   *  superset; modes that don't visit a state simply skip it. */
  getState(): AudioModeState;

  /** Caller signals that an external TTS playback (turn-based: PWA
   *  /tts; realtime: peer-track audio) is starting / ending. Drives
   *  barge detection windows + cooldown timers. */
  notifyReplyPlayback(playing: boolean): void;
}

export type AudioModeState =
  | 'idle' | 'armed' | 'recording' | 'sending' | 'playing' | 'cooldown';

export type AudioModeStartOpts = {
  /** Status callback — caller mirrors to UI. Same union as getState(). */
  onState?: (s: AudioModeState) => void;
  /** Caller's hook for "user committed an utterance, here's the
   *  transcribed text". Both modes can call this; realtime fires on
   *  each `is_final` from the bridge that passes the handsfree
   *  evaluator, turn-based fires once per /transcribe response. */
  onCommit?: (text: string, reason: 'silence' | 'sendword' | 'barge') => void;
  /** Sustained user speech during TTS playback. Both modes detect
   *  this; the caller decides what to do (cancel TTS, re-arm). */
  onBarge?: () => void;
};
```

This contract is **richer than the bare-lifecycle interface I drafted earlier** because both modes really do share more than just start/stop. Today they ride the same agent-contract endpoints (`/api/parley/messages` + `/api/parley/stream`), so "user committed" and "agent reply playing" are meaningful in both. They share the same handsfree mechanisms (silence + sendword) and the same barge algorithm. Forcing those into a thin lifecycle interface would mean main.ts re-branches on the mode anyway, which defeats the point.

**Mode-specific surface stays on the implementation**, not in the interface:

- Realtime extras: `openCall(mode: 'talk' | 'stream')`, `closeIfOpen()` — the WebRTC connection has lifecycle states (negotiating, ICE-gathering, connected) that don't map onto turn-based.
- Turn-based extras: per-bubble replay navigation (`replyNavigator`) — only meaningful when reply audio is cached locally, which realtime doesn't do.

## What changes for a duplex model

The richer interface above is honest **as long as both modes drive the same agent-contract endpoints**. The day we wire a duplex-native backend (OpenAI Realtime, Gemini Live), realtime mode stops POSTing user transcripts to `/api/parley/messages` and stops subscribing to `/api/parley/stream` — the model server takes over both directions over its own WebRTC/WebSocket channel.

In that future:

- `onCommit` is no longer meaningful for realtime — there's no discrete "user turn committed" event; audio just streams. (It's still meaningful for turn-based.)
- `onBarge` is still meaningful — the model emits its own VAD events, but the PWA still needs to know when to cancel any UI affordances tied to playback.
- `getState()` mostly survives; the duplex peer goes through similar lifecycle stages.

So the **lifecycle + barge** subset of the interface survives; **commit** does not.

Recommendation for now: ship the richer interface today, since both modes really do hit the same backend. Mark `onCommit` in the doc as "turn-based-shaped backend only — duplex models will signal through `onState` instead." When duplex lands we can either widen the state union (`speaking` / `listening` / `interrupted`) or split into two interfaces (`AudioMode` + `DuplexMode`). Don't pre-build the abstraction now; the duplex shape isn't pinned down enough to design against.

The handsfree mechanisms (`shared/handsfree.ts`) survive duplex unchanged — they're a policy module that any audio source can feed. So extracting them now is value-positive in either future.

## File layout (proposed)

```
src/audio/
├── README.md                  # this file
├── mode.ts                    # AudioMode interface
├── shared/                    # mode-agnostic infrastructure
│   ├── capture.ts             # MediaStream owner, ref-counted by mode + memo
│   ├── platform.ts            # Web Audio + MediaStream shim (iOS quirks)
│   ├── session.ts             # Media Session API + audioSession.type
│   ├── memo.ts                # MediaRecorder bar (push-to-record)
│   ├── recorderBar.ts         # visual recorder UI (memo + turn-based share)
│   ├── micMeter.ts            # per-frame peak meter
│   ├── audio-processor.js     # AudioWorklet for peak meter
│   ├── feedback.ts            # send/receive UI chimes
│   ├── ios-specific.ts        # iOS-only background-audio hacks
│   ├── stt-provider.ts        # STT provider abstraction (one impl)
│   └── tts-provider.ts        # TTS provider abstraction (interface only)
├── turn-based/                # HTTP-mode files
│   ├── turnbased.ts           # state machine + barge (was listen.ts)
│   ├── tts.ts                 # /tts blob fetch + playback (was text-tts.ts)
│   ├── replyNavigator.ts      # per-bubble play/pause + BT skip-fwd/back
│   ├── replyCache.ts          # LRU for /tts blobs
│   └── sendwordDetector.ts    # Web Speech API "over" detector
└── realtime/                  # WebRTC-mode files (was src/pipelines/webrtc/)
    ├── realtime.ts            # peer setup + offer/ICE (was connection.ts)
    ├── controls.ts            # openCall, closeIfOpen, mode swap
    ├── dictate.ts             # live dictation variant
    ├── dictation.ts           # per-call utterance state machine
    └── suppress.ts            # user-transcript suppression during reply
```

### Why these groupings

- **`shared/`** = touched by both modes. If you're adding a new mode (or the bridge gets rewritten), these are the primitives you'd reuse. None of them assume WebRTC or HTTP.
- **`turn-based/`** = anything that only runs when `settings.realtime === false`. The reply-playback files (`tts.ts`, `replyNavigator.ts`, `replyCache.ts`) live here because they're the *turn-based reply path* — realtime gets its TTS over the WebRTC peer.
- **`realtime/`** = anything that only runs when `settings.realtime === true`. The `dictation.ts` state machine moved out of the bridge into the PWA; it lives here because it's WebRTC-mode-specific.

### What this rename clarifies

- `listen.ts` → `turnbased.ts`. The name "listen" came from the subagent that first wrote it; it described the *user-facing* feature ("handsfree listening"). But the file is the entry point for the whole turn-based mode, including the per-bubble replay path. The new name names the mode, not the feature.
- `connection.ts` → `realtime.ts`. Symmetric peer of `turnbased.ts`. "Connection" was generic — every WebRTC file has a connection.
- `text-tts.ts` → `tts.ts` (under `turn-based/`). Disambiguated by directory; the realtime side has its own TTS over the peer track.

## Choosing a mode

`src/main.ts` exposes two dispatch helpers — one per composer button:

- `startMicMode(initialCursor)` — reads `settings.streaming` and picks: `startDictate` (cursor-aware) or `startMemo` (memo bar).
- `startCallMode()` — reads `settings.realtime` and picks: `startCallStream` (WebRTC) or `startListen` (turn-based).

The mic-button gesture state machine (HOLD-vs-TAP, drag-to-discard, double-tap guard) wraps `startMicMode`. The call button is simpler — explicit tap-to-toggle, no gesture machinery — and just calls `startCallMode` / `stopVoice`. Each helper tears down a competing mode if the user starts a new one mid-mode.

Today this is duplicated branching: turn-based delivers a `Blob` to `main.ts:onCommit` (which then POSTs to `/transcribe`), while realtime delivers transcribed text via the bridge. The `AudioMode` contract papers over this by saying "`onCommit` carries the post-transcription text" — but adopting it requires moving the `/transcribe` POST inside turn-based mode (so both modes deliver text). That migration is queued; it'll likely land alongside the handsfree consolidation when both modes are getting touched anyway.

Until then, `mode.ts` is the documented contract and `main.ts` runs parallel paths. The interface is honest about today's shape; the file just isn't `import`ed anywhere yet.

## What's NOT in this directory

- **`audio-bridge/`** (Python) is the realtime mode's server-side peer. Only the realtime mode talks to it directly (over WebRTC). Turn-based STT *does* go through the bridge's `POST /v1/transcribe`, but that's a one-shot HTTP hop initiated by the proxy, not a long-lived peer connection.
- **`src/cards/`** renders agent-emitted media (images, links, YouTube embeds). It runs after the reply-final envelope, but it's not audio I/O — it lives at the chat-rendering layer.

## Pointers

- Top-level `README.md` "Two voice modes" — wire-level / endpoint view.
- `docs/PARLEY_AUDIO_PROTOCOL.md` — bridge ↔ proxy ↔ PWA contract details.
- `audio-bridge/README.md` — Python-side architecture.
