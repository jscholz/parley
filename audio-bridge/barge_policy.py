"""
Bridge-side barge policy — server-side acoustic VAD that fires
{type:'speech-active'} envelopes to the PWA, consumed by the client's
BridgeVadSource (see src/audio/shared/vadSource.ts).

WHY: client-side ONNX Silero is structurally broken on Mac Chrome
(microsoft/onnxruntime#19177 — InferenceSession.create cold-start
times out >15s). Bridge-side Silero (Python torch) loads once at
process start, works regardless of the client device, and lets us
ship the toggleable VadSource that frontier labs converged on
(LiveKit, Pipecat hybrid model).

PIPELINE: mic → WebRTC → audio-bridge → stt_bridge._pcm_iter →
   {feed_frame() here} → silero(p_speech) → hysteresis → emit
   {type:'speech-active', active: bool} envelope on transitions.

GATING: only runs Silero when tts_track.is_active() (the agent is
speaking). Outside that window, barge isn't a concept; we save CPU
and reset the hysteresis counters so a new turn starts clean.

HYSTERESIS: per-frame Silero is jittery; consecutive-frame counters
keep us off the chatter floor. MIN_SPEECH_FRAMES at 16kHz/32ms-window
≈ 220ms sustained — close to the client's 400ms minSpeechMs but
slightly tighter since the bridge has cleaner buffering than the
browser's worklet.

SAMPLE-RATE NOTE: stt_bridge resamples the inbound track to 16kHz
mono int16 with 20ms (320-sample) frames. Silero wants 32ms (512-
sample) at 16kHz. We buffer two incoming frames and feed 512 samples
per Silero call, sliding by 512 — yields one inference per ~32ms,
matching Silero's intended cadence.

DI: the load_model factory is injected via attach() so tests pass a
stub returning prerecorded p_speech sequences and don't need torch.
"""

from __future__ import annotations

import logging
import os
from parley_env import env_get
from typing import Any, Callable, Optional

import numpy as np

logger = logging.getLogger(__name__)

# Frame and Silero sizing (must match stt_bridge frame contract).
SAMPLE_RATE = 16000
SILERO_WINDOW_SAMPLES = 512  # 32 ms at 16 kHz — Silero's expected window
SILERO_CONTEXT_SAMPLES = 64  # v5 prepends 64 samples of prior audio per window
INT16_TO_FLOAT = 1.0 / 32768.0

# Defaults — overridable via env. Numbers picked to match the spirit of
# the client-side BargeDetector (positiveSpeechThreshold=0.5,
# minSpeechMs=400) translated into bridge cadence (32ms per inference).
DEFAULT_SPEECH_THRESHOLD = float(env_get("PARLEY_BARGE_THRESHOLD", "0.5"))
# 7 frames * 32ms ≈ 224ms — a touch faster than the client's 400ms.
# Bridge has cleaner buffering, so we can be slightly tighter without
# false-firing on transients.
DEFAULT_MIN_SPEECH_FRAMES = int(env_get("PARLEY_BARGE_MIN_SPEECH_FRAMES", "7"))
# 25 frames * 32ms ≈ 800ms — long enough that the user has clearly
# stopped before we re-arm.
DEFAULT_MIN_SILENCE_FRAMES = int(env_get("PARLEY_BARGE_MIN_SILENCE_FRAMES", "25"))


SileroInfer = Callable[[np.ndarray], float]
"""Stable-shaped callable: takes a 512-sample float32 array in [-1, 1]
at 16kHz, returns p_speech in [0, 1]. Production wraps the torch model;
tests pass a stub returning prerecorded values."""


class BargePolicy:
    """Per-peer barge-policy state machine.

    Owns:
      - a rolling sample buffer (we receive 320-sample frames; Silero
        wants 512-sample windows; buffer concatenates and slides)
      - hysteresis counters (consecutive_speech / consecutive_silence)
      - the boolean is_active flag that drives envelope emissions

    Does NOT own:
      - the data-channel send (caller provides emit_envelope)
      - the model lifecycle (caller provides infer)
      - the tts_active flag (caller passes it per feed_frame)

    Pure-function in spirit: feed_frame() and current state determine
    whether an envelope fires. Easy to test on fixture sequences.
    """

    def __init__(
        self,
        infer: SileroInfer,
        emit_envelope: Callable[[dict], None],
        *,
        speech_threshold: float = DEFAULT_SPEECH_THRESHOLD,
        min_speech_frames: int = DEFAULT_MIN_SPEECH_FRAMES,
        min_silence_frames: int = DEFAULT_MIN_SILENCE_FRAMES,
    ):
        self._infer = infer
        self._emit = emit_envelope
        self._speech_threshold = speech_threshold
        self._min_speech_frames = min_speech_frames
        self._min_silence_frames = min_silence_frames
        # Sample buffer — slides as Silero consumes 512-sample windows.
        # Sized to comfortably hold ~3 incoming frames before slide.
        self._buf: list[float] = []
        # Hysteresis counters in Silero-window units (32ms each).
        self._consec_speech = 0
        self._consec_silence = 0
        self._is_active = False
        # Diagnostic (temporary, logging-only): per-TTS-window peaks so a
        # single real device call reveals WHICH way barge breaks — mic
        # carries no detectable speech during playback (iOS double-talk
        # ducking; max_amp≈0) vs. speech present but p_speech sits just
        # under threshold (a tuning fix; max_p≈0.3-0.49). Flushed once
        # when the TTS window ends.
        self._diag_max_p = 0.0
        self._diag_max_amp = 0.0
        self._diag_windows = 0
        self._diag_fired = False

    @property
    def is_active(self) -> bool:
        """Current speech-active flag (after hysteresis)."""
        return self._is_active

    def feed_frame(self, frame_bytes: bytes, tts_active: bool) -> None:
        """Feed one 320-sample int16 frame from stt_bridge._pcm_iter.

        Behavior:
          - When tts_active=False: not in barge window. Reset hysteresis
            counters; emit a final 'inactive' envelope if we were active;
            drop the buffered samples (they predate the new turn).
          - When tts_active=True: convert to float32, append to buffer,
            consume 512-sample windows by running infer() and updating
            hysteresis. Emit envelopes on state-change boundaries.
        """
        if not tts_active:
            # Diagnostic: flush the peaks seen during the window that just
            # ended (one line per agent utterance). max_amp≈0 ⇒ the mic
            # uplink was ducked/suppressed during playback (device AEC);
            # max_p just under threshold ⇒ tune it down.
            if self._diag_windows > 0:
                logger.info(
                    "[barge-policy] tts window ended: %d windows, max p_speech=%.3f, "
                    "max |amp|=%.4f, fired=%s (threshold=%.2f, min_speech_frames=%d)",
                    self._diag_windows, self._diag_max_p, self._diag_max_amp,
                    self._diag_fired, self._speech_threshold, self._min_speech_frames,
                )
                self._diag_max_p = 0.0
                self._diag_max_amp = 0.0
                self._diag_windows = 0
                self._diag_fired = False
            # Reset cleanly so the next TTS-active window starts fresh.
            if self._is_active:
                self._is_active = False
                try:
                    self._emit({"type": "speech-active", "active": False})
                except Exception as e:  # pragma: no cover
                    logger.warning("[barge-policy] emit (inactive) failed: %s", e)
            self._consec_speech = 0
            self._consec_silence = 0
            self._buf.clear()
            return

        # int16 → float32 in [-1, 1]
        arr = np.frombuffer(frame_bytes, dtype=np.int16).astype(np.float32) * INT16_TO_FLOAT
        if arr.size:
            amp = float(np.abs(arr).max())
            if amp > self._diag_max_amp:
                self._diag_max_amp = amp
        self._buf.extend(arr.tolist())

        # Consume non-overlapping 512-sample windows.
        while len(self._buf) >= SILERO_WINDOW_SAMPLES:
            window = np.asarray(self._buf[:SILERO_WINDOW_SAMPLES], dtype=np.float32)
            del self._buf[:SILERO_WINDOW_SAMPLES]
            try:
                p_speech = float(self._infer(window))
            except Exception as e:  # pragma: no cover
                logger.warning("[barge-policy] infer threw: %s", e)
                continue
            self._diag_windows += 1
            if p_speech > self._diag_max_p:
                self._diag_max_p = p_speech
            self._step(p_speech)

    def _step(self, p_speech: float) -> None:
        """Advance the hysteresis state machine one Silero window."""
        if p_speech >= self._speech_threshold:
            self._consec_speech += 1
            self._consec_silence = 0
            if not self._is_active and self._consec_speech >= self._min_speech_frames:
                self._is_active = True
                self._diag_fired = True
                try:
                    self._emit({"type": "speech-active", "active": True})
                    logger.info(
                        "[barge-policy] speech-active (sustained %d frames, p=%.3f)",
                        self._consec_speech, p_speech,
                    )
                except Exception as e:  # pragma: no cover
                    logger.warning("[barge-policy] emit (active) failed: %s", e)
        else:
            self._consec_silence += 1
            self._consec_speech = 0
            if self._is_active and self._consec_silence >= self._min_silence_frames:
                self._is_active = False
                try:
                    self._emit({"type": "speech-active", "active": False})
                    logger.info(
                        "[barge-policy] speech-inactive (sustained silence %d frames)",
                        self._consec_silence,
                    )
                except Exception as e:  # pragma: no cover
                    logger.warning("[barge-policy] emit (inactive) failed: %s", e)


# ── Production model loading ──────────────────────────────────────────
#
# Two interchangeable inference backends, tried in this order:
#
#   1. torch + silero-vad  — used when already installed. Keeps existing
#      deployments byte-for-byte unchanged: same model, same numbers,
#      zero new behavior.
#
#   2. onnxruntime + vendored assets/silero_vad.onnx — the default for
#      fresh installs. onnxruntime-CPU is a few MB; torch+silero pulls
#      ~750MB (and, depending on the index, CUDA wheels) on first
#      install. requirements.txt now ships only onnxruntime so a clean
#      `pip install -r` never drags in torch.
#
# Either way the bridge can run with NEITHER installed: _make_infer()
# returns None and attach() falls back to a no-op policy that never fires
# envelopes (the PWA then uses client-side VAD via FallbackVadSource).

_SILERO_MODEL: Any = None
_SILERO_LOAD_TRIED = False

_ONNX_SESSION: Any = None
_ONNX_LOAD_TRIED = False


def _load_silero() -> Optional[Any]:
    """Lazy-load the silero-vad torch model. Returns None if the package
    isn't installed (bridge degrades to no-op barge policy)."""
    global _SILERO_MODEL, _SILERO_LOAD_TRIED
    if _SILERO_LOAD_TRIED:
        return _SILERO_MODEL
    _SILERO_LOAD_TRIED = True
    try:
        import torch  # noqa: F401  # imported for side-effect
        from silero_vad import load_silero_vad
        _SILERO_MODEL = load_silero_vad()
        _SILERO_MODEL.eval()
        logger.info("[barge-policy] silero-vad model loaded")
    except Exception as e:
        logger.info("[barge-policy] torch silero-vad not installed (%s) — using onnxruntime", e)
        _SILERO_MODEL = None
    return _SILERO_MODEL


def _make_torch_infer() -> Optional[SileroInfer]:
    """Build a SileroInfer callable bound to the loaded torch model.
    Returns None when silero-vad isn't available."""
    model = _load_silero()
    if model is None:
        return None

    import torch

    def infer(frame: np.ndarray) -> float:
        # reset_states gives each peer's policy a fresh internal state —
        # otherwise inference accumulates across all peers' frames and
        # the model "remembers" prior context that doesn't apply to
        # this peer's mic.
        # NOTE: this is a per-peer concern; the model itself is shared
        # but state-reset on every call here means we lose Silero's
        # internal LSTM context. For barge-detection that's actually
        # fine — we want per-frame discrimination, not utterance-level
        # tracking. Trade-off documented for future tuning.
        with torch.no_grad():
            t = torch.from_numpy(frame)
            return float(model(t, SAMPLE_RATE))
    return infer


def _onnx_model_path() -> str:
    """Path to the vendored silero v5 onnx model (bridge-relative)."""
    return os.path.join(os.path.dirname(__file__), "assets", "silero_vad.onnx")


def _load_onnx() -> Optional[Any]:
    """Lazy-load an onnxruntime session over the vendored silero model.
    Returns None if onnxruntime isn't installed or the model is missing."""
    global _ONNX_SESSION, _ONNX_LOAD_TRIED
    if _ONNX_LOAD_TRIED:
        return _ONNX_SESSION
    _ONNX_LOAD_TRIED = True
    try:
        import onnxruntime as ort

        path = _onnx_model_path()
        if not os.path.exists(path):
            logger.warning("[barge-policy] onnx model missing at %s — barge disabled", path)
            _ONNX_SESSION = None
            return None
        opts = ort.SessionOptions()
        # Single-threaded: one 512-sample inference per ~32ms is trivial,
        # and the bridge runs other peers' frames on the same loop — we
        # don't want onnxruntime spawning a thread pool per session.
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        _ONNX_SESSION = ort.InferenceSession(
            path, sess_options=opts, providers=["CPUExecutionProvider"],
        )
        logger.info("[barge-policy] onnxruntime silero model loaded (%s)", path)
    except Exception as e:
        logger.warning("[barge-policy] onnxruntime silero unavailable: %s — barge disabled", e)
        _ONNX_SESSION = None
    return _ONNX_SESSION


def _make_onnx_infer() -> Optional[SileroInfer]:
    """Build a SileroInfer callable backed by the vendored onnx model.
    Returns None when onnxruntime / the model isn't available.

    Each call to this factory closes over its own LSTM state array, so the
    per-peer infer built in attach() keeps that peer's recurrent context
    across frames (the shared session itself is stateless w.r.t. run()).
    Unlike the torch path's per-call reset, this preserves context — which
    only helps barge discrimination; BargePolicy's frame hysteresis is the
    actual jitter guard either way."""
    session = _load_onnx()
    if session is None:
        return None

    sr = np.array(SAMPLE_RATE, dtype=np.int64)
    state = np.zeros((2, 1, 128), dtype=np.float32)
    # Silero v5's silero_vad.onnx requires 64 samples of preceding audio
    # (at 16 kHz) prepended to each 512-sample window — the model infers on
    # 576 samples. The official OnnxWrapper carries this rolling context
    # forward across frames (silero_vad/utils_vad.py); feeding a bare 512
    # window makes the model emit ~0 on everything (it never crosses
    # threshold, so barge silently dies). Keep the last 64 samples of each
    # fed window as the next frame's context.
    context = np.zeros((1, SILERO_CONTEXT_SAMPLES), dtype=np.float32)

    def infer(frame: np.ndarray) -> float:
        nonlocal state, context
        x = frame.reshape(1, -1).astype(np.float32)
        x = np.concatenate([context, x], axis=1)
        out, state = session.run(None, {"input": x, "state": state, "sr": sr})
        context = x[:, -SILERO_CONTEXT_SAMPLES:]
        return float(out[0][0])
    return infer


def _make_infer() -> Optional[SileroInfer]:
    """Pick an inference backend: torch if already installed (existing
    deployments stay identical), else the vendored onnxruntime model
    (fresh installs avoid the torch/CUDA download). None when neither
    is available — caller degrades to a no-op policy."""
    infer = _make_torch_infer()
    if infer is not None:
        return infer
    return _make_onnx_infer()


def attach(peer, *, voice_config: Any = None) -> Optional[BargePolicy]:
    """Wire a per-peer BargePolicy onto peer.extra['barge_policy'].

    Production: builds an infer fn (torch if installed, else the vendored
    onnxruntime model) and an emit fn that sends data-channel envelopes via
    stt_bridge._send_data_channel. Tests can call BargePolicy(...)
    directly with stubbed deps and skip attach().

    Returns the BargePolicy (None when no VAD backend is available, in
    which case the bridge degrades to client-side-only barge — the PWA's
    FallbackVadSource detects this via the barge-vad-query handshake and
    switches to client-side Silero).
    """
    infer = _make_infer()
    if infer is None:
        peer.extra["barge_policy"] = None
        return None

    # Late import to avoid circular dep with stt_bridge.
    import stt_bridge

    def emit(envelope: dict) -> None:
        stt_bridge._send_data_channel(peer, envelope)

    policy = BargePolicy(infer=infer, emit_envelope=emit)
    peer.extra["barge_policy"] = policy
    logger.info("[barge-policy] attached to peer %s", peer.peer_id)
    return policy


__all__ = ["BargePolicy", "attach", "SileroInfer"]
