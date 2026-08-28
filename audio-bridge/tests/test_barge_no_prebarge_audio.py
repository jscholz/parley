"""Nothing the mic heard BEFORE the barge may ever reach Deepgram.

This file used to pin the opposite contract (ef904f3's "barge ring":
capture gated mic audio while the bridge's Silero policy reported
speech, replay it into Deepgram at gate release so an interruption
didn't start mid-word). The walk test of 2026-08-28 11:20 showed why
that could not stand.

    11:20:36.708  barge-policy speech-active (sustained 7 frames, p=0.784)
    11:20:37.687  barge-policy speech-inactive (sustained silence 25 frames)
    11:20:38.228  tts window ended: fired=True, max p_speech=0.993,
                  max |amp|=0.6137
    11:20:38.228  barge replay (gate-release): 87 frames (1.74s) of gated
                  mic audio flushed to Deepgram ahead of live frames

There is no `barge halted TTS` line in that round because the CLIENT
never barged — Jonathan had said "give me a quick reply that I won't
interrupt" and then stayed quiet. What fired was the BRIDGE's Silero,
on the agent's own voice bleeding out of the speaker at |amp| 0.61.
The ring then replayed 1.74 s of the agent's own speech into Deepgram
as if it were the user: the "1 2 3 … zero" feedback-loop class,
reintroduced through the replay path.

The lesson generalises past that one bug. Bridge-side VAD cannot tell
the user's voice from the agent's — that is exactly why barge detection
moved to the client (v0.424, bargeDetector.ts). So no bridge-side VAD
verdict may authorise sending gated audio to Deepgram, and since ALL
gated audio is by definition pre-barge, the ring has no remaining
purpose and is gone.

What replaced it is Jonathan's own rule, in his words:

    "It might be better from a user standpoint if the audio was clipped
    to synchronize with the barge time that the user hears. So the user
    understands that everything before the barge is detected will be
    discarded, but everything immediately afterwards will be captured."

The client now makes that cut audible (realtime.ts cancelRemotePlayback
ramps the remote output to silence in 25 ms), so the echo stops at the
barge and the bridge only has to bridge the uplink skew
(tts_bridge.HALT_TAIL_GRACE_S). Everything from the cut onward is live
mic audio.

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

    def is_halt_tail(self):
        return False


class _ScriptedBargePolicy:
    """Stand-in for BargePolicy with the same surface _pcm_iter uses.

    Drives the whole scenario off its own feed_frame call count, which
    _pcm_iter invokes exactly once per queued mic frame, in order.
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
        self.peer_id = "test-peer-no-prebarge"
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
async def test_bridge_vad_alone_never_sends_one_gated_byte(monkeypatch):
    """THE round-0 regression, 2026-08-28 11:20:38.

    The bridge's Silero fires during the playback window (here on
    `BARGE`-shaped frames — in the field it was the agent's own voice at
    |amp| 0.61) and the client sends NO barge envelope: the TTS window
    simply ends on its own. Pre-fix, gate release flushed 87 frames /
    1.74 s of that audio into Deepgram. Not one byte of it may go now.
    """
    frames, gs, ge, ba = _scenario()
    _peer, stt = await _drive(frames, gate_start=gs, gate_end=ge,
                              barge_at=ba, monkeypatch=monkeypatch)

    gated_leaked = [c for c in stt.chunks if c in (QUIET, BARGE)]
    assert not gated_leaked, (
        f"{len(gated_leaked)} frames the bridge captured DURING playback "
        "reached Deepgram on bridge-VAD alone — that is the 2026-08-28 "
        "11:20:38 replay, and in the field those frames were the agent's "
        "own voice coming back as a fake user turn"
    )
    # Only the pre-window live audio, the gate's paced silence, and the
    # post-window live audio. Nothing else exists in the stream.
    assert set(stt.chunks) <= {REAL, SILENCE}


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
async def test_the_gate_is_paced_silence_not_a_hole(monkeypatch):
    """Dropping the replay must not turn into dropping the frames: the
    provider still gets one 20 ms frame per mic frame, so Deepgram's
    stream stays paced and its idle timeout never fires mid-reply."""
    frames, gs, ge, ba = _scenario(pre=5, bleed=40, barge=30, post=60)
    _peer, stt = await _drive(frames, gate_start=gs, gate_end=ge,
                              barge_at=ba, monkeypatch=monkeypatch)

    assert len(stt.chunks) == len(frames), (
        "the provider must see exactly one frame per mic frame — no "
        f"holes, no replay padding (got {len(stt.chunks)} for {len(frames)})"
    )
    assert stt.chunks.count(SILENCE) == 70


@pytest.mark.asyncio
async def test_live_speech_after_the_window_reaches_deepgram_unchanged(monkeypatch):
    """The user's post-cut sentence is the half that MUST survive. Every
    live frame, in order, with nothing spliced in ahead of it."""
    frames, gs, ge, ba = _scenario()
    _peer, stt = await _drive(frames, gate_start=gs, gate_end=ge,
                              barge_at=ba, monkeypatch=monkeypatch)

    assert stt.chunks.count(REAL) == 65  # pre=5 + post=60
    assert stt.chunks[-1] == REAL
    # The first frame after the gate is live audio, immediately — the
    # replay used to sit here and push it back by up to 2 s.
    last_silence = len(stt.chunks) - 1 - stt.chunks[::-1].index(SILENCE)
    assert all(c == REAL for c in stt.chunks[last_silence + 1:])
    assert len(stt.chunks) - (last_silence + 1) == 60


@pytest.mark.asyncio
async def test_no_barge_policy_installed_is_harmless(monkeypatch):
    """silero/onnxruntime absent → policy is None. The loop must not
    raise and must still gate."""
    frames, gs, ge, _ = _scenario()
    track = _FakeTtsTrack()

    peer = _FakePeer(track, None)
    peer.extra["barge_policy"] = None
    stt = _RecordingSTT()
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)
    pcm_q: asyncio.Queue = asyncio.Queue()
    for f in frames:
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


@pytest.mark.asyncio
async def test_the_replay_machinery_is_gone_not_just_disabled(monkeypatch):
    """A disabled-by-flag ring is a loaded gun: the next person to read
    `barge replay` in a log will re-enable it. It must not exist."""
    assert not hasattr(stt_bridge, "BARGE_REPLAY_MAX_S")
    assert not hasattr(stt_bridge, "BARGE_REPLAY_MAX_FRAMES")
    assert not hasattr(stt_bridge, "BARGE_REPLAY_PRE_ROLL_FRAMES")
    src = open(
        os.path.join(os.path.dirname(__file__), "..", "stt_bridge.py"),
        encoding="utf-8",
    ).read()
    # The historical log line, as a format string. (The module comment
    # quotes the field journal verbatim, so match the emitting form.)
    assert "peer %s barge replay" not in src, (
        "the replay log line still exists — so does the replay"
    )
