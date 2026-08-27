"""Frame-level contract for the post-TTS resume path in stt_bridge._pcm_iter.

Field bug 2026-08-26 (docs/bugs/2026-08-26-realtime-talk-post-reply-audio-
failures.md): after an assistant TTS reply, the bridge logged "resuming
mic→Deepgram (TTS done)" + "announced listening" and the user's next
utterance still went nowhere. Those log lines only proved a Boolean gate
cleared — nothing at frame level. This suite drives a full talk round
through _run_stt with a fake TTS track and pins the FRAME behavior:

  - while tts_track.is_active() → the provider is fed pure silence
    (half-duplex swap engaged);
  - the moment is_active() flips false → the provider is fed the REAL
    mic bytes again (the swap RELEASES — it cannot stick);
  - a `listening` envelope goes out on the data channel at call start
    AND again after the TTS window (once each, not per frame);
  - the new post-TTS diagnostics fire: round counter increments, the
    ~1s peak sample sees the real (non-silent) audio, and the first
    post-TTS transcript is flagged per round.

Also pins tts_bridge.PCMTrack.is_active() self-clearing: it is TIME-based
(last-nonsilent-frame + grace), so a truncated TTS stream (the 16:20:05
Deepgram Aura TransferEncodingError) can NOT leave it latched true — the
frame queue drains and is_active() decays to false on its own. That
refutes the "incomplete TTS payload feeds Deepgram silence forever"
hypothesis from the report.

No aiortc peer, no sockets — plain queues and fakes, same style as
test_stt_reconnect.py.
"""

import asyncio
import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import stt_bridge
from providers import Transcript

SILENCE = bytes(640)
# Loud-ish 16 kHz s16 frame: alternating ±8000 samples. Anything with a
# real peak works; the sampler just needs |amp| > 100.
REAL = (b"\x40\x1f\xc0\xe0" * 160)


class _FakeDataChannel:
    readyState = "open"

    def __init__(self):
        self.sent = []

    def send(self, payload):
        self.sent.append(json.loads(payload))


class _FakeTtsTrack:
    """Scriptable is_active() — flipped by the test mid-stream."""

    def __init__(self):
        self.active = False

    def is_active(self, grace_s=None):
        return self.active


class _FakePeer:
    def __init__(self, tts_track):
        self.peer_id = "test-peer-post-tts"
        self.on_transcript = None
        self.data_channel = _FakeDataChannel()
        self.extra = {"tts_track": tts_track}


class _Spec:
    options: dict = {}


class _VoiceConfig:
    stt = _Spec()


class _RecordingSTT:
    """Consumes the pcm iterator, records every chunk it is fed, and
    emits one transcript after the first REAL post-TTS chunk (so the
    first-post-TTS-transcript probe has something to log)."""

    def __init__(self, tts_track, pre_frames, tts_frames):
        self.chunks = []
        self.tts_track = tts_track
        self.pre_frames = pre_frames
        self.tts_frames = tts_frames
        self._emitted_post_tts = False

    async def stream(self, pcm_iter):
        n = 0
        async for chunk in pcm_iter:
            self.chunks.append(chunk)
            n += 1
            # Script the TTS window: activate after the pre-roll, and
            # deactivate after tts_frames gated frames.
            if n == self.pre_frames:
                self.tts_track.active = True
            elif n == self.pre_frames + self.tts_frames:
                self.tts_track.active = False
            # First real (non-silent) frame after the TTS window ended →
            # pretend Deepgram transcribed it.
            if (not self._emitted_post_tts
                    and n > self.pre_frames + self.tts_frames
                    and chunk != SILENCE):
                self._emitted_post_tts = True
                yield Transcript(text="post tts speech", is_final=False)

    async def aclose(self):
        pass


async def _drive(total_frames, pre_frames, tts_frames, monkeypatch):
    track = _FakeTtsTrack()
    peer = _FakePeer(track)
    stt = _RecordingSTT(track, pre_frames, tts_frames)
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)

    pcm_q: asyncio.Queue = asyncio.Queue()
    for _ in range(total_frames):
        pcm_q.put_nowait(REAL)
    pcm_q.put_nowait(None)
    pump = asyncio.create_task(asyncio.sleep(3600))
    await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    return peer, stt


@pytest.mark.asyncio
async def test_half_duplex_swap_engages_and_releases_at_frame_level(monkeypatch):
    PRE, TTS, POST = 5, 20, 60
    peer, stt = await _drive(PRE + TTS + POST, PRE, TTS, monkeypatch)

    # Pre-roll: real mic bytes reach the provider untouched.
    assert stt.chunks[:PRE] == [REAL] * PRE

    # TTS window: every frame swapped for silence — Deepgram never sees
    # the speakerphone bleed. (is_active() consulted per frame, so the
    # flip lands on the NEXT frame after activation.)
    gated = stt.chunks[PRE:PRE + TTS]
    assert gated and all(c == SILENCE for c in gated), "TTS window must feed pure silence"

    # THE 2026-08-26 assertion: after is_active() clears, the very next
    # frames are the REAL mic bytes again. "resuming mic→Deepgram" must
    # mean frames, not a Boolean.
    post = stt.chunks[PRE + TTS:]
    assert post and all(c == REAL for c in post), "real mic frames must resume after TTS end"


@pytest.mark.asyncio
async def test_listening_announced_at_start_and_after_tts_once_each(monkeypatch):
    PRE, TTS, POST = 5, 20, 60
    peer, _stt = await _drive(PRE + TTS + POST, PRE, TTS, monkeypatch)

    listens = [e for e in peer.data_channel.sent if e.get("type") == "listening"]
    assert len(listens) == 2, (
        f"expected exactly 2 listening envelopes (call start + post-TTS), got {len(listens)}"
    )


@pytest.mark.asyncio
async def test_post_tts_diagnostics_round_peak_and_first_transcript(monkeypatch):
    PRE, TTS, POST = 5, 20, 60  # POST > 50 so the peak sampler completes
    peer, _stt = await _drive(PRE + TTS + POST, PRE, TTS, monkeypatch)

    assert peer.extra.get("post_tts_round") == 1
    # The sampler saw the REAL frames (peak 8000/32768), not silence.
    assert peer.extra.get("post_tts_peak", 0) > 100
    # The transcript emitted after resume was flagged as the round's first.
    assert peer.extra.get("post_tts_first_tx_logged") is True
    assert any(e.get("type") == "transcript" and e.get("text") == "post tts speech"
               for e in peer.data_channel.sent)


def _require_pcmtrack():
    import tts_bridge
    if not tts_bridge._AIORTC_OK:  # pragma: no cover — env without aiortc
        pytest.skip("aiortc/PyAV not installed")
    return tts_bridge


@pytest.mark.asyncio
async def test_pcmtrack_is_active_self_clears_after_feed_stops():
    """A truncated TTS stream (Aura TransferEncodingError) cannot latch
    is_active() true: the flag is derived from the timestamp of the last
    queue-fed frame plus a grace window, so once the queue drains it
    decays to false with no halt/complete signal required."""
    tts_bridge = _require_pcmtrack()
    track = tts_bridge.PCMTrack()
    # Feed a few frames as if synth died mid-reply, then drain via recv.
    for _ in range(3):
        track.feed(b"\x01\x02" * 320)
    for _ in range(3):
        await track.recv()
    assert track.is_active(grace_s=10.0), "sanity: active right after frames"
    # Grace elapses with no further feeds → inactive, mic path reopens.
    await asyncio.sleep(0.12)
    assert not track.is_active(grace_s=0.1), (
        "is_active() must decay after the queue drains — a truncated TTS "
        "payload must not gate the mic forever"
    )
    # And recv() on the now-empty queue emits silence WITHOUT refreshing
    # the activity timestamp.
    await track.recv()
    assert not track.is_active(grace_s=0.1)
