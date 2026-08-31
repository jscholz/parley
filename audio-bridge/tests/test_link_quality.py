"""Contract for the user-facing {type:'link-quality'} envelope.

Jonathan lost a long dictation on a bike ride (2026-08-27) and again at
the airport (2026-08-28 21:45-21:56) talking into a void. The bridge saw
every one of those stalls and told nobody but the journal:

    inbound mic RTP GAP: 4.9s with no frames — uplink stalled;
    Deepgram heard nothing for the duration

His complaint, verbatim: "If it was a real phone call ... I would have
gotten feedback after a minute ... that the audio was weak. And second,
it will eventually come back, and I get a chime to that effect."

Two properties have to hold for that to be worth anything, and they pull
against each other. The envelope has to arrive DURING the stall (the
pre-existing gap log is emitted retroactively, from the frame that ENDS
the gap — by then he has already finished monologuing). And it must not
cry wolf, because an indicator that lies every ninety seconds is one he
will learn to ignore, which is strictly worse than silence.

Same fakes/style as test_transcript_hole_diagnostics.py — plain objects,
no aiortc, no sockets, no sleeping through production thresholds.
"""

import asyncio
import json
import logging
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import stt_bridge


class _FakeDataChannel:
    readyState = "open"

    def __init__(self, witness=None):
        self.sent = []
        self._witness = witness

    def send(self, payload):
        env = json.loads(payload)
        # Stamp each envelope with how much of the track had been
        # consumed when it went out, so a test can prove the envelope
        # left the bridge mid-stall rather than after it.
        if self._witness is not None:
            env["_frames_yielded"] = self._witness()
        self.sent.append(env)


class _FakePeer:
    def __init__(self, witness=None):
        self.peer_id = "test-peer-link-quality"
        self.on_transcript = None
        self.data_channel = _FakeDataChannel(witness)
        self.extra = {}


def _quality(peer):
    return [e for e in peer.data_channel.sent if e.get("type") == "link-quality"]


def _states(peer):
    return [e["state"] for e in _quality(peer)]


def _edges(peer):
    """Collapse the level stream to its transitions — what the user's
    ear and eye actually see, since the CUE is edge-triggered."""
    out = []
    for s in _states(peer):
        if not out or out[-1] != s:
            out.append(s)
    return out


# ── Integration: the pump + watchdog, driven by a scripted track ──────

class _Frame:
    pass


class _NoopResampler:
    """We are testing gap timing, not PCM — produce nothing."""

    def __init__(self, **kw):
        pass

    def resample(self, frame):
        return []


class _ScriptedTrack:
    """Yields frames on a fast cadence, stalling where told.

    `stall_before` maps a frame ordinal to how long recv() should block
    before producing it — i.e. a hole in the inbound RTP stream.
    """

    def __init__(self, total, stall_before, cadence_s=0.005):
        self.total = total
        self.stall_before = stall_before
        self.cadence_s = cadence_s
        self.n = 0

    async def recv(self):
        if self.n >= self.total:
            raise RuntimeError("track ended")
        stall = self.stall_before.get(self.n + 1)
        await asyncio.sleep(stall if stall else self.cadence_s)
        self.n += 1
        return _Frame()


def _shrink(monkeypatch):
    """Production thresholds scaled down ~20x so the suite doesn't sleep
    through them. Ratios (degrade > recover > run-break) are preserved,
    which is what the state machine actually depends on."""
    monkeypatch.setattr(stt_bridge, "LINK_DEGRADED_AFTER_S", 0.20)
    monkeypatch.setattr(stt_bridge, "LINK_RECOVERED_AFTER_S", 0.15)
    monkeypatch.setattr(stt_bridge, "LINK_RUN_BREAK_S", 0.06)
    monkeypatch.setattr(stt_bridge, "LINK_QUALITY_PING_S", 0.05)
    monkeypatch.setattr(stt_bridge, "LINK_WATCHDOG_TICK_S", 0.01)


async def _pump(track, monkeypatch):
    import av.audio.resampler as _res
    monkeypatch.setattr(_res, "AudioResampler", _NoopResampler)
    peer = _FakePeer(witness=lambda: track.n)
    q: asyncio.Queue = asyncio.Queue()
    await stt_bridge._pump_audio(track, q, peer)
    # The watchdog is cancelled in the pump's `finally`; give the loop
    # one turn to actually reap it so a leaked task can't tick into the
    # next test's assertions.
    await asyncio.sleep(0)
    return peer


@pytest.mark.asyncio
async def test_a_long_stall_is_announced_while_it_is_still_happening(monkeypatch):
    """THE point of the feature. A retroactive signal is worthless: he
    needs to know at second three that nobody is hearing him, so he can
    stop and wait instead of spending the next two minutes dictating
    into a void."""
    _shrink(monkeypatch)
    # 8 frames; a 0.5 s hole (>> 0.20 degrade threshold) before frame 4.
    track = _ScriptedTrack(total=8, stall_before={4: 0.5})
    peer = await _pump(track, monkeypatch)

    degraded = [e for e in _quality(peer) if e["state"] == "degraded"]
    assert degraded, (
        "a half-second-scale uplink stall produced no link-quality envelope "
        f"at all; sent={peer.data_channel.sent}"
    )
    first = degraded[0]
    assert first["_frames_yielded"] == 3, (
        "the degraded envelope must leave the bridge DURING the stall "
        "(after frame 3, before frame 4 lands). It went out at frame "
        f"{first['_frames_yielded']} — that is the retroactive behaviour "
        "the RTP GAP log already had, and it is too late to be useful."
    )
    assert first["stalled_s"] >= 0.20


@pytest.mark.asyncio
async def test_a_short_gap_below_threshold_says_nothing(monkeypatch):
    """Eight of the twelve gaps in the airport session were 1.0-2.1 s.
    Those are ordinary bike-and-city hiccups; alerting on them is a
    chime every ninety seconds, which is how you teach someone to ignore
    an indicator. Sub-threshold gaps must be completely silent."""
    _shrink(monkeypatch)
    # 0.12 s hole — a real gap (well past RTP_GAP_LOG_S scale), but
    # under the 0.20 s degrade threshold.
    track = _ScriptedTrack(total=8, stall_before={4: 0.12})
    peer = await _pump(track, monkeypatch)

    assert _quality(peer) == [], (
        "a below-threshold gap cried wolf: "
        f"{_quality(peer)}"
    )


@pytest.mark.asyncio
async def test_recovery_is_announced_exactly_once_when_frames_come_back(monkeypatch):
    """The second half of what he asked for: "it will eventually come
    back, and I get a chime to that effect"."""
    _shrink(monkeypatch)
    # Stall, then ~40 frames at 5 ms = 0.2 s of clean flow (> 0.15 s
    # recovery hold).
    track = _ScriptedTrack(total=45, stall_before={4: 0.5})
    peer = await _pump(track, monkeypatch)

    assert _edges(peer) == ["degraded", "ok"], (
        f"expected one degradation and one recovery, got {_edges(peer)}"
    )
    oks = [e for e in _quality(peer) if e["state"] == "ok"]
    assert len(oks) == 1, f"the recovery must be edge-triggered, got {len(oks)}"


@pytest.mark.asyncio
async def test_persisting_degradation_does_not_re_announce_the_edge(monkeypatch):
    """The envelope is a LEVEL — republished so the client's evidence
    deadline can be renewed — but the user-facing edge happens once.
    A chirp every second through a ten-second dead zone is the failure
    mode this test exists to prevent."""
    _shrink(monkeypatch)
    track = _ScriptedTrack(total=6, stall_before={4: 0.6})
    peer = await _pump(track, monkeypatch)

    assert _edges(peer)[0] == "degraded"
    assert _edges(peer).count("degraded") == 1, (
        f"degradation was re-announced as a new edge: {_edges(peer)}"
    )
    # It IS republished, though — that is what bounds the client.
    repeats = [e for e in _quality(peer) if e["state"] == "degraded"]
    assert len(repeats) >= 2, (
        "the degraded level must be republished while it persists, or the "
        "client's evidence deadline can never be renewed and the indicator "
        f"will self-clear mid-stall; got {len(repeats)}"
    )


@pytest.mark.asyncio
async def test_the_degradation_is_also_named_in_the_journal(monkeypatch, caplog):
    """A user-facing signal that leaves no forensic trace is unanswerable
    when he asks "why did it chime at me"."""
    _shrink(monkeypatch)
    # Long enough after the stall to clear the recovery hold, so both
    # ends of the episode are exercised.
    track = _ScriptedTrack(total=45, stall_before={4: 0.5})
    with caplog.at_level(logging.INFO, logger="stt_bridge"):
        await _pump(track, monkeypatch)
    assert [r for r in caplog.records if "LINK DEGRADED" in r.getMessage()]
    assert [r for r in caplog.records if "LINK RECOVERED" in r.getMessage()]


@pytest.mark.asyncio
async def test_a_call_whose_uplink_never_starts_is_not_a_degradation(monkeypatch):
    """No frame has ever arrived: that is a CONNECT failure, and the call
    state machine already owns and explains it. Reporting "your link
    degraded" on top would be a second, worse story about one event."""
    _shrink(monkeypatch)
    track = _ScriptedTrack(total=0, stall_before={})
    peer = await _pump(track, monkeypatch)
    assert _quality(peer) == []


# ── The state machine, replayed against the real field timeline ───────

def _replay(monitor, gaps, total_s, *, frame_dt=0.02, tick_dt=None):
    """Drive the monitor over a virtual clock.

    Frames arrive every `frame_dt` (20 ms — the nominal Opus cadence)
    except inside a gap. `tick_dt` defaults to the production watchdog
    period. Wall-clock free: nothing sleeps.
    """
    if tick_dt is None:
        tick_dt = stt_bridge.LINK_WATCHDOG_TICK_S
    in_gap = lambda t: any(g0 <= t < g0 + d for (g0, d) in gaps)  # noqa: E731

    events = []
    t = 0.0
    while t < total_s:
        if not in_gap(t):
            events.append((t, "frame"))
        t += frame_dt
    t = tick_dt
    while t < total_s:
        events.append((t, "tick"))
        t += tick_dt
    # Frame before tick at equal timestamps, mirroring _pump_audio
    # (which calls note_frame then tick on the frame it just received).
    events.sort(key=lambda e: (e[0], e[1] == "tick"))

    for (when, kind) in events:
        if kind == "frame":
            monitor.note_frame(when)
        monitor.tick(when)


# The airport session, 2026-08-28 21:45-21:56 — the worst link on
# record and the one that cost him the dictation. Three consecutive
# calls, so three peers, so three independent monitors.
#
# Each entry is (gap_start_offset_s, duration_s), derived from the
# journal's `inbound mic RTP GAP: Ns` lines: the line is written when
# the gap ENDS, so start = end - N. Offsets are relative to a 2 s
# lead-in of clean audio on each call.
AIRPORT = {
    # 21:45:57.596 (3.0s), 21:46:02.637 (4.9s) — note the second gap
    # begins 0.14 s after the first ends. 21:47:42.601 (1.0s),
    # 21:47:46.405 (2.0s).
    "peer1": ([(2.0, 3.0), (5.14, 4.9), (109.0, 1.0), (112.8, 2.0)], 120.0),
    # 21:51:05.512 (2.1s), 21:51:07.608 (1.2s), 21:51:42.746 (4.9s)
    "peer2": ([(2.0, 2.1), (5.0, 1.2), (39.3, 4.9)], 60.0),
    # 21:54:45.925 (2.0s), 21:54:58.973 (2.0s), 21:55:05.685 (3.5s),
    # 21:55:53.958 (1.9s), 21:56:08.627 (1.2s)
    "peer3": ([(2.0, 2.0), (15.0, 2.0), (20.3, 3.5), (68.1, 1.9), (82.8, 1.2)], 95.0),
}


def _run_field(name):
    gaps, total = AIRPORT[name]
    peer = _FakePeer()
    monitor = stt_bridge._LinkQualityMonitor(peer)
    _replay(monitor, gaps, total)
    return peer


def test_airport_session_yields_three_episodes():
    """The dosage test, and the one that justifies the numbers.

    Twelve gaps in eleven minutes: 1.0 1.2 1.2 1.9 2.0 2.0 2.0 2.1 3.0
    3.5 4.9 4.9. Alerting on each is a chime every ~80 s. Alerting on
    none is today's behaviour, which cost him the dictation.

    At LINK_DEGRADED_AFTER_S=3.0 / LINK_RECOVERED_AFTER_S=2.0 the whole
    session collapses to ONE episode per call — three chime-pairs in
    eleven minutes of the worst connectivity we have ever recorded, and
    silence on an ordinary ride.
    """
    per_call = {name: _edges(_run_field(name)) for name in AIRPORT}
    assert per_call == {
        "peer1": ["degraded", "ok"],
        "peer2": ["degraded", "ok"],
        "peer3": ["degraded", "ok"],
    }, f"airport replay changed shape: {per_call}"


def test_the_four_and_nine_second_burst_is_one_episode_not_two():
    """peer1's 3.0 s gap is followed 0.14 s later by a 4.9 s gap. With no
    recovery hold the user gets degraded/ok/degraded/ok — four cues in
    five seconds for what he experienced as one bad patch. The 2 s hold
    is what makes it one episode, and this is the case that sized it."""
    peer = _run_field("peer1")
    q = _quality(peer)
    assert [e["state"] for e in q].count("ok") == 1, (
        "the back-to-back stall burst flapped: "
        f"{[e['state'] for e in q]}"
    )


def test_the_sub_threshold_cluster_is_silent():
    """Eight of the twelve field gaps were 1.0-2.1 s. peer2's first two
    (2.1 s and 1.2 s) and peer3's last two (1.9 s and 1.2 s) must pass
    without a word."""
    for name, gaps in (("peer2", [(2.0, 2.1), (5.0, 1.2)]),
                       ("peer3", [(2.0, 1.9), (16.0, 1.2)])):
        peer = _FakePeer()
        monitor = stt_bridge._LinkQualityMonitor(peer)
        _replay(monitor, gaps, 30.0)
        assert _quality(peer) == [], (
            f"{name}'s sub-threshold cluster cried wolf: {_quality(peer)}"
        )


def test_a_stuttering_link_stays_degraded_rather_than_flapping():
    """Repeated 1.5 s dropouts never reach the 3 s degrade threshold on
    their own, but once we ARE degraded they must keep the indicator up:
    a link dropping a second and a half of speech every few seconds is
    still bad, and blinking amber at him is worse than either state."""
    peer = _FakePeer()
    monitor = stt_bridge._LinkQualityMonitor(peer)
    gaps = [(2.0, 4.0)] + [(8.0 + 3.0 * i, 1.5) for i in range(6)]
    _replay(monitor, gaps, 32.0)
    edges = _edges(peer)
    assert edges[0] == "degraded"
    assert edges.count("degraded") == 1, f"indicator flapped: {edges}"
    assert edges[-1] == "ok", "the stutter ended; recovery must still land"


def test_recovery_requires_a_sustained_run_not_a_single_frame():
    """One frame is not a recovery — it is the jitter buffer coughing.
    Clearing on it would announce "you're back" to a man who is still
    not being heard."""
    peer = _FakePeer()
    monitor = stt_bridge._LinkQualityMonitor(peer)
    # 5 s stall, one 0.5 s island of frames, then another 5 s stall.
    _replay(monitor, [(2.0, 5.0), (7.5, 5.0)], 20.0)
    states = _states(peer)
    assert "ok" not in states[:-1] or states.index("ok") > 0
    edges = _edges(peer)
    assert edges.count("ok") <= 1, f"a 0.5 s island was called recovery: {edges}"
