"""Empty-final recovery — Deepgram shows the words, then finalises EMPTY.

Field evidence, airport session 2026-08-28 21:46–21:56 (peer rounds):

    interims=147 finals=47 empty_finals=14
    interims=139 finals=27 empty_finals=11

…roughly 30% of utterances closing empty, and three
"utterance closed EMPTY after N non-empty interims" lines in the
journal. He lost a long dictation to it in-call: "Are you there? That's
a bummer. I just dictated a long summary of day and ended with some
gratitudes…". The same hole ate a sendword on 2026-08-27 and
auto-committed a partial.

Pre-fix the bridge LOGGED the shape and dropped the content. These tests
pin that it now forwards the last non-empty interim as the utterance's
final — exactly once, never fabricated, never doubled.

Same fake-peer style as test_transcript_hole_diagnostics.py — no sockets.
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
        self.peer_id = "test-peer-empty-final"
        self.on_transcript = None
        self.data_channel = _FakeDataChannel()
        self.extra = {"tts_track": tts_track}


class _Spec:
    options: dict = {}


class _VoiceConfig:
    stt = _Spec()


class _ScriptedSTT:
    def __init__(self, script):
        self.script = dict(script)

    async def stream(self, pcm_iter):
        n = 0
        async for _chunk in pcm_iter:
            n += 1
            for tx in self.script.get(n, []):
                yield tx

    async def aclose(self):
        pass


async def _drive(monkeypatch, total, script):
    track = _FakeTtsTrack()
    peer = _FakePeer(track)
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: _ScriptedSTT(script))
    pcm_q: asyncio.Queue = asyncio.Queue()
    for _ in range(total):
        pcm_q.put_nowait(REAL)
    pcm_q.put_nowait(None)
    pump = asyncio.create_task(asyncio.sleep(3600))
    try:
        await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    finally:
        pump.cancel()
    return peer


def _user_finals(peer):
    """Non-empty user finals in wire order — i.e. the WORDS the client
    gets to act on. Empty finals (UtteranceEnd markers) are asserted
    separately where they matter."""
    return [
        e["text"] for e in peer.data_channel.sent
        if e.get("type") == "transcript" and e.get("role") == "user"
        and e.get("is_final") and e.get("text")
    ]


@pytest.mark.asyncio
async def test_empty_final_after_interims_recovers_the_last_interim(monkeypatch, caplog):
    """THE airport bug. Interims showed the words; the utterance closed
    empty; pre-fix the client got nothing it could act on (its dictation
    machine only moves on non-empty finals) and the dictation was lost."""
    caplog.set_level(logging.INFO, logger="stt_bridge")
    script = {
        2: [Transcript(text="I just dictated", is_final=False)],
        3: [Transcript(text="I just dictated a long summary", is_final=False)],
        4: [Transcript(text="I just dictated a long summary of day", is_final=False)],
        5: [Transcript(text="", is_final=True)],  # UtteranceEnd, content eaten
    }
    peer = await _drive(monkeypatch, total=10, script=script)

    finals = _user_finals(peer)
    assert finals == ["I just dictated a long summary of day"], (
        "the last non-empty interim must be forwarded as the utterance's "
        f"final — got {finals}"
    )
    # …and exactly once.
    assert finals.count("I just dictated a long summary of day") == 1

    # The empty end-of-utterance marker still ships (dictate.ts's caret
    # re-anchor depends on it) and lands AFTER the recovered text.
    user_env = [
        e for e in peer.data_channel.sent
        if e.get("type") == "transcript" and e.get("role") == "user"
    ]
    assert user_env[-1]["is_final"] is True and user_env[-1]["text"] == ""

    recovery_lines = [r.getMessage() for r in caplog.records if "RECOVERED utterance" in r.getMessage()]
    assert len(recovery_lines) == 1, f"one measurable line per recovery, got {recovery_lines}"
    assert "after 3 non-empty interims" in recovery_lines[0]

    summaries = [r.getMessage() for r in caplog.records if "transcript summary" in r.getMessage()]
    assert "eaten=1 recovered=1" in summaries[-1], summaries


@pytest.mark.asyncio
async def test_recovered_sendword_reaches_the_client(monkeypatch):
    """The second, independent field failure (2026-08-27): the sendword
    landed in a final that then vanished, so 'over' never reached the
    PWA's matchSendword and a partial auto-committed on the silence
    timer instead. The recovered final must carry the sendword."""
    script = {
        2: [Transcript(text="ship it", is_final=False)],
        3: [Transcript(text="ship it over", is_final=False)],
        4: [Transcript(text="", is_final=True)],
    }
    peer = await _drive(monkeypatch, total=8, script=script)
    assert _user_finals(peer) == ["ship it over"]


@pytest.mark.asyncio
async def test_empty_final_with_no_interims_forwards_nothing(monkeypatch, caplog):
    """A bare UtteranceEnd with no orphaned interims is the NORMAL
    end-of-utterance marker. Recovery must never invent text for it —
    a silent fabrication would be worse than the bug."""
    caplog.set_level(logging.INFO, logger="stt_bridge")
    script = {
        2: [Transcript(text="hello there", is_final=False)],
        3: [Transcript(text="hello there.", is_final=True)],
        4: [Transcript(text="", is_final=True)],   # normal UtteranceEnd
        6: [Transcript(text="", is_final=True)],   # and a bare one
    }
    peer = await _drive(monkeypatch, total=10, script=script)

    assert _user_finals(peer) == ["hello there."], (
        "no synthetic final may be minted for a normal UtteranceEnd"
    )
    assert not [r for r in caplog.records if "RECOVERED utterance" in r.getMessage()]


@pytest.mark.asyncio
async def test_normal_final_is_unchanged_and_not_doubled(monkeypatch):
    """The happy path must be byte-identical: one final in, one final
    out, no recovery, no added envelope."""
    script = {
        2: [Transcript(text="one two", is_final=False)],
        3: [Transcript(text="one two three", is_final=True)],
        4: [Transcript(text="four five", is_final=False)],
        5: [Transcript(text="four five six", is_final=True)],
    }
    peer = await _drive(monkeypatch, total=9, script=script)
    assert _user_finals(peer) == ["one two three", "four five six"]


@pytest.mark.asyncio
async def test_late_final_duplicating_a_recovery_is_suppressed(monkeypatch, caplog):
    """Deepgram's UtteranceEnd can race ahead of a straggling is_final
    for the same segment. Having already recovered those words, we must
    not hand the client the same sentence twice (it would render two
    bubbles and dispatch the text twice). Punctuation/casing differences
    between an interim and its final are expected and must not defeat
    the guard."""
    caplog.set_level(logging.INFO, logger="stt_bridge")
    script = {
        2: [Transcript(text="four five", is_final=False)],
        3: [Transcript(text="four five six", is_final=False)],
        4: [Transcript(text="", is_final=True)],              # recovery fires
        5: [Transcript(text="Four, five, six.", is_final=True)],  # the straggler
    }
    peer = await _drive(monkeypatch, total=9, script=script)

    assert _user_finals(peer) == ["four five six"], (
        f"the same utterance must reach the client once, got {_user_finals(peer)}"
    )
    assert [r for r in caplog.records if "suppressed late final" in r.getMessage()]


@pytest.mark.asyncio
async def test_a_genuinely_new_final_after_a_recovery_still_ships(monkeypatch):
    """The dedup guard is one-shot and content-matched — the NEXT real
    utterance must not be swallowed by it."""
    script = {
        2: [Transcript(text="four five six", is_final=False)],
        3: [Transcript(text="", is_final=True)],          # recovery
        4: [Transcript(text="seven eight", is_final=False)],
        5: [Transcript(text="seven eight nine", is_final=True)],
    }
    peer = await _drive(monkeypatch, total=9, script=script)
    assert _user_finals(peer) == ["four five six", "seven eight nine"]


@pytest.mark.asyncio
async def test_recovery_reaches_the_on_transcript_hook_once(monkeypatch):
    """peer.on_transcript is the in-process consumer (used by the
    dictate/memo paths). It must see the recovered final exactly once,
    with is_final=True — and still see the empty end-marker after it."""
    seen = []

    track = _FakeTtsTrack()
    peer = _FakePeer(track)

    async def _hook(text, is_final):
        seen.append((text, is_final))

    peer.on_transcript = _hook
    script = {
        2: [Transcript(text="gratitudes", is_final=False)],
        3: [Transcript(text="", is_final=True)],
    }
    monkeypatch.setattr(stt_bridge, "get_stt_provider", lambda spec: _ScriptedSTT(script))
    pcm_q: asyncio.Queue = asyncio.Queue()
    for _ in range(6):
        pcm_q.put_nowait(REAL)
    pcm_q.put_nowait(None)
    pump = asyncio.create_task(asyncio.sleep(3600))
    try:
        await stt_bridge._run_stt(peer, _VoiceConfig(), pcm_q, pump)
    finally:
        pump.cancel()

    assert seen == [("gratitudes", False), ("gratitudes", True), ("", True)], seen
