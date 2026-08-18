# Realtime voice integration — design notes

Design notes for realtime voice integration, captured during openclaw
bring-up. Not a build plan — a design discussion to revisit when
lifting voice mode.

## Context: how openclaw's "Start Talk" works

Stack (from `src/gateway/server-methods/talk-session.ts`
+ `extensions/openai/realtime-voice-provider.ts` in the openclaw gateway):

1. Browser captures mic → base64 PCM16 24kHz frames
2. Frames flow into the openclaw gateway WS (`talk.session.appendAudio`)
3. Gateway relays frames to OpenAI's Realtime API
   (`wss://api.openai.com/...`, model `gpt-realtime-2`)
4. OpenAI server-side: VAD + turn-detect + speech-to-speech model
   (no intermediate STT→text→LLM→TTS hops) → audio back through gateway
5. Realtime model carries its OWN short audio-shaped session memory
6. When it needs heavy reasoning, it calls `openclaw_agent_consult` —
   a function tool that synchronously dispatches to the text agent
   (openclaw today, hermes for us). The text agent's reply text is
   fed back as the tool result; the realtime model speaks it.

Auth note: openclaw falls back to Codex OAuth when no explicit OpenAI
API key is configured (`extensions/openai/realtime-voice-provider.ts:312`).

## What gets logged where today (openclaw)

- The relay emits per-turn events (`talk-realtime-relay.ts:32-55`):
  `ready`, `inputAudio`, `audio`, `transcript {role, text, final}`,
  `toolCall`, `toolResult`, `error`, `close`
- The text-agent side (the consult call) writes to `chat.history` like
  any other turn — so the agent's reasoning/tools/output appears in
  session history.
- **The voice transcript itself is ephemeral.** OpenAI's Realtime
  session holds it; once the call ends, only what the consult tool
  passed down to the text agent persists in any durable store.

## Proposed approach

When porting realtime to parley, log and dedupe the audio transcript
into the session logs. Annotate as realtime-dialog and visualise
differently (collapsed by default) so users can see the full
interaction. Multiple turns of audio per single turn of LLM, so
interleaving isn't obvious — but the root principle is: user-agent
stream is linear and sequential, so use timestamps to park every
message in the appropriate spot in the transcript. Won't make
context-fed-to-main-agent fully evident, but memory is already opaque,
so history of user interaction is probably enough.

Below are refinements.

## Refinements

### 1. The natural unit is a "consult arc", not interleaved timestamps

A realtime turn around a substantive consult looks like:

```
t0  user_speech    "remind me what jon's flight number was"
t1  voice_ack      "let me check…"
t2  consult_call   {question: "user asked about jon's flight number"}
t3  hermes_runs    [memory_search → match → text reply]   (5–20s)
t4  consult_result "American 1473, departing JFK 6:40am"
t5  voice_response "American 1473 out of JFK at 6:40 in the morning"
```

Pure timestamp-flat ordering would interleave hermes's tool runs (t3)
between t2 and t4, which is chronologically correct but visually
chaotic — it makes the consult feel like the voice convo "paused" for
hermes when really the voice model was just filling with t1 while
hermes worked.

Better: render the consult as a single collapsible block (like how
Claude Code renders bash tool blocks), with the voice exchanges
surrounding it as a 🎙 sub-strip. The hermes turn stays the primary
bubble in the transcript; the voice strip nests beneath it.

```
🎙  [voice exchange · 3 turns · 8s]  ▶ expand
[hermes bubble with tools + final text — primary]
🎙  [voice exchange · 1 turn · 2s]    ▶ expand
```

Collapse-default is right. Click-to-expand reveals the audio transcript
turns. Long-press / hover shows timestamps.

### 2. Persist voice transcript server-side DURING the call

OpenAI's Realtime session is ephemeral — when the call ends, the
transcript dies with it. So we need an active capture step inside the
proxy/plugin during the call, not after.

The hook point: the relay's `transcript` events
(`talk-realtime-relay.ts:38-44` — payload
`{role: "user"|"assistant", text, final}`). Subscribe, persist each
`final: true` entry into a parley-owned table keyed by chat_id +
relaySessionId + monotonic seq.

Schema sketch (add to `src/schema.sql` when implemented):

```sql
CREATE TABLE IF NOT EXISTS voice_dialog (
  id            TEXT PRIMARY KEY,        -- voice-{uuid}
  chat_id       TEXT NOT NULL,
  relay_id      TEXT NOT NULL,           -- ties to one continuous call
  consult_id    TEXT,                    -- hermes turn this arc fed
                                         -- (NULL if no consult fired)
  seq           INTEGER NOT NULL,        -- ordering within call
  role          TEXT NOT NULL,           -- user|assistant
  text          TEXT NOT NULL,
  created_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_chat ON voice_dialog(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_voice_consult ON voice_dialog(consult_id);
```

### 3. Link voice entries to the hermes turn via consult_call_id

Two reasons to thread voice entries to consult turns:

- The UI grouping ("voice exchange before/after this hermes bubble")
  needs a foreign key.
- Replay across devices needs to know "this hermes turn was triggered
  by voice context X" — important when the user picks the chat back up
  on desktop and wants to understand why the agent ran the query it did.

When the realtime model emits a `toolCall` event for
`openclaw_agent_consult`, capture the `callId`. Stamp it on subsequent
voice transcript rows until the next consult fires.

### 4. Dedup: voice transcript vs delivery-mirror

`chat.history` already has a deduplication trap: openclaw double-writes
substantive assistant text — once as the real `openai-codex` row, once
as a `provider: "openclaw", model: "delivery-mirror"` row. We need to
filter mirrors out before showing them in parley (matches against
`__openclaw.idempotencyKey` ending `:internal-source-reply:0` or
`provider === "openclaw" && model === "delivery-mirror"`).

For voice: the voice agent's spoken text is NOT mirrored into
chat.history (it bypasses the text agent unless a consult fires). So
voice rows don't dedup against chat.history rows — they're additive.
Parley's UI just needs to render both streams.

## Open questions to defer

- Raw vs cleaned transcript: voice STT includes fillers, false-starts,
  interruptions. Worth a toggle? Default raw, post-process on demand?
- Audio retention: do we keep the actual audio bytes anywhere, or
  transcript-only? OpenAI returns audio frames; openclaw doesn't
  persist them. Probably transcript-only for storage cost / privacy.
  Could allow opt-in raw-audio persistence per chat.
- Per-platform behavior: on phone (PWA + audio-bridge), voice mode
  may want a different visual treatment than on desktop (the audio
  experience IS the primary interaction; transcript is secondary).
  Defer until we actually port voice mode.
- The "consult call surface" question: do we lift openclaw's pattern
  verbatim (consult tool → hermes acts as opaque smart answerer) or
  expose specific hermes capabilities as their own voice-callable
  function tools (memory_search, send_message, query_calendar etc.)
  for lower-latency, more-predictable behavior? The granular approach
  is probably better for parley — hermes has a richer tool surface
  than openclaw's text agent does.

## Status

Not on the critical path for the openclaw-as-second-backend project.
Revisit once `/v1/conversations` + `/v1/responses` work against
openclaw and parley can A/B both backends. Voice mode is the natural
Phase 2 of the multi-backend project.
