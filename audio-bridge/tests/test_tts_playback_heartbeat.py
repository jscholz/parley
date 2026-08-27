"""Contract for the {type:'tts-playing'} playback heartbeat and for the
"no speakable text, no arming envelope" rule.

Why these exist: the PWA's user-transcript gate (ttsPlaying,
src/audio/realtime/suppress.ts) had exactly one clear — the bridge's
`listening` envelope — and `listening` is EDGE-triggered, announced at
most once per turn boundary. Three live wedges followed from that, all
confirmed by probe against 155c098:

  1. Stream mode: signaling.py only calls tts_bridge.attach for
     mode=='talk', so `tts_track is None`, `tts_active` is permanently
     False, `listening_announced` never re-arms, and `listening` fires
     EXACTLY ONCE — at the first mic frame of the call. The first reply
     delta then latched the client's gate for the rest of the call.
  2. Barge mid-reply: the halt consumes the turn's only `listening`,
     then the aborted reply's remaining deltas re-arm the gate with
     nothing left to clear it.
  3. A reply that sanitizes to empty for TTS (markup/emoji only): the
     assistant DC envelope went out on the RAW delta, arming the gate
     with no TTS round behind it at all.

The heartbeat is the LEVEL signal that bounds the client's gate: it
republishes `tts_track.is_active()`, i.e. the exact boolean this loop
already uses to decide whether mic audio reaches the STT provider. The
client's gate can therefore mirror the bridge's own half-duplex gate
instead of inferring playback from text.

Same fakes/style as test_post_tts_resume.py — plain queues, no aiortc,
no sockets.
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
REAL = (b"\x40\x1f\xc0\xe0" * 160)


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
        self.peer_id = "test-peer-heartbeat"
        self.on_transcript = None
        self.data_channel = _FakeDataChannel()
        self.extra = {} if tts_track is None else {"tts_track": tts_track}


class _Spec:
    options: dict = {}


class _VoiceConfig:
    stt = _Spec()


class _ScriptedSTT:
    """Consumes the pcm iterator and flips the fake TTS track active for
    a scripted window, so the heartbeat sees a real transition."""

    def __init__(self, tts_track, pre_frames, tts_frames):
        self.chunks = []
        self.tts_track = tts_track
        self.pre_frames = pre_frames
        self.tts_frames = tts_frames

    async def stream(self, pcm_iter):
        n = 0
        async for chunk in pcm_iter:
            self.chunks.append(chunk)
            n += 1
            if self.tts_track is None:
                continue
            if n == self.pre_frames:
                self.tts_track.active = True
            elif n == self.pre_frames + self.tts_frames:
                self.tts_track.active = False
        return
        yield  # pragma: no cover — makes this an async generator

    async def aclose(self):
        pass


async def _drive(total_frames, pre_frames, tts_frames, monkeypatch, *, with_track=True):
    track = _FakeTtsTrack() if with_track else None
    peer = _FakePeer(track)
    stt = _ScriptedSTT(track, pre_frames, tts_frames)
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)

    pcm_q: asyncio.Queue = asyncio.Queue()
    for _ in range(total_frames):
        pcm_q.put_nowait(REAL)
    pcm_q.put_nowait(None)
    pump = asyncio.create_task(asyncio.sleep(3600))
    await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    pump.cancel()
    return peer, stt


def _pings(peer):
    return [e for e in peer.data_channel.sent if e.get("type") == "tts-playing"]


@pytest.mark.asyncio
async def test_first_mic_frame_publishes_the_initial_playback_level(monkeypatch):
    """The client may only enforce its playback deadline once it knows
    this bridge tells the truth about playback. That capability
    announcement is the first envelope of every call — including calls
    that never play anything."""
    peer, _ = await _drive(10, 99, 99, monkeypatch)
    pings = _pings(peer)
    assert pings, "every call must publish its playback level on the first mic frame"
    assert pings[0] == {"type": "tts-playing", "active": False}


@pytest.mark.asyncio
async def test_stream_mode_publishes_inactive_even_with_no_tts_track(monkeypatch):
    """Wedge (1). Stream mode has no outbound TTS track at all, and its
    `listening` fires exactly once per CALL — so the client cannot use
    `listening` to reopen a gate that a later delta shut. The heartbeat
    still goes out here (it is emitted from the mic loop, which runs in
    both modes), so the client learns the level and can bound itself."""
    peer, _ = await _drive(10, 99, 99, monkeypatch, with_track=False)
    pings = _pings(peer)
    assert pings and all(p["active"] is False for p in pings)
    listens = [e for e in peer.data_channel.sent if e.get("type") == "listening"]
    assert len(listens) == 1, (
        "documents the deterministic stream-mode wedge: ONE listening for the "
        f"whole call, got {len(listens)}"
    )


@pytest.mark.asyncio
async def test_heartbeat_tracks_the_same_flag_that_gates_mic_to_stt(monkeypatch):
    """active:true while the half-duplex swap is engaged, active:false
    the moment it releases. The client mirrors this, so client gate and
    bridge gate can no longer disagree — which is what every wedge in
    this family has been."""
    PRE, TTS, POST = 5, 20, 30
    peer, stt = await _drive(PRE + TTS + POST, PRE, TTS, monkeypatch)
    pings = _pings(peer)
    levels = [p["active"] for p in pings]
    assert levels[0] is False, "call starts not-playing"
    assert True in levels, "TTS window must publish active:true"
    assert levels[-1] is False, "the TTS window ending must publish active:false"

    # The transition is not merely announced — it matches the frames.
    gated = stt.chunks[PRE:PRE + TTS]
    assert gated and all(c == SILENCE for c in gated)
    assert all(c == REAL for c in stt.chunks[PRE + TTS:])


@pytest.mark.asyncio
async def test_repeats_while_active_so_the_client_deadline_can_be_renewed(monkeypatch):
    """A long reply's text deltas end seconds before its audio does, so
    the gate has to be held open by something other than text. That is
    this repeat. Cadence is TTS_PLAYBACK_PING_S in production; shrunk
    here so the test doesn't sleep."""
    monkeypatch.setattr(stt_bridge, "TTS_PLAYBACK_PING_S", 0.0)
    PRE, TTS, POST = 2, 25, 5
    peer, _ = await _drive(PRE + TTS + POST, PRE, TTS, monkeypatch)
    actives = [p for p in _pings(peer) if p["active"]]
    assert len(actives) >= 5, (
        f"expected a repeating heartbeat through the TTS window, got {len(actives)}"
    )


@pytest.mark.asyncio
async def test_no_ping_storm_at_the_production_cadence(monkeypatch):
    """The flip side: the ping must stay cheap. At 1 s cadence a 25-frame
    (0.5 s of wall-clock-free) TTS window produces the transition pair
    and nothing more — not one envelope per 20 ms mic frame."""
    PRE, TTS, POST = 2, 25, 5
    peer, _ = await _drive(PRE + TTS + POST, PRE, TTS, monkeypatch)
    pings = _pings(peer)
    assert len(pings) <= 4, f"heartbeat must be edge+1Hz, not per-frame; got {len(pings)}"


@pytest.mark.asyncio
async def test_send_failure_retries_on_the_next_frame(monkeypatch):
    """SRTP and SCTP negotiate independently — the first mic frames can
    land before the data channel opens. A failed send must not consume
    the announcement (same contract as listening_announced)."""
    class _LateOpeningChannel(_FakeDataChannel):
        """Reports 'connecting' for the first two reads (the DC is still
        negotiating), 'open' thereafter."""

        def __init__(self):
            super().__init__()
            self._reads = 0

        @property
        def readyState(self):  # noqa: N802 — mirrors the RTCDataChannel field
            self._reads += 1
            return "connecting" if self._reads <= 2 else "open"

    track = _FakeTtsTrack()
    peer = _FakePeer(track)
    peer.data_channel = _LateOpeningChannel()
    stt = _ScriptedSTT(track, 99, 99)
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)

    pcm_q: asyncio.Queue = asyncio.Queue()
    for _ in range(6):
        pcm_q.put_nowait(REAL)
    pcm_q.put_nowait(None)
    pump = asyncio.create_task(asyncio.sleep(3600))
    await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    pump.cancel()
    assert _pings(peer), "the announcement must retry once the channel opens"


# ── Wedge (3): no speakable text, no arming envelope ──────────────────

class _CapturePeer:
    def __init__(self):
        self.peer_id = "test-peer-sanitize"
        self.on_transcript = None
        self.data_channel = _FakeDataChannel()
        self.extra = {}


def _sse(event, payload):
    return [
        f"event: {event}\n".encode(),
        b"data: " + json.dumps(payload).encode() + b"\n",
        b"\n",
    ]


@pytest.mark.asyncio
async def test_markup_only_reply_sends_no_assistant_arming_envelope():
    """Wedge (3). Since cc57300 the PWA uses the assistant DC envelope
    for exactly one thing: arming its suppression gate (rendering is
    SSE-only — main.ts "single render origin"). A reply that sanitizes
    to empty has no TTS round behind it, so arming on it shut the mic
    with nothing able to reopen it. No speakable text, no envelope."""
    peer = _CapturePeer()
    q: asyncio.Queue = asyncio.Queue()
    reader = stt_bridge._ParleyStreamReader(peer, q)
    for line in _sse("reply_delta", {"message_id": "m1", "text": "**✨**"}):
        await reader.process_line(line)

    assistant = [
        e for e in peer.data_channel.sent
        if e.get("type") == "transcript" and e.get("role") == "assistant"
        and not e.get("is_final")
    ]
    assert assistant == [], (
        "a markup/emoji-only delta sanitizes to empty for TTS — it must not "
        f"arm the client's mic gate; got {assistant}"
    )
    assert q.empty(), "and nothing speakable reached the TTS queue either"


@pytest.mark.asyncio
async def test_a_normal_reply_still_arms():
    """The complement — the guard must not silence real replies."""
    peer = _CapturePeer()
    q: asyncio.Queue = asyncio.Queue()
    reader = stt_bridge._ParleyStreamReader(peer, q)
    for line in _sse("reply_delta", {"message_id": "m1", "text": "hello there"}):
        await reader.process_line(line)

    assistant = [
        e for e in peer.data_channel.sent
        if e.get("type") == "transcript" and e.get("role") == "assistant"
    ]
    assert len(assistant) == 1 and assistant[0]["text"] == "hello there"
    assert not q.empty()
