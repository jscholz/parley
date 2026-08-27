"""The half-duplex echo guard must not delete the user's barge speech.

Field bug 2026-08-27 23:04:20-23:04:37 (peer b040d3ef, home Wi-Fi):

    23:04:20.496  gating mic→Deepgram (TTS active)
    23:04:22.757  barge-policy speech-active (sustained 7 frames, p=1.000)
                  ^^ he is TALKING, and every one of those frames is being
                     replaced with 640 zero bytes before it reaches Deepgram
    23:04:23.503  barge halted TTS
    23:04:23.519  resuming mic→Deepgram — real audio resumes MID-WORD

So 762 ms of real speech was deliberately discarded, and what Deepgram
did receive started in the middle of a word. Measured against the live
Deepgram API on the offline harness (/tmp/dg-repro/harness.py, repo
smoke fixtures, that exact 3.02 s gate with the user speaking its last
0.76 s):

    zerofill (pre-fix)   first transcript after release = "Three four"
                         → the spoken "one two" never existed; 1.25 s
                           to the first word
    replay   (this fix)  first transcript after release = "One"
                         → gated speech recovered; 0.21 s to first word

Reproduced identically on 3 consecutive rounds of one long-lived stream,
and at 3.02 s / 7.5 s / 12.5 s gate lengths.

The guard itself must survive intact: it exists because the speakerphone
bleed of our own TTS was being transcribed as fake user turns. So the
contract is narrow — replay ONLY audio the bridge's own Silero policy
attributed to the user, and nothing at all on rounds where the user
stayed quiet.

Plain queues and fakes; no aiortc, no sockets. Same style as
test_post_tts_resume.py.
"""

import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import stt_bridge
from providers import Transcript

SILENCE = bytes(640)
# Three distinguishable 640-byte frames so the provider's input stream
# can be read back symbolically.
REAL = b"\x40\x1f\xc0\xe0" * 160     # live mic, gate open
QUIET = b"\x10\x00\xf0\xff" * 160    # gated: speakerphone bleed, user silent
BARGE = b"\x00\x30\x00\xd0" * 160    # gated: the user interrupting


class _FakeDataChannel:
    readyState = "open"

    def __init__(self):
        self.sent = []

    def send(self, payload):
        self.sent.append(json.loads(payload))


class _FakeTtsTrack:
    def __init__(self):
        self.active = False

    def is_active(self, grace_s=None):
        return self.active


class _ScriptedBargePolicy:
    """Stand-in for BargePolicy with the same surface _pcm_iter uses.

    Drives the whole scenario off its own feed_frame call count, which
    _pcm_iter invokes exactly once per queued mic frame, in order — so
    the script stays aligned even though the provider sees a different
    (replay-augmented) stream.
    """

    def __init__(self, track, *, gate_start, gate_end, barge_at=None):
        self.track = track
        self.gate_start = gate_start
        self.gate_end = gate_end
        self.barge_at = barge_at
        self.is_active = False
        self.n = 0

    def feed_frame(self, frame, tts_active):
        self.n += 1
        # Flips land on the NEXT frame (tts_active is read before this
        # call), which is exactly how the real track behaves.
        if self.n == self.gate_start:
            self.track.active = True
        elif self.n == self.gate_end:
            self.track.active = False
        if not tts_active:
            self.is_active = False
        elif self.barge_at is not None and self.n >= self.barge_at:
            self.is_active = True


class _FakePeer:
    def __init__(self, tts_track, barge_policy):
        self.peer_id = "test-peer-barge-replay"
        self.on_transcript = None
        self.data_channel = _FakeDataChannel()
        self.extra = {"tts_track": tts_track, "barge_policy": barge_policy}


class _Spec:
    options: dict = {}


class _VoiceConfig:
    stt = _Spec()


class _RecordingSTT:
    def __init__(self):
        self.chunks = []

    async def stream(self, pcm_iter):
        async for chunk in pcm_iter:
            self.chunks.append(chunk)
            if False:  # pragma: no cover — keeps this an async generator
                yield Transcript(text="", is_final=False)

    async def aclose(self):
        pass


async def _drive(frames, *, gate_start, gate_end, barge_at, monkeypatch):
    track = _FakeTtsTrack()
    policy = _ScriptedBargePolicy(
        track, gate_start=gate_start, gate_end=gate_end, barge_at=barge_at,
    )
    peer = _FakePeer(track, policy)
    stt = _RecordingSTT()
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)

    pcm_q: asyncio.Queue = asyncio.Queue()
    for f in frames:
        pcm_q.put_nowait(f)
    pcm_q.put_nowait(None)
    pump = asyncio.create_task(asyncio.sleep(3600))
    try:
        await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    finally:
        pump.cancel()
    return peer, stt


def _scenario(pre=5, bleed=40, barge=30, post=60):
    """Frames as the MIC produced them: live → gate(bleed then barge) → live.

    Index note: `tts_active` for frame *n* is read BEFORE feed_frame(n),
    so a flip scripted at n takes effect on frame n+1. The gate markers
    below are therefore one lower than the first/last gated frame.
    """
    return (
        [REAL] * pre + [QUIET] * bleed + [BARGE] * barge + [REAL] * post,
        pre,                      # flip on → frames pre+1 … are gated
        pre + bleed + barge,      # flip off → frame pre+bleed+barge+1 is live
        pre + bleed + 1,          # barge_at: first BARGE frame
    )


@pytest.mark.asyncio
async def test_barge_speech_reaches_deepgram_instead_of_being_deleted(monkeypatch):
    """THE regression. Pre-fix the provider never sees a single BARGE
    frame: all 30 were swapped for zeros and dropped on the floor."""
    frames, gs, ge, ba = _scenario()
    _peer, stt = await _drive(frames, gate_start=gs, gate_end=ge,
                              barge_at=ba, monkeypatch=monkeypatch)

    assert BARGE in stt.chunks, (
        "the user's interrupting speech was deleted before Deepgram saw it "
        "— the half-duplex guard must replay barge audio, not discard it"
    )
    # All of it, capped only by the ring size.
    assert stt.chunks.count(BARGE) == 30

    # And it must arrive in the right PLACE: contiguously, after the
    # gated silence run and BEFORE the live frames resume, so Deepgram
    # receives one whole utterance rather than a mid-word fragment.
    first_barge = stt.chunks.index(BARGE)
    last_barge = len(stt.chunks) - 1 - stt.chunks[::-1].index(BARGE)
    assert stt.chunks[first_barge:last_barge + 1].count(BARGE) == 30, \
        "barge frames must be replayed contiguously"
    assert stt.chunks[first_barge - 1] in (SILENCE, QUIET), \
        "replay must sit at the gate-release boundary"
    assert all(c == REAL for c in stt.chunks[last_barge + 1:]), \
        "live mic frames must follow the replay, not interleave with it"


@pytest.mark.asyncio
async def test_echo_guard_intact_no_barge_means_no_mic_audio_at_all(monkeypatch):
    """The guard's whole reason for existing. With no barge, NOTHING the
    mic heard during playback may reach Deepgram — otherwise our own TTS
    comes back as a fake user turn (the iOS speakerphone feedback loop)."""
    frames, gs, ge, _ba = _scenario(bleed=70, barge=0)
    _peer, stt = await _drive(frames, gate_start=gs, gate_end=ge,
                              barge_at=None, monkeypatch=monkeypatch)

    assert QUIET not in stt.chunks, (
        "speakerphone bleed reached Deepgram — the echo guard is broken"
    )
    assert BARGE not in stt.chunks
    gated = [c for c in stt.chunks if c == SILENCE]
    assert gated, "the gate must still feed paced silence during playback"


@pytest.mark.asyncio
async def test_replay_is_bounded_so_a_long_reply_cannot_flood_deepgram(monkeypatch):
    """A 60 s monologue over a long reply must not buffer 60 s of PCM and
    dump it in one burst. The ring is capped at BARGE_REPLAY_MAX_S."""
    cap = stt_bridge.BARGE_REPLAY_MAX_FRAMES
    frames, gs, ge, ba = _scenario(bleed=5, barge=cap * 3)
    _peer, stt = await _drive(frames, gate_start=gs, gate_end=ge,
                              barge_at=ba, monkeypatch=monkeypatch)

    replayed = stt.chunks.count(BARGE) + stt.chunks.count(QUIET)
    assert replayed == cap, (
        f"replay must be capped at {cap} frames "
        f"({stt_bridge.BARGE_REPLAY_MAX_S}s), got {replayed}"
    )
    assert stt.chunks.count(BARGE) < cap * 3


@pytest.mark.asyncio
async def test_replay_carries_a_pre_roll_for_silero_confirmation_lag(monkeypatch):
    """Silero needs ~224 ms of sustained speech before it declares a
    barge, so the first syllable is already past when is_active flips.
    A bounded pre-roll hands those frames back."""
    frames, gs, ge, ba = _scenario(bleed=40, barge=10)
    _peer, stt = await _drive(frames, gate_start=gs, gate_end=ge,
                              barge_at=ba, monkeypatch=monkeypatch)

    pre_rolled = stt.chunks.count(QUIET)
    assert pre_rolled == stt_bridge.BARGE_REPLAY_PRE_ROLL_FRAMES, (
        "expected exactly the pre-roll window of pre-fire frames, got "
        f"{pre_rolled}"
    )
    # Bounded: the other 25 bleed frames stay out of the stream.
    assert pre_rolled < 40


@pytest.mark.asyncio
async def test_ring_does_not_leak_across_turns(monkeypatch):
    """Two playback windows, barge only in the FIRST. The second release
    must replay nothing — stale audio from an earlier turn arriving a
    minute later would be worse than losing it."""
    pre, bleed, barge, mid = 5, 20, 20, 30
    frames = (
        [REAL] * pre + [QUIET] * bleed + [BARGE] * barge
        + [REAL] * mid
        + [QUIET] * 40
        + [REAL] * 30
    )
    track = _FakeTtsTrack()

    class _TwoWindowPolicy(_ScriptedBargePolicy):
        def feed_frame(self, frame, tts_active):
            self.n += 1
            if self.n == pre:
                self.track.active = True
            elif self.n == pre + bleed + barge:
                self.track.active = False
            elif self.n == pre + bleed + barge + mid:
                self.track.active = True
            elif self.n == pre + bleed + barge + mid + 40:
                self.track.active = False
            if not tts_active:
                self.is_active = False
            elif pre + bleed < self.n <= pre + bleed + barge:
                self.is_active = True

    policy = _TwoWindowPolicy(track, gate_start=0, gate_end=0, barge_at=None)
    peer = _FakePeer(track, policy)
    stt = _RecordingSTT()
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)
    pcm_q: asyncio.Queue = asyncio.Queue()
    for f in frames:
        pcm_q.put_nowait(f)
    pcm_q.put_nowait(None)
    pump = asyncio.create_task(asyncio.sleep(3600))
    try:
        await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    finally:
        pump.cancel()

    # Round 1 replayed its barge …
    assert stt.chunks.count(BARGE) == barge
    # … and round 2, with no barge, replayed nothing: the only QUIET
    # frames in the stream are round 1's pre-roll.
    assert stt.chunks.count(QUIET) == stt_bridge.BARGE_REPLAY_PRE_ROLL_FRAMES


@pytest.mark.asyncio
async def test_no_barge_policy_installed_degrades_to_old_behaviour(monkeypatch):
    """silero/onnxruntime absent → policy is None → no replay, and the
    loop must not raise."""
    frames, gs, ge, _ = _scenario()
    track = _FakeTtsTrack()

    class _NoPolicyPeer(_FakePeer):
        pass

    peer = _NoPolicyPeer(track, None)
    peer.extra["barge_policy"] = None
    stt = _RecordingSTT()
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)
    pcm_q: asyncio.Queue = asyncio.Queue()
    # Drive the window manually since there is no policy to script it.
    for i, f in enumerate(frames, start=1):
        pcm_q.put_nowait(f)
    pcm_q.put_nowait(None)

    real_is_active = {"n": 0}

    def is_active(grace_s=None):
        real_is_active["n"] += 1
        return gs < real_is_active["n"] <= ge

    track.is_active = is_active
    pump = asyncio.create_task(asyncio.sleep(3600))
    try:
        await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    finally:
        pump.cancel()

    assert BARGE not in stt.chunks and QUIET not in stt.chunks
