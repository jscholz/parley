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
