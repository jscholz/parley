"""Clamps for the transcript-hole diagnostics (field 2026-08-27).

That night's bike test hit an 11–30 s window, three separate times, in
which real mic audio flowed into the bridge and Deepgram returned
nothing — including both post-barge rounds ("the post-barge dictation
wedge": he spoke for 9–30 s after barging and no utterance ever
dispatched). The logs of the night could not localize it: the bridge
logged only the FIRST transcript per listening round and sampled mic
peaks for one second, so "Deepgram went quiet", "the mic went quiet"
and "the client dropped them" were indistinguishable. These tests pin
the diagnostics that make the next occurrence attributable from the
journal alone:

  1. per-round transcript counters, logged when the round ends
     (next TTS window) AND at stream end (the wedge ended in a hangup —
     a next-round-only summary would skip exactly the round that
     mattered);
  2. the STT-HOLE stall line: voice-level mic audio present but no
     transcript for STALL_AFTER_S;
  3. the "utterance closed EMPTY after N interims" line — Deepgram
     occasionally finalizes a segment its interims had already shown as
     an EMPTY transcript (reproduced live against api.deepgram.com
     during the investigation), silently eating the content and any
     sendword in it.

Same fake-peer style as test_post_tts_resume.py — no sockets.
"""

import asyncio
import json
import logging
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import stt_bridge
from providers import Transcript

SILENCE = bytes(640)
REAL = (b"\x40\x1f\xc0\xe0" * 160)  # peak 8000 — well over STALL_VOICE_PEAK


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


class _FakePeer:
    def __init__(self, tts_track):
        self.peer_id = "test-peer-hole-diag"
        self.on_transcript = None
        self.data_channel = _FakeDataChannel()
        self.extra = {"tts_track": tts_track}


class _Spec:
    options: dict = {}


class _VoiceConfig:
    stt = _Spec()


class _ScriptedSTT:
    """Feeds scripted Transcript events per consumed frame index."""

    def __init__(self, tts_track, script, tts_on=None, tts_off=None):
        self.tts_track = tts_track
        self.script = dict(script)  # frame index -> list[Transcript]
        self.tts_on = tts_on
        self.tts_off = tts_off
        self.chunks = []

    async def stream(self, pcm_iter):
        n = 0
        async for chunk in pcm_iter:
            self.chunks.append(chunk)
            n += 1
            if self.tts_on is not None and n == self.tts_on:
                self.tts_track.active = True
            if self.tts_off is not None and n == self.tts_off:
                self.tts_track.active = False
            for tx in self.script.get(n, []):
                yield tx

    async def aclose(self):
        pass


async def _drive(monkeypatch, total, script, tts_on=None, tts_off=None):
    track = _FakeTtsTrack()
    peer = _FakePeer(track)
    stt = _ScriptedSTT(track, script, tts_on, tts_off)
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)
    pcm_q: asyncio.Queue = asyncio.Queue()
    for _ in range(total):
        pcm_q.put_nowait(REAL)
    pcm_q.put_nowait(None)
    pump = asyncio.create_task(asyncio.sleep(3600))
    await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    return peer, stt


@pytest.mark.asyncio
async def test_round_summary_logged_at_tts_start_and_stream_end(monkeypatch, caplog):
    """Counters cover each listening round and reset between rounds."""
    caplog.set_level(logging.INFO, logger="stt_bridge")
    script = {
        # Listening window 1 (frames 1..9): 2 interims + 1 final.
        3: [Transcript(text="hey", is_final=False)],
        5: [Transcript(text="hey there", is_final=False)],
        7: [Transcript(text="hey there.", is_final=True)],
        # Frames 10..19 are a TTS window; 20.. is round 1 post-TTS,
        # which produces NOTHING (the wedge signature).
    }
    await _drive(monkeypatch, total=40, script=script, tts_on=10, tts_off=20)

    summaries = [r.getMessage() for r in caplog.records if "transcript summary" in r.getMessage()]
    assert len(summaries) == 2, f"expected tts-start + stream-end summaries, got {summaries}"
    assert "(tts-start): interims=2 finals=1 empty_finals=0" in summaries[0]
    # Post-TTS round produced nothing — the summary must SAY so, and the
    # first round's counts must not leak into it.
    assert "round=1" in summaries[1]
    assert "(stream-end): interims=0 finals=0 empty_finals=0" in summaries[1]
    assert "NO TRANSCRIPTS THIS ROUND" in summaries[1]


@pytest.mark.asyncio
async def test_stt_hole_stall_line_fires_on_voice_without_transcripts(monkeypatch, caplog):
    """Voice-level audio + STALL_AFTER_S of transcript silence → one
    rate-limited warning naming the round."""
    caplog.set_level(logging.INFO, logger="stt_bridge")
    # Compress time: stall after 0.2 s, relog every hour (so exactly one
    # line), frames all voice-level.
    monkeypatch.setattr(stt_bridge, "STALL_AFTER_S", 0.2)
    monkeypatch.setattr(stt_bridge, "STALL_RELOG_S", 3600.0)

    real_monotonic = stt_bridge.time.monotonic
    t0 = real_monotonic()
    frames_seen = {"n": 0}

    class _Clock:
        """Advance a fake clock 50 ms per pcm frame consumed."""
        @staticmethod
        def now():
            return t0 + frames_seen["n"] * 0.05

    monkeypatch.setattr(stt_bridge.time, "monotonic", _Clock.now)

    class _CountingSTT(_ScriptedSTT):
        async def stream(self, pcm_iter):
            async for chunk in pcm_iter:
                frames_seen["n"] += 1
                if False:  # pragma: no cover — generator shape
                    yield None

    track = _FakeTtsTrack()
    peer = _FakePeer(track)
    stt = _CountingSTT(track, {})
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)
    pcm_q: asyncio.Queue = asyncio.Queue()
    for _ in range(40):  # 40 frames × 50 ms fake-clock = 2 s ≫ 0.2 s stall
        pcm_q.put_nowait(REAL)
    pcm_q.put_nowait(None)
    pump = asyncio.create_task(asyncio.sleep(3600))
    await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)

    holes = [r for r in caplog.records if "STT HOLE" in r.getMessage()]
    assert len(holes) == 1, f"expected exactly one rate-limited STT HOLE line, got {len(holes)}"
    assert holes[0].levelno == logging.WARNING
    assert "no transcript for" in holes[0].getMessage()


def _stale_voice_scenario(monkeypatch, *, voice_frames, total, dg_last_ago=None):
    """Voice for the first `voice_frames` frames, silence after, on a
    fake clock advancing 50 ms per consumed frame. STALL_AFTER_S is set
    to 2.0 so the stall window only opens LONG after the voice stopped —
    the shape of the 2026-08-28 11:21:06 false positive.

    `dg_last_ago` (seconds) models a Deepgram that is answering.
    """
    monkeypatch.setattr(stt_bridge, "STALL_AFTER_S", 2.0)
    monkeypatch.setattr(stt_bridge, "STALL_RELOG_S", 3600.0)

    t0 = stt_bridge.time.monotonic()
    seen = {"n": 0}
    monkeypatch.setattr(
        stt_bridge.time, "monotonic", lambda: t0 + seen["n"] * 0.05,
    )

    class _LivelySTT:
        def __init__(self):
            self.chunks = []
            self.messages_seen = 78

        @property
        def last_message_mono(self):
            if dg_last_ago is None:
                return None
            return t0 + seen["n"] * 0.05 - dg_last_ago

        async def stream(self, pcm_iter):
            async for chunk in pcm_iter:
                seen["n"] += 1
                self.chunks.append(chunk)
                if False:  # pragma: no cover — generator shape
                    yield None

        async def aclose(self):
            pass

    track = _FakeTtsTrack()
    peer = _FakePeer(track)
    stt = _LivelySTT()
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)
    pcm_q: asyncio.Queue = asyncio.Queue()
    for i in range(total):
        pcm_q.put_nowait(REAL if i < voice_frames else SILENCE)
    pcm_q.put_nowait(None)
    return peer, stt, pcm_q


@pytest.mark.asyncio
async def test_stale_voice_with_a_responsive_deepgram_is_not_a_hole(monkeypatch, caplog):
    """THE cried-wolf regression, walk test 2026-08-28 11:21:06:

        STT HOLE: voice-level mic audio (last 3.6s ago) but no transcript
        for 5.0s (round=2) — deepgram last spoke 0.7s ago (78 frames
        this stream)

    Nothing was wrong. He had stopped talking 3.6 s earlier and Deepgram
    was answering 0.7 s before the line was written. "Voice at some point
    in this listening window" is not the detector's premise — "audio in,
    nothing out" is, and audio 3.6 s ago is not audio in.

    Here: voice stops at 0.5 s (fake clock), the stall window opens at
    2.0 s, so voice is 1.5 s stale — comfortably past
    STALL_VOICE_RECENT_S — while Deepgram answered 0.2 s ago.
    """
    caplog.set_level(logging.INFO, logger="stt_bridge")
    peer, _stt, pcm_q = _stale_voice_scenario(
        monkeypatch, voice_frames=10, total=80, dg_last_ago=0.2,
    )
    pump = asyncio.create_task(asyncio.sleep(3600))
    try:
        await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    finally:
        pump.cancel()

    holes = [r.getMessage() for r in caplog.records if "STT HOLE" in r.getMessage()]
    assert not holes, (
        "warned about a hole that was not there — his voice was long over "
        f"and Deepgram was answering: {holes}"
    )


@pytest.mark.asyncio
async def test_a_responsive_deepgram_does_not_suppress_a_real_hole(monkeypatch, caplog):
    """The tradeoff, pinned. A socket that is alive and answering while
    transcribing CURRENT speech as nothing is a REAL failure — it is one
    of the shapes the detector was built for (see the `dg_state` branch
    in _pcm_iter). So Deepgram liveness must only CLASSIFY the warning,
    never suppress it. A missed real hole costs a whole ride; a rare
    false one costs a log line."""
    caplog.set_level(logging.INFO, logger="stt_bridge")
    # Voice all the way through — the real shape — with Deepgram
    # answering 0.2 s ago the entire time.
    peer, _stt, pcm_q = _stale_voice_scenario(
        monkeypatch, voice_frames=80, total=80, dg_last_ago=0.2,
    )
    pump = asyncio.create_task(asyncio.sleep(3600))
    try:
        await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    finally:
        pump.cancel()

    holes = [r.getMessage() for r in caplog.records if "STT HOLE" in r.getMessage()]
    assert len(holes) == 1, (
        f"the real shape must still warn, got {len(holes)} lines: {holes}"
    )
    assert "deepgram last spoke 0.2s ago (78 frames this stream)" in holes[0], (
        "the liveness readout must still be in the line — it is what "
        "names the guilty layer"
    )


@pytest.mark.asyncio
async def test_no_stall_line_when_transcripts_flow_or_mic_silent(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="stt_bridge")
    monkeypatch.setattr(stt_bridge, "STALL_AFTER_S", 0.0)  # hair trigger
    # Mic frames are pure silence → no voice evidence → no stall line
    # even with the hair trigger (a quiet rider is not an anomaly).
    track = _FakeTtsTrack()
    peer = _FakePeer(track)
    stt = _ScriptedSTT(track, {})
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)
    pcm_q: asyncio.Queue = asyncio.Queue()
    for _ in range(30):
        pcm_q.put_nowait(SILENCE)
    pcm_q.put_nowait(None)
    pump = asyncio.create_task(asyncio.sleep(3600))
    await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    assert not [r for r in caplog.records if "STT HOLE" in r.getMessage()]


@pytest.mark.asyncio
async def test_utterance_closed_empty_after_interims_is_called_out(monkeypatch, caplog):
    """Deepgram showed content in interims, then finalized the segment
    EMPTY (UtteranceEnd with no non-empty final in between) — the
    content-eaten shape reproduced live in the lab. Must be logged; a
    normal non-empty final followed by UtteranceEnd must NOT be."""
    caplog.set_level(logging.INFO, logger="stt_bridge")
    script = {
        # Normal utterance: interims → non-empty final → UtteranceEnd.
        2: [Transcript(text="one two", is_final=False)],
        3: [Transcript(text="one two three", is_final=True),
            Transcript(text="", is_final=True)],
        # Eaten utterance: interims → UtteranceEnd, no non-empty final.
        5: [Transcript(text="four five", is_final=False)],
        6: [Transcript(text="four five six", is_final=False)],
        7: [Transcript(text="", is_final=True)],
    }
    peer, _ = await _drive(monkeypatch, total=12, script=script)

    eaten = [r.getMessage() for r in caplog.records if "closed EMPTY" in r.getMessage()]
    assert len(eaten) == 1, f"expected exactly one eaten-utterance line, got {eaten}"
    assert "after 2 non-empty interims" in eaten[0]
    # Counters classified everything: 3 interims, 1 real final, 2 empty.
    summaries = [r.getMessage() for r in caplog.records if "transcript summary" in r.getMessage()]
    assert "interims=3 finals=1 empty_finals=2" in summaries[-1]


@pytest.mark.asyncio
async def test_inbound_rtp_gap_is_logged(monkeypatch, caplog):
    """A stalled uplink (track.recv() blocking) starves Deepgram of ALL
    audio — invisible pre-fix below Deepgram's ~10 s NET-0001 timeout.
    The pump must log the gap retroactively when frames resume."""
    caplog.set_level(logging.INFO, logger="stt_bridge")
    monkeypatch.setattr(stt_bridge, "RTP_GAP_LOG_S", 0.05)

    class _Frame:
        def to_ndarray(self):
            raise RuntimeError("unused")

    class _GappyTrack:
        def __init__(self):
            self.n = 0

        async def recv(self):
            self.n += 1
            if self.n == 3:
                await asyncio.sleep(0.12)  # the stall (>> RTP_GAP_LOG_S)
            if self.n > 5:
                raise RuntimeError("track ended")
            return _Frame()

    class _NoopResampler:
        def __init__(self, **kw):
            pass

        def resample(self, frame):
            return []  # no pcm out — we only care about gap timing

    import av.audio.resampler as _res
    monkeypatch.setattr(_res, "AudioResampler", _NoopResampler)

    q: asyncio.Queue = asyncio.Queue()
    await stt_bridge._pump_audio(_GappyTrack(), q, "test-peer-gap")

    gaps = [r for r in caplog.records if "RTP GAP" in r.getMessage()]
    assert len(gaps) == 1, f"expected exactly one RTP GAP line, got {len(gaps)}"
    assert gaps[0].levelno == logging.WARNING
