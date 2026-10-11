"""Batch diarize fallback (2026-10-09): Deepgram's v2 diarizer collapses
quiet meeting audio to a single speaker — a 63-minute four-person
meeting rendered as one Speaker 0 turn, reproduced deterministically on
the same bytes while the default diarizer heard four people. One
speaker over minutes of audio triggers exactly one retry with the
default diarizer; the pass that heard more people wins; short clips and
real multi-speaker results never retry; a failed retry keeps the v2
transcript (the meeting is never lost to the fallback)."""

import pytest

from providers.deepgram import (
    DIARIZE_FALLBACK_MIN_S, DIARIZE_PARAMS_DEFAULT, DIARIZE_PARAMS_V2, DeepgramSTT,
    _parse_diarized_utterances,
)


class _Spec:
    provider = "deepgram"
    options: dict = {}

    def get_api_key(self):
        return "test-key"


def _payload(speakers, duration_s):
    utts = [
        {"speaker": sp, "start": float(i * 10), "transcript": f"turn {i}"}
        for i, sp in enumerate(speakers)
    ]
    return {"metadata": {"duration": duration_s}, "results": {"utterances": utts}}


def _stub(stt, responses):
    """Replace the REST seam; records the params of every call."""
    calls = []

    async def fake(audio, mime, params):
        calls.append(params)
        r = responses[len(calls) - 1]
        if isinstance(r, Exception):
            raise r
        return r

    stt._diarize_request = fake  # type: ignore[method-assign]
    return calls


@pytest.mark.asyncio
async def test_multi_speaker_v2_result_is_final():
    stt = DeepgramSTT(_Spec())
    calls = _stub(stt, [_payload([0, 1, 0, 2], 1500.0)])
    out = await stt.transcribe_diarized(b"audio", "audio/mp4")
    assert calls == [DIARIZE_PARAMS_V2]
    assert {u["speaker"] for u in out} == {0, 1, 2}
    assert stt.last_diarizer == "v2"


@pytest.mark.asyncio
async def test_single_speaker_over_minutes_retries_with_default_and_keeps_the_richer_pass():
    stt = DeepgramSTT(_Spec())
    calls = _stub(stt, [_payload([0] * 40, 3600.0), _payload([0, 1, 2, 3] * 10, 3600.0)])
    out = await stt.transcribe_diarized(b"audio", "audio/mp4")
    assert calls == [DIARIZE_PARAMS_V2, DIARIZE_PARAMS_DEFAULT]
    assert "diarize_model" not in DIARIZE_PARAMS_DEFAULT      # the 400 trap: never both
    assert {u["speaker"] for u in out} == {0, 1, 2, 3}
    assert stt.last_diarizer == "default"


@pytest.mark.asyncio
async def test_retry_that_hears_no_more_people_keeps_v2():
    stt = DeepgramSTT(_Spec())
    _stub(stt, [_payload([0] * 40, 3600.0), _payload([0] * 40, 3600.0)])
    out = await stt.transcribe_diarized(b"audio", "audio/mp4")
    assert len(out) == 40 and stt.last_diarizer == "v2"


@pytest.mark.asyncio
async def test_short_single_speaker_clip_is_a_memo_not_a_failure():
    stt = DeepgramSTT(_Spec())
    calls = _stub(stt, [_payload([0, 0, 0], DIARIZE_FALLBACK_MIN_S - 1)])
    out = await stt.transcribe_diarized(b"audio", "audio/mp4")
    assert len(calls) == 1 and len(out) == 3


@pytest.mark.asyncio
async def test_failed_retry_keeps_the_v2_transcript():
    stt = DeepgramSTT(_Spec())
    _stub(stt, [_payload([0] * 40, 3600.0), RuntimeError("deepgram REST returned 503")])
    out = await stt.transcribe_diarized(b"audio", "audio/mp4")
    assert len(out) == 40 and stt.last_diarizer == "v2"


def test_parse_skips_empty_and_malformed_utterances():
    out = _parse_diarized_utterances({"results": {"utterances": [
        {"speaker": 1, "start": 2.5, "transcript": "  hi   there "},
        {"speaker": 0, "start": 9.0, "transcript": ""},
        {"speaker": "x", "start": 1.0, "transcript": "bad"},
    ]}})
    assert out == [{"speaker": 1, "start": 2.5, "text": "hi there"}]
