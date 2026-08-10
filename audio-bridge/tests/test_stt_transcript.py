"""Pin the user-transcript forwarding contract in stt_bridge._handle_transcript.

Contract since 9eb5a88 (fix(dictate): next utterance anchors at the
user's moved caret, 2026-08-09):

  - empty FINAL   → FORWARDED. Deepgram's UtteranceEnd arrives as an
    empty final; the PWA's dictate.ts closes out the current utterance
    on it (bakes trailing space, re-anchors the next utterance at the
    user's caret). Pre-9eb5a88 the bridge dropped these as "internal
    sync points", leaving the client's utterance-end branch dead in
    production — the 2026-08-09 field bug where text kept landing at
    the first utterance's caret position.
  - empty INTERIM → skipped. Pure noise; nothing downstream keys on it.
  - non-empty (interim or final) → passes through unchanged as a
    {type:'transcript', role:'user'} envelope.

Tests drive _handle_transcript directly with a fake peer + fake data
channel — no aiortc, no Deepgram.
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from providers import Transcript
from stt_bridge import _handle_transcript


class _FakeDataChannel:
    """Captures every envelope _send_data_channel pushes, decoded."""

    readyState = "open"

    def __init__(self):
        self.sent = []

    def send(self, payload):
        self.sent.append(json.loads(payload))


class _FakePeer:
    """Stand-in for PeerSession; only fields _handle_transcript touches."""

    def __init__(self):
        self.peer_id = "test-peer-12345678"
        self.on_transcript = None
        self.data_channel = _FakeDataChannel()


@pytest.mark.asyncio
async def test_empty_final_forwarded_as_utterance_end_marker():
    """Deepgram UtteranceEnd = empty final → MUST reach the data channel
    with is_final=true and text='' so dictate.ts can re-anchor (9eb5a88)."""
    peer = _FakePeer()
    await _handle_transcript(peer, Transcript(text="", is_final=True))
    assert peer.data_channel.sent == [{
        "type": "transcript",
        "text": "",
        "is_final": True,
        "role": "user",
    }]


@pytest.mark.asyncio
async def test_empty_interim_still_skipped():
    """Empty interims stay dropped — 9eb5a88 opened the gate for empty
    FINALS only."""
    peer = _FakePeer()
    await _handle_transcript(peer, Transcript(text="", is_final=False))
    assert peer.data_channel.sent == []


@pytest.mark.asyncio
async def test_nonempty_interim_passes_through_unchanged():
    peer = _FakePeer()
    await _handle_transcript(peer, Transcript(text="hello wor", is_final=False))
    assert peer.data_channel.sent == [{
        "type": "transcript",
        "text": "hello wor",
        "is_final": False,
        "role": "user",
    }]


@pytest.mark.asyncio
async def test_nonempty_final_passes_through_unchanged():
    """No sanitizing / trimming on the user path — the PWA owns all
    utterance UX; the bridge is pass-through."""
    peer = _FakePeer()
    await _handle_transcript(peer, Transcript(text="hello world.", is_final=True))
    assert peer.data_channel.sent == [{
        "type": "transcript",
        "text": "hello world.",
        "is_final": True,
        "role": "user",
    }]


@pytest.mark.asyncio
async def test_on_transcript_hook_fires_even_for_skipped_empty_interim():
    """The barge/diagnostics hook sees EVERY event; only the data-channel
    forward is gated. Pins that the empty-interim skip sits after the
    hook call, not before it."""
    peer = _FakePeer()
    seen = []

    async def hook(text, is_final):
        seen.append((text, is_final))

    peer.on_transcript = hook
    await _handle_transcript(peer, Transcript(text="", is_final=False))
    await _handle_transcript(peer, Transcript(text="", is_final=True))
    assert seen == [("", False), ("", True)]
    # Data channel got only the empty FINAL.
    assert peer.data_channel.sent == [{
        "type": "transcript", "text": "", "is_final": True, "role": "user",
    }]
