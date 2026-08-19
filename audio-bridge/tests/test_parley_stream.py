"""Verify the peer-scoped parley-stream subscriber drains every
reply_delta into the TTS text queue, including bubbles that follow a
reply_final within the same user turn (post-tool-call results, ACK +
tool + result patterns).

Pre-fix: stt_bridge._dispatch_to_agent broke the SSE loop on the first
reply_final, so the post-tool-call paragraph arrived as text on the
PWA but was never spoken. Fix is
the _ParleyStreamReader + _run_parley_stream pair, which feeds the
TTS queue for the lifetime of the peer regardless of bubble boundaries.

These tests drive _ParleyStreamReader directly with synthetic SSE
frames — no aiohttp, no real proxy. The reader is the unit under
repair; _run_parley_stream is just the connect / reconnect harness
around it.
"""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from stt_bridge import _ParleyStreamReader


class _FakePeer:
    """Stand-in for PeerSession; only fields the reader touches."""
    def __init__(self):
        self.peer_id = "test-peer-12345678"
        self.on_transcript = None
        self.data_channel = None  # data-channel sends are best-effort no-ops


def _sse_lines(*envelopes):
    """Build raw SSE byte lines from a list of (event_name, payload_dict).

    Mirrors the wire format the proxy emits: ``event: <name>\n`` then
    ``data: <json>\n`` then a blank line per envelope.
    """
    import json
    out = []
    for event, payload in envelopes:
        out.append(f"event: {event}\n".encode())
        out.append(f"data: {json.dumps(payload)}\n".encode())
        out.append(b"\n")
    return out


async def _drain(reader, lines):
    for line in lines:
        await reader.process_line(line)


def _drain_queue(q):
    """Pull every available item without awaiting; keeps the test
    synchronous by checking what was produced after _drain returns."""
    items = []
    while not q.empty():
        items.append(q.get_nowait())
    return items


@pytest.mark.asyncio
async def test_single_bubble_full_turn():
    """Baseline: one reply_delta + one reply_final → one text delta + one
    None sentinel."""
    peer = _FakePeer()
    q = asyncio.Queue()
    reader = _ParleyStreamReader(peer, q)
    lines = _sse_lines(
        ("reply_delta", {
            "type": "reply_delta", "chat_id": "c1",
            "message_id": "msg_a", "text": "Hello world.",
        }),
        ("reply_final", {
            "type": "reply_final", "chat_id": "c1",
            "message_id": "msg_a",
        }),
    )
    await _drain(reader, lines)
    items = _drain_queue(q)
    # Expect: one speakable delta (full text), then None end-of-reply.
    assert items == ["Hello world.", None]


@pytest.mark.asyncio
async def test_multi_bubble_one_turn_all_reach_queue():
    """The bug: bubble-1 → reply_final → bubble-2 (post-tool-call) →
    reply_final. Pre-fix the second bubble never reached the TTS queue.
    Post-fix: both bubbles' deltas appear, separated by None sentinels."""
    peer = _FakePeer()
    q = asyncio.Queue()
    reader = _ParleyStreamReader(peer, q)
    lines = _sse_lines(
        # ACK bubble
        ("reply_delta", {
            "type": "reply_delta", "chat_id": "c1",
            "message_id": "msg_ack", "text": "On it.",
        }),
        ("reply_final", {
            "type": "reply_final", "chat_id": "c1",
            "message_id": "msg_ack",
        }),
        # Tool call envelopes (proxy multiplexes these in; reader ignores)
        ("tool_call", {
            "type": "tool_call", "chat_id": "c1",
            "call_id": "x", "tool_name": "search", "args": {},
        }),
        ("tool_result", {
            "type": "tool_result", "chat_id": "c1",
            "call_id": "x", "tool_name": "search", "result": "...",
        }),
        # Result bubble
        ("reply_delta", {
            "type": "reply_delta", "chat_id": "c1",
            "message_id": "msg_result", "text": "Comms sweep summary: A, B, C.",
        }),
        ("reply_final", {
            "type": "reply_final", "chat_id": "c1",
            "message_id": "msg_result",
        }),
    )
    await _drain(reader, lines)
    items = _drain_queue(q)
    # Both bubble's full text + their respective None sentinels.
    assert items == [
        "On it.",
        None,
        "Comms sweep summary: A, B, C.",
        None,
    ]


@pytest.mark.asyncio
async def test_cumulative_diff_per_message_id():
    """Each reply_delta sends CUMULATIVE text. Reader must emit only the
    new portion, and track the cumulative cursor per-message_id so two
    bubbles with overlapping prefixes don't interfere."""
    peer = _FakePeer()
    q = asyncio.Queue()
    reader = _ParleyStreamReader(peer, q)
    lines = _sse_lines(
        ("reply_delta", {
            "type": "reply_delta", "chat_id": "c1",
            "message_id": "msg_a", "text": "Hello",
        }),
        ("reply_delta", {
            "type": "reply_delta", "chat_id": "c1",
            "message_id": "msg_a", "text": "Hello world",
        }),
        ("reply_delta", {
            "type": "reply_delta", "chat_id": "c1",
            "message_id": "msg_a", "text": "Hello world. How",
        }),
    )
    await _drain(reader, lines)
    items = _drain_queue(q)
    assert items == ["Hello", " world", ". How"]


@pytest.mark.asyncio
async def test_per_msgid_state_isolation():
    """Two bubbles with different message_ids stream interleaved (rare
    but possible). Each gets its own cumulative cursor — bubble-B's
    delta must not be diffed against bubble-A's prefix."""
    peer = _FakePeer()
    q = asyncio.Queue()
    reader = _ParleyStreamReader(peer, q)
    lines = _sse_lines(
        ("reply_delta", {
            "message_id": "msg_a", "text": "Alpha first chunk.",
        }),
        ("reply_delta", {
            "message_id": "msg_b", "text": "Beta different.",
        }),
        ("reply_delta", {
            "message_id": "msg_a", "text": "Alpha first chunk. Second.",
        }),
    )
    await _drain(reader, lines)
    items = _drain_queue(q)
    assert items == [
        "Alpha first chunk.",
        "Beta different.",
        " Second.",
    ]


@pytest.mark.asyncio
async def test_sanitizer_runs_against_cumulative_strip():
    """TTS-bound deltas should have markdown stripped. Sanitizer drift
    between bridge (Python) and PWA (TS) is documented elsewhere; this
    pin keeps the bridge's behavior stable."""
    peer = _FakePeer()
    q = asyncio.Queue()
    reader = _ParleyStreamReader(peer, q)
    lines = _sse_lines(
        ("reply_delta", {
            "message_id": "msg_a", "text": "**Comms sweep** results below:",
        }),
    )
    await _drain(reader, lines)
    items = _drain_queue(q)
    # The sanitizer drops the asterisks before the delta lands in the queue.
    assert items == ["Comms sweep results below:"]


@pytest.mark.asyncio
async def test_idempotent_duplicate_envelope():
    """Proxy occasionally re-broadcasts identical envelopes (replay-ring
    on subscriber reconnect — masked by live_only=1 but defense in depth).
    A duplicate reply_delta must NOT re-emit text into the queue."""
    peer = _FakePeer()
    q = asyncio.Queue()
    reader = _ParleyStreamReader(peer, q)
    lines = _sse_lines(
        ("reply_delta", {"message_id": "msg_a", "text": "Hello world."}),
        ("reply_delta", {"message_id": "msg_a", "text": "Hello world."}),
    )
    await _drain(reader, lines)
    items = _drain_queue(q)
    assert items == ["Hello world."]


@pytest.mark.asyncio
async def test_completed_bubble_state_dropped():
    """After reply_final for a msgid, internal state for that msgid is
    dropped so it doesn't accumulate forever. A re-use of the same msgid
    afterward (unlikely but possible if the agent recycles ids) starts
    fresh — full text flows through, no spurious diff."""
    peer = _FakePeer()
    q = asyncio.Queue()
    reader = _ParleyStreamReader(peer, q)
    lines = _sse_lines(
        ("reply_delta", {"message_id": "msg_a", "text": "First."}),
        ("reply_final", {"message_id": "msg_a"}),
        ("reply_delta", {"message_id": "msg_a", "text": "Recycled."}),
    )
    await _drain(reader, lines)
    items = _drain_queue(q)
    assert items == ["First.", None, "Recycled."]


@pytest.mark.asyncio
async def test_non_reply_envelopes_ignored():
    """typing / tool_call / tool_result / error / session_changed flow
    through the PWA's separate subscriber — the bridge stream consumer
    is audio-only and ignores them."""
    peer = _FakePeer()
    q = asyncio.Queue()
    reader = _ParleyStreamReader(peer, q)
    lines = _sse_lines(
        ("typing", {"chat_id": "c1"}),
        ("tool_call", {"call_id": "x", "tool_name": "y", "args": {}}),
        ("tool_result", {"call_id": "x", "result": "z"}),
        ("session_changed", {"chat_id": "c1", "session_id": "s"}),
        ("reply_delta", {"message_id": "msg_a", "text": "After noise."}),
    )
    await _drain(reader, lines)
    items = _drain_queue(q)
    assert items == ["After noise."]
