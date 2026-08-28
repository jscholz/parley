"""
TTS bridge: agent reply text-stream -> TTSProvider.synth -> outbound RTC track.

Per peer (talk mode only):

    text_queue (asyncio.Queue[str])    # populated by stt_bridge
        |
        |  async generator: drain queue
        v
    TTSProvider.synth(text_iter)
        |
        v  16 kHz mono int16 PCM bytes
    PCMTrack (MediaStreamTrack subclass)
        |
        v  av.AudioFrame chunks of 20 ms
    aiortc.PeerConnection.addTrack -> Opus encode -> outbound RTP

The PCMTrack instance is constructed up-front and added to the peer
connection BEFORE we accept the offer so the answer SDP advertises the
outbound track.  The synth task fires lazily — it sits idle until the
text queue starts producing.

Resampling: The Aura adapter returns 16 kHz int16 PCM (we requested
linear16/16000 in the URL).  aiortc happily encodes any sample rate to
Opus via PyAV; we just package the bytes into 20 ms AudioFrame slices.
"""

from __future__ import annotations

import asyncio
import fractions
import logging
import time
from typing import Any, AsyncIterator, Optional

from config import VoiceConfig
from providers import get_tts_provider

logger = logging.getLogger(__name__)

# 20 ms frames at 16 kHz mono int16 = 16000 * 0.02 * 2 bytes = 640 bytes.
TTS_SAMPLE_RATE = 16000
TTS_FRAME_MS = 20
TTS_FRAME_SAMPLES = int(TTS_SAMPLE_RATE * TTS_FRAME_MS / 1000)
TTS_FRAME_BYTES = TTS_FRAME_SAMPLES * 2

# ── Post-halt speaker tail ────────────────────────────────────────────
#
# `halt()` stops the bridge ORIGINATING TTS within one 20 ms tick (it
# drains _frame_queue and recv() falls straight through to silence).
# It cannot stop the audio that has already left this process — but as
# of 2026-08-28 it no longer has to. The client now MUTES its remote
# output at the barge (src/audio/realtime/realtime.ts
# `cancelRemotePlayback`: a 25 ms gain ramp to zero, not an unbind), so
# the 100–300 ms sitting in the browser's jitter buffer plays into a
# zeroed gain and never reaches the speaker. That mute IS the cut the
# user hears, and it is what Jonathan asked for: "everything before the
# barge is detected will be discarded, but everything immediately
# afterwards will be captured."
#
# So this window is no longer "how long the speaker keeps talking". It
# is one thing only: UPLINK SKEW — mic frames captured just BEFORE the
# mute, still in flight, which still carry the agent's voice.
#
#   Let t=0 be the instant the client mutes (its own barge decision).
#   The barge envelope reaches us over the data channel at t + D, and
#   halt() runs there, so this window starts at t + D.
#   A mic frame captured at time c arrives in _pcm_iter at c + U.
#   Frames are contaminated for c < t + ramp, i.e. they keep arriving
#   until t + ramp + U.
#   Required window = (t + ramp + U) - (t + D) = U - D + ramp.
#
#   U (mic capture → here): iOS capture buffer 20–40 ms, Opus encode +
#     packetization 20 ms, network one-way 10–30 ms, aiortc jitter
#     buffer + decode + pump queue 20–60 ms  →  ~70–150 ms.
#   D (data channel one-way): same network path, no media buffering
#     →  ~10–30 ms.
#   ramp: 25 ms (DUCK_RAMP_MS in realtime.ts).
#
#   U - D + ramp  ≈  55–165 ms.  Round up to 200 ms for headroom on a
#   worse uplink and for the few ms of room-reverb tail already in the
#   air at the mute.
#
# Was 400 ms, which was correct when the speaker genuinely kept playing
# for 100–300 ms after the halt. Halving it directly buys back 200 ms of
# the user's post-cut speech: every gated frame is DISCARDED now (there
# is no replay — see stt_bridge), so a longer window is not caution, it
# is deleted words.
#
# It stays deliberately much shorter than TTS_TAIL_GRACE_S (1.2 s),
# which covers a NATURAL end-of-reply where the provider may still be
# emitting into an UNMUTED speaker and the room reverb tail is in play.
#
# `is_active()` reports True for this window, which is the single
# boolean the whole system already mirrors: stt_bridge's half-duplex
# gate, its {type:'tts-playing'} heartbeat, and barge_policy's Silero
# gate. Holding it True is therefore the complete fix — no separate
# concept has to be threaded through three modules.
HALT_TAIL_GRACE_S = 0.2

# Cap text queue so a runaway delta stream doesn't OOM us.
MAX_TEXT_QUEUE = 1024
# PCM frame queue cap. The producer (synth feed loop) blocks via
# `await queue.put()` when the queue is full, so this cap is purely
# a memory ceiling — not a correctness threshold. 200 frames = 4 s.
# Was 150 with silent drops on overflow (rushed/garbled audio after
# 5-6 s of long replies). True backpressure replaces the drops:
# producer waits, consumer drains at 20 ms wall-clock, no frames
# ever lost. Receiver always sees a continuous, properly-paced
# stream.
MAX_PCM_FRAME_QUEUE = 200


def attach(peer, *, voice_config: VoiceConfig, api_server: Any) -> None:
    """Wire an outbound TTS track onto *peer*.

    Must be called before :func:`signaling.handle_offer` calls
    setLocalDescription so the SDP answer advertises the outbound track.
    """
    try:
        from aiortc import MediaStreamTrack  # type: ignore
    except ImportError as exc:  # pragma: no cover
        logger.error("[tts-bridge] aiortc missing: %s", exc)
        return

    text_queue: "asyncio.Queue[Optional[str]]" = asyncio.Queue(maxsize=MAX_TEXT_QUEUE)
    peer.extra["tts_text_queue"] = text_queue

    track = PCMTrack()
    peer.pc.addTrack(track)
    peer.extra["tts_track"] = track

    peer.tts_task = asyncio.create_task(
        _run_tts(peer, voice_config, text_queue, track),
        name=f"webrtc-tts-{peer.peer_id[:8]}",
    )

    logger.info("[tts-bridge] peer %s outbound TTS track wired", peer.peer_id)


async def _run_tts(peer, voice_config: VoiceConfig, text_queue, track) -> None:
    """Drain the text queue, run TTSProvider.synth, push PCM into the track."""
    # Per-peer voice override (PWA Voice-output picker / per-session
    # voice, forwarded in the offer — signaling.handle_offer sanitizes
    # + stashes it). Clone the spec rather than mutate shared state,
    # mirroring stt_bridge's per-peer keyterms clone.
    tts_spec = voice_config.tts
    peer_voice = peer.extra.get("voice")
    if peer_voice:
        from dataclasses import replace
        tts_spec = replace(tts_spec, options={**tts_spec.options, "voice": peer_voice})
        logger.info(
            "[tts-bridge] peer %s voice=%s (base=%s)",
            peer.peer_id, peer_voice, voice_config.tts.options.get("voice"),
        )
    tts = get_tts_provider(tts_spec)

    async def _text_iter() -> AsyncIterator[str]:
        # We don't end after the first None — the agent may produce
        # several replies in one call (one per utterance).  Instead we
        # treat None as an end-of-reply marker and keep the iterator
        # alive for the next reply.
        while True:
            chunk = await text_queue.get()
            if chunk is None:
                # End of one reply; reset and continue.  This relies on
                # the provider's internal buffer flushing on its own
                # when the inner generator ``yield``s nothing more —
                # most providers will close the upstream HTTP request
                # at that point.  Practical workaround: re-instantiate
                # the provider per reply.
                return
            if not chunk:
                continue
            yield chunk

    try:
        # Loop forever: each iteration handles one reply round.
        while not peer.closed:
            # Wait for the first chunk — peeking lets us avoid making
            # a fresh HTTP TTS connection until there's actually text.
            first: Optional[str] = await text_queue.get()
            if first is None:
                # Spurious end marker; loop back and wait.
                continue
            if not first:
                continue

            async def _iter_with_first() -> AsyncIterator[str]:
                yield first
                while True:
                    chunk = await text_queue.get()
                    if chunk is None:
                        return
                    if chunk:
                        yield chunk

            buf = bytearray()
            halted = False
            # Diagnostic counters — frames_fed is the one signal that
            # tells us whether synth() actually produced audio for this
            # round, separate from whether the round was halted.
            # Distinguishes "provider hung after prior halt" (frames=0
            # on a new round) from "halted mid-stream" (frames>0, halted=True).
            first_pcm_seen = False
            frames_fed = 0
            logger.info(
                "[tts-bridge] peer %s reply round start (first_chunk_len=%d)",
                peer.peer_id, len(first or ""),
            )
            # Clear any stale halt_event left over from a barge that
            # fired AFTER the previous round's natural completion (or
            # during its tail flush). Without this, the inner halt-check
            # below sees the orphaned flag on synth()'s very first yield
            # and bails the new round before any audio flows — frames_fed=0,
            # reply text in chat history, no TTS audio. The inner check
            # still catches in-flight barges within this round.
            if track.halt_event.is_set():
                logger.info(
                    "[tts-bridge] peer %s clearing stale halt_event at round start",
                    peer.peer_id,
                )
                track.halt_event.clear()
            try:
                async for pcm in tts.synth(_iter_with_first()):
                    # Halt signal — server-side barge or future
                    # explicit interrupt has been raised. Bail out of
                    # the current TTS reply ASAP so new frames don't
                    # refill the queue that halt() just drained.
                    # We do NOT raise: the halt is cooperative, the
                    # outer loop should keep running for the next
                    # reply round.
                    if track.halt_event.is_set():
                        halted = True
                        break
                    if not pcm:
                        continue
                    if not first_pcm_seen:
                        first_pcm_seen = True
                        logger.info(
                            "[tts-bridge] peer %s first PCM (size=%d)",
                            peer.peer_id, len(pcm),
                        )
                    buf.extend(pcm)
                    while len(buf) >= TTS_FRAME_BYTES:
                        frame_bytes = bytes(buf[:TTS_FRAME_BYTES])
                        del buf[:TTS_FRAME_BYTES]
                        # Backpressure-by-await: if PCMTrack's queue
                        # is full, the synth loop blocks here until
                        # recv() drains a slot. The upstream HTTP
                        # connection from Aura idles for a few hundred
                        # ms; that's fine — Aura tolerates pauses.
                        # This is the structural alternative to the
                        # old silent-drop-on-overflow which caused
                        # rushed/garbled audio on long replies.
                        try:
                            await track.feed_async(frame_bytes)
                            frames_fed += 1
                        except Exception as e:  # pragma: no cover
                            logger.warning("[tts-bridge] track.feed_async failed: %s", e)
                if halted:
                    # Drop any partial buffer — don't flush halted
                    # audio to the now-empty queue. Drain text_queue
                    # up to and including the reply's terminator
                    # (None) so leftover deltas from the halted reply
                    # don't bleed into the next round. Then clear the
                    # event so the next reply's synth loop runs free.
                    buf.clear()
                    drained = 0
                    while True:
                        try:
                            item = text_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                        drained += 1
                        if item is None:
                            break
                    logger.info(
                        "[tts-bridge] peer %s halted; drained %d text-queue items, frames_fed=%d first_pcm=%s",
                        peer.peer_id, drained, frames_fed, first_pcm_seen,
                    )
                    track.halt_event.clear()
                    continue
                # Flush tail (zero-pad to frame boundary so the encoder
                # gets a clean last frame).
                if buf:
                    pad = TTS_FRAME_BYTES - (len(buf) % TTS_FRAME_BYTES)
                    if pad and pad < TTS_FRAME_BYTES:
                        buf.extend(b"\x00" * pad)
                    while len(buf) >= TTS_FRAME_BYTES:
                        frame_bytes = bytes(buf[:TTS_FRAME_BYTES])
                        del buf[:TTS_FRAME_BYTES]
                        try:
                            await track.feed_async(frame_bytes)
                            frames_fed += 1
                        except Exception:  # pragma: no cover
                            pass
                logger.info(
                    "[tts-bridge] peer %s reply round complete (frames_fed=%d first_pcm=%s)",
                    peer.peer_id, frames_fed, first_pcm_seen,
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(
                    "[tts-bridge] peer %s synth error: %s (frames_fed=%d first_pcm=%s)",
                    peer.peer_id, e, frames_fed, first_pcm_seen,
                )
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.exception("[tts-bridge] peer %s outer loop crashed: %s", peer.peer_id, e)
    finally:
        try:
            await tts.aclose()
        except Exception:  # pragma: no cover
            pass


# ----------------------------------------------------------------------
# PCMTrack: MediaStreamTrack subclass that emits 20ms av.AudioFrame slices
# from a bytes-feeding queue.  When the queue is empty we emit silence so
# the RTP track keeps flowing — iOS Safari likes a continuously-paced
# track over a stop/start one.
# ----------------------------------------------------------------------

try:
    from aiortc import MediaStreamTrack  # type: ignore
    from av.audio.frame import AudioFrame  # type: ignore
    import numpy as np  # type: ignore
    _AIORTC_OK = True
except ImportError:  # pragma: no cover
    MediaStreamTrack = object  # type: ignore
    AudioFrame = None  # type: ignore
    np = None  # type: ignore
    _AIORTC_OK = False


class PCMTrack(MediaStreamTrack):  # type: ignore[misc]
    """Outbound audio MediaStreamTrack fed from an in-process bytes queue.

    External producers call :meth:`feed` with 20 ms (640-byte) PCM
    chunks; the track's :meth:`recv` paces them out at 20 ms wall-clock.
    Empty queue -> silence.
    """

    kind = "audio"

    def __init__(self) -> None:
        super().__init__()
        if not _AIORTC_OK:
            raise RuntimeError("aiortc/PyAV not installed")
        self._frame_queue: "asyncio.Queue[bytes]" = asyncio.Queue(maxsize=MAX_PCM_FRAME_QUEUE)
        self._sample_rate = TTS_SAMPLE_RATE
        self._samples_per_frame = TTS_FRAME_SAMPLES
        self._pts = 0
        self._silence = bytes(TTS_FRAME_BYTES)
        self._next_send_time: Optional[float] = None
        self._closed = False
        # Monotonic timestamp of the last non-silent frame emitted to
        # the wire. The STT bridge consults this via is_active() to
        # gate inbound transcription during TTS playback (kills the
        # iOS speakerphone echo loop deterministically).
        self._last_nonsilent_at: Optional[float] = None
        # Monotonic timestamp of the last halt() (i.e. of a barge).
        # Keeps is_active() True for HALT_TAIL_GRACE_S afterwards so the
        # speaker tail still draining out of the phone can't be
        # re-captured into Deepgram. Cleared by the next fed frame.
        self._halted_at: Optional[float] = None
        # Halt signal: set by halt() to tell the synthesis loop in
        # _run_tts to bail out of the current TTS reply ASAP. The
        # synth loop polls this between provider chunks (Option A —
        # see halt() docstring for why over a generation token).
        # Cleared by _run_tts itself after it has drained the leftover
        # text_queue and is ready for a fresh reply round.
        self.halt_event: asyncio.Event = asyncio.Event()

    def feed(self, pcm_bytes: bytes) -> None:
        """Synchronous push, kept for any non-async caller.

        Drops on full queue rather than blocking. Prefer feed_async
        from async producer code paths to get true backpressure.
        """
        if self._closed:
            return
        # New audio for a fresh round supersedes the previous round's
        # halt tail — there is nothing left to drain once we are
        # deliberately playing again.
        self._halted_at = None
        if len(pcm_bytes) != TTS_FRAME_BYTES:
            if len(pcm_bytes) < TTS_FRAME_BYTES:
                pcm_bytes = pcm_bytes + bytes(TTS_FRAME_BYTES - len(pcm_bytes))
            else:
                pcm_bytes = pcm_bytes[:TTS_FRAME_BYTES]
        try:
            self._frame_queue.put_nowait(pcm_bytes)
        except asyncio.QueueFull:
            pass

    async def feed_async(self, pcm_bytes: bytes) -> None:
        """Async push that BLOCKS when the queue is full — true
        backpressure to the producer.

        When `recv()` (paced at 20 ms wall-clock) can't drain fast
        enough to keep up with the synth feed rate, this await pauses
        the producer until a slot frees. Receiver sees a continuous,
        correctly-paced RTP stream regardless of upstream burstiness.
        No frame drops, no buffer-overflow speedup symptoms.
        """
        if self._closed:
            return
        # See feed(): a fed frame ends any pending halt tail.
        self._halted_at = None
        if len(pcm_bytes) != TTS_FRAME_BYTES:
            if len(pcm_bytes) < TTS_FRAME_BYTES:
                pcm_bytes = pcm_bytes + bytes(TTS_FRAME_BYTES - len(pcm_bytes))
            else:
                pcm_bytes = pcm_bytes[:TTS_FRAME_BYTES]
        await self._frame_queue.put(pcm_bytes)

    async def recv(self):  # noqa: D401 — aiortc API
        """Return the next AudioFrame, paced at 20 ms wall-clock.

        Strict pacing: if the consumer is asking too fast (delay > 0)
        we sleep until the next slot. If the consumer is asking too
        SLOW (delay <= 0, we're past schedule), we DON'T catch up by
        emitting fast — we resync to wall-clock so the next slot is
        20 ms from `now`, not 20 ms from a stale past schedule.

        The previous version (always `+= 20ms` regardless) accumulated
        phase debt: a few ms of drift per call, no resync, eventually
        bursting frames as fast as the consumer pulled them. Browser
        plays the burst sped-up + garbled — empirically reproducible
        ~5-6 s into a TTS reply across both desktop and mobile.
        """
        now = time.monotonic()
        if self._next_send_time is None:
            self._next_send_time = now
        delay = self._next_send_time - now
        if delay > 0.001:
            await asyncio.sleep(delay)
            self._next_send_time += TTS_FRAME_MS / 1000.0
        else:
            # Behind schedule — resync to wall-clock. No burst.
            self._next_send_time = now + TTS_FRAME_MS / 1000.0

        # Pull a frame; fall back to silence to keep the track active.
        try:
            pcm = self._frame_queue.get_nowait()
            self._last_nonsilent_at = now
        except asyncio.QueueEmpty:
            pcm = self._silence

        # Build an av.AudioFrame.  layout=mono, format=s16, samples=320.
        arr = np.frombuffer(pcm, dtype=np.int16).reshape(1, -1)
        frame = AudioFrame.from_ndarray(arr, format="s16", layout="mono")
        frame.sample_rate = self._sample_rate
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, self._sample_rate)
        self._pts += self._samples_per_frame
        return frame

    # Grace period after the last non-silent frame was put on the wire
    # before the STT bridge resumes forwarding mic audio to Deepgram.
    # Covers TTS audio still in transit (network buffer, decoder lag,
    # speakerphone-driver latency) plus the room reverb tail. 1.2s
    # mirrors the PWA-side duplex tail we used and gives a comfortable
    # margin without making barge-in feel laggy.
    TTS_TAIL_GRACE_S = 1.2

    def is_halt_tail(self) -> bool:
        """True while the post-halt speaker-tail window is running.

        Distinct from plain `is_active()` because the two windows want
        opposite treatment of the barge ring: during normal playback the
        bridge CAPTURES gated mic audio so a barge can be replayed
        (ef904f3), whereas during the halt tail the mic is carrying our
        own drained TTS and nothing captured there may ever be replayed.
        See stt_bridge._pcm_iter.
        """
        if self._halted_at is None:
            return False
        return (time.monotonic() - self._halted_at) < HALT_TAIL_GRACE_S

    def is_active(self, grace_s: Optional[float] = None) -> bool:
        """True if a non-silent TTS frame was emitted recently, OR if we
        are inside the post-halt speaker-tail window.

        STT bridge calls this to decide whether to forward mic audio
        to Deepgram. While True, mic frames are replaced with silence
        — Deepgram sees a quiet input and produces no false transcripts
        from the speakerphone echo of TTS playback.

        The halt-tail term is what makes that guarantee hold across a
        BARGE. halt() used to flip this False on the very next call, so
        for ~400 ms the mic→Deepgram path was open while the phone was
        still emitting the drained TTS tail; the client compensated by
        blanket-dropping every user transcript for 1.5 s, which also ate
        the user's genuine post-barge words (field 2026-08-27 23:04:25,
        "during barge drain: 1 interim/1 final"). Suppressing the echo
        where the AUDIO is means the client can trust every transcript
        it receives.
        """
        if self.is_halt_tail():
            return True
        if self._last_nonsilent_at is None:
            return False
        g = grace_s if grace_s is not None else PCMTrack.TTS_TAIL_GRACE_S
        return (time.monotonic() - self._last_nonsilent_at) < g

    def halt(self) -> None:
        """Drop queued frames + mark inactive immediately. Symmetrizes
        the bridge-side TTS state with the PWA-side <audio> pause on
        barge.

        Two effects, both required for a clean stop:

        1. Drain `_frame_queue` so the next ~MAX_PCM_FRAME_QUEUE recv()
           calls fall back to silence rather than emitting buffered
           TTS audio that the PWA has already paused — without this,
           recv() keeps `_last_nonsilent_at` fresh and `is_active()`
           stays true.

        2. Reset `_last_nonsilent_at` to None and stamp `_halted_at`, so
           `is_active()` reports the post-halt SPEAKER TAIL
           (HALT_TAIL_GRACE_S) and then goes false. The STT bridge polls
           `is_active()` per inbound frame; it keeps feeding Deepgram
           silence for the tail and reopens the mic→Deepgram path once
           the drained audio can no longer be in the room. Stamping
           rather than clearing outright is the 2026-08-28 fix: an
           immediate reopen let the tail be transcribed as a fake user
           turn, which the client then had to defend against by dropping
           the user's real post-barge speech too.

        Halt synthesis-in-flight via `halt_event`: the `_run_tts` loop
        polls this between provider chunks and bails out of the current
        TTS reply, so new frames don't refill the queue right after
        we drained it.

        Idempotent: safe to call multiple times. Safe to call from
        a sync context (no awaits)."""
        self.halt_event.set()
        while not self._frame_queue.empty():
            try:
                self._frame_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        self._last_nonsilent_at = None
        self._halted_at = time.monotonic()

    def stop(self) -> None:  # pragma: no cover — aiortc lifecycle
        self._closed = True
        try:
            super().stop()
        except Exception:
            pass


__all__ = ["attach", "PCMTrack"]
