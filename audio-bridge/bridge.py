"""
Sidekick audio bridge — standalone aiohttp service.

This is the reference Python/aiortc implementation of the sidekick
audio bridge contract (see ``docs/SIDEKICK_AUDIO_PROTOCOL.md`` in this
repo for the wire format). It owns:

  - WebRTC peer connection lifecycle (offer / answer / ICE / close)
  - Opus → 16 kHz PCM resampling
  - STT provider stream (Deepgram nova-3 default)
  - DataChannel events (transcripts, future control messages)
  - (Talk mode) TTS provider PCM → outbound RTP track

The bridge does NOT talk to the agent backend directly. All sidekick
→ agent traffic flows through the sidekick proxy, which is the sole
gateway. The bridge POSTs utterances to
``<SIDEKICK_PROXY_URL>/api/<backend>/responses`` (the active backend is
configured on the proxy) and streams the SSE reply back over the data
channel as transcript envelopes.

Environment variables:

    SIDEKICK_AUDIO_HOST   bind host (default 127.0.0.1)
    SIDEKICK_AUDIO_PORT   bind port (default 8643)
    SIDEKICK_PROXY_URL    sidekick proxy base URL (default http://127.0.0.1:3001)
    SIDEKICK_BACKEND      active backend slug for the proxy responses
                          endpoint (default ``hermes``). The bridge POSTs
                          utterances to ``<proxy>/api/<be>/responses``;
                          ``<be>`` is this value. Set to whatever slug
                          the proxy is wired to dispatch.
    SIDEKICK_AUDIO_LOG_FILE  optional path to a log file. Falls back to
                          ``/tmp/sidekick-audio.log`` if the bridge is
                          launched under systemd (so logs are still
                          tailable when journald isn't capturing this
                          unit for whatever reason). Set to empty
                          string to disable file logging.
    DEEPGRAM_API_KEY      required for the default deepgram STT provider
"""

from __future__ import annotations

import logging
import os
import sys

from aiohttp import web

from config import VoiceConfig
from signaling import register_routes


def main() -> None:
    level = os.environ.get("SIDEKICK_AUDIO_LOG_LEVEL", "INFO").upper()
    fmt = "%(asctime)s %(levelname)s %(name)s: %(message)s"
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]

    # File handler — defaults to /tmp/sidekick-audio.log so logs are
    # tailable even when user-level journald isn't capturing this unit.
    # `tail -f` works regardless of journald state.
    log_file = os.environ.get("SIDEKICK_AUDIO_LOG_FILE", "/tmp/sidekick-audio.log")
    if log_file:
        try:
            handlers.append(logging.FileHandler(log_file))
        except Exception as e:
            print(f"[bridge] couldn't open {log_file}: {e}", file=sys.stderr)

    logging.basicConfig(level=level, format=fmt, handlers=handlers, force=True)

    host = os.environ.get("SIDEKICK_AUDIO_HOST", "127.0.0.1")
    port = int(os.environ.get("SIDEKICK_AUDIO_PORT", "8643"))
    proxy_url = os.environ.get("SIDEKICK_PROXY_URL", "http://127.0.0.1:3001")
    backend = os.environ.get("SIDEKICK_BACKEND", "hermes")

    voice_config = VoiceConfig.defaults()
    # Smoke-test overrides — let the rig swap providers via env without
    # writing a config.yaml. Production deployments leave these unset
    # and use the deepgram defaults. Both override blocks are
    # self-contained: an unset env var → no change to defaults.
    tts_provider_env = os.environ.get("SIDEKICK_AUDIO_TTS_PROVIDER")
    if tts_provider_env:
        from config import ProviderSpec
        opts = {}
        wav_path = os.environ.get("SIDEKICK_AUDIO_TTS_WAV_PATH")
        if wav_path:
            opts["wav_path"] = wav_path
        voice_config = type(voice_config)(
            stt=voice_config.stt,
            tts=ProviderSpec(provider=tts_provider_env, options=opts),
            bind_host=voice_config.bind_host,
            enabled=voice_config.enabled,
        )
    stt_provider_env = os.environ.get("SIDEKICK_AUDIO_STT_PROVIDER")
    if stt_provider_env:
        from config import ProviderSpec
        voice_config = type(voice_config)(
            stt=ProviderSpec(provider=stt_provider_env, options={}),
            tts=voice_config.tts,
            bind_host=voice_config.bind_host,
            enabled=voice_config.enabled,
        )

    # aiohttp's default body limit is 1MB. /v1/transcribe receives raw
    # webm blobs from the PWA via the sidekick proxy (a 3-minute memo is
    # ~6MB), and /v1/transcribe-diarized receives a WHOLE MEETING's
    # stitched mono AAC from the capture pipeline — ~22MB/hour, so a
    # 3-hour meeting is ~65MB. The old 25MB cap silently rejected the
    # diarize pass for any long meeting (capture audit 2026-07-09 #5:
    # 413 before the handler ran, silent fallback to the plain
    # transcript — short test recordings hid it). 256MB gives 10+ hours
    # of headroom; this is a loopback single-user service, not an
    # internet edge.
    app = web.Application(client_max_size=256 * 1024 * 1024)
    register_routes(app, voice_config=voice_config, proxy_url=proxy_url, backend=backend)

    logging.getLogger(__name__).info(
        "starting sidekick audio bridge host=%s port=%d proxy=%s backend=%s",
        host, port, proxy_url, backend,
    )
    web.run_app(app, host=host, port=port, access_log=None)


if __name__ == "__main__":
    main()
