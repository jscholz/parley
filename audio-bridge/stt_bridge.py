"""
STT bridge: incoming RTC audio track -> 16 kHz mono int16 PCM -> STTProvider
-> data-channel transcript envelopes.

Per peer:

    pc.ontrack(track)
        |
        +- async pump task
            - frame = await track.recv()           # 48 kHz Opus-decoded
            - resampled = resampler(frame)         # 16 kHz mono int16
            - put(pcm_bytes) onto pcm_queue
        |
        +- async stt task
            - get pcm_bytes off pcm_queue
            - feed STTProvider.stream(pcm_iter)
            - on every Transcript:
                send {type: 'transcript', role: 'user', text, is_final}
                over the peer's data channel.  Pass-through only — no
                buffering, no commit-phrase, no silence timer.  The PWA
                owns all UX logic (utterance buffer, silence timeout,
                commit-phrase, dispatch decision).

    Half-duplex echo guard:

        While TTS is active on this peer's outbound track, mic frames
        are substituted with silence before being handed to Deepgram.
        Stops the speaker→mic bleed of our own TTS from polluting the
        user's transcript without disconnecting the WSS or starving
        Deepgram of paced audio. Pure silence-substitution — barge
        detection is owned entirely by the PWA's client-side
        BargeWindow (since v0.381+), which now ships `{type:'barge'}`
        envelopes upstream over the data channel.

        The window extends past a barge by HALT_TAIL_GRACE_S so the mic
        frames captured just before the client muted its speaker — still
        in flight up the uplink at halt time — can't be transcribed
        either. That makes the guarantee total — echo NEVER reaches STT
        — which is what lets the PWA trust (and render) every transcript
        it receives instead of blanket-dropping user speech for a second
        and a half after every interruption.

        Nothing captured while the gate is shut is ever replayed. See
        the "Why there is no barge-window audio replay" block below.

Dispatch path:

    The PWA decides when to send an utterance to the agent and posts a
    {type: 'dispatch', text} envelope back over the data channel.  The
    bridge's dispatch_listener (in dispatch_listener.py) handles those
    messages and calls _dispatch_to_agent() here, which POSTs to
    ``<proxy_url>/api/<backend>/responses`` and streams the SSE reply
    back over the data channel as assistant transcript envelopes.

    Bridge → proxy → agent: the bridge does NOT POST directly to the
    agent backend.  The parley proxy is the sole parley→agent
    gateway.  proxy_url is stashed on the PeerSession at offer time.
"""

from __future__ import annotations

import array
import asyncio
import logging
import os
import re
import time
from typing import Any, AsyncIterator, Dict, Optional

from config import VoiceConfig
from providers import Transcript, get_stt_provider

logger = logging.getLogger(__name__)

# Target sample rate / format for STT providers (Deepgram nova-3 prefers
# 16 kHz mono int16, plus the local_whisper stub will too).  If a provider
# wants something else, add a per-provider format hint to ProviderSpec
# and resample again — keep this bridge ignorant of provider details.
TARGET_SAMPLE_RATE = 16000
TARGET_LAYOUT = "mono"
TARGET_FORMAT = "s16"

# Cap the audio queue so a slow STT upstream doesn't grow memory
# unboundedly.  20 ms frames * 100 = ~2 s of buffer.
MAX_PCM_QUEUE = 100
# STT reconnect backoff. Base is short because the overwhelmingly common
# close is Deepgram's idle timeout during a natural pause — the user may
# already be talking again by the time we notice. Capped so a persistent
# failure retries slowly instead of hammering the provider.
STT_RETRY_BASE_S = 0.5
STT_RETRY_MAX_S = 8.0

# ── Transcript-hole diagnostics (field 2026-08-27, bike test) ─────────
#
# Three times that night, real mic audio flowed into Deepgram and NO
# transcripts came back for 11–30+ seconds (once mid-monologue, twice
# right after a barge — the post-barge dictation wedge). The logs could
# not localize it: the bridge only logged the FIRST transcript per
# post-TTS round and sampled mic peaks for a single second, so "Deepgram
# went quiet", "the mic went quiet" and "the client dropped them" were
# indistinguishable. Lab replays of the exact stream parameters (clean
# speech → zero-fill gate → speech, including mid-word cuts) show
# Deepgram itself recovering within ~0.9 s — so when the next hole
# happens, these bounded diagnostics have to name the guilty layer:
#
#   • per-round transcript counters (interims / finals / empty finals),
#     logged when the round ends — zeros are the wedge signature;
#   • a stall line when the mic has voice-level audio but no transcript
#     has arrived for STALL_AFTER_S — "audio in, nothing out" pins the
#     STT hop; its absence with a silent mic pins the capture path;
#   • an "utterance closed EMPTY after N interims" line — observed live
#     in the lab: Deepgram occasionally returns a FINAL with an empty
#     transcript for a segment its interims had already shown, which
#     silently eats the content (and any sendword) the interims carried.
#
# Cost: ≤2 INFO lines per reply round + at most one stall line per
# STALL_RELOG_S while the anomaly persists.
STALL_AFTER_S = 5.0
STALL_RELOG_S = 10.0
# How CURRENT the voice evidence has to be. The detector's premise is
# "audio in, nothing out" — so the audio has to still be coming in.
#
# Walk test 2026-08-28 11:21:06 cried wolf on exactly this:
#
#   STT HOLE: voice-level mic audio (last 3.6s ago) but no transcript
#   for 5.0s (round=2) — deepgram last spoke 0.7s ago (78 frames)
#
# Nothing was wrong. He had finished his sentence 3.6 s earlier and
# Deepgram had answered 0.7 s before the line was written. The old test
# was `voice_last_at > anchor` — "voice at ANY point since the window
# opened" — which every normal turn satisfies: speak, stop, wait for the
# reply, and 5 s of legitimate silence trips it.
#
# 1 s: long enough that ordinary inter-word and inter-sentence gaps
# (~200-600 ms) never break the evidence chain, short enough that a
# finished sentence stops counting almost immediately.
#
# Deliberately NOT suppressed on Deepgram socket liveness. A socket that
# is alive and answering while transcribing current speech as nothing is
# one of the REAL failure shapes this detector exists to catch (see the
# `dg_state` branch below, added for precisely that case). Liveness
# CLASSIFIES the warning; it must never veto it. A missed real hole
# costs a whole ride; a rare false one costs a log line.
STALL_VOICE_RECENT_S = 1.0
# Peak (int16) above which a probed frame counts as "voice-level".
# 656/32768 ≈ 0.02 — an order of magnitude over line noise, well under
# any real speech peak seen in the field samples (0.1–0.3).
STALL_VOICE_PEAK = 656
# Probe every Nth frame (20 ms frames → 10 probes/s). Keeps the extra
# per-frame work off the hot path.
STALL_PROBE_EVERY = 5
# Inbound-RTP gap logging (the case the per-frame stall detector CANNOT
# see: when the phone's uplink stalls, track.recv() blocks and NO frames
# arrive at all — Deepgram is fed nothing, transcribes nothing, and
# closes with NET-0001 after ~10 s; below 10 s the stall was completely
# invisible). Logged retroactively when the next frame lands. 20 ms is
# the nominal cadence, so 1 s ≈ 50 missing frames — far beyond jitter.
RTP_GAP_LOG_S = 1.0
# Rate limit for the "pcm queue full" warning (see _pump_audio).
DROP_RELOG_S = 2.0

# ── User-facing link quality ({type:'link-quality'}) ──────────────────
#
# Jonathan, 2026-08-27, after losing minutes of speech on a bike ride:
#
#   "If it was a real phone call, number one, I would have gotten
#    feedback after a minute from WhatsApp or whatever service that the
#    audio was weak. And second, it will eventually come back, and I get
#    a chime to that effect."
#
# The bridge already DETECTED every one of those stalls and told nobody
# but the journal. This is the envelope that closes that loop.
#
# ── Why the RTP gap and NOT the STT hole ─────────────────────────────
# Two detectors live in this file. Only one of them is honest evidence
# about HIS radio link:
#
#   • RTP gap — `track.recv()` produced nothing for N seconds. No
#     packets arrived. "Your connection is weak" is then literally true,
#     and the action it implies ("stop talking and wait") is the correct
#     one. This is the signal we surface.
#   • STT HOLE — mic audio IS arriving but no transcript comes back.
#     The uplink is fine; the fault is at the provider hop. Telling him
#     his connection is weak would be a lie, and stopping talking would
#     not help. It also has a field record of crying wolf (see the
#     2026-08-28 11:21 walk test in STALL_VOICE_RECENT_S's note above) —
#     a heuristic with known false positives is exactly the wrong thing
#     to wire to a chime on a handlebar. It stays a journal diagnostic.
#
# ── Why a watchdog and not the existing gap log ──────────────────────
# The `inbound mic RTP GAP` line is emitted RETROACTIVELY, from the
# frame that ends the gap (see _pump_audio). That is fine for forensics
# and useless for the user: by the time it fires he has already
# finished monologuing into the void. Telling him IN the stall requires
# a timer that fires while `track.recv()` is still blocked, which is
# what _LinkQualityMonitor's watchdog task is for.
#
# ── Thresholds, from the field ───────────────────────────────────────
# Every RTP gap in the airport session (2026-08-28 21:45–21:56, three
# consecutive calls, the worst connectivity on record), in seconds:
#
#   1.0  1.2  1.2  1.9  2.0  2.0  2.0  2.1  3.0  3.5  4.9  4.9
#
# Twelve gaps in eleven minutes. Alerting on all of them is one chime
# every ~80 s, which is how you train someone to ignore a chime — worse
# than silence, and the explicit instruction is to bias against crying
# wolf. The distribution is helpfully bimodal: a dense cluster at
# 1.0–2.1 (8 of 12) and a tail at 3.0+ (4 of 12).
#
# 3.0 s sits in that valley. Below it are the ordinary bike/urban
# hiccups that cost a word or two and resolve themselves; at and above
# it are the stalls that ate a whole clause (~2.5 words/s → a 3 s gap
# is ~7 words, a lost sentence fragment he cannot reconstruct). 3 s is
# also ~150 missing 20 ms frames, far past any jitter-buffer excuse.
LINK_DEGRADED_AFTER_S = 3.0
# How long frames must flow CONTINUOUSLY before we call it recovered.
#
# This is the anti-flap knob, and the field data sizes it exactly. The
# 3.0 s gap ending 21:45:57.596 was followed by the 4.9 s gap ending
# 21:46:02.637 — which therefore STARTED at 21:45:57.7, one tenth of a
# second later. With no recovery hold those two would be one
# degraded/ok/degraded/ok burst in five seconds: four chimes for what
# the user experienced as a single bad patch. A 2 s hold collapses them
# into one episode with one chime at each end.
#
# Replaying the whole airport session through these two numbers yields
# THREE degraded/recovered pairs in eleven minutes of the worst link we
# have ever recorded — roughly one every 3-4 minutes while things are
# genuinely bad, and nothing at all on an ordinary ride. Pinned by
# tests/test_link_quality.py::test_airport_session_yields_three_episodes.
LINK_RECOVERED_AFTER_S = 2.0
# A gap at least this long breaks the "frames are flowing" run and
# re-arms the recovery clock. Shared with RTP_GAP_LOG_S deliberately:
# while we are already degraded, repeated 1 s dropouts mean the link is
# still bad and the indicator should stay up.
LINK_RUN_BREAK_S = RTP_GAP_LOG_S
# Re-send cadence for the degraded envelope while degradation persists.
# The client turns this into a DEADLINE (src/audio/realtime/
# linkQuality.ts LINK_EVIDENCE_DEADLINE_MS, 3 s) so a dead bridge or a
# dropped data channel can never leave the amber indicator stuck on.
# Same idiom, and the same reasoning, as TTS_PLAYBACK_PING_S.
#
# Note this is NOT a repeated user-facing alert: the envelope is a
# level, the CUE is edge-triggered on the client. Costs ~50 bytes/s of
# SCTP, and only while the link is already bad.
LINK_QUALITY_PING_S = 1.0
# Watchdog wake-up period. Fine enough that the degraded edge lands
# within a quarter second of LINK_DEGRADED_AFTER_S (imperceptible
# against a 3 s threshold), coarse enough to be free.
LINK_WATCHDOG_TICK_S = 0.25

# ── Why there is no barge-window audio replay ─────────────────────────
#
# ef904f3 added a ring buffer here: while TTS played, mic frames the
# bridge's own Silero policy attributed to speech were captured and
# replayed into Deepgram at gate release, so an interruption wouldn't
# start mid-word. The walk test of 2026-08-28 11:20 (peer c19f3b6d)
# killed that idea:
#
#   11:20:36.708  barge-policy speech-active (sustained 7 frames, p=0.784)
#   11:20:38.228  tts window ended: fired=True, max p_speech=0.993,
#                 max |amp|=0.6137
#   11:20:38.228  barge replay (gate-release): 87 frames (1.74s) of gated
#                 mic audio flushed to Deepgram ahead of live frames
#
# No `barge halted TTS` line in that round: the CLIENT never barged.
# Jonathan had asked for "a quick reply that I won't interrupt" and then
# stayed quiet. What fired was bridge-side Silero, on the agent's own
# voice bleeding out of the speaker at |amp| 0.61 — and the ring handed
# Deepgram 1.74 s of the agent talking to itself. That is the "1 2 3 …
# zero" feedback loop, re-entering through the replay path.
#
# Bridge-side VAD cannot distinguish the user's voice from the agent's;
# that is precisely why barge detection moved to the client in v0.424
# (src/audio/shared/bargeDetector.ts). So no bridge-side verdict may
# authorise sending gated audio to Deepgram. And every gated frame is by
# definition PRE-barge, which makes the whole ring dead machinery under
# the rule that replaced it (Jonathan, 2026-08-28):
#
#   "It might be better from a user standpoint if the audio was clipped
#    to synchronize with the barge time that the user hears. So the user
#    understands that everything before the barge is detected will be
#    discarded, but everything immediately afterwards will be captured."
#
# What makes that a good trade rather than a loss is the other half of
# the change: the client now MUTES the remote output at the barge
# (realtime.ts cancelRemotePlayback — a 25 ms gain ramp, not an unbind),
# so the cut is audible and the echo stops there. The user hears exactly
# where the transcript resumes. The bridge no longer has to cover 400 ms
# of audible drain, only the uplink skew — see
# tts_bridge.HALT_TAIL_GRACE_S.
#
# Pinned by audio-bridge/tests/test_barge_no_prebarge_audio.py.

# Cadence of the {type:'tts-playing'} playback heartbeat (see
# _pcm_iter). The client turns this into a DEADLINE — its
# user-transcript gate stays shut only while playback evidence keeps
# arriving — so the ping period must sit comfortably under the client's
# TTS_EVIDENCE_DEADLINE_MS (3 s, src/audio/realtime/suppress.ts). 1 s
# tolerates two dropped/late pings and costs ~40 bytes/s of SCTP while
# the agent is speaking, nothing at all while the call is idle.
TTS_PLAYBACK_PING_S = 1.0

# ── Empty-final recovery (field 2026-08-28, airport session) ──────────
#
# Deepgram nova-3 sometimes SHOWS an utterance's words in interim
# results and then closes the utterance with no non-empty final at all.
# The bridge used to log that ("utterance closed EMPTY after N
# non-empty interims") and drop the words on the floor, because the PWA
# only moves its dictation state machine on FINALS. Field rate that
# session: 14 empty finals / 47 finals and 11 / 27 in two rounds —
# roughly 30% of utterances, and he lost a long dictation to it
# ("I just dictated a long summary of day and ended with some
# gratitudes…"). Same hole ate a sendword on 2026-08-27, which
# auto-committed a partial when the "over" landed in a vanished final.
#
# Fix is REACTIVE, not pre-emptive: nothing waits, nothing is delayed.
# When the utterance closes empty we forward the last non-empty interim
# we already have in hand as that utterance's final. Zero added latency
# on the happy path — this code only runs on a shape that was
# previously a total loss.
#
# Duplicate safety: Deepgram's UtteranceEnd can (rarely) race ahead of a
# straggling is_final for the same segment. If a non-empty final lands
# within RECOVERED_FINAL_DEDUP_S carrying the same text we just
# recovered, we suppress it — the client already has those words. The
# window is deliberately short so a genuine repeat ("over … over") a few
# seconds later is never swallowed.
RECOVERED_FINAL_DEDUP_S = 2.0


def _norm_for_dedup(text: str) -> str:
    """Loose comparison key for the recovered-final duplicate guard.

    Deepgram's final for a segment usually differs from its last interim
    only in punctuation/casing ("four five six" → "Four, five, six."),
    so an exact match would miss the very duplicate we're guarding
    against. Strip everything but alphanumerics and single spaces.
    """
    return " ".join(re.sub(r"[^0-9a-z ]+", " ", (text or "").lower()).split())


def _halt_tail_grace_s() -> float:
    """Length of the post-halt gate, for the log line only.

    Lazy import: tts_bridge pulls aiortc/PyAV at module scope and this
    module is importable (and tested) without them.
    """
    try:
        import tts_bridge
        return float(tts_bridge.HALT_TAIL_GRACE_S)
    except Exception:  # pragma: no cover — stubbed tracks in tests
        return 0.0


def attach(peer, *, voice_config: VoiceConfig, api_server: Any = None) -> None:
    """Wire the inbound audio track of *peer* into the configured STT provider.

    Idempotent: if attach() is called twice on the same peer, only the
    first ontrack handler dispatches.  (We rely on aiortc invoking each
    handler exactly once per inbound track; a defensive guard is in the
    handler itself.)
    """
    pc = peer.pc

    @pc.on("track")
    async def _on_track(track):
        if track.kind != "audio":
            logger.debug(
                "[stt-bridge] peer %s ignoring %s track", peer.peer_id, track.kind,
            )
            return
        if peer.extra.get("stt_attached"):
            logger.debug(
                "[stt-bridge] peer %s additional audio track ignored", peer.peer_id,
            )
            return
        peer.extra["stt_attached"] = True

        logger.info(
            "[stt-bridge] peer %s audio track received; starting STT pump",
            peer.peer_id,
        )
        # Two cooperating tasks: the audio pump and the STT consumer.
        pcm_q: "asyncio.Queue[Optional[bytes]]" = asyncio.Queue(maxsize=MAX_PCM_QUEUE)

        pump_task = asyncio.create_task(
            _pump_audio(track, pcm_q, peer),
            name=f"webrtc-pump-{peer.peer_id[:8]}",
        )
        stt_task = asyncio.create_task(
            _run_stt(peer, voice_config, pcm_q, pump_task),
            name=f"webrtc-stt-{peer.peer_id[:8]}",
        )
        peer.stt_task = stt_task
        peer.extra["pump_task"] = pump_task


class _LinkQualityMonitor:
    """Edge-triggered `{type:'link-quality'}` publisher for one peer.

    Owns exactly one bit of user-visible state — is his uplink stalled
    right now — and the hysteresis around it. See the LINK_* constants
    above for the thresholds and the field data behind them.

    Two inputs, one output:

        note_frame(now)  a mic frame landed
        tick(now)        time passed (watchdog, ~4 Hz)
              |
              +-> {'type':'link-quality','state':'degraded'|'ok', ...}

    `tick` is deliberately a plain synchronous method taking an explicit
    `now`, so the whole state machine can be tested by handing it a
    scripted clock instead of sleeping through real thresholds.
    """

    def __init__(
        self,
        peer,
        *,
        degrade_after_s: Optional[float] = None,
        recover_after_s: Optional[float] = None,
        run_break_s: Optional[float] = None,
        ping_s: Optional[float] = None,
    ) -> None:
        self.peer = peer
        # Resolved from module globals HERE rather than as default-arg
        # values, which Python binds once at class-definition time and
        # which monkeypatching the constants therefore cannot reach.
        self.degrade_after_s = (
            LINK_DEGRADED_AFTER_S if degrade_after_s is None else degrade_after_s)
        self.recover_after_s = (
            LINK_RECOVERED_AFTER_S if recover_after_s is None else recover_after_s)
        self.run_break_s = (
            LINK_RUN_BREAK_S if run_break_s is None else run_break_s)
        self.ping_s = LINK_QUALITY_PING_S if ping_s is None else ping_s
        self.degraded = False
        # None until the first frame: a call whose uplink never starts
        # is a CONNECT failure, already owned by the call state machine.
        # Reporting "your link degraded" for it would be a second, worse
        # explanation of the same event.
        self.last_frame_at: Optional[float] = None
        self.healthy_since: Optional[float] = None
        self.last_ping_at = 0.0
        self.degraded_at: Optional[float] = None

    def note_frame(self, now: float) -> None:
        prev = self.last_frame_at
        if prev is None or now - prev >= self.run_break_s:
            # First frame, or a real dropout — the "frames are flowing"
            # run restarts here. While degraded this is what stops a
            # link that keeps stuttering from being called recovered.
            self.healthy_since = now
        self.last_frame_at = now

    def tick(self, now: float) -> None:
        if self.last_frame_at is None:
            return
        stalled_for = now - self.last_frame_at
        if not self.degraded:
            if stalled_for >= self.degrade_after_s:
                self.degraded = True
                self.degraded_at = now
                self.last_ping_at = now
                logger.warning(
                    "[stt-bridge] peer %s LINK DEGRADED: %.1fs with no inbound "
                    "mic frames — telling the client his uplink has stalled",
                    self.peer.peer_id, stalled_for,
                )
                self._send(stalled_for)
            return
        flowing = stalled_for < self.run_break_s
        held = (
            self.healthy_since is not None
            and now - self.healthy_since >= self.recover_after_s
        )
        if flowing and held:
            self.degraded = False
            self.degraded_at = None
            logger.info(
                "[stt-bridge] peer %s LINK RECOVERED: mic frames flowing for "
                "%.1fs", self.peer.peer_id, now - (self.healthy_since or now),
            )
            _send_data_channel(self.peer, {"type": "link-quality", "state": "ok"})
            return
        # Still bad. Republish so the client's evidence deadline can be
        # renewed — a LEVEL, not a repeated alert (the cue is edge-only).
        if now - self.last_ping_at >= self.ping_s:
            self.last_ping_at = now
            self._send(stalled_for)

    def _send(self, stalled_for: float) -> None:
        _send_data_channel(self.peer, {
            "type": "link-quality",
            "state": "degraded",
            # Diagnostic only — the client renders a binary indicator.
            # Present so a "why did it chime" report is answerable.
            "stalled_s": round(stalled_for, 1),
        })


async def _link_quality_watchdog(monitor: "_LinkQualityMonitor") -> None:
    """Drive `monitor.tick` on a timer.

    This task exists because the thing we need to report happens while
    `track.recv()` is BLOCKED — there is no frame to hang the check on,
    which is precisely why the pre-existing gap log could only ever be
    retroactive. Cancelled by _pump_audio's `finally`.
    """
    try:
        while True:
            await asyncio.sleep(LINK_WATCHDOG_TICK_S)
            try:
                monitor.tick(time.monotonic())
            except Exception as e:  # pragma: no cover — never kill the pump
                logger.debug("[stt-bridge] link watchdog tick failed: %s", e)
    except asyncio.CancelledError:
        raise


async def _pump_audio(track, pcm_q: "asyncio.Queue[Optional[bytes]]", peer) -> None:
    """Receive Opus-decoded frames from the inbound track, resample to 16 kHz mono int16, push to the queue."""
    peer_id = peer.peer_id
    try:
        from av.audio.resampler import AudioResampler  # type: ignore
    except ImportError as exc:  # pragma: no cover
        logger.error("[stt-bridge] PyAV missing: %s", exc)
        await pcm_q.put(None)
        return

    resampler = AudioResampler(
        format=TARGET_FORMAT, layout=TARGET_LAYOUT, rate=TARGET_SAMPLE_RATE,
    )
    frames_seen = 0
    bytes_pushed = 0
    started = time.time()
    last_frame_at: Optional[float] = None
    frames_dropped = 0
    last_drop_log_at = 0.0
    # User-facing half of the same observation the gap log below makes.
    # The watchdog is what can speak DURING a stall; note_frame here is
    # what ends one.
    link = _LinkQualityMonitor(peer)
    peer.extra["link_monitor"] = link
    watchdog = asyncio.create_task(
        _link_quality_watchdog(link),
        name=f"link-quality-{peer_id[:8]}",
    )
    try:
        while True:
            frame = await track.recv()
            now_mono = time.monotonic()
            link.note_frame(now_mono)
            link.tick(now_mono)
            if last_frame_at is not None and now_mono - last_frame_at >= RTP_GAP_LOG_S:
                logger.warning(
                    "[stt-bridge] peer %s inbound mic RTP GAP: %.1fs with no "
                    "frames (frame %d) — uplink stalled; Deepgram heard "
                    "nothing for the duration",
                    peer_id, now_mono - last_frame_at, frames_seen + 1,
                )
            last_frame_at = now_mono
            frames_seen += 1
            for resampled in resampler.resample(frame):
                # av AudioFrame.to_ndarray() => int16 array shaped (channels, samples)
                pcm = resampled.to_ndarray().tobytes()
                if not pcm:
                    continue
                bytes_pushed += len(pcm)
                # If the queue is full, drop frames rather than blocking
                # the audio pump (which would also block aiortc).  In
                # practice the consumer should keep up; this guard is
                # for the case where Deepgram's WS is unreachable.
                try:
                    pcm_q.put_nowait(pcm)
                except asyncio.QueueFull:
                    # Drop the OLDEST frame, not the newest. The consumer
                    # only starts draining once the Deepgram WS handshake
                    # completes, and that handshake is not always fast:
                    # on 2026-08-27 21:49 (peer c8e08f57) it took 4.5 s,
                    # during which this queue filled at 2 s and then
                    # discarded every subsequent frame — so the audio
                    # Deepgram eventually received was the FIRST 2 s
                    # followed by a 2.5 s hole, and the words either side
                    # of the hole were spliced into nonsense. Sliding the
                    # window keeps the most RECENT audio, which is both
                    # contiguous and the part still worth transcribing.
                    frames_dropped += 1
                    try:
                        pcm_q.get_nowait()
                        pcm_q.put_nowait(pcm)
                    except (asyncio.QueueEmpty, asyncio.QueueFull):  # pragma: no cover
                        pass
                    # One line per burst, not one per frame: the pre-fix
                    # version emitted 100+ WARNINGs per stall and buried
                    # everything else in the journal.
                    if now_mono - last_drop_log_at >= DROP_RELOG_S:
                        logger.warning(
                            "[stt-bridge] peer %s pcm queue full — STT "
                            "consumer not draining (provider still "
                            "connecting?); %d frames (%.1fs of audio) "
                            "dropped so far, keeping the newest",
                            peer_id, frames_dropped, frames_dropped * 0.02,
                        )
                        last_drop_log_at = now_mono
            if frames_seen in (1, 50, 250):
                elapsed = time.time() - started
                logger.info(
                    "[stt-bridge] peer %s frames=%d bytes=%d elapsed=%.1fs",
                    peer_id, frames_seen, bytes_pushed, elapsed,
                )
    except asyncio.CancelledError:
        raise
    except Exception as e:
        # MediaStreamError on track end is normal; aiortc raises it when
        # the remote half-closes.  Log debug, not warning.
        logger.debug("[stt-bridge] peer %s pump exit: %s", peer_id, e)
    finally:
        watchdog.cancel()
        # Sentinel so the consumer can exit.
        try:
            pcm_q.put_nowait(None)
        except asyncio.QueueFull:
            pass


async def _run_stt(
    peer,
    voice_config: VoiceConfig,
    pcm_q: "asyncio.Queue[Optional[bytes]]",
    pump_task: asyncio.Task,
) -> None:
    """Consume the PCM queue, drive the STT provider, forward transcripts to the data channel."""
    # Per-peer keyterm biasing: the PWA stashed its IDB-backed list onto
    # peer.extra in signaling.handle_offer. Merge into the configured
    # provider's options for THIS peer only, so two simultaneous users
    # with different vocabularies don't clobber each other. Empty list
    # → use the spec as-is (bridge defaults).
    base_spec = voice_config.stt
    peer_keyterms = peer.extra.get("keyterms") or []
    if peer_keyterms:
        from dataclasses import replace
        merged_options = dict(base_spec.options)
        # Dedup case-insensitive while preserving caller order; the PWA
        # already dedups, but a user-edited config + PWA list could
        # overlap.
        existing_lc = {str(t).strip().lower() for t in merged_options.get("keyterms", []) or []}
        existing = list(merged_options.get("keyterms", []) or [])
        for t in peer_keyterms:
            if t.lower() not in existing_lc:
                existing.append(t)
                existing_lc.add(t.lower())
        merged_options["keyterms"] = existing
        spec = replace(base_spec, options=merged_options)
        logger.info(
            "[stt-bridge] peer %s keyterms=%d (peer=%d, base=%d)",
            peer.peer_id, len(existing), len(peer_keyterms),
            len(base_spec.options.get("keyterms", []) or []),
        )
    else:
        spec = base_spec
    stt = get_stt_provider(spec)

    # Frame of pure silence at the same shape the mic produces (16 kHz
    # mono int16, 20 ms = 640 bytes). Substituted for the real mic
    # frame whenever TTS is currently playing on this peer's outbound
    # track, so Deepgram sees clean silence instead of the speakerphone
    # echo of our own TTS — kills the iOS Safari feedback loop without
    # disconnecting the WSS or starving Deepgram of paced audio.
    silence_frame = bytes(640)

    async def _pcm_iter() -> AsyncIterator[bytes]:
        tts_track = peer.extra.get("tts_track")
        # Bridge-side BargePolicy — set in attach() if silero-vad is
        # available. Fed every mic frame here BEFORE the half-duplex
        # silence-swap so the policy sees real audio during tts_active
        # windows. Falls through (None) when silero-vad isn't installed
        # or attach() hasn't run for this peer; bridge-side barge is
        # then a no-op and the client's BargeDetector remains the only
        # source. See audio-bridge/barge_policy.py.
        barge_policy = peer.extra.get("barge_policy")
        was_active = False
        # Post-TTS frame-level evidence (field bug 2026-08-26): the
        # "resuming mic→Deepgram" line only proves the Boolean gate
        # cleared. These counters prove FRAMES: on every TTS-end
        # transition we sample the next ~1s (50 frames) of real mic
        # audio and log its peak amplitude once — silence (peak≈0)
        # means the CLIENT stopped producing audio; a healthy peak with
        # no transcripts points at the STT hop instead. Round index +
        # first-transcript flag live on peer.extra so _handle_transcript
        # can log the first post-TTS transcript per round. One or two
        # INFO lines per reply round — bounded.
        post_tts_sample_left = 0
        post_tts_peak = 0
        # Whether we've already announced "STT pipe is hot" for this
        # turn boundary. Flips True on the first frame the bridge
        # actually accepts into Deepgram (call-start AND every TTS-end
        # transition); resets when TTS goes active again. Drives the
        # `{type: 'listening'}` envelope so the PWA can chime "your
        # turn." Without this, listening would either fire on every
        # frame (spam) or only at call-start (one-shot, useless for
        # multi-turn calls).
        listening_announced = False
        # ── Playback heartbeat ({type:'tts-playing'}) ────────────────
        # `listening` is EDGE-triggered and fires at most once per turn
        # boundary, which is why the client's ttsPlaying gate could get
        # latched with nothing to unlatch it (field bug 2026-08-26 and
        # the three follow-on wedges: stream mode never gets a second
        # `listening` at all, a barge consumes the turn's only one, and
        # a reply that sanitizes to empty produces no TTS round behind
        # the arming delta). This ping is the LEVEL signal that closes
        # all three: it publishes `tts_track.is_active()` — the exact
        # boolean this loop already uses to decide whether mic audio
        # reaches Deepgram — so the client's gate can mirror the
        # bridge's own half-duplex gate instead of guessing from text.
        #
        # Emission policy: on every change, plus a repeat every
        # TTS_PLAYBACK_PING_S while active. `last_playback_sent`
        # starts as None so the FIRST mic frame of every call publishes
        # the initial state; that first envelope doubles as the
        # capability announcement the client needs before it may
        # enforce its deadline (an older bridge sends none, and the
        # client then keeps its pre-existing unbounded behavior rather
        # than risking an unsuppress mid-playback).
        #
        # Send failures don't advance the state, so a not-yet-open data
        # channel simply retries on the next frame — same contract as
        # listening_announced above.
        last_playback_sent: Optional[bool] = None
        last_playback_sent_at = 0.0
        # Transcript-hole stall detector state (see STALL_AFTER_S).
        # `resumed_at` anchors the "no transcripts since" clock at the
        # start of each listening window; `voice_last_at` is refreshed
        # by the 10 Hz peak probe whenever the mic carries voice-level
        # audio. Voice after the anchor + STALL_AFTER_S of transcript
        # silence = the smoking-gun line tonight's logs were missing.
        resumed_at: Optional[float] = None
        voice_last_at = 0.0
        stall_logged_at = 0.0
        probe_i = 0
        # Whether we've already logged the post-halt speaker-tail hold
        # for the current tail window (one line per barge, not per frame).
        halt_tail_logged = False

        while True:
            chunk = await pcm_q.get()
            if chunk is None:
                return
            tts_active = tts_track is not None and tts_track.is_active()
            # Post-halt speaker tail (tts_bridge.HALT_TAIL_GRACE_S): the
            # barge stopped synthesis and the client muted its speaker,
            # but mic frames captured just BEFORE that mute are still in
            # flight up the uplink and still carry the agent's voice.
            # `is_active()` covers that window too, so the gate below
            # keeps them out of Deepgram. Probed separately from
            # is_active() only so the hold can log itself once per barge.
            # getattr keeps older/stubbed tracks (and stream mode's None)
            # working.
            halt_tail = False
            if tts_active:
                probe = getattr(tts_track, "is_halt_tail", None)
                if probe is not None:
                    try:
                        halt_tail = bool(probe())
                    except Exception:  # pragma: no cover — defensive
                        halt_tail = False
            now_mono = time.monotonic()
            if (tts_active != last_playback_sent
                    or (tts_active
                        and now_mono - last_playback_sent_at >= TTS_PLAYBACK_PING_S)):
                if _send_data_channel(peer, {"type": "tts-playing", "active": tts_active}):
                    if tts_active != last_playback_sent:
                        logger.info(
                            "[stt-bridge] peer %s tts-playing -> %s",
                            peer.peer_id, tts_active,
                        )
                    last_playback_sent = tts_active
                    last_playback_sent_at = now_mono
            # Feed the BargePolicy regardless of tts_active — the policy's
            # own gate uses the flag to enable Silero only during the
            # agent-speaking window AND to reset hysteresis cleanly when
            # TTS ends. Cheap call when silero isn't loaded (None branch).
            if barge_policy is not None:
                try:
                    barge_policy.feed_frame(chunk, tts_active)
                except Exception as e:  # pragma: no cover
                    logger.warning(
                        "[stt-bridge] peer %s barge_policy.feed_frame raised: %s",
                        peer.peer_id, e,
                    )
            if tts_active:
                if not was_active:
                    logger.info(
                        "[stt-bridge] peer %s: gating mic→Deepgram (TTS active)",
                        peer.peer_id,
                    )
                    was_active = True
                    # The listening round that just ended: say what the
                    # STT hop produced for it (zeros = the wedge shape).
                    _log_round_tx_summary(peer, "tts-start")
                    resumed_at = None
                    halt_tail_logged = False
                if halt_tail and not halt_tail_logged:
                    # One line per barge, so a field log can distinguish
                    # "the bridge held the gate for the skew" from "the
                    # bridge sent nothing".
                    halt_tail_logged = True
                    logger.info(
                        "[stt-bridge] peer %s post-barge speaker-tail "
                        "gate: mic→Deepgram held shut for %.2fs while the "
                        "pre-mute mic frames still in flight drain, so the "
                        "agent's own voice cannot be transcribed as a fake "
                        "user turn (round=%s)",
                        peer.peer_id, _halt_tail_grace_s(),
                        peer.extra.get("post_tts_round"),
                    )
                # Half-duplex echo guard: substitute silence so Deepgram
                # doesn't get fed the speakerphone bleed of our own TTS.
                # Nothing captured here is ever replayed — see the
                # "Why there is no barge-window audio replay" block above.
                # Barge detection is owned by the PWA's BargeDetector
                # ({type:'barge'} envelope over the data channel); see
                # src/audio/realtime/realtimeBarge.ts.
                yield silence_frame
                # While TTS is active we are NOT listening, so re-arm
                # the listening announcement for the next user turn.
                listening_announced = False
                continue
            if was_active:
                logger.info(
                    "[stt-bridge] peer %s: resuming mic→Deepgram (TTS done)",
                    peer.peer_id,
                )
                was_active = False
                # Arm the post-TTS frame sampler + transcript probe for
                # this resume (one round = one TTS-active window).
                round_idx = int(peer.extra.get("post_tts_round") or 0) + 1
                peer.extra["post_tts_round"] = round_idx
                peer.extra["post_tts_first_tx_logged"] = False
                post_tts_sample_left = 50
                post_tts_peak = 0
                halt_tail_logged = False
            if resumed_at is None:
                # First forwarded frame of a listening window (call
                # start or post-TTS resume) — anchor the stall clock.
                resumed_at = now_mono
                stall_logged_at = 0.0
            # ── Stall detector: voice-level mic audio with no
            # transcripts for STALL_AFTER_S. 10 Hz peak probe keeps the
            # per-frame cost negligible; the log is rate-limited to one
            # line per STALL_RELOG_S while the anomaly persists.
            probe_i += 1
            if probe_i % STALL_PROBE_EVERY == 0:
                try:
                    samples = array.array("h", chunk[: len(chunk) - (len(chunk) % 2)])
                    if samples and max(max(samples), -min(samples)) >= STALL_VOICE_PEAK:
                        voice_last_at = now_mono
                except Exception:  # pragma: no cover — diag only
                    pass
            anchor = max(peer.extra.get("last_tx_mono") or 0.0, resumed_at)
            if (
                voice_last_at > anchor
                # …and the voice is STILL arriving, not a memory of a
                # sentence he finished before the reply (STALL_VOICE_RECENT_S).
                and now_mono - voice_last_at <= STALL_VOICE_RECENT_S
                and now_mono - anchor >= STALL_AFTER_S
                and now_mono - stall_logged_at >= STALL_RELOG_S
            ):
                stall_logged_at = now_mono
                # Socket liveness vs. transcript liveness are DIFFERENT
                # failures and pre-fix this line could not tell them
                # apart: the provider drops every empty Results frame
                # before the bridge sees it, so a Deepgram that is
                # answering once a second — but transcribing his speech
                # as nothing — looked identical to a dead socket. The
                # provider now stamps every inbound frame; report it.
                dg_last = getattr(stt, "last_message_mono", None)
                if dg_last is None:
                    dg_state = "deepgram has sent NOTHING on this stream"
                else:
                    dg_state = (
                        f"deepgram last spoke {now_mono - dg_last:.1f}s ago "
                        f"({getattr(stt, 'messages_seen', 0)} frames this stream)"
                    )
                logger.warning(
                    "[stt-bridge] peer %s STT HOLE: voice-level mic audio "
                    "(last %.1fs ago) but no transcript for %.1fs "
                    "(round=%s) — audio in, nothing out of Deepgram; %s",
                    peer.peer_id, now_mono - voice_last_at,
                    now_mono - anchor, peer.extra.get("post_tts_round") or 0,
                    dg_state,
                )
            if post_tts_sample_left > 0:
                try:
                    import array as _array
                    samples = _array.array("h", chunk[: len(chunk) - (len(chunk) % 2)])
                    if samples:
                        post_tts_peak = max(post_tts_peak, max(samples), -min(samples))
                except Exception:  # pragma: no cover — diag only
                    pass
                post_tts_sample_left -= 1
                if post_tts_sample_left == 0:
                    peer.extra["post_tts_peak"] = post_tts_peak
                    logger.info(
                        "[stt-bridge] peer %s post-TTS mic sample: round=%s "
                        "peak=%.3f over 50 frames (~1s) — %s",
                        peer.peer_id, peer.extra.get("post_tts_round"),
                        post_tts_peak / 32768.0,
                        "real audio flowing" if post_tts_peak > 100 else "SILENCE (client mic stalled?)",
                    )
            # First mic frame after a TTS-active window (or the first
            # frame of the call entirely): announce listening so the
            # PWA can chime "your turn." Idempotent within a single
            # user-turn — the `listening_announced` flag prevents
            # re-firing on every frame.
            if not listening_announced:
                # WebRTC audio (SRTP) and data channel (SCTP) negotiate
                # independently; the first audio frame can arrive before
                # the DC reaches readyState=='open'. Only set the flag
                # after a successful send so a too-early attempt doesn't
                # consume the once-per-turn announcement and leave the
                # PWA without its "your turn" listening chime.
                if _send_data_channel(peer, {"type": "listening"}):
                    listening_announced = True
                    logger.info(
                        "[stt-bridge] peer %s: announced listening (dc open)",
                        peer.peer_id,
                    )
            yield chunk

    # Supervised: a provider stream can close on a transient fault and the
    # call must survive it. The common one is Deepgram's own idle timeout,
    # which fires after ~10s of no audio — i.e. whenever the user simply
    # doesn't speak, or when audio hasn't started flowing yet on a freshly
    # renegotiated peer. This used to end transcription for the WHOLE call:
    # _run_stt is spawned exactly once per audio track and nothing ever
    # observed it finishing, so the peer stayed ICE-connected and read
    # "Connected" in the UI while being completely deaf (field bug
    # 2026-08-23 — a reconnect delivered zero mic frames, Deepgram timed
    # out 13s in, and 90 seconds of speech went nowhere before the client
    # flushed a mid-sentence utterance).
    #
    # Retries are unbounded on purpose: giving up after N attempts just
    # restores the original bug on call N+1. The loop exits on the pump's
    # sentinel (track ended) or cancellation, and backoff is capped so a
    # hard failure (bad API key) settles into a slow, visible retry rather
    # than a hot loop. `attempt` resets on every transcript, so a long call
    # that idles out repeatedly keeps reconnecting promptly.
    attempt = 0
    degraded = False
    try:
        while True:
            try:
                async for tx in stt.stream(_pcm_iter()):
                    if degraded:
                        degraded = False
                        _send_data_channel(peer, {"type": "stt-up"})
                        logger.info(
                            "[stt-bridge] peer %s STT recovered", peer.peer_id,
                        )
                    attempt = 0
                    await _handle_transcript(peer, tx)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # Not .exception(): the idle-timeout close is routine and a
                # traceback per occurrence buries the real faults.
                logger.warning(
                    "[stt-bridge] peer %s STT stream closed: %s", peer.peer_id, e,
                )
                if not degraded:
                    degraded = True
                    _send_data_channel(peer, {"type": "stt-down"})
            else:
                # Clean completion — _pcm_iter returned on the pump's None
                # sentinel, so the track is gone and there is nothing left
                # to reconnect to.
                break
            if pump_task.done():
                break
            attempt += 1
            delay = min(STT_RETRY_MAX_S, STT_RETRY_BASE_S * (2 ** (attempt - 1)))
            logger.info(
                "[stt-bridge] peer %s reconnecting STT in %.1fs (attempt %d)",
                peer.peer_id, delay, attempt,
            )
            # Drop the dead socket before opening the next one; stream()
            # overwrites the provider's _ws and would otherwise leak it.
            try:
                await stt.aclose()
            except Exception:  # pragma: no cover
                pass
            await asyncio.sleep(delay)
    finally:
        # Close out the last listening round's counters — the 2026-08-27
        # wedge ended in a hangup, so a summary only-at-next-TTS-start
        # would have skipped exactly the round that mattered.
        _log_round_tx_summary(peer, "stream-end")
        try:
            await stt.aclose()
        except Exception:  # pragma: no cover
            pass
        if not pump_task.done():
            pump_task.cancel()
            try:
                await pump_task
            except (asyncio.CancelledError, Exception):
                pass


# Match XML/HTML-style tags <foo …> and </foo>. Conservative — won't
# match angle brackets used as math/comparison ("a < b") because those
# don't form valid tag-name shapes.
_TAG_RE = re.compile(r"<[^>]{1,200}>")
# Markdown image syntax `![alt](url)`. Drop entirely — the URL is
# noise to TTS.
_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]+\)")
# Markdown link syntax `[label](url)`. Keep the label, drop the URL.
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
# Code fences — drop the fence delimiters but keep what's inside as a
# placeholder; ` ``` ` reads as "back tick back tick back tick" otherwise.
_CODE_BLOCK_RE = re.compile(r"```[\s\S]*?```", re.MULTILINE)
_CODE_FENCE_RE = re.compile(r"```[a-zA-Z0-9_+-]*\n?")
# Markdown emphasis: `**bold**` and `*italic*` / `_italic_`. Without
# stripping these the agent's reply reads as "star star bold star star".
# Canonical regex set lives in `test/tts-clean.test.ts`; keep in sync.
_MD_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
_MD_ITALIC_STAR_RE = re.compile(r"(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)")
_MD_ITALIC_UNDER_RE = re.compile(r"(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)")
_MD_HEADER_RE = re.compile(r"^#+\s+", re.MULTILINE)
_MD_LIST_RE = re.compile(r"^[\s]*[-*•]\s+", re.MULTILINE)
# URLs that survived the link-syntax strip (bare https://… in text).
_BARE_URL_RE = re.compile(r"https?://[^\s<)\]\"']+")
# Emoji: Aura reads "🤖" as silence but reads "✓" as a literal phrase
# ("check mark"). Strip the wide ranges that the test set covers.
_EMOJI_RE = re.compile(
    r"[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE00-\uFE0F\u200D\u20E3]"
)


def _sanitize_for_tts(text: str) -> str:
    """Strip markup that TTS shouldn't pronounce. Catches markdown
    bold/italic/headers/lists/code-blocks/links/images, raw HTML tags,
    bare URLs, and a wide emoji range. Without this Aura reads the
    asterisks of `**bold**` as "star star" out loud. Canonical regex
    set lives in test/tts-clean.test.ts (keep both in sync). Idempotent
    — running twice is a no-op."""
    if not text:
        return text
    out = _TAG_RE.sub("", text)
    out = _CODE_BLOCK_RE.sub("[code block]", out)
    out = _MD_IMAGE_RE.sub(r"\1", out)
    out = _MD_LINK_RE.sub(r"\1", out)
    out = _CODE_FENCE_RE.sub("", out)
    out = out.replace("`", "")
    out = _MD_BOLD_RE.sub(r"\1", out)
    out = _MD_ITALIC_STAR_RE.sub(r"\1\2", out)
    out = _MD_ITALIC_UNDER_RE.sub(r"\1\2", out)
    out = _MD_HEADER_RE.sub("", out)
    out = _MD_LIST_RE.sub("", out)
    out = _BARE_URL_RE.sub("(link in canvas)", out)
    out = _EMOJI_RE.sub("", out)
    # Trailing pass: drop any stray asterisks the patterns above didn't
    # catch (e.g. `*foo` with no closer, or `**` at line ends).
    out = out.replace("*", "")
    return out


def _log_round_tx_summary(peer, why: str) -> None:
    """One line per listening round: what the STT hop actually produced.

    Called when a round ENDS (the next TTS window starts, or the stream
    winds down). All-zero counters are the point — that is the exact
    signature of the 2026-08-27 post-barge wedge, and pre-fix it was
    invisible (only the FIRST transcript per round was ever logged)."""
    extra = getattr(peer, "extra", None)
    if extra is None:
        return
    interims = extra.pop("tx_interims", 0)
    finals = extra.pop("tx_finals", 0)
    empty_finals = extra.pop("tx_empty_finals", 0)
    # `eaten` counts the Deepgram-dropped-the-utterance shape; `recovered`
    # counts how many of those we handed back to the client from the last
    # non-empty interim. eaten>recovered means words were still lost —
    # that difference is the field metric to watch.
    eaten = extra.pop("tx_eaten_utterances", 0)
    recovered = extra.pop("tx_recovered_finals", 0)
    extra.pop("tx_interims_since_final", None)
    extra.pop("tx_last_interim_text", None)
    logger.info(
        "[stt-bridge] peer %s round=%s transcript summary (%s): "
        "interims=%d finals=%d empty_finals=%d eaten=%d recovered=%d%s",
        peer.peer_id, extra.get("post_tts_round") or 0, why,
        interims, finals, empty_finals, eaten, recovered,
        "" if (interims or finals) else " — NO TRANSCRIPTS THIS ROUND",
    )


def _send_data_channel(peer, payload: dict) -> bool:
    """Best-effort send of a JSON envelope over the peer's data channel.

    Returns True if the bytes left the bridge, False if the channel was
    closed / not-yet-opened. Caller can use the return value to decide
    whether to retry on the next opportunity (e.g. listening_announced
    only flips True after a successful send so a too-early send doesn't
    consume the once-per-turn flag).
    """
    dc = peer.data_channel
    if dc is None:
        return False
    try:
        # aiortc tracks ready-state; sending while not 'open' raises.
        if getattr(dc, "readyState", "open") != "open":
            return False
        import json as _json
        dc.send(_json.dumps(payload, ensure_ascii=False))
        return True
    except Exception as e:  # pragma: no cover
        logger.debug(
            "[stt-bridge] peer %s data-channel send failed: %s",
            peer.peer_id, e,
        )
        return False


async def _handle_transcript(peer, tx: Transcript) -> None:
    """Forward an interim or final transcript to the data channel.

    Pass-through behavior: every transcript event (interim + final +
    empty-final) goes out as a {type:'transcript', role:'user'}
    envelope. The bridge does NOT buffer, gate on commit-phrase, or run
    a silence timer — those decisions belong to the PWA, which owns the
    dispatch trigger.

    Empty FINALS (Deepgram's UtteranceEnd marker) are forwarded: the
    PWA's dictate.ts state machine closes out the current utterance on
    them — bakes the trailing space and re-anchors the NEXT utterance at
    the user's current caret. Dropping them here (pre-2026-08-09
    behavior, on the theory they were "internal sync points") left the
    client's utterance-end branch permanently dead: the anchor never
    reset, so after a caret move every later utterance still landed at
    the FIRST utterance's position (Jonathan field bug 2026-08-09).
    Empty interims stay skipped — pure noise.

    Empty-final RECOVERY: when an utterance closes empty after we had
    already seen non-empty interims for it, the last such interim is
    forwarded as that utterance's final BEFORE the empty end-of-utterance
    marker. See RECOVERED_FINAL_DEDUP_S. A recovered final is an ordinary
    {is_final:true} envelope on the wire — deliberately unmarked, so
    every downstream consumer (dictation buffer, sendword matcher, user
    bubble, dictate.ts caret anchor) treats it exactly like any other
    final. There is nothing useful the client could do differently with
    the knowledge, and a new envelope field would have to be understood
    by the frozen CAP bundle on his phone to be worth anything.
    """
    # First transcript after a TTS round ended — the other half of the
    # post-TTS frame evidence (see _pcm_iter): proves the resumed frames
    # actually produced STT output. One INFO line per reply round.
    extra = getattr(peer, "extra", None)
    if extra is not None and extra.get("post_tts_round") and not extra.get("post_tts_first_tx_logged"):
        extra["post_tts_first_tx_logged"] = True
        logger.info(
            "[stt-bridge] peer %s first post-TTS transcript (round=%s final=%s len=%d)",
            peer.peer_id, extra.get("post_tts_round"), tx.is_final, len(tx.text or ""),
        )

    # Round counters + Deepgram-ate-the-utterance probe — see the
    # transcript-hole diagnostics comment near STALL_AFTER_S.
    recovered_text = ""
    if extra is not None:
        now_mono = time.monotonic()
        extra["last_tx_mono"] = now_mono
        has_text = bool((tx.text or "").strip())
        if tx.is_final:
            if has_text:
                # Duplicate guard: UtteranceEnd can beat a straggling
                # is_final for the same segment, in which case we already
                # recovered these exact words a moment ago. Suppress the
                # late arrival rather than let the client render + buffer
                # the sentence twice.
                pending = extra.get("tx_recovered_text") or ""
                pending_at = extra.get("tx_recovered_at") or 0.0
                if (
                    pending
                    and (now_mono - pending_at) <= RECOVERED_FINAL_DEDUP_S
                    and _norm_for_dedup(pending) == _norm_for_dedup(tx.text)
                ):
                    extra["tx_recovered_text"] = ""
                    extra["tx_interims_since_final"] = 0
                    extra["tx_last_interim_text"] = ""
                    logger.info(
                        "[stt-bridge] peer %s suppressed late final duplicating "
                        "a recovered utterance (%d chars) — client already has it",
                        peer.peer_id, len(tx.text or ""),
                    )
                    return
                extra["tx_recovered_text"] = ""
                extra["tx_finals"] = extra.get("tx_finals", 0) + 1
                extra["tx_interims_since_final"] = 0
                extra["tx_last_interim_text"] = ""
            else:
                extra["tx_empty_finals"] = extra.get("tx_empty_finals", 0) + 1
                orphaned = extra.get("tx_interims_since_final", 0)
                if orphaned:
                    extra["tx_eaten_utterances"] = extra.get("tx_eaten_utterances", 0) + 1
                    # RECOVERY — forward what the interims already showed
                    # instead of dropping the utterance. Reactive: costs
                    # nothing on the happy path, runs only on a shape
                    # that was previously a total loss.
                    recovered_text = (extra.get("tx_last_interim_text") or "").strip()
                    if recovered_text:
                        extra["tx_recovered_finals"] = extra.get("tx_recovered_finals", 0) + 1
                        extra["tx_recovered_text"] = recovered_text
                        extra["tx_recovered_at"] = now_mono
                        logger.info(
                            "[stt-bridge] peer %s RECOVERED utterance closed EMPTY "
                            "after %d non-empty interims — forwarding the last "
                            "interim as the final (%d chars): %r",
                            peer.peer_id, orphaned, len(recovered_text),
                            recovered_text[:120],
                        )
                    else:
                        # Should not happen (orphaned>0 implies we stored
                        # text), but never fabricate: log and drop.
                        logger.info(
                            "[stt-bridge] peer %s utterance closed EMPTY after %d "
                            "non-empty interims and NO interim text was retained "
                            "— content lost (unrecoverable)",
                            peer.peer_id, orphaned,
                        )
                    extra["tx_interims_since_final"] = 0
                    extra["tx_last_interim_text"] = ""
        elif has_text:
            extra["tx_interims"] = extra.get("tx_interims", 0) + 1
            extra["tx_interims_since_final"] = extra.get("tx_interims_since_final", 0) + 1
            # Deepgram interims for a segment are cumulative, so the most
            # recent one is the fullest view of the utterance we ever get
            # if the final never arrives. Keep only that one.
            extra["tx_last_interim_text"] = tx.text

    # Emit the recovered final FIRST, then fall through to the empty
    # end-of-utterance marker below — the client needs the words before
    # the utterance-closed signal, same order a healthy Deepgram uses.
    if recovered_text:
        if peer.on_transcript is not None:
            try:
                await peer.on_transcript(recovered_text, True)
            except Exception as e:  # pragma: no cover
                logger.warning("[stt-bridge] peer %s on_transcript hook raised: %s", peer.peer_id, e)
        _send_data_channel(peer, {
            "type": "transcript",
            "text": recovered_text,
            "is_final": True,
            "role": "user",
        })

    if peer.on_transcript is not None:
        try:
            await peer.on_transcript(tx.text, tx.is_final)
        except Exception as e:  # pragma: no cover
            logger.warning("[stt-bridge] peer %s on_transcript hook raised: %s", peer.peer_id, e)

    if not tx.text and not tx.is_final:
        return

    _send_data_channel(peer, {
        "type": "transcript",
        "text": tx.text,
        "is_final": tx.is_final,
        "role": "user",
    })


async def dispatch_to_agent(peer, utterance: str, *, user_message_id: Optional[str] = None) -> None:
    """Public dispatch entry point invoked by the PWA-driven dispatch listener.

    POSTs *utterance* to the parley proxy. For the chat_id (parley-
    platform) route the agent reply arrives on the peer-scoped
    persistent stream subscriber started at peer-attach
    (``start_parley_stream``); this function is fire-and-forget POST.
    For the legacy /v1/responses route there is no persistent stream,
    so we still consume the per-POST SSE inline.

    *user_message_id* (when set) is the PWA-minted id riding the
    dispatch envelope. We forward it so the upstream's user_message
    echo carries the same id, letting the originating device's
    optimistic bubble dedup idempotently. Absent → server mints.
    """
    asyncio.create_task(
        _dispatch_to_agent(peer, utterance, user_message_id=user_message_id),
        name=f"webrtc-agent-{peer.peer_id[:8]}",
    )


# ── Persistent parley-stream subscriber ───────────────────────────────
#
# Long-lived per-peer SSE subscriber to /api/parley/stream?chat_id=X.
# Replaces the legacy per-utterance subscriber that broke out of the
# stream after the first reply_final and missed every subsequent bubble
# in the same user turn (post-tool-call results, follow-up nudges, etc.).
#
# Architecture: peer has a chat_id and is in talk mode → there's a
# tts_text_queue → spawn this subscriber at peer-attach time →
# every reply_delta drains into the queue → tts_bridge consumes →
# Aura synth → outbound peer audio track. Cancelled on peer.close().
#
# Cumulative-text diff is per-message-id. The agent emits multiple
# bubbles per user turn, each with its own message_id; reply_delta
# carries cumulative-so-far text for that bubble. We diff against
# prev cumulative for THAT msgid to extract the speakable delta.
#
# `live_only=1` is preserved: the bridge subscribes when the peer
# attaches and only wants envelopes broadcast AFTER that point —
# historical envelopes from earlier turns in the same chat would
# re-feed Aura TTS for already-spoken replies. The PWA's separate
# subscriber keeps its replay cursor for cross-device sync; only the
# bridge needs the live-only opt-out.

class _ParleyStreamReader:
    """Stateful SSE-frame consumer for the parley-platform route.

    Holds per-message-id cumulative-text state so reply_delta diffs
    work correctly when multiple bubbles interleave. Idempotent on
    duplicate envelopes (cumulative.startswith(prev) catches that).
    Pushes speakable deltas into ``text_queue`` and forwards to the
    peer's data channel for PWA-side rendering parity.
    """

    def __init__(self, peer, text_queue):
        self.peer = peer
        self.text_queue = text_queue
        self._current_event: Optional[str] = None
        # Per-message-id cumulative accumulators. Cleared on reply_final
        # for that msgid so completed bubbles don't hold memory forever.
        self._prev_cumulative: Dict[str, str] = {}
        self._prev_stripped_for_tts: Dict[str, str] = {}

    def _put_text(self, delta: str) -> None:
        if not delta or self.text_queue is None:
            return
        try:
            self.text_queue.put_nowait(delta)
        except asyncio.QueueFull:
            pass

    def _put_eor(self) -> None:
        """End-of-reply sentinel — flushes the TTS buffer for this bubble."""
        if self.text_queue is None:
            return
        try:
            self.text_queue.put_nowait(None)
        except asyncio.QueueFull:
            pass

    async def process_line(self, line_bytes) -> None:
        """Consume one raw SSE line. Side-effects: text_queue push,
        on_transcript hook, data-channel forward.
        """
        line = line_bytes.rstrip(b"\r\n")
        if not line:
            self._current_event = None
            return
        if line.startswith(b":"):
            return
        if line.startswith(b"event:"):
            self._current_event = line[len(b"event:"):].strip().decode(
                "utf-8", errors="replace",
            )
            return
        if not line.startswith(b"data:"):
            return
        data = line[len(b"data:"):].strip()
        if not data:
            return
        try:
            import json as _json
            chunk = _json.loads(data)
        except (ValueError, TypeError):
            return
        event_name = self._current_event or chunk.get("type")

        if event_name == "reply_delta":
            cumulative = chunk.get("text") or ""
            if not cumulative:
                return
            msgid = str(chunk.get("message_id") or "")
            prev = self._prev_cumulative.get(msgid, "")
            if cumulative.startswith(prev):
                delta = cumulative[len(prev):]
            else:
                # Restart — agent sent a non-additive delta (rare).
                delta = cumulative
            self._prev_cumulative[msgid] = cumulative
            if not delta:
                return
            new_stripped = _sanitize_for_tts(cumulative)
            prev_stripped = self._prev_stripped_for_tts.get(msgid, "")
            if new_stripped.startswith(prev_stripped):
                tts_delta = new_stripped[len(prev_stripped):]
            else:
                tts_delta = new_stripped
            self._prev_stripped_for_tts[msgid] = new_stripped
            self._put_text(tts_delta)
            if self.peer.on_transcript is not None:
                try: await self.peer.on_transcript(delta, False)
                except Exception: pass
            # Only forward an assistant delta the TTS queue actually
            # ACCEPTED. Since cc57300 the PWA uses this envelope for
            # exactly one thing — arming its ttsPlaying suppression gate
            # (rendering is SSE-only; see main.ts "single render
            # origin") — and arming is only ever correct when a TTS
            # round is going to follow. A markup/emoji-only reply
            # sanitizes to empty here, so pre-fix it armed the gate with
            # no audio, no `listening` and therefore no clear: the mic
            # was dead for the rest of the call. No speakable text, no
            # arming envelope.
            if not tts_delta:
                return
            _send_data_channel(self.peer, {
                "type": "transcript", "text": delta,
                "is_final": False, "role": "assistant",
            })
            return

        if event_name == "reply_final":
            msgid = str(chunk.get("message_id") or "")
            cumulative_len = len(self._prev_cumulative.get(msgid, ""))
            logger.info(
                "[stt-bridge] peer %s reply_final msgid=%s cumulative_len=%d",
                self.peer.peer_id, msgid[:32], cumulative_len,
            )
            # Flush this bubble's TTS buffer; tts_bridge treats None as
            # end-of-reply and starts a new synth round on next text.
            self._put_eor()
            # Drop completed-bubble state so it doesn't leak. New bubbles
            # come in with fresh msgids.
            self._prev_cumulative.pop(msgid, None)
            self._prev_stripped_for_tts.pop(msgid, None)
            # Forward end-of-reply to the data channel for the PWA
            # streaming-cursor drop. (PWA also has its own subscriber;
            # this is parity with the legacy per-utterance path.)
            _send_data_channel(self.peer, {
                "type": "transcript",
                "text": "",
                "is_final": True,
                "role": "assistant",
            })
            return

        # Other envelope types (typing, tool_call, tool_result, error,
        # session_changed, user_message, notification) flow through the
        # PWA's separate subscriber; we don't need to mirror them since
        # we're only interested in audio synth.


def start_parley_stream(peer) -> None:
    """Start the peer-scoped persistent stream subscriber.

    Caller (signaling.handle_offer) invokes this AFTER tts_bridge.attach
    has created peer.extra['tts_text_queue'], and only when mode=='talk'
    AND chat_id is set. No-op if either precondition is missing.
    """
    if peer.mode != "talk":
        return
    chat_id = peer.extra.get("chat_id")
    if not chat_id:
        return
    text_queue = peer.extra.get("tts_text_queue")
    if text_queue is None:
        logger.warning(
            "[stt-bridge] peer %s start_parley_stream: no tts_text_queue (talk mode but TTS attach skipped?)",
            peer.peer_id,
        )
        return
    if peer.parley_stream_task is not None and not peer.parley_stream_task.done():
        return  # idempotent
    peer.parley_stream_task = asyncio.create_task(
        _run_parley_stream(peer, chat_id, text_queue),
        name=f"webrtc-parley-stream-{peer.peer_id[:8]}",
    )


async def _run_parley_stream(peer, chat_id: str, text_queue) -> None:
    """Stay subscribed to /api/parley/stream for the peer's lifetime,
    feeding every reply_delta delta into ``text_queue``. Reconnects with
    bounded backoff if the connection drops; exits cleanly on
    cancellation (peer.close).
    """
    proxy_url = (peer.extra.get("proxy_url") or "http://127.0.0.1:3001").rstrip("/")
    stream_url = f"{proxy_url}/api/parley/stream?chat_id={chat_id}&live_only=1"

    try:
        import aiohttp  # type: ignore
    except ImportError:  # pragma: no cover
        logger.error("[stt-bridge] aiohttp missing for parley stream")
        return

    reader = _ParleyStreamReader(peer, text_queue)
    backoff_s = 0.5
    BACKOFF_MAX = 8.0

    logger.info(
        "[stt-bridge] peer %s parley stream subscriber starting (chat_id=%s)",
        peer.peer_id, chat_id[:12],
    )
    try:
        async with aiohttp.ClientSession() as sess:
            while not peer.closed:
                try:
                    async with sess.get(
                        stream_url,
                        timeout=aiohttp.ClientTimeout(total=None),
                    ) as resp:
                        if resp.status != 200:
                            err = (await resp.text())[:200]
                            logger.warning(
                                "[stt-bridge] peer %s parley stream open %d: %s (retry in %.1fs)",
                                peer.peer_id, resp.status, err, backoff_s,
                            )
                            await asyncio.sleep(backoff_s)
                            backoff_s = min(BACKOFF_MAX, backoff_s * 2)
                            continue
                        backoff_s = 0.5  # reset on successful connect
                        async for raw in resp.content:
                            await reader.process_line(raw)
                        # EOF without cancellation → server closed the
                        # stream. Reconnect with a small delay.
                        if not peer.closed:
                            logger.info(
                                "[stt-bridge] peer %s parley stream EOF, reconnecting",
                                peer.peer_id,
                            )
                            await asyncio.sleep(0.5)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.warning(
                        "[stt-bridge] peer %s parley stream error: %s (retry in %.1fs)",
                        peer.peer_id, e, backoff_s,
                    )
                    await asyncio.sleep(backoff_s)
                    backoff_s = min(BACKOFF_MAX, backoff_s * 2)
    except asyncio.CancelledError:
        pass
    finally:
        logger.info(
            "[stt-bridge] peer %s parley stream subscriber exiting",
            peer.peer_id,
        )
        # Final flush so any tail text in the TTS provider gets
        # synthesized before the queue idles.
        if text_queue is not None:
            try:
                text_queue.put_nowait(None)
            except asyncio.QueueFull:
                pass


async def _dispatch_to_agent(peer, utterance: str, *, user_message_id: Optional[str] = None) -> None:
    """Run an agent turn for *utterance* and route the streaming reply.

    Two routing paths, selected by which identifier the offer payload
    carried:

    - **chat_id present** (hermes-gateway backend): POST
      <proxy_url>/api/parley/messages with {chat_id, text}. The proxy
      forwards via WebSocket to the hermes parley platform adapter;
      the SSE response carries `event: <envelope_type>` frames with the
      adapter envelope (reply_delta / reply_final / typing / etc) as the
      data payload.

    - **chat_id absent** (legacy): POST <proxy_url>/api/<backend>/responses
      with the OpenAI Responses API body. The proxy forwards to the
      agent's /v1/responses; SSE carries response.output_text.delta /
      response.completed events.

    Both paths feed the same two sinks:

    1. The peer's TTS bridge (talk mode) — registers a queue under
       peer.extra["tts_text_queue"]; we push text deltas into it.

    2. The data channel — the PWA renders the assistant bubble from
       these envelopes.  A terminal {role:'assistant', is_final:true}
       fires after the stream completes so the PWA can drop the
       streaming-cursor on the bubble.
    """
    proxy_url = (peer.extra.get("proxy_url") or "http://127.0.0.1:3001").rstrip("/")
    chat_id = peer.extra.get("chat_id")
    if chat_id:
        url = f"{proxy_url}/api/parley/messages"
        body: Dict[str, Any] = {"chat_id": chat_id, "text": utterance}
        if user_message_id:
            body["user_message_id"] = user_message_id
        route = "parley-platform"
    else:
        backend = peer.extra.get("backend") or "hermes"
        url = f"{proxy_url}/api/{backend}/responses"
        conv_name = peer.extra.get("conv_name")
        body = {"input": utterance, "stream": True}
        if conv_name:
            body["conversation"] = conv_name
        if user_message_id:
            # Riding metadata (OAI-blessed Dict[str,str] extension
            # point) so vanilla OpenAI servers ignore-gracefully
            # instead of choking on an unknown top-level field.
            body["metadata"] = {"user_message_id": user_message_id}
        route = "responses"

    headers = {"Content-Type": "application/json"}

    try:
        import aiohttp  # type: ignore
    except ImportError:  # pragma: no cover
        logger.error("[stt-bridge] aiohttp missing for agent dispatch")
        return

    logger.info(
        "[stt-bridge] peer %s dispatch start (route=%s utterance_len=%d)",
        peer.peer_id, route, len(utterance),
    )

    text_queue: Optional[asyncio.Queue] = peer.extra.get("tts_text_queue")

    # SSE events arrive as `event: <name>\ndata: <json>\n\n` frames. We
    # track the current event name across lines so the data: payload can
    # be interpreted in context.
    #
    # Two event vocabularies depending on `route`:
    #   responses        — response.output_text.delta (per-token delta) /
    #                      response.completed (terminal)
    #   parley-platform — reply_delta (cumulative text) / reply_final
    #                       (terminal). See backends/hermes/plugin/__init__.py.
    #
    # For the cumulative-text path we diff against the previously-seen
    # text so the data-channel envelope to the PWA stays per-token (the
    # PWA's transcript renderer appends, doesn't replace) and the TTS
    # text-queue gets only the new tokens.
    current_event: Optional[str] = None
    prev_cumulative: str = ""
    # Stripped mirror of prev_cumulative — what the TTS queue has
    # actually consumed so far. Diffing against this rather than the
    # raw cumulative lets us push only the SPEAKABLE delta (HTML/
    # markdown/etc. dropped) without splitting tags mid-token.
    prev_stripped_for_tts: str = ""

    # Inline SSE parser: consumes one frame at a time from `content_iter`,
    # feeds delta tokens into the TTS queue + on_transcript hook + data
    # channel envelope. Returns True when a terminal event arrives
    # (response.completed / reply_final), so the caller breaks out.
    async def _process_sse_frame(line_bytes) -> bool:
        nonlocal current_event, prev_cumulative, prev_stripped_for_tts
        line = line_bytes.rstrip(b"\r\n")
        if not line:
            current_event = None
            return False
        if line.startswith(b":"):
            return False
        if line.startswith(b"event:"):
            current_event = line[len(b"event:"):].strip().decode(
                "utf-8", errors="replace",
            )
            return False
        if not line.startswith(b"data:"):
            return False
        data = line[len(b"data:"):].strip()
        if not data:
            return False
        try:
            import json as _json
            chunk = _json.loads(data)
        except (ValueError, TypeError):
            return False
        event_name = current_event or chunk.get("type")
        if event_name == "response.output_text.delta":
            delta = chunk.get("delta") or ""
            if delta:
                if text_queue is not None:
                    try: text_queue.put_nowait(delta)
                    except asyncio.QueueFull: pass
                if peer.on_transcript is not None:
                    try: await peer.on_transcript(delta, False)
                    except Exception: pass
                _send_data_channel(peer, {
                    "type": "transcript", "text": delta,
                    "is_final": False, "role": "assistant",
                })
            return False
        if event_name == "response.completed":
            logger.info(
                "[stt-bridge] peer %s reply terminal (event=response.completed)",
                peer.peer_id,
            )
            return True
        if event_name == "reply_delta":
            cumulative = chunk.get("text") or ""
            if not cumulative:
                return False
            if cumulative.startswith(prev_cumulative):
                delta = cumulative[len(prev_cumulative):]
            else:
                delta = cumulative
            prev_cumulative = cumulative
            if not delta:
                return False
            # TTS path: feed the SPEAKABLE delta only. Strip XML/HTML
            # tags + markdown link/image syntax from the cumulative
            # text, diff against prev_stripped_for_tts to compute the
            # new audible portion. Keeps Aura from pronouncing
            # `<audio src="speech_…mp3">` literally when the agent
            # leaks markup into its output (gemma-4 sometimes hallucinates
            # an audio embed; gpt-oss leaks Harmony channel tokens).
            new_stripped = _sanitize_for_tts(cumulative)
            if new_stripped.startswith(prev_stripped_for_tts):
                tts_delta = new_stripped[len(prev_stripped_for_tts):]
            else:
                tts_delta = new_stripped
            prev_stripped_for_tts = new_stripped
            if tts_delta and text_queue is not None:
                try: text_queue.put_nowait(tts_delta)
                except asyncio.QueueFull: pass
            # PWA-side surfaces (data channel + on_transcript) get the
            # raw delta — the chat-bubble renderer handles its own
            # display cleanup.
            if peer.on_transcript is not None:
                try: await peer.on_transcript(delta, False)
                except Exception: pass
            # Same rule as _ParleyStreamReader: the DC assistant delta
            # is the PWA's suppression-ARMING signal, so it may only go
            # out when there is speakable text (and therefore a TTS
            # round) behind it. See the comment there.
            if not tts_delta:
                return False
            _send_data_channel(peer, {
                "type": "transcript", "text": delta,
                "is_final": False, "role": "assistant",
            })
            return False
        if event_name == "reply_final":
            logger.info(
                "[stt-bridge] peer %s reply terminal (event=reply_final cumulative_len=%d)",
                peer.peer_id, len(prev_cumulative),
            )
            return True
        return False

    async with aiohttp.ClientSession() as sess:
        try:
            if route == "parley-platform":
                # Platform-adapter path: fire-and-forget POST. Reply
                # envelopes arrive on the peer-scoped persistent
                # subscriber started at peer-attach (start_parley_stream).
                # See _run_parley_stream for the consumer.
                async with sess.post(url, json=body, headers=headers) as post_resp:
                    if post_resp.status not in (200, 202):
                        err = (await post_resp.text())[:200]
                        logger.warning(
                            "[stt-bridge] peer %s agent dispatch %d: %s",
                            peer.peer_id, post_resp.status, err,
                        )
                        return
                logger.info(
                    "[stt-bridge] peer %s dispatch posted (route=parley-platform)",
                    peer.peer_id,
                )
            else:
                # Legacy /v1/responses route: no persistent stream
                # available — consume per-POST SSE inline. Same
                # break-on-reply_final shape as before; that route is
                # one-bubble-per-turn by /v1/responses semantics, so
                # the bug doesn't apply.
                async with sess.post(url, json=body, headers=headers) as resp:
                    if resp.status != 200:
                        err = (await resp.text())[:200]
                        logger.warning(
                            "[stt-bridge] peer %s agent dispatch %d: %s",
                            peer.peer_id, resp.status, err,
                        )
                        return
                    async for raw in resp.content:
                        if await _process_sse_frame(raw):
                            break
                # Legacy-route end-of-reply housekeeping. Parley-
                # platform route doesn't run this finally because the
                # persistent stream owns the lifecycle.
                if text_queue is not None:
                    try:
                        text_queue.put_nowait(None)
                    except asyncio.QueueFull:
                        pass
                _send_data_channel(peer, {
                    "type": "transcript",
                    "text": "",
                    "is_final": True,
                    "role": "assistant",
                })
                logger.info(
                    "[stt-bridge] peer %s dispatch finally (route=responses cumulative_len=%d)",
                    peer.peer_id, len(prev_cumulative),
                )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("[stt-bridge] peer %s agent dispatch error: %s", peer.peer_id, e)


__all__ = ["attach", "dispatch_to_agent", "start_parley_stream"]
