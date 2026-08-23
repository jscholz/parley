"""
STT bridge: incoming RTC audio track -> 16 kHz mono int16 PCM -> STTProvider
-> data-channel transcript envelopes.

Per peer:

    pc.ontrack(track)
        |
        +- async pump task
            - frame = await track.recv()           # 48 kHz Opus-decoded
            - resampled = resampler(frame)         # 16 kHz mono int16
            - put(pcm_bytes) onto pcm_queue
        |
        +- async stt task
            - get pcm_bytes off pcm_queue
            - feed STTProvider.stream(pcm_iter)
            - on every Transcript:
                send {type: 'transcript', role: 'user', text, is_final}
                over the peer's data channel.  Pass-through only — no
                buffering, no commit-phrase, no silence timer.  The PWA
                owns all UX logic (utterance buffer, silence timeout,
                commit-phrase, dispatch decision).

    Half-duplex echo guard:

        While TTS is active on this peer's outbound track, mic frames
        are substituted with silence before being handed to Deepgram.
        Stops the speaker→mic bleed of our own TTS from polluting the
        user's transcript without disconnecting the WSS or starving
        Deepgram of paced audio. Pure silence-substitution — barge
        detection is owned entirely by the PWA's client-side
        BargeWindow (since v0.381+), which now ships `{type:'barge'}`
        envelopes upstream over the data channel.

Dispatch path:

    The PWA decides when to send an utterance to the agent and posts a
    {type: 'dispatch', text} envelope back over the data channel.  The
    bridge's dispatch_listener (in dispatch_listener.py) handles those
    messages and calls _dispatch_to_agent() here, which POSTs to
    ``<proxy_url>/api/<backend>/responses`` and streams the SSE reply
    back over the data channel as assistant transcript envelopes.

    Bridge → proxy → agent: the bridge does NOT POST directly to the
    agent backend.  The parley proxy is the sole parley→agent
    gateway.  proxy_url is stashed on the PeerSession at offer time.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Any, AsyncIterator, Dict, Optional

from config import VoiceConfig
from providers import Transcript, get_stt_provider

logger = logging.getLogger(__name__)

# Target sample rate / format for STT providers (Deepgram nova-3 prefers
# 16 kHz mono int16, plus the local_whisper stub will too).  If a provider
# wants something else, add a per-provider format hint to ProviderSpec
# and resample again — keep this bridge ignorant of provider details.
TARGET_SAMPLE_RATE = 16000
TARGET_LAYOUT = "mono"
TARGET_FORMAT = "s16"

# Cap the audio queue so a slow STT upstream doesn't grow memory
# unboundedly.  20 ms frames * 100 = ~2 s of buffer.
MAX_PCM_QUEUE = 100


def attach(peer, *, voice_config: VoiceConfig, api_server: Any = None) -> None:
    """Wire the inbound audio track of *peer* into the configured STT provider.

    Idempotent: if attach() is called twice on the same peer, only the
    first ontrack handler dispatches.  (We rely on aiortc invoking each
    handler exactly once per inbound track; a defensive guard is in the
    handler itself.)
    """
    pc = peer.pc

    @pc.on("track")
    async def _on_track(track):
        if track.kind != "audio":
            logger.debug(
                "[stt-bridge] peer %s ignoring %s track", peer.peer_id, track.kind,
            )
            return
        if peer.extra.get("stt_attached"):
            logger.debug(
                "[stt-bridge] peer %s additional audio track ignored", peer.peer_id,
            )
            return
        peer.extra["stt_attached"] = True

        logger.info(
            "[stt-bridge] peer %s audio track received; starting STT pump",
            peer.peer_id,
        )
        # Two cooperating tasks: the audio pump and the STT consumer.
        pcm_q: "asyncio.Queue[Optional[bytes]]" = asyncio.Queue(maxsize=MAX_PCM_QUEUE)

        pump_task = asyncio.create_task(
            _pump_audio(track, pcm_q, peer.peer_id),
            name=f"webrtc-pump-{peer.peer_id[:8]}",
        )
        stt_task = asyncio.create_task(
            _run_stt(peer, voice_config, pcm_q, pump_task),
            name=f"webrtc-stt-{peer.peer_id[:8]}",
        )
        peer.stt_task = stt_task
        peer.extra["pump_task"] = pump_task


async def _pump_audio(track, pcm_q: "asyncio.Queue[Optional[bytes]]", peer_id: str) -> None:
    """Receive Opus-decoded frames from the inbound track, resample to 16 kHz mono int16, push to the queue."""
    try:
        from av.audio.resampler import AudioResampler  # type: ignore
    except ImportError as exc:  # pragma: no cover
        logger.error("[stt-bridge] PyAV missing: %s", exc)
        await pcm_q.put(None)
        return

    resampler = AudioResampler(
        format=TARGET_FORMAT, layout=TARGET_LAYOUT, rate=TARGET_SAMPLE_RATE,
    )
    frames_seen = 0
    bytes_pushed = 0
    started = time.time()
    try:
        while True:
            frame = await track.recv()
            frames_seen += 1
            for resampled in resampler.resample(frame):
                # av AudioFrame.to_ndarray() => int16 array shaped (channels, samples)
                pcm = resampled.to_ndarray().tobytes()
                if not pcm:
                    continue
                bytes_pushed += len(pcm)
                # If the queue is full, drop frames rather than blocking
                # the audio pump (which would also block aiortc).  In
                # practice the consumer should keep up; this guard is
                # for the case where Deepgram's WS is unreachable.
                try:
                    pcm_q.put_nowait(pcm)
                except asyncio.QueueFull:
                    logger.warning(
                        "[stt-bridge] peer %s pcm queue full; dropping frame",
                        peer_id,
                    )
            if frames_seen in (1, 50, 250):
                elapsed = time.time() - started
                logger.info(
                    "[stt-bridge] peer %s frames=%d bytes=%d elapsed=%.1fs",
                    peer_id, frames_seen, bytes_pushed, elapsed,
                )
    except asyncio.CancelledError:
        raise
    except Exception as e:
        # MediaStreamError on track end is normal; aiortc raises it when
        # the remote half-closes.  Log debug, not warning.
        logger.debug("[stt-bridge] peer %s pump exit: %s", peer_id, e)
    finally:
        # Sentinel so the consumer can exit.
        try:
            pcm_q.put_nowait(None)
        except asyncio.QueueFull:
            pass


async def _run_stt(
    peer,
    voice_config: VoiceConfig,
    pcm_q: "asyncio.Queue[Optional[bytes]]",
    pump_task: asyncio.Task,
) -> None:
    """Consume the PCM queue, drive the STT provider, forward transcripts to the data channel."""
    # Per-peer keyterm biasing: the PWA stashed its IDB-backed list onto
    # peer.extra in signaling.handle_offer. Merge into the configured
    # provider's options for THIS peer only, so two simultaneous users
    # with different vocabularies don't clobber each other. Empty list
    # → use the spec as-is (bridge defaults).
    base_spec = voice_config.stt
    peer_keyterms = peer.extra.get("keyterms") or []
    if peer_keyterms:
        from dataclasses import replace
        merged_options = dict(base_spec.options)
        # Dedup case-insensitive while preserving caller order; the PWA
        # already dedups, but a user-edited config + PWA list could
        # overlap.
        existing_lc = {str(t).strip().lower() for t in merged_options.get("keyterms", []) or []}
        existing = list(merged_options.get("keyterms", []) or [])
        for t in peer_keyterms:
            if t.lower() not in existing_lc:
                existing.append(t)
                existing_lc.add(t.lower())
        merged_options["keyterms"] = existing
        spec = replace(base_spec, options=merged_options)
        logger.info(
            "[stt-bridge] peer %s keyterms=%d (peer=%d, base=%d)",
            peer.peer_id, len(existing), len(peer_keyterms),
            len(base_spec.options.get("keyterms", []) or []),
        )
    else:
        spec = base_spec
    stt = get_stt_provider(spec)

    # Frame of pure silence at the same shape the mic produces (16 kHz
    # mono int16, 20 ms = 640 bytes). Substituted for the real mic
    # frame whenever TTS is currently playing on this peer's outbound
    # track, so Deepgram sees clean silence instead of the speakerphone
    # echo of our own TTS — kills the iOS Safari feedback loop without
    # disconnecting the WSS or starving Deepgram of paced audio.
    silence_frame = bytes(640)

    async def _pcm_iter() -> AsyncIterator[bytes]:
        tts_track = peer.extra.get("tts_track")
        # Bridge-side BargePolicy — set in attach() if silero-vad is
        # available. Fed every mic frame here BEFORE the half-duplex
        # silence-swap so the policy sees real audio during tts_active
        # windows. Falls through (None) when silero-vad isn't installed
        # or attach() hasn't run for this peer; bridge-side barge is
        # then a no-op and the client's BargeDetector remains the only
        # source. See audio-bridge/barge_policy.py.
        barge_policy = peer.extra.get("barge_policy")
        was_active = False
        # Whether we've already announced "STT pipe is hot" for this
        # turn boundary. Flips True on the first frame the bridge
        # actually accepts into Deepgram (call-start AND every TTS-end
        # transition); resets when TTS goes active again. Drives the
        # `{type: 'listening'}` envelope so the PWA can chime "your
        # turn." Without this, listening would either fire on every
        # frame (spam) or only at call-start (one-shot, useless for
        # multi-turn calls).
        listening_announced = False
        while True:
            chunk = await pcm_q.get()
            if chunk is None:
                return
            tts_active = tts_track is not None and tts_track.is_active()
            # Feed the BargePolicy regardless of tts_active — the policy's
            # own gate uses the flag to enable Silero only during the
            # agent-speaking window AND to reset hysteresis cleanly when
            # TTS ends. Cheap call when silero isn't loaded (None branch).
            if barge_policy is not None:
                try:
                    barge_policy.feed_frame(chunk, tts_active)
                except Exception as e:  # pragma: no cover
                    logger.warning(
                        "[stt-bridge] peer %s barge_policy.feed_frame raised: %s",
                        peer.peer_id, e,
                    )
            if tts_active:
                if not was_active:
                    logger.info(
                        "[stt-bridge] peer %s: gating mic→Deepgram (TTS active)",
                        peer.peer_id,
                    )
                    was_active = True
                # Half-duplex echo guard: substitute silence so Deepgram
                # doesn't get fed the speakerphone bleed of our own TTS.
                # Barge detection is owned by the PWA's client-side
                # BargeWindow (mic AnalyserNode → {type:'barge'} envelope
                # over the data channel); see src/audio/realtime/realtimeBarge.ts.
                yield silence_frame
                # While TTS is active we are NOT listening, so re-arm
                # the listening announcement for the next user turn.
                listening_announced = False
                continue
            if was_active:
                logger.info(
                    "[stt-bridge] peer %s: resuming mic→Deepgram (TTS done)",
                    peer.peer_id,
                )
                was_active = False
            # First mic frame after a TTS-active window (or the first
            # frame of the call entirely): announce listening so the
            # PWA can chime "your turn." Idempotent within a single
            # user-turn — the `listening_announced` flag prevents
            # re-firing on every frame.
            if not listening_announced:
                # WebRTC audio (SRTP) and data channel (SCTP) negotiate
                # independently; the first audio frame can arrive before
                # the DC reaches readyState=='open'. Only set the flag
                # after a successful send so a too-early attempt doesn't
                # consume the once-per-turn announcement and leave the
                # PWA without its "your turn" listening chime.
                if _send_data_channel(peer, {"type": "listening"}):
                    listening_announced = True
                    logger.info(
                        "[stt-bridge] peer %s: announced listening (dc open)",
                        peer.peer_id,
                    )
            yield chunk

    try:
        async for tx in stt.stream(_pcm_iter()):
            await _handle_transcript(peer, tx)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.exception("[stt-bridge] peer %s STT error: %s", peer.peer_id, e)
    finally:
        try:
            await stt.aclose()
        except Exception:  # pragma: no cover
            pass
        if not pump_task.done():
            pump_task.cancel()
            try:
                await pump_task
            except (asyncio.CancelledError, Exception):
                pass


# Match XML/HTML-style tags <foo …> and </foo>. Conservative — won't
# match angle brackets used as math/comparison ("a < b") because those
# don't form valid tag-name shapes.
_TAG_RE = re.compile(r"<[^>]{1,200}>")
# Markdown image syntax `![alt](url)`. Drop entirely — the URL is
# noise to TTS.
_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]+\)")
# Markdown link syntax `[label](url)`. Keep the label, drop the URL.
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
# Code fences — drop the fence delimiters but keep what's inside as a
# placeholder; ` ``` ` reads as "back tick back tick back tick" otherwise.
_CODE_BLOCK_RE = re.compile(r"```[\s\S]*?```", re.MULTILINE)
_CODE_FENCE_RE = re.compile(r"```[a-zA-Z0-9_+-]*\n?")
# Markdown emphasis: `**bold**` and `*italic*` / `_italic_`. Without
# stripping these the agent's reply reads as "star star bold star star".
# Canonical regex set lives in `test/tts-clean.test.ts`; keep in sync.
_MD_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
_MD_ITALIC_STAR_RE = re.compile(r"(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)")
_MD_ITALIC_UNDER_RE = re.compile(r"(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)")
_MD_HEADER_RE = re.compile(r"^#+\s+", re.MULTILINE)
_MD_LIST_RE = re.compile(r"^[\s]*[-*•]\s+", re.MULTILINE)
# URLs that survived the link-syntax strip (bare https://… in text).
_BARE_URL_RE = re.compile(r"https?://[^\s<)\]\"']+")
# Emoji: Aura reads "🤖" as silence but reads "✓" as a literal phrase
# ("check mark"). Strip the wide ranges that the test set covers.
_EMOJI_RE = re.compile(
    r"[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE00-\uFE0F\u200D\u20E3]"
)


def _sanitize_for_tts(text: str) -> str:
    """Strip markup that TTS shouldn't pronounce. Catches markdown
    bold/italic/headers/lists/code-blocks/links/images, raw HTML tags,
    bare URLs, and a wide emoji range. Without this Aura reads the
    asterisks of `**bold**` as "star star" out loud. Canonical regex
    set lives in test/tts-clean.test.ts (keep both in sync). Idempotent
    — running twice is a no-op."""
    if not text:
        return text
    out = _TAG_RE.sub("", text)
    out = _CODE_BLOCK_RE.sub("[code block]", out)
    out = _MD_IMAGE_RE.sub(r"\1", out)
    out = _MD_LINK_RE.sub(r"\1", out)
    out = _CODE_FENCE_RE.sub("", out)
    out = out.replace("`", "")
    out = _MD_BOLD_RE.sub(r"\1", out)
    out = _MD_ITALIC_STAR_RE.sub(r"\1\2", out)
    out = _MD_ITALIC_UNDER_RE.sub(r"\1\2", out)
    out = _MD_HEADER_RE.sub("", out)
    out = _MD_LIST_RE.sub("", out)
    out = _BARE_URL_RE.sub("(link in canvas)", out)
    out = _EMOJI_RE.sub("", out)
    # Trailing pass: drop any stray asterisks the patterns above didn't
    # catch (e.g. `*foo` with no closer, or `**` at line ends).
    out = out.replace("*", "")
    return out


def _send_data_channel(peer, payload: dict) -> bool:
    """Best-effort send of a JSON envelope over the peer's data channel.

    Returns True if the bytes left the bridge, False if the channel was
    closed / not-yet-opened. Caller can use the return value to decide
    whether to retry on the next opportunity (e.g. listening_announced
    only flips True after a successful send so a too-early send doesn't
    consume the once-per-turn flag).
    """
    dc = peer.data_channel
    if dc is None:
        return False
    try:
        # aiortc tracks ready-state; sending while not 'open' raises.
        if getattr(dc, "readyState", "open") != "open":
            return False
        import json as _json
        dc.send(_json.dumps(payload, ensure_ascii=False))
        return True
    except Exception as e:  # pragma: no cover
        logger.debug(
            "[stt-bridge] peer %s data-channel send failed: %s",
            peer.peer_id, e,
        )
        return False


async def _handle_transcript(peer, tx: Transcript) -> None:
    """Forward an interim or final transcript to the data channel.

    Pass-through behavior: every transcript event (interim + final +
    empty-final) goes out as a {type:'transcript', role:'user'}
    envelope. The bridge does NOT buffer, gate on commit-phrase, or run
    a silence timer — those decisions belong to the PWA, which owns the
    dispatch trigger.

    Empty FINALS (Deepgram's UtteranceEnd marker) are forwarded: the
    PWA's dictate.ts state machine closes out the current utterance on
    them — bakes the trailing space and re-anchors the NEXT utterance at
    the user's current caret. Dropping them here (pre-2026-08-09
    behavior, on the theory they were "internal sync points") left the
    client's utterance-end branch permanently dead: the anchor never
    reset, so after a caret move every later utterance still landed at
    the FIRST utterance's position (Jonathan field bug 2026-08-09).
    Empty interims stay skipped — pure noise.
    """
    if peer.on_transcript is not None:
        try:
            await peer.on_transcript(tx.text, tx.is_final)
        except Exception as e:  # pragma: no cover
            logger.warning("[stt-bridge] peer %s on_transcript hook raised: %s", peer.peer_id, e)

    if not tx.text and not tx.is_final:
        return

    _send_data_channel(peer, {
        "type": "transcript",
        "text": tx.text,
        "is_final": tx.is_final,
        "role": "user",
    })


async def dispatch_to_agent(peer, utterance: str, *, user_message_id: Optional[str] = None) -> None:
    """Public dispatch entry point invoked by the PWA-driven dispatch listener.

    POSTs *utterance* to the parley proxy. For the chat_id (parley-
    platform) route the agent reply arrives on the peer-scoped
    persistent stream subscriber started at peer-attach
    (``start_parley_stream``); this function is fire-and-forget POST.
    For the legacy /v1/responses route there is no persistent stream,
    so we still consume the per-POST SSE inline.

    *user_message_id* (when set) is the PWA-minted id riding the
    dispatch envelope. We forward it so the upstream's user_message
    echo carries the same id, letting the originating device's
    optimistic bubble dedup idempotently. Absent → server mints.
    """
    asyncio.create_task(
        _dispatch_to_agent(peer, utterance, user_message_id=user_message_id),
        name=f"webrtc-agent-{peer.peer_id[:8]}",
    )


# ── Persistent parley-stream subscriber ───────────────────────────────
#
# Long-lived per-peer SSE subscriber to /api/parley/stream?chat_id=X.
# Replaces the legacy per-utterance subscriber that broke out of the
# stream after the first reply_final and missed every subsequent bubble
# in the same user turn (post-tool-call results, follow-up nudges, etc.).
#
# Architecture: peer has a chat_id and is in talk mode → there's a
# tts_text_queue → spawn this subscriber at peer-attach time →
# every reply_delta drains into the queue → tts_bridge consumes →
# Aura synth → outbound peer audio track. Cancelled on peer.close().
#
# Cumulative-text diff is per-message-id. The agent emits multiple
# bubbles per user turn, each with its own message_id; reply_delta
# carries cumulative-so-far text for that bubble. We diff against
# prev cumulative for THAT msgid to extract the speakable delta.
#
# `live_only=1` is preserved: the bridge subscribes when the peer
# attaches and only wants envelopes broadcast AFTER that point —
# historical envelopes from earlier turns in the same chat would
# re-feed Aura TTS for already-spoken replies. The PWA's separate
# subscriber keeps its replay cursor for cross-device sync; only the
# bridge needs the live-only opt-out.

class _ParleyStreamReader:
    """Stateful SSE-frame consumer for the parley-platform route.

    Holds per-message-id cumulative-text state so reply_delta diffs
    work correctly when multiple bubbles interleave. Idempotent on
    duplicate envelopes (cumulative.startswith(prev) catches that).
    Pushes speakable deltas into ``text_queue`` and forwards to the
    peer's data channel for PWA-side rendering parity.
    """

    def __init__(self, peer, text_queue):
        self.peer = peer
        self.text_queue = text_queue
        self._current_event: Optional[str] = None
        # Per-message-id cumulative accumulators. Cleared on reply_final
        # for that msgid so completed bubbles don't hold memory forever.
        self._prev_cumulative: Dict[str, str] = {}
        self._prev_stripped_for_tts: Dict[str, str] = {}

    def _put_text(self, delta: str) -> None:
        if not delta or self.text_queue is None:
            return
        try:
            self.text_queue.put_nowait(delta)
        except asyncio.QueueFull:
            pass

    def _put_eor(self) -> None:
        """End-of-reply sentinel — flushes the TTS buffer for this bubble."""
        if self.text_queue is None:
            return
        try:
            self.text_queue.put_nowait(None)
        except asyncio.QueueFull:
            pass

    async def process_line(self, line_bytes) -> None:
        """Consume one raw SSE line. Side-effects: text_queue push,
        on_transcript hook, data-channel forward.
        """
        line = line_bytes.rstrip(b"\r\n")
        if not line:
            self._current_event = None
            return
        if line.startswith(b":"):
            return
        if line.startswith(b"event:"):
            self._current_event = line[len(b"event:"):].strip().decode(
                "utf-8", errors="replace",
            )
            return
        if not line.startswith(b"data:"):
            return
        data = line[len(b"data:"):].strip()
        if not data:
            return
        try:
            import json as _json
            chunk = _json.loads(data)
        except (ValueError, TypeError):
            return
        event_name = self._current_event or chunk.get("type")

        if event_name == "reply_delta":
            cumulative = chunk.get("text") or ""
            if not cumulative:
                return
            msgid = str(chunk.get("message_id") or "")
            prev = self._prev_cumulative.get(msgid, "")
            if cumulative.startswith(prev):
                delta = cumulative[len(prev):]
            else:
                # Restart — agent sent a non-additive delta (rare).
                delta = cumulative
            self._prev_cumulative[msgid] = cumulative
            if not delta:
                return
            new_stripped = _sanitize_for_tts(cumulative)
            prev_stripped = self._prev_stripped_for_tts.get(msgid, "")
            if new_stripped.startswith(prev_stripped):
                tts_delta = new_stripped[len(prev_stripped):]
            else:
                tts_delta = new_stripped
            self._prev_stripped_for_tts[msgid] = new_stripped
            self._put_text(tts_delta)
            if self.peer.on_transcript is not None:
                try: await self.peer.on_transcript(delta, False)
                except Exception: pass
            _send_data_channel(self.peer, {
                "type": "transcript", "text": delta,
                "is_final": False, "role": "assistant",
            })
            return

        if event_name == "reply_final":
            msgid = str(chunk.get("message_id") or "")
            cumulative_len = len(self._prev_cumulative.get(msgid, ""))
            logger.info(
                "[stt-bridge] peer %s reply_final msgid=%s cumulative_len=%d",
                self.peer.peer_id, msgid[:32], cumulative_len,
            )
            # Flush this bubble's TTS buffer; tts_bridge treats None as
            # end-of-reply and starts a new synth round on next text.
            self._put_eor()
            # Drop completed-bubble state so it doesn't leak. New bubbles
            # come in with fresh msgids.
            self._prev_cumulative.pop(msgid, None)
            self._prev_stripped_for_tts.pop(msgid, None)
            # Forward end-of-reply to the data channel for the PWA
            # streaming-cursor drop. (PWA also has its own subscriber;
            # this is parity with the legacy per-utterance path.)
            _send_data_channel(self.peer, {
                "type": "transcript",
                "text": "",
                "is_final": True,
                "role": "assistant",
            })
            return

        # Other envelope types (typing, tool_call, tool_result, error,
        # session_changed, user_message, notification) flow through the
        # PWA's separate subscriber; we don't need to mirror them since
        # we're only interested in audio synth.


def start_parley_stream(peer) -> None:
    """Start the peer-scoped persistent stream subscriber.

    Caller (signaling.handle_offer) invokes this AFTER tts_bridge.attach
    has created peer.extra['tts_text_queue'], and only when mode=='talk'
    AND chat_id is set. No-op if either precondition is missing.
    """
    if peer.mode != "talk":
        return
    chat_id = peer.extra.get("chat_id")
    if not chat_id:
        return
    text_queue = peer.extra.get("tts_text_queue")
    if text_queue is None:
        logger.warning(
            "[stt-bridge] peer %s start_parley_stream: no tts_text_queue (talk mode but TTS attach skipped?)",
            peer.peer_id,
        )
        return
    if peer.parley_stream_task is not None and not peer.parley_stream_task.done():
        return  # idempotent
    peer.parley_stream_task = asyncio.create_task(
        _run_parley_stream(peer, chat_id, text_queue),
        name=f"webrtc-parley-stream-{peer.peer_id[:8]}",
    )


async def _run_parley_stream(peer, chat_id: str, text_queue) -> None:
    """Stay subscribed to /api/parley/stream for the peer's lifetime,
    feeding every reply_delta delta into ``text_queue``. Reconnects with
    bounded backoff if the connection drops; exits cleanly on
    cancellation (peer.close).
    """
    proxy_url = (peer.extra.get("proxy_url") or "http://127.0.0.1:3001").rstrip("/")
    stream_url = f"{proxy_url}/api/parley/stream?chat_id={chat_id}&live_only=1"

    try:
        import aiohttp  # type: ignore
    except ImportError:  # pragma: no cover
        logger.error("[stt-bridge] aiohttp missing for parley stream")
        return

    reader = _ParleyStreamReader(peer, text_queue)
    backoff_s = 0.5
    BACKOFF_MAX = 8.0

    logger.info(
        "[stt-bridge] peer %s parley stream subscriber starting (chat_id=%s)",
        peer.peer_id, chat_id[:12],
    )
    try:
        async with aiohttp.ClientSession() as sess:
            while not peer.closed:
                try:
                    async with sess.get(
                        stream_url,
                        timeout=aiohttp.ClientTimeout(total=None),
                    ) as resp:
                        if resp.status != 200:
                            err = (await resp.text())[:200]
                            logger.warning(
                                "[stt-bridge] peer %s parley stream open %d: %s (retry in %.1fs)",
                                peer.peer_id, resp.status, err, backoff_s,
                            )
                            await asyncio.sleep(backoff_s)
                            backoff_s = min(BACKOFF_MAX, backoff_s * 2)
                            continue
                        backoff_s = 0.5  # reset on successful connect
                        async for raw in resp.content:
                            await reader.process_line(raw)
                        # EOF without cancellation → server closed the
                        # stream. Reconnect with a small delay.
                        if not peer.closed:
                            logger.info(
                                "[stt-bridge] peer %s parley stream EOF, reconnecting",
                                peer.peer_id,
                            )
                            await asyncio.sleep(0.5)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.warning(
                        "[stt-bridge] peer %s parley stream error: %s (retry in %.1fs)",
                        peer.peer_id, e, backoff_s,
                    )
                    await asyncio.sleep(backoff_s)
                    backoff_s = min(BACKOFF_MAX, backoff_s * 2)
    except asyncio.CancelledError:
        pass
    finally:
        logger.info(
            "[stt-bridge] peer %s parley stream subscriber exiting",
            peer.peer_id,
        )
        # Final flush so any tail text in the TTS provider gets
        # synthesized before the queue idles.
        if text_queue is not None:
            try:
                text_queue.put_nowait(None)
            except asyncio.QueueFull:
                pass


async def _dispatch_to_agent(peer, utterance: str, *, user_message_id: Optional[str] = None) -> None:
    """Run an agent turn for *utterance* and route the streaming reply.

    Two routing paths, selected by which identifier the offer payload
    carried:

    - **chat_id present** (hermes-gateway backend): POST
      <proxy_url>/api/parley/messages with {chat_id, text}. The proxy
      forwards via WebSocket to the hermes parley platform adapter;
      the SSE response carries `event: <envelope_type>` frames with the
      adapter envelope (reply_delta / reply_final / typing / etc) as the
      data payload.

    - **chat_id absent** (legacy): POST <proxy_url>/api/<backend>/responses
      with the OpenAI Responses API body. The proxy forwards to the
      agent's /v1/responses; SSE carries response.output_text.delta /
      response.completed events.

    Both paths feed the same two sinks:

    1. The peer's TTS bridge (talk mode) — registers a queue under
       peer.extra["tts_text_queue"]; we push text deltas into it.

    2. The data channel — the PWA renders the assistant bubble from
       these envelopes.  A terminal {role:'assistant', is_final:true}
       fires after the stream completes so the PWA can drop the
       streaming-cursor on the bubble.
    """
    proxy_url = (peer.extra.get("proxy_url") or "http://127.0.0.1:3001").rstrip("/")
    chat_id = peer.extra.get("chat_id")
    if chat_id:
        url = f"{proxy_url}/api/parley/messages"
        body: Dict[str, Any] = {"chat_id": chat_id, "text": utterance}
        if user_message_id:
            body["user_message_id"] = user_message_id
        route = "parley-platform"
    else:
        backend = peer.extra.get("backend") or "hermes"
        url = f"{proxy_url}/api/{backend}/responses"
        conv_name = peer.extra.get("conv_name")
        body = {"input": utterance, "stream": True}
        if conv_name:
            body["conversation"] = conv_name
        if user_message_id:
            # Riding metadata (OAI-blessed Dict[str,str] extension
            # point) so vanilla OpenAI servers ignore-gracefully
            # instead of choking on an unknown top-level field.
            body["metadata"] = {"user_message_id": user_message_id}
        route = "responses"

    headers = {"Content-Type": "application/json"}

    try:
        import aiohttp  # type: ignore
    except ImportError:  # pragma: no cover
        logger.error("[stt-bridge] aiohttp missing for agent dispatch")
        return

    logger.info(
        "[stt-bridge] peer %s dispatch start (route=%s utterance_len=%d)",
        peer.peer_id, route, len(utterance),
    )

    text_queue: Optional[asyncio.Queue] = peer.extra.get("tts_text_queue")

    # SSE events arrive as `event: <name>\ndata: <json>\n\n` frames. We
    # track the current event name across lines so the data: payload can
    # be interpreted in context.
    #
    # Two event vocabularies depending on `route`:
    #   responses        — response.output_text.delta (per-token delta) /
    #                      response.completed (terminal)
    #   parley-platform — reply_delta (cumulative text) / reply_final
    #                       (terminal). See backends/hermes/plugin/__init__.py.
    #
    # For the cumulative-text path we diff against the previously-seen
    # text so the data-channel envelope to the PWA stays per-token (the
    # PWA's transcript renderer appends, doesn't replace) and the TTS
    # text-queue gets only the new tokens.
    current_event: Optional[str] = None
    prev_cumulative: str = ""
    # Stripped mirror of prev_cumulative — what the TTS queue has
    # actually consumed so far. Diffing against this rather than the
    # raw cumulative lets us push only the SPEAKABLE delta (HTML/
    # markdown/etc. dropped) without splitting tags mid-token.
    prev_stripped_for_tts: str = ""

    # Inline SSE parser: consumes one frame at a time from `content_iter`,
    # feeds delta tokens into the TTS queue + on_transcript hook + data
    # channel envelope. Returns True when a terminal event arrives
    # (response.completed / reply_final), so the caller breaks out.
    async def _process_sse_frame(line_bytes) -> bool:
        nonlocal current_event, prev_cumulative, prev_stripped_for_tts
        line = line_bytes.rstrip(b"\r\n")
        if not line:
            current_event = None
            return False
        if line.startswith(b":"):
            return False
        if line.startswith(b"event:"):
            current_event = line[len(b"event:"):].strip().decode(
                "utf-8", errors="replace",
            )
            return False
        if not line.startswith(b"data:"):
            return False
        data = line[len(b"data:"):].strip()
        if not data:
            return False
        try:
            import json as _json
            chunk = _json.loads(data)
        except (ValueError, TypeError):
            return False
        event_name = current_event or chunk.get("type")
        if event_name == "response.output_text.delta":
            delta = chunk.get("delta") or ""
            if delta:
                if text_queue is not None:
                    try: text_queue.put_nowait(delta)
                    except asyncio.QueueFull: pass
                if peer.on_transcript is not None:
                    try: await peer.on_transcript(delta, False)
                    except Exception: pass
                _send_data_channel(peer, {
                    "type": "transcript", "text": delta,
                    "is_final": False, "role": "assistant",
                })
            return False
        if event_name == "response.completed":
            logger.info(
                "[stt-bridge] peer %s reply terminal (event=response.completed)",
                peer.peer_id,
            )
            return True
        if event_name == "reply_delta":
            cumulative = chunk.get("text") or ""
            if not cumulative:
                return False
            if cumulative.startswith(prev_cumulative):
                delta = cumulative[len(prev_cumulative):]
            else:
                delta = cumulative
            prev_cumulative = cumulative
            if not delta:
                return False
            # TTS path: feed the SPEAKABLE delta only. Strip XML/HTML
            # tags + markdown link/image syntax from the cumulative
            # text, diff against prev_stripped_for_tts to compute the
            # new audible portion. Keeps Aura from pronouncing
            # `<audio src="speech_…mp3">` literally when the agent
            # leaks markup into its output (gemma-4 sometimes hallucinates
            # an audio embed; gpt-oss leaks Harmony channel tokens).
            new_stripped = _sanitize_for_tts(cumulative)
            if new_stripped.startswith(prev_stripped_for_tts):
                tts_delta = new_stripped[len(prev_stripped_for_tts):]
            else:
                tts_delta = new_stripped
            prev_stripped_for_tts = new_stripped
            if tts_delta and text_queue is not None:
                try: text_queue.put_nowait(tts_delta)
                except asyncio.QueueFull: pass
            # PWA-side surfaces (data channel + on_transcript) get the
            # raw delta — the chat-bubble renderer handles its own
            # display cleanup.
            if peer.on_transcript is not None:
                try: await peer.on_transcript(delta, False)
                except Exception: pass
            _send_data_channel(peer, {
                "type": "transcript", "text": delta,
                "is_final": False, "role": "assistant",
            })
            return False
        if event_name == "reply_final":
            logger.info(
                "[stt-bridge] peer %s reply terminal (event=reply_final cumulative_len=%d)",
                peer.peer_id, len(prev_cumulative),
            )
            return True
        return False

    async with aiohttp.ClientSession() as sess:
        try:
            if route == "parley-platform":
                # Platform-adapter path: fire-and-forget POST. Reply
                # envelopes arrive on the peer-scoped persistent
                # subscriber started at peer-attach (start_parley_stream).
                # See _run_parley_stream for the consumer.
                async with sess.post(url, json=body, headers=headers) as post_resp:
                    if post_resp.status not in (200, 202):
                        err = (await post_resp.text())[:200]
                        logger.warning(
                            "[stt-bridge] peer %s agent dispatch %d: %s",
                            peer.peer_id, post_resp.status, err,
                        )
                        return
                logger.info(
                    "[stt-bridge] peer %s dispatch posted (route=parley-platform)",
                    peer.peer_id,
                )
            else:
                # Legacy /v1/responses route: no persistent stream
                # available — consume per-POST SSE inline. Same
                # break-on-reply_final shape as before; that route is
                # one-bubble-per-turn by /v1/responses semantics, so
                # the bug doesn't apply.
                async with sess.post(url, json=body, headers=headers) as resp:
                    if resp.status != 200:
                        err = (await resp.text())[:200]
                        logger.warning(
                            "[stt-bridge] peer %s agent dispatch %d: %s",
                            peer.peer_id, resp.status, err,
                        )
                        return
                    async for raw in resp.content:
                        if await _process_sse_frame(raw):
                            break
                # Legacy-route end-of-reply housekeeping. Parley-
                # platform route doesn't run this finally because the
                # persistent stream owns the lifecycle.
                if text_queue is not None:
                    try:
                        text_queue.put_nowait(None)
                    except asyncio.QueueFull:
                        pass
                _send_data_channel(peer, {
                    "type": "transcript",
                    "text": "",
                    "is_final": True,
                    "role": "assistant",
                })
                logger.info(
                    "[stt-bridge] peer %s dispatch finally (route=responses cumulative_len=%d)",
                    peer.peer_id, len(prev_cumulative),
                )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("[stt-bridge] peer %s agent dispatch error: %s", peer.peer_id, e)


__all__ = ["attach", "dispatch_to_agent", "start_parley_stream"]
