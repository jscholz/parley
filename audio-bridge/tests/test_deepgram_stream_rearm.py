"""DeepgramSTT must be reusable across reconnects.

`_run_stt` holds ONE provider instance for the whole call and re-enters
`stream()` after every transient close — and Deepgram closing is routine
(its ~10 s idle timeout fires whenever the user simply stops talking).

`self._closed` is the pcm pump's stop flag. Both `aclose()` and the
previous `stream()`'s `finally` set it True, and pre-fix nothing ever set
it back. So the first reconnect of any call produced a stream whose pump
saw `_closed` on its very first chunk, broke immediately, and sent
CloseStream with zero audio. Deepgram replied Metadata and closed; the
`async for raw in ws` loop ended WITHOUT raising; `_run_stt` read that
clean completion as "the audio track is gone" and left its supervisor
loop for good.

Net effect: one idle timeout permanently deafened the rest of the call,
with no error line in the journal — the same failure mode as the
2026-08-23 field bug, re-created one layer below where it was fixed.

Drives the real DeepgramSTT.stream() against a fake `websockets` module.
No network.
"""

import asyncio
import json
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from providers.deepgram import DeepgramSTT

RESULT_FRAME = json.dumps({
    "type": "Results",
    "is_final": True,
    "channel": {"alternatives": [{"transcript": "hello there", "confidence": 0.9}]},
})


class _FakeWS:
    def __init__(self):
        self.sent_audio = []
        self.sent_text = []
        self._inbox = asyncio.Queue()
        self.closed = False

    async def send(self, payload):
        if isinstance(payload, (bytes, bytearray)):
            self.sent_audio.append(bytes(payload))
            # Answer the first audio chunk so the stream yields something.
            if len(self.sent_audio) == 1:
                self._inbox.put_nowait(RESULT_FRAME)
        else:
            self.sent_text.append(payload)
            self._inbox.put_nowait(None)  # CloseStream → end of stream

    async def close(self):
        self.closed = True
        self._inbox.put_nowait(None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self._inbox.get()
        if item is None:
            raise StopAsyncIteration
        return item


class _Spec:
    provider = "deepgram"
    options: dict = {}

    def get_api_key(self):
        return "test-key"


def _install_fake_websockets(monkeypatch, sockets):
    mod = types.ModuleType("websockets")

    async def connect(url, **kwargs):
        ws = _FakeWS()
        sockets.append(ws)
        return ws

    mod.connect = connect
    monkeypatch.setitem(sys.modules, "websockets", mod)


async def _run_one(stt, frames):
    async def pcm():
        for f in frames:
            yield f
            await asyncio.sleep(0)

    out = []
    async for tx in stt.stream(pcm()):
        out.append(tx)
    return out


@pytest.mark.asyncio
async def test_second_stream_after_aclose_still_sends_audio(monkeypatch):
    """THE regression: reconnect #1 must carry audio, not CloseStream."""
    sockets = []
    _install_fake_websockets(monkeypatch, sockets)
    stt = DeepgramSTT(_Spec())

    frames = [b"\x01\x02" * 320] * 5

    first = await _run_one(stt, frames)
    assert [t.text for t in first] == ["hello there"]
    assert len(sockets[0].sent_audio) == 5

    # Exactly what _run_stt does between attempts.
    await stt.aclose()

    second = await _run_one(stt, frames)
    assert len(sockets) == 2, "a second socket should have been opened"
    assert sockets[1].sent_audio, (
        "the reconnected stream sent NO audio — the pcm pump saw a stale "
        "_closed flag and gave up on its first chunk, so the call went "
        "permanently deaf after one routine Deepgram idle timeout"
    )
    assert len(sockets[1].sent_audio) == 5
    assert [t.text for t in second] == ["hello there"]


@pytest.mark.asyncio
async def test_stream_stamps_socket_liveness_for_the_hole_diagnostics(monkeypatch):
    """Every inbound Deepgram frame updates last_message_mono, including
    the ones the parser discards. Without it the STT HOLE warning cannot
    tell a dead socket from a Deepgram that is answering with empty
    transcripts — the ambiguity that left the 2026-08-27 holes
    unattributable."""
    sockets = []
    _install_fake_websockets(monkeypatch, sockets)
    stt = DeepgramSTT(_Spec())
    assert stt.last_message_mono is None
    assert stt.messages_seen == 0

    await _run_one(stt, [b"\x01\x02" * 320] * 3)

    assert stt.messages_seen >= 1
    assert stt.last_message_mono is not None


@pytest.mark.asyncio
async def test_empty_results_still_count_as_socket_liveness(monkeypatch):
    """An empty interim yields no Transcript but IS proof of life."""
    sockets = []
    mod = types.ModuleType("websockets")

    class _EmptyWS(_FakeWS):
        async def send(self, payload):
            if isinstance(payload, (bytes, bytearray)):
                self.sent_audio.append(bytes(payload))
                if len(self.sent_audio) == 1:
                    self._inbox.put_nowait(json.dumps({
                        "type": "Results", "is_final": False,
                        "channel": {"alternatives": [{"transcript": ""}]},
                    }))
            else:
                self.sent_text.append(payload)
                self._inbox.put_nowait(None)

    async def connect(url, **kwargs):
        ws = _EmptyWS()
        sockets.append(ws)
        return ws

    mod.connect = connect
    monkeypatch.setitem(sys.modules, "websockets", mod)

    stt = DeepgramSTT(_Spec())
    out = await _run_one(stt, [b"\x01\x02" * 320] * 3)

    assert out == [], "an empty interim must not surface as a transcript"
    assert stt.messages_seen == 1, "…but it must register as socket liveness"
    assert stt.last_message_mono is not None
