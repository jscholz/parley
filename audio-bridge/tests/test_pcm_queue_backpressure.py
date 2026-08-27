"""When the PCM queue overflows, keep the NEWEST audio, not the oldest.

The queue is only drained once the Deepgram WebSocket handshake finishes,
and that handshake is not always fast. Field, 2026-08-27 21:49 (peer
c8e08f57):

    21:49:21.530  frames=1                    ← first mic frame pumped
    21:49:23.53   pcm queue full; dropping frame   (×100+, one line each)
    21:49:26.002  tts-playing -> False        ← first frame actually CONSUMED

4.5 s between the mic starting and the consumer starting. Pre-fix the
queue filled at its 2 s cap and then discarded every subsequent frame, so
what Deepgram finally received was the first 2 s of his sentence followed
by a 2.5 s hole spliced straight onto the resumed audio — "audio in,
nothing sensible out". Dropping the oldest frame instead keeps the
surviving audio contiguous AND recent.

Also pins the log rate limit: the pre-fix version emitted one WARNING per
dropped frame and buried the rest of the journal under 100+ lines.
"""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import stt_bridge


class _FakeResampled:
    def __init__(self, payload):
        self._payload = payload

    def to_ndarray(self):
        class _A:
            def __init__(self, b):
                self._b = b

            def tobytes(self):
                return self._b

        return _A(self._payload)


class _FakeResampler:
    def __init__(self, *a, **kw):
        pass

    def resample(self, frame):
        return [_FakeResampled(frame)]


class _FakeTrack:
    """Emits `payloads` then raises to end the pump (a real track raises
    MediaStreamError when the remote half-closes)."""

    def __init__(self, payloads):
        self._it = iter(payloads)

    async def recv(self):
        try:
            return next(self._it)
        except StopIteration:
            raise RuntimeError("track ended")


@pytest.mark.asyncio
async def test_overflow_drops_oldest_and_keeps_the_newest_audio(monkeypatch):
    import av.audio.resampler as _res
    monkeypatch.setattr(_res, "AudioResampler", _FakeResampler)

    cap = stt_bridge.MAX_PCM_QUEUE
    total = cap + 25          # 25 frames more than the queue can hold
    payloads = [bytes([i % 251 + 1]) * 640 for i in range(total)]

    q: asyncio.Queue = asyncio.Queue(maxsize=cap)
    await stt_bridge._pump_audio(_FakeTrack(payloads), q, "test-peer-backpressure")

    drained = []
    while not q.empty():
        item = q.get_nowait()
        if item is None:
            break
        drained.append(item)

    assert len(drained) == cap, "queue must still respect its cap"
    # The survivors are the LAST `cap` frames the mic produced, in order —
    # contiguous and recent, not a stale prefix.
    assert drained == payloads[-cap:], (
        "overflow discarded the newest audio instead of the oldest: the "
        "audio reaching Deepgram is a stale prefix followed by a hole"
    )


@pytest.mark.asyncio
async def test_overflow_warning_is_rate_limited(monkeypatch, caplog):
    import av.audio.resampler as _res
    monkeypatch.setattr(_res, "AudioResampler", _FakeResampler)

    cap = stt_bridge.MAX_PCM_QUEUE
    payloads = [bytes([1]) * 640] * (cap + 60)
    q: asyncio.Queue = asyncio.Queue(maxsize=cap)

    with caplog.at_level("WARNING", logger="stt_bridge"):
        await stt_bridge._pump_audio(_FakeTrack(payloads), q, "test-peer-ratelimit")

    full_lines = [r for r in caplog.records if "pcm queue full" in r.getMessage()]
    assert len(full_lines) <= 2, (
        f"60 dropped frames produced {len(full_lines)} warnings — the "
        "journal must not be flooded one line per frame"
    )
    assert full_lines, "an overflow must still be reported at least once"
    assert "dropped so far" in full_lines[0].getMessage()
