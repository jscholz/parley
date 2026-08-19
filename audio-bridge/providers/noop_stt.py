"""
No-op STT provider — for smoke tests.

Consumes audio frames silently; never yields a transcript. Lets the
bridge boot without Deepgram credentials when the smoke driver
dispatches user text via the proxy's HTTP composer path instead of
through the mic. The bridge's STT machinery still runs; it just sees
zero transcripts the entire call.

Selected via ``provider: noop`` in the audio-bridge config (or the
PARLEY_AUDIO_STT_PROVIDER=noop env var the smoke harness sets).
Provider name: ``noop``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator

from config import ProviderSpec
from .stt import STTProvider, Transcript, register_stt_provider

logger = logging.getLogger(__name__)


class NoopSTT(STTProvider):
    def __init__(self, _spec: ProviderSpec) -> None:
        pass

    async def stream(self, audio_iter: AsyncIterator[bytes]) -> AsyncIterator[Transcript]:
        # Drain incoming audio frames so the upstream coroutine completes
        # cleanly. Yield nothing — no transcripts ever surface.
        async for _frame in audio_iter:
            await asyncio.sleep(0)
        # Empty generator — must yield at least once for the type
        # checker, but we want zero output, so use an unreachable yield.
        return
        yield  # pragma: no cover

    async def aclose(self) -> None:
        pass


def _factory(spec: ProviderSpec) -> STTProvider:
    return NoopSTT(spec)


register_stt_provider("noop", _factory)
