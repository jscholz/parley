# Sidekick proxy (`proxy/sidekick/`)

Node-side handlers for the `/api/parley/*` PWA-facing surface plus
the `UpstreamAgent` adapter the proxy uses to talk `/v1/*` to whichever
agent is wired in (hermes plugin, stub agent, raw OAI third-party).

## Files

| File | Owns |
|---|---|
| `index.ts` | Module root. Wires `init({token, url})` and re-exports the per-route handlers consumed by `server.ts`. |
| `messages.ts` | `POST /api/parley/messages` — turn dispatch (fire-and-forget). Forwards to `upstream.sendMessage`, fans every yielded envelope onto the SSE multiplexer via `pushEnvelope`. |
| `stream.ts` | `GET /api/parley/stream` — persistent SSE multiplexer. Replay ring, per-chat filtering, cursor-aware reconnect (`Last-Event-ID` / `?last_event_id=`). Subscribes to upstream `/v1/events` once at boot via `init()`. |
| `sessions.ts` | Drawer list + delete + rename. Wraps upstream `/v1/conversations` (channel) or `/v1/gateway/conversations` (cross-platform). |
| `history.ts` | `GET /api/parley/sessions/{id}/messages` — transcript replay. |
| `settings.ts` | `/api/parley/settings/*` — wraps upstream `/v1/settings/*`. |
| `commands.ts` | `GET /api/parley/commands` — slash-command catalog. |
| `modelModalities.ts` | Model capabilities + auxiliary-vision passthrough — thin proxy to hermes plugin's models.dev lookup; powers attach-button gating. (Filename pre-dates the refactor; content is now ground-truth caps, not modalities.) |
| `frontend-config.ts` | yaml-backed PWA settings (`/api/parley/config`). Distinct from `/v1/settings` — those are agent-owned. |
| `upstream.ts` | The `UpstreamAgent` interface + `HTTPAgentUpstream` implementation. The `SidekickEnvelope` union here is the canonical wire-shape reference. |
| `__tests__/proxy.test.ts` | Integration tests against a `FakeAgent`. Run via `npm test`. |

## Wire shape

The `SidekickEnvelope` union near the top of `upstream.ts` is the
canonical list of envelope types fanned out on
`/api/parley/stream` — see also the top-level
[`README.md`](../../README.md) endpoint inventory.

## Why a single persistent SSE stream

See the comment block at the top of `stream.ts` — agents emit multiple
`send()` calls per turn (bootstrap nudges, the actual reply, possibly
tool-result-as-text), and out-of-turn envelopes (notifications, cron
output, `user_message` cross-device broadcasts) need a channel that
isn't tied to any single turn.
