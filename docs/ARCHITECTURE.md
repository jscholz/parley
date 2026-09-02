# Architecture

Parley is a **four-process system**: a browser PWA, a Node proxy, a Python audio bridge, and a separate agent upstream. The PWA, proxy, and bridge are parley code. The agent is whatever you point upstream at (`backends/hermes/plugin`, the in-tree stub, or any third-party `/v1/*`-speaking server).

The PWA only ever talks to the proxy and the audio bridge — never to the agent directly. The bridge only ever talks to the proxy.

```
                    ┌─────────────────────────────────────────┐
                    │ Browser (PWA)                            │
                    │   src/                                   │
                    │   - chat surface, drawer, composer       │
                    │   - chat_id minted in IDB                │
                    │   - one persistent SSE channel inbound   │
                    │   - Listen mode + per-bubble TTS replay  │
                    └────────────┬────────────────────┬────────┘
                                 │                    │
                         HTTP+SSE                  WebRTC
                         /api/parley/*           (realtime mode only,
                         /transcribe, /tts          audio bytes only)
                                 │                    │
                                 ▼                    ▼
              ┌──────────────────────────┐    ┌────────────────────────────┐
              │ Parley proxy           │    │ Audio bridge                │
              │   (Node, server.ts)      │◀───│   (Python, aiortc)          │
              │                          │    │                             │
              │ - serves static assets   │    │ Realtime mode:              │
              │ - serves /api/parley/* │    │ - terminates WebRTC peer    │
              │ - /tts → Deepgram Aura   │    │ - live STT during speech    │
              │ - /transcribe → bridge   │    │ - posts text to proxy at    │
              │   /v1/transcribe         │    │   /api/parley/messages,   │
              │ - translates             │    │   subscribes to             │
              │   /api/parley/* ↔      │    │   /api/parley/stream,     │
              │   /v1/*                  │    │   streams TTS over WebRTC   │
              │ - SSE multiplexer (mem)  │    │                             │
              │ - utility endpoints      │    │ Turn-based mode:            │
              │   (/gen-image, /weather, │    │ - serves /v1/transcribe     │
              │   /link-preview)         │    │   (HTTP, one-shot STT)      │
              │ - injects auth tokens    │    │ - no WebRTC peer at all     │
              │   for upstream calls     │    │                             │
              │ Owns no durable state.   │    └─────────────────────────────┘
              └────────────┬─────────────┘
                           │
                    HTTP+SSE
                    /v1/responses
                    /v1/conversations*
                    /v1/events
                           │
                           ▼
              ┌──────────────────────────┐
              │ Upstream agent            │
              │   any /v1/*-speaking      │
              │   server, e.g. one of:    │
              │   - backends/hermes/      │
              │     (Python plugin into   │
              │     hermes-agent)         │
              │   - backends/stub/        │
              │     (in-tree TS, echo /   │
              │     gemini / ollama)      │
              │   - any 3rd-party         │
              │     OpenAI-compat         │
              │                           │
              │ Owns ALL agent state      │
              │ (sessions, transcripts,   │
              │ memory).                  │
              └───────────────────────────┘
```

**Two voice modes**, both handsfree, picked by the user via the **Realtime** toggle in the mic menu (default off):

- **Realtime** — full-duplex WebRTC peer to the bridge. Optimises for **latency**: live STT as the user speaks, TTS streamed back over the same peer. The bridge POSTs recognised text to `/api/parley/messages` and subscribes to `/api/parley/stream` on the user's behalf.
- **Turn-based** — `MediaRecorder` writes one blob locally per utterance. Optimises for **fidelity**: the full audio uploads to `/transcribe`, the agent's reply text round-trips through `/tts` for an mp3, played in `<audio>`. No WebRTC peer; everything rides plain HTTP+SSE through the proxy. The PWA also caches the mp3 (LRU) so per-bubble replay chips and BT skip-fwd/back are instant.

Both modes use the same handsfree commit triggers — silence timeout and a sendword (default "over"). Both ride the same agent contract (`POST /api/parley/messages`, `GET /api/parley/stream`); only audio in/out differ. See [`../src/audio/README.md`](../src/audio/README.md) for the PWA-side architecture.

**Wire contracts**:
- `/api/parley/*` — the PWA-and-bridge-facing surface served by the proxy. Fully agent-agnostic. POST messages, GET drawer rows, GET a persistent SSE multiplexer, DELETE chats.
- `/v1/*` — the upstream-facing surface the proxy speaks to whichever agent it's wired to. OpenAI Responses-shaped, plus a parley-defined `/v1/gateway/conversations` extension for cross-platform drawer. See [`ABSTRACT_AGENT_PROTOCOL.md`](ABSTRACT_AGENT_PROTOCOL.md).

## Endpoint inventory

Every HTTP+SSE endpoint parley speaks, with a one-line purpose and a classification: **OAI-standard** (mirrors OpenAI's Conversations / Responses API, drop-in compatible), **parley-extension** (we invented), or **mixed** (OAI shape with parley-extension fields).

### Upstream contract — `/v1/*` (proxy → agent)

| Method+Path | Class | Purpose |
|---|---|---|
| `POST /v1/responses` | mixed | Dispatch a turn. OAI Responses shape; parley adds optional body fields `attachments`, `voice`, `user_message_id`. Streams `response.output_text.delta` / `response.completed` SSE events. |
| `GET /v1/conversations` | OAI-standard | Drawer list (channel-scoped). Returns `ConversationSummary[]`. |
| `GET /v1/conversations/{id}/items` | OAI-standard | Transcript replay. Returns `ConversationItem[]` plus `first_id` / `has_more` cursor. |
| `DELETE /v1/conversations/{id}` | OAI-standard | Cascade-delete a session (transcript + memory store). |
| `PATCH /v1/conversations/{id}` | parley-ext | Rename a conversation. Server-side persistence so renames cross devices via `session_changed`. |
| `GET /v1/conversations/search` | parley-ext | Full-text search across messages (FTS5-backed when the upstream supports it). 404 = unsupported, PWA cmd+K Messages section stays empty. |
| `GET /v1/events` | parley-ext | Persistent out-of-turn SSE channel: notifications, session_changed, tool events fired outside any active `/v1/responses` turn, **user_message broadcasts** for cross-device user-bubble propagation. Reconnect-aware via `Last-Event-ID`. |
| `GET /v1/gateway/conversations` | parley-ext | Cross-platform drawer. Same shape as `/v1/conversations` plus `metadata.source` (telegram/slack/whatsapp/parley) + `chat_type`. 404 = agent doesn't implement; proxy falls back to channel-only view. |
| `GET /v1/settings/schema` | parley-ext | Agent-declared user-facing settings catalog. 404 = unsupported, parley hides the Agent group. |
| `POST /v1/settings/{id}` | parley-ext | Update one agent setting. 400 propagates as a UI revert + error message. |
| `GET /v1/commands` | parley-ext | Slash-command catalog (composer autocomplete). 404 = unsupported. |
| `GET /v1/parley/auxiliary-models` | parley-ext | Advertises the auxiliary vision model the agent will auto-route image attachments through. PWA uses this to enable the attach button when the primary model is text-only but a fallback is configured. |
| `GET /health` | parley-ext | Liveness probe used by the proxy's healthcheck poll. |

### PWA-facing surface — `/api/parley/*` (browser → proxy)

| Method+Path | Class | Purpose |
|---|---|---|
| `POST /api/parley/messages` | parley-ext | Send a turn. Body `{chat_id, text, attachments?, voice?, user_message_id?}`. 202 fire-and-forget — replies arrive on the persistent SSE channel. |
| `GET /api/parley/stream` | parley-ext | Persistent SSE multiplexer. Fans every upstream envelope (`reply_delta`, `reply_final`, `tool_call`, `tool_result`, `notification`, `session_changed`, `image`, `error`, `user_message`) to subscribed PWA tabs, tagged with `chat_id`. Reconnect-aware via `Last-Event-ID` / `?last_event_id=N`; `?live_only=1` opts out of replay (audio bridge). |
| `GET /api/parley/sessions` | mixed | Drawer list. Wraps `/v1/gateway/conversations` (when available) or `/v1/conversations`. |
| `GET /api/parley/sessions/{id}/messages` | mixed | Transcript replay. Wraps `/v1/conversations/{id}/items`. |
| `DELETE /api/parley/sessions/{id}` | mixed | Cascade delete. |
| `PATCH /api/parley/sessions/{id}` | parley-ext | Rename. Wraps `PATCH /v1/conversations/{id}`. |
| `GET /api/parley/search` | parley-ext | Cross-conversation FTS search. Wraps `GET /v1/conversations/search`. |
| `GET /api/parley/settings/schema` | parley-ext | Wraps `GET /v1/settings/schema`. |
| `POST /api/parley/settings/{id}` | parley-ext | Wraps `POST /v1/settings/{id}`. |
| `GET /api/parley/commands` | parley-ext | Wraps `GET /v1/commands`. |
| `GET /api/parley/model-capabilities?model=Y[&provider=X]` | parley-ext | Ground-truth ModelCapabilities from hermes's models.dev registry (powers attach-button gating). Wraps `GET /v1/parley/model-capabilities`. |
| `GET /api/parley/auxiliary-models` | parley-ext | Auxiliary-vision-model advertisement (`{vision: <id> \| null}`) — drives the "images route via X" hint when the primary is non-vision. Wraps `GET /v1/parley/auxiliary-models`. |
| `GET /api/parley/config` | parley-ext | PWA-frontend settings snapshot (yaml-backed). Distinct from `/v1/settings/*` — those are agent-owned. |
| `POST /api/parley/config/{key}` | parley-ext | Write one frontend setting back to `parley.config.yaml`. |

### Audio + utility — proxy-owned

| Method+Path | Class | Purpose |
|---|---|---|
| `POST /tts` | proxy-utility | Text → mp3 via Deepgram Aura. Used by turn-based mode + per-bubble replay chips. |
| `POST /transcribe` | proxy-utility | Audio blob → transcript. Forwards to audio-bridge `POST /v1/transcribe`. Honors `?keyterms=` for per-user STT biasing. |
| `/api/rtc/*` | proxy-passthrough | WebRTC signaling (offer / ICE / answer). Reverse-proxy onto the audio bridge's `/v1/rtc/*`. |
| `POST /gen-image` | proxy-utility | Gemini image generation. |
| `GET /weather` | proxy-utility | Open-Meteo proxy, ambient-clock card. |
| `GET /link-preview` | proxy-utility | OG metadata for a URL (link cards). |
| `GET /screenshot` | proxy-utility | Persistent-Chromium screenshot for sites with no OG. |
| `GET /config` | proxy-utility | Runtime config (gateway token, app name, theme, model picker prefs). |
| `GET /api/keyterms` | proxy-utility | First-boot STT keyterm seed list (yaml-backed). |

## Information flow

### Typed turn

1. PWA pre-mints a `user_message_id`, renders an optimistic user bubble keyed on that id (idempotent in `renderedMessages`), then sends `POST /api/parley/messages` with `{chat_id, text, user_message_id}`.
2. Proxy forwards `POST /v1/responses` (with `stream: true`) to upstream.
3. Upstream emits a `user_message` envelope on `/v1/events` — fans out to ALL connected PWA tabs via `/api/parley/stream`. The originating tab dedups (the entry already exists); other devices render the user bubble for the first time.
4. Upstream streams `response.output_text.delta` events on the per-turn /v1/responses SSE.
5. Proxy fans those into the persistent `/api/parley/stream` SSE channel as `reply_delta` envelopes.
6. PWA renders the streaming reply bubble.
7. Upstream emits `response.completed`; proxy emits `reply_final`.

### Realtime voice turn (WebRTC)

1. PWA opens a WebRTC peer connection to the audio bridge.
2. Bridge streams mic audio to STT, gets transcripts.
3. On end-of-utterance (silence-detect or commit-phrase), bridge POSTs the recognized text to the proxy's `/api/parley/messages`.
4. Bridge subscribes to `/api/parley/stream` (scoped to the same `chat_id`) for the agent's reply.
5. As `reply_delta` envelopes arrive, bridge synthesizes TTS audio chunks and streams them back over the WebRTC connection.

### Turn-based voice turn (Listen mode)

1. PWA captures one utterance with `MediaRecorder`. End-of-turn fires on local silence detection or sendword (e.g. "over").
2. PWA `POST /transcribe` with the audio blob. Proxy forwards to the bridge's `POST /v1/transcribe` (one HTTP round-trip — no WebRTC), which runs the configured STT provider and returns `{transcript}`.
3. PWA submits the transcript through the same canonical send path a typed message uses: `POST /api/parley/messages`, then watch the shared `/api/parley/stream` for `reply_final`.
4. On `reply_final`, PWA `POST /tts` with the reply text. Proxy forwards to Deepgram Aura and returns mp3.
5. PWA caches the mp3 (`replyCache.ts` LRU) and plays it in the shared `<audio id="player">` element. Per-bubble replay chips and BT skip-fwd/back navigate this same cache.

Turn-based mode adds **zero new wire endpoints** — `/transcribe`, `/tts`, `/api/parley/messages`, and `/api/parley/stream` already existed for typed turns and voice memos.

### Drawer state

- The PWA's drawer cache lives in IDB and is the immediate-render path.
- The proxy queries the upstream's `GET /v1/conversations` to populate the server-authoritative list. Reconciles into the IDB cache.
- Deletes cascade end-to-end: PWA → proxy → upstream → upstream's ancillary stores (transcript files, vector-store memory, etc.).

## Why the audio bridge is a separate process

WebRTC audio processing (aiortc + STT/TTS pipelines) lives on a long-lived Python process so it survives PWA reloads and isolates audio failure modes from the proxy. The bridge talks to the proxy via the same `/api/parley/*` HTTP surface the PWA uses — no special channel.

## Why the proxy exists at all (vs. PWA → upstream direct)

- **Reusable contract.** Any `/v1/*`-speaking server fits the same shape (hermes plugin, stub, future openclaw plugin, raw OAI third-parties). A new backend just speaks the contract from whatever language it's in.
- **Decouples app server from agent runtime.** Hermes restarts (or GIL stalls) don't take down the chat UI; static asset serving keeps working. The proxy is single-purpose Node, fast to restart.
- **Centralized auth.** The browser never holds the upstream bearer token; the proxy injects it on every outbound call.
- **Multiplexing.** PWA sees one persistent `/api/parley/stream` even when there are N concurrent chats with reply streams in flight. The proxy translates that to per-turn `/v1/responses` streams against the upstream and fans envelopes back tagged with `chat_id`.
- **Utility endpoints.** `/gen-image`, `/weather`, `/link-preview`, `/transcribe` — none of these belong in an agent backend, but they belong somewhere.

The proxy owns no durable state. That stays in the upstream.

## Module layout

```
parley/
├── server.ts                 proxy entry point
├── proxy/                    proxy-side TS (handlers, upstream client)
│   └── parley/                /api/parley/* PWA-facing routes
├── src/                      PWA (browser) code
├── audio-bridge/             Python WebRTC bridge (STT + TTS + barge-in)
├── backends/                 each subdirectory = one /v1/*-speaking agent
│   ├── stub/                    in-tree TS reference impl (echo / gemini / ollama)
│   └── hermes/
│       └── plugin/                Python plugin loaded into hermes-agent
├── scripts/                  build + smoke runner + start-all
├── docs/                     ABSTRACT_AGENT_PROTOCOL, ARCHITECTURE, CANVAS, ...
├── styles/                   app.css + manifest
├── sw.js                     service worker (PWA app-shell cache)
├── install.sh                one-command Mac/Linux installer (curl-pipe-bash)
└── example.parley.config.yaml   copy to parley.config.yaml + fill in
```

PWA breakdown:

```
src/
├── main.ts              entry — boots modules, wires cross-module callbacks
├── config.ts            runtime config loaded from /config, applies skinning
├── backend.ts           adapter loader — single proxy-client path
├── proxyClient.ts       calls /api/parley/* on the local Node proxy
├── proxyClientTypes.ts  BackendAdapter contract types
├── agentSettings.ts     generic SettingDef[] renderer for /v1/settings/*
├── chat.ts              transcript rendering + sessionStorage persistence
├── sessionDrawer.ts     past-conversations list, rename/delete, IDB cache
├── sessionCache.ts      IndexedDB cache for instant tap-to-resume
├── settings.ts          persistent settings (localStorage), model picker
├── attachments.ts       composer image picker + chips + model-capability gate
├── wakeLock.ts          ref-counted Screen Wake Lock
├── queue.ts             IndexedDB outbox (audio blobs + text messages)
├── voiceMemos.ts        memo persistence (IndexedDB) + waveform extraction
├── ios/                 pocket-lock overlay + iOS audio gesture-unlock
├── audio/               voice I/O — see src/audio/README.md
│   ├── shared/             mode-agnostic primitives
│   ├── turn-based/         HTTP /transcribe + /tts mode (handsfree, fidelity)
│   └── realtime/           WebRTC peer-to-bridge mode (handsfree, latency)
└── cards/               inline cards (link previews, YouTube/Spotify, images, markdown)
```

## Caveats

- **iOS PWA background audio**: installed PWAs get some lockscreen / headset-tap latitude via Media Session; they do **not** get microphone access while backgrounded. Pocket-lock is the workaround — keeps the tab foreground so mic/TTS/barge-in keep working under a fake lockscreen.
- **Chrome desktop local TTS**: SpeechSynthesis has long-standing bugs around cancel+speak (crbug/521818) and 15s idle auto-pause. Works on iOS / macOS Safari; on Chrome use the server Deepgram Aura path.
- **iOS premium voices**: Web Speech only exposes the built-in voice bank. Premium voices are reserved for native apps via AVSpeechSynthesizer.
