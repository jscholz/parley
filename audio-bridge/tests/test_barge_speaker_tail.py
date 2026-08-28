"""The post-barge SPEAKER TAIL must never reach Deepgram.

Field bug 2026-08-27 23:04 (peer b040d3ef), relay log
/tmp/parley-debug/2026-08-27T22-03-29-dl652e3o.log:

    23:04:23  [webrtc-controls] client-side barge fired — sending upstream
    23:04:24  bridge: first post-TTS transcript (round=2 final=False len=11)
    23:04:25  [dictation] gate reopened — during barge drain: 1 interim/
              1 final — FINALS WERE DROPPED (real speech may be lost)

Deepgram transcribed the user's first post-barge words, the bridge
delivered them, and the PWA threw them away. It threw them away because
it could not tell them apart from ECHO: `halt()` used to flip
`is_active()` False on the very next mic frame, so for the ~400 ms in
which the phone was still emitting the drained TTS out of its speaker,
that audio went straight into Deepgram and came back as a fake user turn
(historically the "1 2 3 4 5 6 7 8 9 zero" loop). The client's only
defence was a blanket 1.5 s transcript drop — which necessarily ate the
user's interrupting words too, i.e. exactly the thing a barge is for.

The fix puts the suppression where the AUDIO is. These tests pin it:

  1. `PCMTrack.halt()` keeps `is_active()` True for HALT_TAIL_GRACE_S,
     so stt_bridge keeps feeding Deepgram paced silence until the last
     contaminated mic frame has drained through.

  2. Not one frame captured inside that window — or anywhere else inside
     the playback gate — is ever handed to Deepgram.

2026-08-28 update. Point 2 used to have an exception: the ef904f3 barge
ring replayed gated audio the bridge's own Silero had attributed to
speech. Round 0 of the 11:20 walk test showed bridge-side Silero firing
on the AGENT's voice (max p_speech 0.993, |amp| 0.6137) with no client
barge at all, and the ring duly replayed 1.74 s of it into Deepgram.
The ring is gone; see audio-bridge/tests/test_barge_no_prebarge_audio.py
for the full account. What pays for the loss is the client muting its
speaker at the barge, which makes the cut audible and lets this window
shrink from 400 ms to 200 ms.

Plain queues and fakes; no aiortc, no sockets. Same style as
test_barge_no_prebarge_audio.py.
"""

import asyncio
import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import stt_bridge
import tts_bridge
from providers import Transcript

SILENCE = bytes(640)
# Distinguishable 640-byte frames so the provider's input stream can be
# read back symbolically.
REAL = b"\x40\x1f\xc0\xe0" * 160     # live mic, gate open
QUIET = b"\x10\x00\xf0\xff" * 160    # gated: speakerphone bleed, user silent
BARGE = b"\x00\x30\x00\xd0" * 160    # gated: the user interrupting
ECHO = b"\x7f\x0a\x81\xf5" * 160     # post-halt: the drained TTS tail


# ── 1. PCMTrack: halt() must not reopen the mic instantly ─────────────

def _bare_track():
    """A PCMTrack without __init__ (which needs aiortc/PyAV, absent from
    the test venv). Only the fields halt()/is_active()/feed() touch."""
    t = tts_bridge.PCMTrack.__new__(tts_bridge.PCMTrack)
    t._frame_queue = asyncio.Queue()
    t._last_nonsilent_at = None
    t._halted_at = None
    t._closed = False
    t.halt_event = asyncio.Event()
    return t


def test_halt_holds_the_gate_shut_for_the_speaker_tail():
    """THE regression. Pre-fix `halt()` cleared `_last_nonsilent_at` and
    nothing else, so the mic→Deepgram path reopened on the next frame —
    while 100-300 ms of TTS was still in the jitter buffer, on its way
    out of the speaker and back into the mic."""
    t = _bare_track()
    t._last_nonsilent_at = time.monotonic()
    assert t.is_active()

    t.halt()
    assert t.is_halt_tail(), "halt() must open a speaker-tail window"
    assert t.is_active(), (
        "the mic→Deepgram gate reopened the instant TTS was halted — the "
        "drained speaker tail goes straight into Deepgram as a fake user turn"
    )


def test_speaker_tail_window_ends_and_the_mic_reopens():
    """The window is a bound, not a latch: it must expire on its own so
    the user's next words are transcribed normally."""
    t = _bare_track()
    t._last_nonsilent_at = time.monotonic()
    t.halt()
    # Rewind past the grace rather than sleeping.
    t._halted_at = time.monotonic() - tts_bridge.HALT_TAIL_GRACE_S - 0.01
    assert not t.is_halt_tail()
    assert not t.is_active(), "the gate must reopen once the tail has drained"


def test_new_audio_supersedes_a_pending_tail():
    """A fresh reply round starting inside the tail is real playback, not
    a drain — the tail must not outlive it or the two windows would
    disagree about what `is_active()` means."""
    t = _bare_track()
    t.halt()
    assert t.is_halt_tail()
    t.feed(b"\x11\x22" * 320)
    assert not t.is_halt_tail()


# ── 2. _pcm_iter: the tail is gated AND never replayed ────────────────

class _FakeDataChannel:
    readyState = "open"

    def __init__(self):
        self.sent = []

    def send(self, payload):
        self.sent.append(json.loads(payload))


class _FakeTtsTrack:
    """Mirrors PCMTrack's post-fix contract: halt() ends playback but
    keeps is_active() True (and is_halt_tail() True) until the tail is
    declared over."""

    def __init__(self):
        self.active = False
        self.halted = False

    def is_active(self, grace_s=None):
        return self.active or self.halted

    def is_halt_tail(self):
        return self.halted

    def halt(self):
        self.active = False
        self.halted = True

    def end_tail(self):
        self.halted = False


class _ScriptedPolicy:
    """Drives the whole scenario off its own feed_frame call count,
    which _pcm_iter invokes exactly once per queued mic frame, in order.

    Note `is_active` stays True across the tail — that is the real
    policy's behaviour (the user is still talking, and Silero's
    min_silence hysteresis is 800 ms, twice the tail), and it is why the
    ring has to be disarmed explicitly rather than left to lapse.
    """

    def __init__(self, track, *, gate_start, barge_at, halt_at, tail_end):
        self.track = track
        self.gate_start = gate_start
        self.barge_at = barge_at
        self.halt_at = halt_at
        self.tail_end = tail_end
        self.is_active = False
        self.n = 0

    def feed_frame(self, frame, tts_active):
        self.n += 1
        # Flips land on the NEXT frame (tts_active is read before this
        # call), matching the real track.
        if self.n == self.gate_start:
            self.track.active = True
        elif self.n == self.halt_at:
            self.track.halt()
        elif self.n == self.tail_end:
            self.track.end_tail()
        if not tts_active:
            self.is_active = False
        elif self.n >= self.barge_at:
            self.is_active = True


class _FakePeer:
    def __init__(self, tts_track, barge_policy):
        self.peer_id = "test-peer-speaker-tail"
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


PRE, BLEED, BARGE_N, TAIL, POST = 5, 20, 20, 20, 30


async def _drive_barge_round(monkeypatch):
    """live → TTS window (bleed, then the user barging) → halt → speaker
    tail → live. The exact shape of the 23:04 field round."""
    frames = (
        [REAL] * PRE + [QUIET] * BLEED + [BARGE] * BARGE_N
        + [ECHO] * TAIL + [REAL] * POST
    )
    track = _FakeTtsTrack()
    policy = _ScriptedPolicy(
        track,
        gate_start=PRE,                          # frame PRE+1 is gated
        barge_at=PRE + BLEED + 1,                # first BARGE frame
        halt_at=PRE + BLEED + BARGE_N,           # frame after → tail
        tail_end=PRE + BLEED + BARGE_N + TAIL,   # frame after → live
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


@pytest.mark.asyncio
async def test_speaker_tail_never_reaches_deepgram(monkeypatch):
    """THE echo-loop guarantee. Not one frame of the drained TTS may be
    transcribed — not live (the gate covers that) and not via the barge
    replay, which pre-fix scooped the tail up because the VAD was still
    reporting speech."""
    _peer, stt = await _drive_barge_round(monkeypatch)

    assert ECHO not in stt.chunks, (
        "the post-halt speaker tail reached Deepgram — it will come back "
        'as a fake user turn (the "1 2 3 ... zero" feedback loop)'
    )
    # And the tail window fed paced silence rather than starving the WSS.
    assert stt.chunks.count(SILENCE) >= TAIL


@pytest.mark.asyncio
async def test_nothing_from_before_the_cut_reaches_deepgram(monkeypatch):
    """Jonathan's rule, stated as an invariant: the ONLY mic audio
    Deepgram sees is what the mic produced with the gate open. Not the
    bleed, not the interrupting words that provoked the barge, not the
    tail — the gate window is silence end to end."""
    _peer, stt = await _drive_barge_round(monkeypatch)

    assert BARGE not in stt.chunks, (
        "pre-barge audio reached Deepgram — everything before the cut is "
        "discarded by design (2026-08-28 rule); the replay that used to "
        "send it is what fed the agent's own voice back on round 0"
    )
    assert QUIET not in stt.chunks, "speakerphone bleed reached Deepgram"
    assert ECHO not in stt.chunks
    assert set(stt.chunks) <= {REAL, SILENCE}
    # The whole gate — bleed, barge and tail — is exactly one paced
    # silence frame per mic frame. No holes, no splices.
    assert stt.chunks.count(SILENCE) == BLEED + BARGE_N + TAIL
    assert len(stt.chunks) == PRE + BLEED + BARGE_N + TAIL + POST


def test_halt_tail_stays_short_enough_to_be_a_cut():
    """The window is pure uplink skew now (U - D + mute ramp ≈ 55–165 ms;
    see the derivation over HALT_TAIL_GRACE_S). Since nothing gated is
    replayed any more, every extra millisecond here is a millisecond of
    the user's post-cut speech deleted — so this must not silently drift
    back up toward the old 400 ms."""
    assert tts_bridge.HALT_TAIL_GRACE_S <= 0.25, (
        f"halt tail grew to {tts_bridge.HALT_TAIL_GRACE_S}s — that is "
        "deleted user speech, not caution"
    )
    assert tts_bridge.HALT_TAIL_GRACE_S >= 0.1, (
        "too short to cover the uplink skew — the agent's own voice will "
        "reach Deepgram"
    )


@pytest.mark.asyncio
async def test_live_speech_resumes_after_the_tail(monkeypatch):
    """The window is bounded — the user's post-barge sentence must be
    transcribed normally once the tail is gone. (This is the half the
    field bug lost at the CLIENT; here we prove the bridge delivers it.)"""
    _peer, stt = await _drive_barge_round(monkeypatch)

    assert stt.chunks.count(REAL) == PRE + POST
    assert stt.chunks[-1] == REAL


@pytest.mark.asyncio
async def test_tail_gate_logs_itself(monkeypatch, caplog):
    """One line per barge, so a future field log can distinguish 'the
    bridge held the gate' from 'the bridge sent nothing'."""
    import logging
    caplog.set_level(logging.INFO, logger="stt_bridge")
    await _drive_barge_round(monkeypatch)

    hits = [r.getMessage() for r in caplog.records
            if "post-barge speaker-tail gate" in r.getMessage()]
    assert len(hits) == 1, (
        "the tail hold must announce itself exactly once per barge, got "
        f"{len(hits)}"
    )
