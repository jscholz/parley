"""A stalled uplink must not churn Deepgram sockets (field 2026-10-18).

The phone's mic track stopped delivering frames while the call stayed
connected. With nothing sent, Deepgram closed the socket after ~10s
(1011 "did not receive audio data …"), the bridge reopened it, and so on
every ~20s — 23 closes in one evening, which the health digest read as a
Deepgram failure. DeepgramSTT now sends KeepAlive text frames while no
audio flows, so one socket waits for audio to resume.

Drives the real DeepgramSTT.stream() against a fake `websockets`. No network.
"""
import asyncio
import json
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import providers.deepgram as dg  # noqa: E402

RESULT = json.dumps({"type": "Results", "is_final": True,
                     "channel": {"alternatives": [{"transcript": "back again", "confidence": 0.9}]}})


class _WS:
    def __init__(self):
        self.audio, self.text = [], []
        self.inbox: asyncio.Queue = asyncio.Queue()

    async def send(self, payload):
        if isinstance(payload, (bytes, bytearray)):
            self.audio.append(bytes(payload))
            self.inbox.put_nowait(RESULT)
        else:
            self.text.append(json.loads(payload)["type"])
            if json.loads(payload)["type"] == "CloseStream":
                self.inbox.put_nowait(None)

    async def close(self):
        self.inbox.put_nowait(None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.inbox.get()
        if item is None:
            raise StopAsyncIteration
        return item


class _Spec:
    provider = "deepgram"
    options: dict = {}

    def get_api_key(self):
        return "k"


@pytest.mark.asyncio
async def test_keepalive_bridges_an_uplink_stall(monkeypatch):
    sockets = []
    mod = types.ModuleType("websockets")

    async def connect(url, **kw):
        ws = _WS(); sockets.append(ws); return ws
    mod.connect = connect
    monkeypatch.setitem(sys.modules, "websockets", mod)
    monkeypatch.setattr(dg, "KEEPALIVE_IDLE_S", 0.05)
    monkeypatch.setattr(dg, "KEEPALIVE_CHECK_S", 0.01)

    async def pcm():
        yield b"\x01" * 640
        await asyncio.sleep(0.3)          # the uplink stalls
        yield b"\x02" * 640               # …and comes back

    stt = dg.DeepgramSTT(_Spec())
    out = [t.text async for t in stt.stream(pcm())]
    assert len(sockets) == 1
    assert sockets[0].text.count("KeepAlive") >= 2, sockets[0].text
    assert sockets[0].text[-1] == "CloseStream"
    assert len(sockets[0].audio) == 2 and out == ["back again", "back again"]


@pytest.mark.asyncio
async def test_no_keepalive_while_audio_flows(monkeypatch):
    sockets = []
    mod = types.ModuleType("websockets")

    async def connect(url, **kw):
        ws = _WS(); sockets.append(ws); return ws
    mod.connect = connect
    monkeypatch.setitem(sys.modules, "websockets", mod)
    monkeypatch.setattr(dg, "KEEPALIVE_IDLE_S", 0.2)
    monkeypatch.setattr(dg, "KEEPALIVE_CHECK_S", 0.01)

    async def pcm():
        for _ in range(15):
            yield b"\x01" * 640
            await asyncio.sleep(0.02)

    stt = dg.DeepgramSTT(_Spec())
    [t async for t in stt.stream(pcm())]
    assert "KeepAlive" not in sockets[0].text
