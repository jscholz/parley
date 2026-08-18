# Audio bridge (`audio-bridge/`)

Standalone Python aiortc service. Owns WebRTC signaling + STT + TTS +
barge detection — long-lived process so it survives PWA reloads and
isolates audio failure modes from the proxy.

## Files

| File | Owns |
|---|---|
| `bridge.py` | Service entry point. Runs the aiohttp app on `:8643`. |
| `signaling.py` | `/v1/rtc/*` WebRTC signaling endpoints (offer / answer / ICE). |
| `peer.py` | RTCPeerConnection lifecycle — terminates a single browser peer. |
| `stt_bridge.py` | Live STT during the WebRTC call. Emits transcripts on the data channel. |
| `tts_bridge.py` | TTS playback over the WebRTC audio track. |
| `dispatch_listener.py` | Per-turn `/api/parley/stream` subscription (`?live_only=1`) so the bridge knows when the agent's reply text is ready to TTS. |
| `providers/` | STT + TTS provider abstractions (Deepgram is the default for both). |
| `tests/` | Pytest suite — runs against the in-process app. |
| `sidekick-audio.service` | systemd unit installed under `~/.config/systemd/user/`. |

## Wire protocol

See [`docs/SIDEKICK_AUDIO_PROTOCOL.md`](../docs/SIDEKICK_AUDIO_PROTOCOL.md)
for the data-channel events, dispatch path, listening + barge
envelopes.

## How the bridge fits

```
PWA (browser) <—WebRTC—> audio-bridge (Python)
                                |
                                | /api/parley/messages (POST text)
                                | /api/parley/stream (?live_only=1)
                                v
                        Node proxy (port 3001)
                                |
                                v
                          Hermes plugin (port 8645)
```

The bridge is a peer of the PWA: both POST messages through the proxy
and subscribe to the SSE multiplexer. The proxy is the single agent
gateway — bridge → agent never bypasses it.

See the top-level [`README.md`](../README.md) for the full architecture.
