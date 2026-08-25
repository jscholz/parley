"""Pin the STT supervisor's reconnect contract in stt_bridge._run_stt.

Field bug 2026-08-23: a WebRTC reconnect delivered zero mic frames to the
new peer, so Deepgram hit its ~10s idle timeout and closed the socket.
`_run_stt` caught the error, closed the provider and RETURNED — and since
it is spawned exactly once per audio track (guarded by `stt_attached`)
with nothing observing its completion, transcription was dead for the
rest of the call. The peer stayed ICE-connected and the UI kept reading
"Connected" while being completely deaf; 90 seconds of speech were lost
before the client flushed a mid-sentence utterance to the agent.

Contract now:
  - a stream that raises is retried, indefinitely, while the audio pump
    is alive (giving up after N attempts just restores the bug later in
    the call);
  - a stream that ENDS cleanly is not retried — that is the pump's None
    sentinel, i.e. the track is gone;
  - the client is told, so a deaf call can't masquerade as a quiet one.

Drives _run_stt with a fake provider and a plain queue — no aiortc, no
Deepgram, no sockets.
"""

import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import stt_bridge
from providers import Transcript


class _FakeDataChannel:
    readyState = "open"

    def __init__(self):
        self.sent = []

    def send(self, payload):
        self.sent.append(json.loads(payload))


class _FakePeer:
    def __init__(self):
        self.peer_id = "test-peer-reconnect"
        self.on_transcript = None
        self.data_channel = _FakeDataChannel()
        self.extra = {}


class _Spec:
    options: dict = {}


class _VoiceConfig:
    stt = _Spec()


class _FlakySTT:
    """Fails `failures` times, then transcribes one Transcript per frame."""

    def __init__(self, failures):
        self.failures = failures
        self.calls = 0
        self.closed = 0

    async def stream(self, pcm_iter):
        self.calls += 1
        if self.calls <= self.failures:
            raise ConnectionError("received 1011 (internal error) idle timeout")
            yield  # unreachable; makes this an async generator
        async for _chunk in pcm_iter:
            yield Transcript(text="hello", is_final=True)

    async def aclose(self):
        self.closed += 1


def _sent_types(peer):
    return [e.get("type") for e in peer.data_channel.sent]


async def _drive(peer, stt, frames=1):
    """Run _run_stt against a queue holding `frames` frames then the sentinel."""
    pcm_q: asyncio.Queue = asyncio.Queue()
    for _ in range(frames):
        pcm_q.put_nowait(b"\x00" * 640)
    pcm_q.put_nowait(None)
    # A pump that outlives the consumer: _run_stt only retries while the
    # pump is still running, and cancels it on the way out.
    pump = asyncio.create_task(asyncio.sleep(3600))
    await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)


@pytest.mark.asyncio
async def test_transient_close_reconnects_and_keeps_transcribing(monkeypatch):
    peer = _FakePeer()
    stt = _FlakySTT(failures=1)
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)
    monkeypatch.setattr(stt_bridge, "STT_RETRY_BASE_S", 0.0)

    await _drive(peer, stt)

    assert stt.calls == 2, "stream() must be re-opened after a transient close"
    assert any(e.get("type") == "transcript" and e.get("text") == "hello"
               for e in peer.data_channel.sent), "audio after the reconnect is transcribed"


@pytest.mark.asyncio
async def test_repeated_failures_keep_retrying(monkeypatch):
    """No attempt cap — the call must not go permanently deaf partway in."""
    peer = _FakePeer()
    stt = _FlakySTT(failures=4)
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)
    monkeypatch.setattr(stt_bridge, "STT_RETRY_BASE_S", 0.0)

    await _drive(peer, stt)

    assert stt.calls == 5
    # Every dead socket is closed before the next is opened, so the
    # provider's _ws handle can't leak across attempts.
    assert stt.closed >= 4


@pytest.mark.asyncio
async def test_client_is_told_the_stream_died_and_recovered(monkeypatch):
    """A deaf call must be distinguishable from a quiet one."""
    peer = _FakePeer()
    stt = _FlakySTT(failures=1)
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)
    monkeypatch.setattr(stt_bridge, "STT_RETRY_BASE_S", 0.0)

    await _drive(peer, stt)

    types = _sent_types(peer)
    assert "stt-down" in types
    assert "stt-up" in types
    assert types.index("stt-down") < types.index("stt-up")


@pytest.mark.asyncio
async def test_clean_end_does_not_reconnect(monkeypatch):
    """The pump's None sentinel means the track is gone — reopening the
    provider there would spin a socket per call teardown."""
    peer = _FakePeer()
    stt = _FlakySTT(failures=0)
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: stt)
    monkeypatch.setattr(stt_bridge, "STT_RETRY_BASE_S", 0.0)

    await _drive(peer, stt)

    assert stt.calls == 1
    assert "stt-down" not in _sent_types(peer)
